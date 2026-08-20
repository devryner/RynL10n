import Foundation

/// 실시간 푸시 신호 구독(옵트인) — 기획서 4.1 / 8, M4.
///
/// **데이터 없는 신호만 받는다.** SSE 프레임이 전하는 것은 "manifest가 바뀌었다"는 사실뿐이고,
/// 번역 데이터는 여전히 배포 플레인의 정적 파일에서 내려받는다 → 읽기 데이터 경로는 정적으로 유지된다(4.1).
/// 그래서 이 채널의 엔드포인트는 배포 플레인이 **아니라** 알림(관리) 플레인이며, 끊겨도 기능이 죽지 않는다.
///
/// 폴링(`RemoteDeliveryStore.startPolling`)이 갱신의 보장선이고 이 채널은 **지연 단축용**이다.
/// 연결이 끊기면 백오프 후 스스로 재연결하되, 그 사이 갱신은 폴링이 덮는다.
public final class ServerPushChannel: @unchecked Sendable {

    public enum PushError: Error, Sendable {
        /// 200이 아닌 응답(알림 플레인 미배치·경로 오타 등).
        case badStatus(Int)
        /// 연결 자체가 실패(오프라인·타임아웃).
        case unavailable(underlying: (any Error)?)
    }

    private let eventsURL: URL
    private let session: URLSession
    private let lock = NSLock()
    private var task: Task<Void, Never>?

    /// - Parameters:
    ///   - endpoint: 알림(관리) 플레인 루트. 로컬 셀프호스트는 `http://localhost:8787`.
    ///     배포 플레인과 다른 호스트여도 되고, 지정하지 않으면(=이 타입을 안 쓰면) 폴링만으로 동작한다.
    ///   - project: 프로젝트 ID.
    public init(endpoint: URL, project: String, session: URLSession = .shared) {
        self.eventsURL = endpoint
            .appendingPathComponent("projects", isDirectory: true)
            .appendingPathComponent(project, isDirectory: true)
            .appendingPathComponent("events")
        self.session = session
    }

    /// 연결 하나를 붙잡고 신호를 처리한다. 스트림이 끝나거나 취소되면 반환한다(재연결은 하지 않는다).
    ///
    /// `event: manifest` 프레임만 신호로 센다 — 알림 플레인이 나중에 다른 이벤트를 추가해도
    /// 모르는 프레임은 조용히 무시된다.
    /// - Returns: 처리한 신호 수.
    @discardableResult
    public func receive(onSignal: @escaping @Sendable () async -> Void) async throws -> Int {
        var request = URLRequest(url: eventsURL)
        request.setValue("text/event-stream", forHTTPHeaderField: "accept")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 3600 // 스트림은 오래 열려 있다 — 기본 60초면 매 분 끊긴다.

        let bytes: URLSession.AsyncBytes
        let response: URLResponse
        do {
            (bytes, response) = try await session.bytes(for: request)
        } catch {
            throw PushError.unavailable(underlying: error)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw PushError.badStatus(status) }

        var isManifestFrame = false
        var signals = 0
        // 줄 분해는 직접 한다 — `AsyncLineSequence`는 빈 줄을 내보내지 않아 SSE의 **프레임 경계**가 사라진다.
        var line = [UInt8]()
        for try await byte in bytes {
            guard byte == 0x0A else { line.append(byte); continue }
            if line.last == 0x0D { line.removeLast() } // CRLF
            let text = String(decoding: line, as: UTF8.self)
            line.removeAll(keepingCapacity: true)

            if text.isEmpty {
                // 빈 줄 = 프레임 경계(SSE).
                if isManifestFrame { signals += 1; await onSignal() }
                isManifestFrame = false
            } else if text.hasPrefix("event:") {
                isManifestFrame = text.dropFirst("event:".count).trimmingCharacters(in: .whitespaces) == "manifest"
            }
        }
        // 서버가 프레임 경계(빈 줄) 없이 스트림을 닫은 경우에도 신호는 잃지 않는다.
        if isManifestFrame { signals += 1; await onSignal() }
        return signals
    }

    /// 백그라운드 구독 시작 — 끊기면 백오프(3초 → 최대 60초)로 재연결한다.
    /// 신호를 실제로 받으면 백오프를 초기화한다(일시적 장애 후 빠르게 정상 지연으로 복귀).
    public func start(onSignal: @escaping @Sendable () async -> Void) {
        stop()
        let started = Task { [weak self] in
            var backoff: UInt64 = 3
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    if try await self.receive(onSignal: onSignal) > 0 { backoff = 3 }
                } catch {
                    // 알림 플레인이 없거나 끊김 — 폴링이 안전망이므로 조용히 재시도한다.
                }
                if Task.isCancelled { return }
                do { try await Task.sleep(nanoseconds: backoff * 1_000_000_000) } catch { return }
                backoff = min(backoff * 2, 60)
            }
        }
        setTask(started)
    }

    /// 신호를 받을 때마다 배포 플레인에서 갱신 사이클을 한 번 돌리는 기본 배선.
    public func start(updating client: RynL10nClient, via store: RemoteDeliveryStore) {
        start { try? await store.update(client) }
    }

    /// 구독 중단(백그라운드 전환·로그아웃). 재개는 `start`를 다시 호출하면 된다.
    public func stop() {
        lock.lock(); let running = task; task = nil; lock.unlock()
        running?.cancel()
    }

    deinit { task?.cancel() }

    // NSLock의 lock()/unlock()은 async 컨텍스트에서 직접 호출할 수 없다(Swift 6) → 동기 헬퍼로 감싼다.
    private func setTask(_ new: Task<Void, Never>) {
        lock.lock(); task = new; lock.unlock()
    }
}
