import Foundation
import XCTest
@testable import RynL10n

/// 배포 플레인 HTTP 참조 구현(`RemoteDeliveryStore`) 검증 — 기획서 4.1 / 6.4 / 7.2.
/// 네트워크는 `URLProtocol` 스텁으로 가로채므로 실제 서버가 필요 없다.
final class RemoteDeliveryTests: XCTestCase {

    // MARK: - 픽스처 (배포 플레인이 실제로 내려주는 정적 파일 그대로)

    private let bundleJSON = """
    {"schemaVersion":1,"release":"R42","base":"base0","defaultLocale":"en",
     "locales":{"en":{"pay.button":"Pay"},"ja":{"pay.button":"支払―"}}}
    """

    /// base가 번들과 다른 릴리스용 스냅샷(스냅샷 다운로드 경로 검증에 쓴다).
    private let remoteSnapshotJSON = """
    {"schemaVersion":1,"release":"R42","base":"base9","defaultLocale":"en",
     "locales":{"en":{"pay.button":"Pay"},"ja":{"pay.button":"支払(원격)"}}}
    """

    private let deltaJSON = """
    {"schemaVersion":1,"release":"R42","from":"base0","to":"base1",
     "ops":[{"op":"set","key":"pay.button","locale":"ja","value":"支払い"}]}
    """

    private func manifestJSON(base: String, overlay: String, delta: String?) -> String {
        let deltaField = delta.map { "\"delta\":\"\($0)\"" } ?? "\"delta\":null"
        return """
        {"schemaVersion":1,"project":"demo","defaultLocale":"en","updatedAt":"2026-07-31T00:00:00Z",
         "releases":[{"id":"R42","state":"published",
                      "versionMatch":{"strategy":"semver-range","value":">=1.0.0 <2.0.0"},
                      "base":"\(base)","overlay":"\(overlay)","rollout":100,
                      "snapshot":"releases/R42/snapshot-\(base).json",\(deltaField)}]}
        """
    }

    // MARK: - 하네스

    private var tempDir: URL!

    override func setUp() {
        super.setUp()
        tempDir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("rynl10n-tests-\(UUID().uuidString)")
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

    private func makeStore(cacheName: String = "cache") -> RemoteDeliveryStore {
        RemoteDeliveryStore(baseURL: URL(string: "https://cdn.example.com")!,
                            project: "demo",
                            cacheDirectory: tempDir.appendingPathComponent(cacheName),
                            session: makeSession())
    }

    private func makeClient(store: DeliveryStore) throws -> RynL10nClient {
        let bundled = try Snapshot.baked(contentsOf: write(bundleJSON, as: "bundle.json"))
        return RynL10nClient(bundle: bundled, store: store,
                             context: .init(appVersion: "1.2.0"))
    }

    private func write(_ text: String, as name: String) -> URL {
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let url = tempDir.appendingPathComponent(name)
        try? Data(text.utf8).write(to: url)
        return url
    }

    // MARK: - 갱신 사이클

    func testUpdate_델타를_받아_오버레이를_적용한다() async throws {
        StubURLProtocol.registry.set("/demo/manifest.json",
                                     body: manifestJSON(base: "base0", overlay: "base1",
                                                        delta: "releases/R42/delta-base0-base1.json"))
        StubURLProtocol.registry.set("/demo/releases/R42/delta-base0-base1.json", body: deltaJSON)

        let store = makeStore()
        let client = try makeClient(store: store)
        XCTAssertEqual(client.t("pay.button", locale: "ja"), "支払―", "갱신 전에는 번들 값")

        let changed = try await store.update(client)

        XCTAssertTrue(changed)
        XCTAssertEqual(client.t("pay.button", locale: "ja"), "支払い", "오버레이가 키 단위로 덮어써야 한다")
        XCTAssertEqual(client.status().releaseId, "R42")
        // base가 번들과 같으므로 스냅샷은 내려받지 않아야 한다(불필요한 트래픽 차단).
        XCTAssertFalse(StubURLProtocol.registry.requested.contains { $0.contains("snapshot") },
                       "번들과 base가 같으면 스냅샷을 받지 않는다")
    }

    func testUpdate_base가_다르면_스냅샷을_내려받는다() async throws {
        StubURLProtocol.registry.set("/demo/manifest.json",
                                     body: manifestJSON(base: "base9", overlay: "base9", delta: nil))
        StubURLProtocol.registry.set("/demo/releases/R42/snapshot-base9.json", body: remoteSnapshotJSON)

        let store = makeStore()
        let client = try makeClient(store: store)

        let changed = try await store.update(client)

        XCTAssertTrue(changed)
        XCTAssertEqual(client.status().activeBase, "base9")
        XCTAssertEqual(client.t("pay.button", locale: "ja"), "支払(원격)")
    }

    func testUpdate_매칭_릴리스가_없으면_번들만_쓰고_아무것도_받지_않는다() async throws {
        // 앱 버전 1.2.0은 >=3.0.0 <4.0.0 에 매칭되지 않는다.
        let manifest = """
        {"schemaVersion":1,"project":"demo","defaultLocale":"en","updatedAt":"2026-07-31T00:00:00Z",
         "releases":[{"id":"R99","state":"published",
                      "versionMatch":{"strategy":"semver-range","value":">=3.0.0 <4.0.0"},
                      "base":"baseX","overlay":"baseY","rollout":100,
                      "snapshot":"releases/R99/snapshot-baseX.json",
                      "delta":"releases/R99/delta-baseX-baseY.json"}]}
        """
        StubURLProtocol.registry.set("/demo/manifest.json", body: manifest)

        let store = makeStore()
        let client = try makeClient(store: store)

        _ = try await store.update(client)

        XCTAssertEqual(client.status().selection, "bundle-only")
        XCTAssertEqual(client.t("pay.button", locale: "ja"), "支払―", "번들 값 유지")
        XCTAssertEqual(StubURLProtocol.registry.requested.filter { $0.contains("releases/") }.count, 0,
                       "매칭 릴리스가 없으면 산출물을 받지 않는다")
    }

    // MARK: - 캐싱 · 오프라인

    func testUpdate_불변_산출물은_두_번_받지_않는다() async throws {
        StubURLProtocol.registry.set("/demo/manifest.json",
                                     body: manifestJSON(base: "base0", overlay: "base1",
                                                        delta: "releases/R42/delta-base0-base1.json"))
        StubURLProtocol.registry.set("/demo/releases/R42/delta-base0-base1.json", body: deltaJSON)

        let store = makeStore()
        let client = try makeClient(store: store)
        _ = try await store.update(client)
        _ = try await store.update(client)

        let deltaHits = StubURLProtocol.registry.requested.filter { $0.contains("delta-") }.count
        XCTAssertEqual(deltaHits, 1, "내용해시 URL은 영구 캐싱 — 재요청하지 않는다")
    }

    func testLoadManifest_ETag_304면_캐시본을_쓴다() async throws {
        StubURLProtocol.registry.set("/demo/manifest.json",
                                     body: manifestJSON(base: "base0", overlay: "base0", delta: nil),
                                     etag: "\"v1\"")
        let store = makeStore()
        _ = try await store.loadManifest()

        // 두 번째 요청부터는 304만 돌려준다 → 캐시본으로 복원되어야 한다.
        StubURLProtocol.registry.setNotModified("/demo/manifest.json")
        let manifest = try await store.loadManifest()

        XCTAssertEqual(manifest.project, "demo")
        XCTAssertEqual(manifest.releases.first?.id, "R42")
        XCTAssertTrue(StubURLProtocol.registry.conditionalRequests.contains("\"v1\""),
                      "저장해둔 ETag로 재검증해야 한다")
    }

    func testUpdate_네트워크가_끊겨도_마지막_캐시로_진행한다() async throws {
        StubURLProtocol.registry.set("/demo/manifest.json",
                                     body: manifestJSON(base: "base0", overlay: "base1",
                                                        delta: "releases/R42/delta-base0-base1.json"))
        StubURLProtocol.registry.set("/demo/releases/R42/delta-base0-base1.json", body: deltaJSON)

        // 1) 온라인에서 한 번 성공 → manifest·델타가 디스크 캐시에 남는다.
        let warm = makeStore()
        _ = try await warm.update(try makeClient(store: warm))

        // 2) 앱 재시작 + 완전 오프라인 (같은 캐시 디렉토리를 쓰는 새 인스턴스).
        StubURLProtocol.registry.failEverything = true
        let cold = makeStore()
        let client = try makeClient(store: cold)
        let changed = try await cold.update(client)

        XCTAssertTrue(changed)
        XCTAssertEqual(client.t("pay.button", locale: "ja"), "支払い",
                       "오프라인이어도 마지막 캐시로 오버레이가 적용된다")
    }

    func testUpdate_캐시도_네트워크도_없으면_unavailable을_던진다() async {
        StubURLProtocol.registry.failEverything = true
        let store = makeStore()

        do {
            _ = try await store.update(try makeClient(store: store))
            XCTFail("에러를 던져야 한다")
        } catch let error as RemoteDeliveryStore.DeliveryError {
            guard case .unavailable = error else { return XCTFail("unavailable 이어야 함: \(error)") }
        } catch {
            XCTFail("DeliveryError 여야 함: \(error)")
        }
    }

    func testUpdate_실패해도_화면의_번역은_깨지지_않는다() async {
        StubURLProtocol.registry.failEverything = true
        let store = makeStore()
        let client = try? makeClient(store: store)
        XCTAssertNotNil(client)

        _ = try? await store.update(client!)

        XCTAssertEqual(client!.t("pay.button", locale: "ja"), "支払―", "번들 fallback은 항상 살아 있다")
        XCTAssertEqual(client!.t("pay.button"), "Pay")
    }

    func testClearCache_이후에는_다시_받는다() async throws {
        StubURLProtocol.registry.set("/demo/manifest.json",
                                     body: manifestJSON(base: "base0", overlay: "base1",
                                                        delta: "releases/R42/delta-base0-base1.json"))
        StubURLProtocol.registry.set("/demo/releases/R42/delta-base0-base1.json", body: deltaJSON)

        let store = makeStore()
        let client = try makeClient(store: store)
        _ = try await store.update(client)
        store.clearCache()
        _ = try await store.update(client)

        XCTAssertEqual(StubURLProtocol.registry.requested.filter { $0.contains("delta-") }.count, 2)
    }

    // MARK: - 번들 로더 (bake 산출물 → 런타임)

    func testBakedSnapshot_번들_리소스에서_로드한다() throws {
        let snapshot = try Snapshot.baked(in: .module)
        XCTAssertEqual(snapshot.release, "R42")
        XCTAssertEqual(snapshot.base, "base0")
        XCTAssertEqual(snapshot.locales["ja"]?["pay.button"], .text("支払―"))
    }

    func testBakedLockfile_번들_리소스에서_로드한다() throws {
        let lock = try XCTUnwrap(BakedLockfile.baked(in: .module))
        XCTAssertEqual(lock.release, "R42")
        XCTAssertEqual(lock.base, "base0")
        XCTAssertEqual(lock.locales, ["en", "ja"])
    }

    func testBakedSnapshot_산출물이_없으면_안내_메시지와_함께_실패한다() {
        // 리소스가 없는 번들(Foundation 자신)로 조회 → notFound.
        XCTAssertThrowsError(try Snapshot.baked(in: Bundle(for: NSString.self))) { error in
            guard case Snapshot.BakedError.notFound = error else { return XCTFail("notFound 여야 함: \(error)") }
            XCTAssertTrue("\(error)".contains("RynL10nBakePlugin"), "무엇을 확인해야 하는지 알려줘야 한다")
        }
    }
}

// MARK: - URLProtocol 스텁

/// 스텁 라우팅 테이블. `URLProtocol`은 클래스 메서드에서 상태를 읽어야 해서 잠금으로 보호한 싱글턴을 쓴다.
final class StubRegistry: @unchecked Sendable {
    private struct Route { var body: String; var etag: String?; var notModified: Bool }
    private let lock = NSLock()
    private var routes: [String: Route] = [:]
    private var _requested: [String] = []
    private var _conditional: [String] = []
    private var _failEverything = false

    func reset() {
        lock.lock(); defer { lock.unlock() }
        routes = [:]; _requested = []; _conditional = []; _failEverything = false
    }

    func set(_ path: String, body: String, etag: String? = nil) {
        lock.lock(); defer { lock.unlock() }
        routes[path] = Route(body: body, etag: etag, notModified: false)
    }

    func setNotModified(_ path: String) {
        lock.lock(); defer { lock.unlock() }
        routes[path]?.notModified = true
    }

    var failEverything: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _failEverything }
        set { lock.lock(); _failEverything = newValue; lock.unlock() }
    }

    var requested: [String] { lock.lock(); defer { lock.unlock() }; return _requested }
    var conditionalRequests: [String] { lock.lock(); defer { lock.unlock() }; return _conditional }

    /// 요청 기록 + 응답 결정. nil이면 네트워크 실패로 취급한다.
    fileprivate func handle(path: String, ifNoneMatch: String?) -> (status: Int, body: Data, headers: [String: String])? {
        lock.lock(); defer { lock.unlock() }
        _requested.append(path)
        if let ifNoneMatch { _conditional.append(ifNoneMatch) }
        if _failEverything { return nil }
        guard let route = routes[path] else { return (404, Data(), [:]) }
        if route.notModified { return (304, Data(), [:]) }
        var headers = ["content-type": "application/json"]
        if let etag = route.etag { headers["etag"] = etag }
        return (200, Data(route.body.utf8), headers)
    }
}

final class StubURLProtocol: URLProtocol {
    nonisolated(unsafe) static let registry = StubRegistry()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url?.path ?? ""
        let outcome = StubURLProtocol.registry.handle(path: path,
                                                      ifNoneMatch: request.value(forHTTPHeaderField: "if-none-match"))
        guard let outcome else {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: outcome.status,
                                       httpVersion: "HTTP/1.1", headerFields: outcome.headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if !outcome.body.isEmpty { client?.urlProtocol(self, didLoad: outcome.body) }
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
