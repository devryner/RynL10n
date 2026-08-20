import Foundation

/// 익명 집계 텔레메트리 전송(옵트인) — 기획서 9.3, 카나리 판정(8.4)의 입력.
///
/// 클라이언트가 모으는 것은 4종 카운트뿐이고(`RynL10nClient.TelemetryCounts`), 이 타입은 그것을
/// 관리 플레인의 `POST /projects/{p}/telemetry` 한 곳으로 보낸다. 본문 필드는 서버가 정의한 5개가 전부다
/// (`projectId`·`releaseId`·`event`·`count`·`appVersionBucket`) — **그 외 필드는 서버가 거부하므로**
/// 키 이름·번역 값·기기 식별자는 구조적으로 나갈 수 없다(프라이버시 가드).
/// 카나리 버킷의 `installId`도 여기 포함되지 않는다 — 기기 로컬 값이고 서버에 보내지 않는다(8.4).
///
/// 옵트인 방식은 **이 객체를 만들지 않으면 아무것도 전송되지 않는다**는 것이다. 수집 자체도
/// `RynL10nClient(telemetry: "aggregate")`일 때만 일어난다(기본 `"off"`).
public final class TelemetryReporter: @unchecked Sendable {

    private let url: URL
    private let projectId: String
    private let session: URLSession
    private let lock = NSLock()
    private var task: Task<Void, Never>?

    /// - Parameters:
    ///   - endpoint: 관리 플레인 루트(로컬 셀프호스트는 `http://localhost:8787`).
    ///     읽기 경로가 아니라 **쓰기(집계 업로드) 경로**라 배포 플레인이 아니다.
    ///   - project: 프로젝트 ID.
    public init(endpoint: URL, project: String, session: URLSession = .shared) {
        self.projectId = project
        self.url = endpoint
            .appendingPathComponent("projects", isDirectory: true)
            .appendingPathComponent(project, isDirectory: true)
            .appendingPathComponent("telemetry")
        self.session = session
    }

    /// 서버 스키마(9.3) 그대로의 이벤트 1건. 필드가 더 늘면 서버가 배치를 거부한다.
    struct Event: Encodable {
        let projectId: String
        let releaseId: String
        let event: String
        let count: Int
        let appVersionBucket: String
    }

    /// 누적 카운트를 비우고 한 번 전송한다.
    ///
    /// 전송에 실패하면 드레인한 카운트를 **되돌려** 다음 주기에 다시 시도한다 — 그러지 않으면
    /// 네트워크가 끊긴 구간의 거부율이 통째로 사라져 카나리 판정(8.4)이 실제보다 건강해 보인다.
    /// - Returns: 서버가 수용했으면 true. 보낼 것이 없어도 true(할 일 없음).
    @discardableResult
    public func flush(_ client: RynL10nClient) async -> Bool {
        // 릴리스가 정해지기 전(번들만)에는 귀속시킬 릴리스가 없다 → 드레인하지 않고 다음 기회로 미룬다.
        guard let releaseId = client.status().releaseId else { return true }
        let counts = client.drainTelemetry()
        let events = Self.events(counts, projectId: projectId, releaseId: releaseId,
                                 bucket: Self.versionBucket(client.clientContext.appVersion))
        if events.isEmpty { return true }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        guard let body = try? JSONEncoder().encode(events) else { return true } // 인코딩 불가는 재시도해도 같다
        request.httpBody = body

        do {
            let (_, response) = try await session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                client.mergeTelemetry(counts)
                return false
            }
            return true
        } catch {
            client.mergeTelemetry(counts)
            return false
        }
    }

    /// 주기 전송 시작(기본 5분). 첫 전송은 한 주기 뒤다 — 부팅 직후엔 보낼 것이 거의 없다.
    ///
    /// 백그라운드 전환처럼 마지막 카운트를 확실히 올리고 싶은 시점에는 `await flush(client)`를 직접 부른다.
    public func start(_ client: RynL10nClient, every interval: TimeInterval = 300) {
        stop()
        let started = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: UInt64(max(interval, 0.001) * 1_000_000_000)) } catch { return }
                guard let self, !Task.isCancelled else { return }
                await self.flush(client)
            }
        }
        setTask(started)
    }

    /// 주기 전송 중단. 아직 안 보낸 카운트는 클라이언트에 남아 있다(다음 `flush`에서 함께 나간다).
    public func stop() {
        lock.lock(); let running = task; task = nil; lock.unlock()
        running?.cancel()
    }

    deinit { task?.cancel() }

    private func setTask(_ new: Task<Void, Never>) {
        lock.lock(); task = new; lock.unlock()
    }

    // MARK: - 매핑

    /// 카운트 → 서버 이벤트 배치. 0인 이벤트는 보내지 않는다(빈 행으로 집계를 부풀리지 않기 위해).
    static func events(_ counts: RynL10nClient.TelemetryCounts,
                       projectId: String, releaseId: String, bucket: String) -> [Event] {
        let pairs: [(String, Int)] = [
            ("overlay_applied", counts.overlayApplied),
            ("format_guard_rejected", counts.formatGuardRejected),
            ("key_unresolved", counts.keyUnresolved),
            ("delta_failed", counts.deltaFailed),
        ]
        return pairs.filter { $0.1 > 0 }.map {
            Event(projectId: projectId, releaseId: releaseId, event: $0.0, count: $0.1, appVersionBucket: bucket)
        }
    }

    /// 앱 버전군 라벨(예: `3.2.1` → `3.2`). 개별 빌드가 아니라 **군**이라야 익명 집계로 남는다.
    /// 관측성 탭의 "릴리스 × 앱 버전군" 표가 이 라벨을 그대로 쓴다.
    static func versionBucket(_ appVersion: String?) -> String {
        guard let appVersion, !appVersion.isEmpty else { return "unknown" }
        let parts = appVersion.split(separator: ".")
        guard let major = parts.first else { return "unknown" }
        return parts.count >= 2 ? "\(major).\(parts[1])" : String(major)
    }
}
