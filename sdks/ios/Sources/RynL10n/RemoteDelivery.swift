import Foundation

/// 배포 플레인(CDN/오브젝트 스토리지) HTTP 참조 구현 — 기획서 4.1 / 6.4 / 7.2.
///
/// **관리 API는 절대 호출하지 않는다.** 읽는 것은 정적 파일 세 종류뿐이다(11.2):
/// ```
/// {baseURL}/{project}/manifest.json                            짧은 TTL + ETag
/// {baseURL}/{project}/releases/{r}/snapshot-{hash}.json        불변 → 영구 캐시
/// {baseURL}/{project}/releases/{r}/delta-{base}-{target}.json  불변 → 영구 캐시
/// ```
///
/// `DeliveryStore`는 동기 프로토콜이다(`refresh(manifest:)`가 동기라 화면이 절대 네트워크를 기다리지
/// 않는다). 그래서 이 타입은 **비동기 다운로드와 동기 조회를 분리**한다 — `update(_:)`가 필요한 산출물을
/// 먼저 캐시에 채운 뒤 `refresh`를 호출하고, 프로토콜 메서드는 캐시만 들여다본다(네트워크 접근 없음).
///
/// 산출물은 내용해시 URL이라 한 번 받으면 영구 유효하다 → 디스크 캐시에 그대로 둔다.
/// manifest만 ETag로 재검증하며, 네트워크가 없으면 **마지막 캐시로 진행**한다(오프라인 실행 보장).
public final class RemoteDeliveryStore: DeliveryStore, @unchecked Sendable {

    public enum DeliveryError: Error, Sendable {
        /// 2xx가 아닌 응답.
        case badStatus(Int, path: String)
        /// 네트워크 실패이고 캐시도 없음.
        case unavailable(path: String, underlying: (any Error)?)
        /// 본문을 기대 타입으로 디코딩하지 못함.
        case malformed(path: String)
    }

    private let projectURL: URL
    private let cacheDir: URL
    private let session: URLSession

    private let lock = NSLock()
    private var snapshotCache: [String: Snapshot] = [:]
    private var deltaCache: [String: Delta] = [:]
    private var pollTask: Task<Void, Never>?

    /// - Parameters:
    ///   - baseURL: 배포 플레인 루트. 로컬 셀프호스트는 `http://localhost:8788`, 운영은 CDN 도메인.
    ///   - project: 프로젝트 ID(정적 레이아웃의 첫 경로 세그먼트).
    ///   - cacheDirectory: 기본값은 `Library/Caches/rynl10n/{project}`. OS가 비울 수 있는 자리가 맞다
    ///     — 번들 fallback이 항상 있으므로 캐시가 사라져도 번역 공백은 생기지 않는다.
    public init(baseURL: URL, project: String, cacheDirectory: URL? = nil, session: URLSession = .shared) {
        self.projectURL = baseURL.appendingPathComponent(project, isDirectory: true)
        let root = cacheDirectory
            ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        self.cacheDir = root.appendingPathComponent("rynl10n", isDirectory: true)
            .appendingPathComponent(project, isDirectory: true)
        self.session = session
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
    }

    // MARK: - DeliveryStore (동기 — 캐시만 조회, 네트워크 접근 없음)

    public func snapshot(_ path: String) -> Snapshot? {
        lock.lock()
        if let hit = snapshotCache[path] { lock.unlock(); return hit }
        lock.unlock()
        guard let decoded: Snapshot = decodeCached(path) else { return nil }
        lock.lock(); snapshotCache[path] = decoded; lock.unlock()
        return decoded
    }

    public func delta(_ path: String) -> Delta? {
        lock.lock()
        if let hit = deltaCache[path] { lock.unlock(); return hit }
        lock.unlock()
        guard let decoded: Delta = decodeCached(path) else { return nil }
        lock.lock(); deltaCache[path] = decoded; lock.unlock()
        return decoded
    }

    private func decodeCached<T: Decodable>(_ path: String) -> T? {
        guard let data = try? Data(contentsOf: fileURL(for: path)) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    // MARK: - 갱신 사이클 (6.4)

    /// manifest 조회 → 내 앱 버전에 맞는 릴리스 선택 → 필요한 산출물만 내려받기 → 원자적 스왑.
    ///
    /// 릴리스 선택은 **클라이언트가 정적 manifest만으로** 수행한다(서버 라우팅 없음, 4.3).
    /// 반환값은 카탈로그가 실제로 바뀌었는지 여부다. 네트워크 실패는 던지지 않고 마지막 캐시로 진행하며,
    /// 캐시조차 없으면 `DeliveryError.unavailable`을 던진다 — 어느 경우든 화면의 번역은 깨지지 않는다
    /// (번들 fallback이 항상 살아 있다).
    ///
    /// 호출 시점은 앱 시작 직후와 포그라운드 복귀가 기본이다(README 참조).
    @discardableResult
    public func update(_ client: RynL10nClient) async throws -> Bool {
        let manifest = try await loadManifest()

        switch Matching.selectRelease(manifest.releases, client.clientContext) {
        case .bundleOnly:
            break // 매칭 릴리스 없음 → 번들만. 내려받을 산출물이 없다.
        case .matched(let release), .nearestLower(let release):
            // 활성 번들과 base가 같으면 스냅샷은 이미 손에 있다(빌드타임에 구운 것) → 받지 않는다.
            if release.base != client.status().activeBase {
                try await fetchSnapshot(release.snapshot)
            }
            // 델타는 sparse라 작다. 카나리 미대상이면 refresh가 무시하므로 실패해도 그냥 진행한다.
            if let deltaPath = release.delta, release.overlay != release.base {
                try? await fetchDelta(deltaPath)
            }
        }

        // 스왑과 리스너 통지는 메인에서 — SwiftUI 바인딩(RynL10nObservable)이 여기에 붙는다.
        return await MainActor.run { client.refresh(manifest: manifest) }
    }

    // MARK: - 주기 폴링

    /// 주기 폴링 시작(기본 60초). 즉시 한 번 갱신한 뒤 간격마다 반복한다.
    ///
    /// 실패는 삼킨다 — 실패 = 이전 상태 유지이고 다음 주기에 다시 시도하면 되기 때문이다.
    /// 앱이 `update(_:)`를 직접 부르는 것(앱 시작·포그라운드 복귀)과 배타적이지 않다:
    /// 산출물은 내용해시 URL이라 이미 가진 것은 다시 받지 않고, manifest는 ETag로 재검증된다.
    ///
    /// 배터리·트래픽은 **호출자가 정한다** — 백그라운드 전환 때 `stopPolling()`, 복귀 때 다시 `startPolling`이
    /// 기본 패턴이다(README 4-c). SDK가 앱 생명주기를 가로채지 않는다.
    /// - Parameter onUpdate: 사이클마다 호출(카탈로그가 실제로 바뀌었으면 true). 메인 액터 보장은 없다 —
    ///   UI 갱신은 `RynL10nObservable`이 `onCatalogUpdated`로 처리한다.
    public func startPolling(_ client: RynL10nClient, interval: TimeInterval = 60,
                             onUpdate: (@Sendable (Bool) -> Void)? = nil) {
        stopPolling()
        let started = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let changed = (try? await self.update(client)) ?? false
                if Task.isCancelled { return } // stopPolling 직후 콜백이 한 번 더 나가지 않게
                onUpdate?(changed)
                do { try await Task.sleep(nanoseconds: UInt64(max(interval, 0.001) * 1_000_000_000)) } catch { return }
            }
        }
        setPollTask(started)
    }

    /// 폴링 중단(백그라운드 전환·로그아웃). 진행 중인 사이클은 취소되며, 이미 적용된 카탈로그는 그대로 남는다.
    public func stopPolling() {
        lock.lock(); let running = pollTask; pollTask = nil; lock.unlock()
        running?.cancel()
    }

    // NSLock의 lock()/unlock()은 async 컨텍스트에서 직접 호출할 수 없다(Swift 6) → 동기 헬퍼로 감싼다.
    private func setPollTask(_ new: Task<Void, Never>) {
        lock.lock(); pollTask = new; lock.unlock()
    }

    /// manifest 조회(짧은 TTL + ETag 재검증, 7.2). 네트워크 실패·304면 캐시본을 쓴다.
    public func loadManifest() async throws -> Manifest {
        let url = projectURL.appendingPathComponent("manifest.json")
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData // 재검증은 ETag로 직접 한다.
        // 304를 받아도 되돌릴 캐시본이 실제로 있을 때만 조건부 요청을 보낸다
        // (ETag만 남고 본문 캐시가 사라진 상태에서 304가 오면 복원할 것이 없다).
        if cachedManifest() != nil, let etag = try? String(contentsOf: etagURL, encoding: .utf8) {
            request.setValue(etag, forHTTPHeaderField: "if-none-match")
        }

        do {
            let (data, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            switch status {
            case 200:
                guard let manifest = try? JSONDecoder().decode(Manifest.self, from: data) else {
                    throw DeliveryError.malformed(path: "manifest.json")
                }
                try? data.write(to: manifestURL, options: .atomic)
                if let etag = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "etag") {
                    try? etag.write(to: etagURL, atomically: true, encoding: .utf8)
                }
                return manifest
            case 304:
                guard let manifest = cachedManifest() else { throw DeliveryError.malformed(path: "manifest.json") }
                return manifest
            default:
                // 서버가 살아 있으나 응답이 이상함 → 캐시가 있으면 캐시로 진행.
                if let manifest = cachedManifest() { return manifest }
                throw DeliveryError.badStatus(status, path: "manifest.json")
            }
        } catch let error as DeliveryError {
            throw error
        } catch {
            // 오프라인·타임아웃 — 마지막으로 성공한 manifest로 진행한다.
            if let manifest = cachedManifest() { return manifest }
            throw DeliveryError.unavailable(path: "manifest.json", underlying: error)
        }
    }

    /// 스냅샷 내려받기(불변 → 이미 캐시에 있으면 네트워크를 타지 않는다).
    @discardableResult
    public func fetchSnapshot(_ path: String) async throws -> Snapshot {
        if let hit = snapshot(path) { return hit }
        let data = try await download(path)
        guard let decoded = try? JSONDecoder().decode(Snapshot.self, from: data) else {
            throw DeliveryError.malformed(path: path)
        }
        try? data.write(to: fileURL(for: path), options: .atomic)
        memoize(snapshot: decoded, for: path)
        return decoded
    }

    /// 델타 내려받기(불변 → 이미 캐시에 있으면 네트워크를 타지 않는다).
    @discardableResult
    public func fetchDelta(_ path: String) async throws -> Delta {
        if let hit = delta(path) { return hit }
        let data = try await download(path)
        guard let decoded = try? JSONDecoder().decode(Delta.self, from: data) else {
            throw DeliveryError.malformed(path: path)
        }
        try? data.write(to: fileURL(for: path), options: .atomic)
        memoize(delta: decoded, for: path)
        return decoded
    }

    // NSLock의 lock()/unlock()은 async 컨텍스트에서 직접 호출할 수 없다(Swift 6) → 동기 헬퍼로 감싼다.
    private func memoize(snapshot: Snapshot, for path: String) {
        lock.lock(); snapshotCache[path] = snapshot; lock.unlock()
    }
    private func memoize(delta: Delta, for path: String) {
        lock.lock(); deltaCache[path] = delta; lock.unlock()
    }

    private func download(_ path: String) async throws -> Data {
        let url = projectURL.appendingPathComponent(path)
        do {
            let (data, response) = try await session.data(from: url)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard status == 200 else { throw DeliveryError.badStatus(status, path: path) }
            return data
        } catch let error as DeliveryError {
            throw error
        } catch {
            throw DeliveryError.unavailable(path: path, underlying: error)
        }
    }

    // MARK: - 디스크 캐시

    private var manifestURL: URL { cacheDir.appendingPathComponent("manifest.json") }
    private var etagURL: URL { cacheDir.appendingPathComponent("manifest.etag") }

    private func cachedManifest() -> Manifest? {
        guard let data = try? Data(contentsOf: manifestURL) else { return nil }
        return try? JSONDecoder().decode(Manifest.self, from: data)
    }

    /// 산출물 경로(`releases/R1/snapshot-<hash>.json`)를 평평한 캐시 파일명으로. 내용해시가 들어 있어 충돌하지 않는다.
    private func fileURL(for path: String) -> URL {
        cacheDir.appendingPathComponent(path.replacingOccurrences(of: "/", with: "_"))
    }

    deinit { pollTask?.cancel() }

    /// 캐시 비우기(로그아웃·프로젝트 전환 등). 번들 fallback은 그대로라 번역 공백은 생기지 않는다.
    public func clearCache() {
        lock.lock(); snapshotCache.removeAll(); deltaCache.removeAll(); lock.unlock()
        try? FileManager.default.removeItem(at: cacheDir)
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
    }
}
