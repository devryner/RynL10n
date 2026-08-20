import Foundation
import XCTest
@testable import RynL10n

/// 주기 폴링(6.4) · 실시간 푸시 신호(4.1/M4) · 익명 집계 텔레메트리 전송(9.3) 검증.
/// 네트워크는 `RemoteDeliveryTests`의 `StubURLProtocol`로 가로챈다(실제 서버 불필요).
final class PushTelemetryTests: XCTestCase {

    private let bundleJSON = """
    {"schemaVersion":1,"release":"R42","base":"b0","defaultLocale":"en",
     "locales":{"en":{"pay.button":"Pay"}}}
    """

    private let manifestJSON = """
    {"schemaVersion":1,"project":"demo","defaultLocale":"en","updatedAt":"2026-08-20T00:00:00Z",
     "releases":[{"id":"R42","state":"published",
                  "versionMatch":{"strategy":"semver-range","value":">=1.0.0 <2.0.0"},
                  "base":"b0","overlay":"b0","rollout":100,
                  "snapshot":"releases/R42/snapshot-b0.json","delta":null}]}
    """

    private var tempDir: URL!

    override func setUp() {
        super.setUp()
        tempDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("rynl10n-push-\(UUID().uuidString)")
        StubURLProtocol.registry.reset()
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDir)
        StubURLProtocol.registry.reset()
        super.tearDown()
    }

    private func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: config)
    }

    private func makeBundle() throws -> Snapshot {
        try JSONDecoder().decode(Snapshot.self, from: Data(bundleJSON.utf8))
    }

    // MARK: - 주기 폴링

    func testStartPolling_주기마다_갱신하고_stop이_확실히_멈춘다() async throws {
        StubURLProtocol.registry.set("/demo/manifest.json", body: manifestJSON)
        let store = RemoteDeliveryStore(baseURL: URL(string: "https://cdn.test")!, project: "demo",
                                        cacheDirectory: tempDir, session: makeSession())
        let client = RynL10nClient(bundle: try makeBundle(), store: store, context: .init(appVersion: "1.2.0"))

        let cycles = expectation(description: "폴링 사이클 2회")
        cycles.expectedFulfillmentCount = 2
        store.startPolling(client, interval: 0.05) { _ in cycles.fulfill() }
        await fulfillment(of: [cycles], timeout: 5)

        store.stopPolling()
        let afterStop = StubURLProtocol.registry.requestCount("/demo/manifest.json")
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(StubURLProtocol.registry.requestCount("/demo/manifest.json"), afterStop,
                       "stopPolling 이후에는 요청이 더 나가면 안 된다")
        XCTAssertGreaterThanOrEqual(afterStop, 2)
        XCTAssertEqual(client.status().releaseId, "R42", "폴링이 실제 갱신 사이클을 돌린다")
    }

    // MARK: - 실시간 푸시 신호(SSE)

    func testServerPush_manifest_프레임만_신호로_센다() async throws {
        // 알림 플레인이 내려주는 프레임 그대로 — 모르는 이벤트는 무시돼야 한다.
        let sse = """
        retry: 3000

        event: manifest
        data: {"seq":1}

        event: something-else
        data: {}

        event: manifest
        data: {"seq":2}


        """
        StubURLProtocol.registry.set("/projects/demo/events", body: sse, contentType: "text/event-stream")
        let channel = ServerPushChannel(endpoint: URL(string: "https://admin.test")!, project: "demo",
                                        session: makeSession())

        let counter = Counter()
        let signals = try await channel.receive { await counter.bump() }
        XCTAssertEqual(signals, 2)
        let observed = await counter.value
        XCTAssertEqual(observed, 2, "manifest 프레임 수만큼 갱신이 트리거돼야 한다")
    }

    func testServerPush_신호를_받으면_배포_플레인에서_갱신한다() async throws {
        StubURLProtocol.registry.set("/demo/manifest.json", body: manifestJSON)
        StubURLProtocol.registry.set("/projects/demo/events",
                                     body: "event: manifest\ndata: {\"seq\":1}\n\n",
                                     contentType: "text/event-stream")
        let store = RemoteDeliveryStore(baseURL: URL(string: "https://cdn.test")!, project: "demo",
                                        cacheDirectory: tempDir, session: makeSession())
        let client = RynL10nClient(bundle: try makeBundle(), store: store, context: .init(appVersion: "1.2.0"))
        let channel = ServerPushChannel(endpoint: URL(string: "https://admin.test")!, project: "demo",
                                        session: makeSession())

        try await channel.receive { try? await store.update(client) }

        XCTAssertEqual(client.status().releaseId, "R42")
        // 신호 자체는 데이터를 나르지 않는다 — 번역은 배포 플레인에서 받아 온다(4.1).
        XCTAssertTrue(StubURLProtocol.registry.requested.contains("/demo/manifest.json"))
    }

    func testServerPush_알림_플레인이_없으면_badStatus를_던진다() async {
        let channel = ServerPushChannel(endpoint: URL(string: "https://admin.test")!, project: "demo",
                                        session: makeSession())
        do {
            _ = try await channel.receive { }
            XCTFail("404면 던져야 한다")
        } catch let error as ServerPushChannel.PushError {
            guard case .badStatus(404) = error else { return XCTFail("badStatus(404) 여야 함: \(error)") }
        } catch {
            XCTFail("PushError 여야 함: \(error)")
        }
    }

    // MARK: - 텔레메트리 전송(9.3)

    /// 릴리스가 정해진 클라이언트 + 미해결 키 1건.
    private func makeReportingClient() throws -> RynL10nClient {
        let client = RynL10nClient(bundle: try makeBundle(), store: InMemoryDeliveryStore(),
                                   context: .init(appVersion: "1.2.3"), telemetry: "aggregate")
        let manifest = try JSONDecoder().decode(Manifest.self, from: Data(manifestJSON.utf8))
        client.refresh(manifest: manifest)
        _ = client.t("missing.key")
        return client
    }

    func testTelemetryReporter_익명_집계만_5개_필드로_올린다() async throws {
        StubURLProtocol.registry.set("/projects/demo/telemetry", body: #"{"accepted":1,"rejected":0}"#)
        let client = try makeReportingClient()
        let reporter = TelemetryReporter(endpoint: URL(string: "https://admin.test")!, project: "demo",
                                         session: makeSession())

        let ok = await reporter.flush(client)
        XCTAssertTrue(ok)

        let bodies = StubURLProtocol.registry.postedBodies("/projects/demo/telemetry")
        XCTAssertEqual(bodies.count, 1)
        let batch = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(bodies[0].utf8)) as? [[String: Any]])
        XCTAssertEqual(batch.count, 1, "0인 이벤트는 보내지 않는다")
        let event = batch[0]
        XCTAssertEqual(Set(event.keys), ["projectId", "releaseId", "event", "count", "appVersionBucket"],
                       "서버의 프라이버시 가드가 거부하는 필드가 하나라도 있으면 배치 전체가 버려진다")
        XCTAssertEqual(event["event"] as? String, "key_unresolved")
        XCTAssertEqual(event["count"] as? Int, 1)
        XCTAssertEqual(event["releaseId"] as? String, "R42")
        XCTAssertEqual(event["appVersionBucket"] as? String, "1.2", "개별 빌드가 아니라 버전군이어야 익명이다")
        // 키 이름("missing.key")·번역 값은 어디에도 실리지 않는다.
        XCTAssertFalse(bodies[0].contains("missing.key"))

        XCTAssertEqual(client.drainTelemetry(), RynL10nClient.TelemetryCounts(), "성공하면 카운트는 비워진다")
    }

    func testTelemetryReporter_전송_실패면_카운트를_되돌린다() async throws {
        StubURLProtocol.registry.failEverything = true
        let client = try makeReportingClient()
        let reporter = TelemetryReporter(endpoint: URL(string: "https://admin.test")!, project: "demo",
                                         session: makeSession())

        let ok = await reporter.flush(client)
        XCTAssertFalse(ok)
        XCTAssertEqual(client.drainTelemetry().keyUnresolved, 1,
                       "실패 구간이 사라지면 카나리 판정(8.4)이 실제보다 건강해 보인다")
    }

    func testTelemetryReporter_5xx도_되돌린다() async throws {
        StubURLProtocol.registry.set("/projects/demo/telemetry", body: "{}", status: 500)
        let client = try makeReportingClient()
        let reporter = TelemetryReporter(endpoint: URL(string: "https://admin.test")!, project: "demo",
                                         session: makeSession())
        let ok = await reporter.flush(client)
        XCTAssertFalse(ok)
        XCTAssertEqual(client.drainTelemetry().keyUnresolved, 1)
    }

    func testTelemetryReporter_릴리스가_없으면_드레인하지_않는다() async throws {
        // 번들만 쓰는 상태(매칭 릴리스 없음) → 귀속시킬 릴리스가 없다.
        let client = RynL10nClient(bundle: try makeBundle(), store: InMemoryDeliveryStore(),
                                   context: .init(appVersion: "9.9.9"), telemetry: "aggregate")
        _ = client.t("missing.key")
        let reporter = TelemetryReporter(endpoint: URL(string: "https://admin.test")!, project: "demo",
                                         session: makeSession())

        let ok = await reporter.flush(client)
        XCTAssertTrue(ok)
        XCTAssertTrue(StubURLProtocol.registry.postedBodies("/projects/demo/telemetry").isEmpty)
        XCTAssertEqual(client.drainTelemetry().keyUnresolved, 1, "다음 기회에 릴리스와 함께 나가야 한다")
    }

    func testTelemetry_수집이_off면_보낼_것이_없다() async throws {
        StubURLProtocol.registry.set("/projects/demo/telemetry", body: #"{"accepted":0,"rejected":0}"#)
        let client = RynL10nClient(bundle: try makeBundle(), store: InMemoryDeliveryStore(),
                                   context: .init(appVersion: "1.2.3")) // 기본 telemetry: "off"
        let manifest = try JSONDecoder().decode(Manifest.self, from: Data(manifestJSON.utf8))
        client.refresh(manifest: manifest)
        _ = client.t("missing.key")

        let reporter = TelemetryReporter(endpoint: URL(string: "https://admin.test")!, project: "demo",
                                         session: makeSession())
        let ok = await reporter.flush(client)
        XCTAssertTrue(ok)
        XCTAssertTrue(StubURLProtocol.registry.postedBodies("/projects/demo/telemetry").isEmpty,
                      "옵트인이 아니면 네트워크로 아무것도 나가지 않는다")
    }

    func testVersionBucket() {
        XCTAssertEqual(TelemetryReporter.versionBucket("3.2.1"), "3.2")
        XCTAssertEqual(TelemetryReporter.versionBucket("3.2.1-beta.4"), "3.2")
        XCTAssertEqual(TelemetryReporter.versionBucket("4"), "4")
        XCTAssertEqual(TelemetryReporter.versionBucket(nil), "unknown")
        XCTAssertEqual(TelemetryReporter.versionBucket(""), "unknown")
    }
}

/// async 클로저에서 안전하게 세는 카운터.
private actor Counter {
    private(set) var value = 0
    func bump() { value += 1 }
}
