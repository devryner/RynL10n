import Foundation
import XCTest
@testable import RynL10n

/// M4 코어 파리티 — 카나리(8.4)·정수 매칭·텔레메트리. fixtures/golden/canary.json·intrange.json.
final class M4Tests: XCTestCase {
    func testCanaryGolden() throws {
        struct Bucket: Decodable { let installId: String; let releaseId: String; let bucket: Int }
        struct Roll: Decodable { let rollout: Int; let installId: String?; let releaseId: String; let expected: Bool }
        struct File: Decodable { let buckets: [Bucket]; let inRollout: [Roll] }
        let f = try Golden.load("canary.json", as: File.self)
        for b in f.buckets {
            XCTAssertEqual(Canary.bucket(installId: b.installId, releaseId: b.releaseId), b.bucket, "\(b.installId)/\(b.releaseId)")
        }
        for r in f.inRollout {
            XCTAssertEqual(Canary.inRollout(r.rollout, installId: r.installId, releaseId: r.releaseId), r.expected)
        }
    }

    func testIntRangeGolden() throws {
        struct Sat: Decodable { let n: Int; let range: String; let expected: Bool }
        struct Rej: Decodable { let range: String; let expectedThrow: Bool }
        struct File: Decodable { let satisfies: [Sat]; let reject: [Rej] }
        let f = try Golden.load("intrange.json", as: File.self)
        for c in f.satisfies { XCTAssertEqual(IntRange.inRange(c.n, c.range), c.expected, "\(c.n) in \(c.range)") }
        for c in f.reject where c.expectedThrow { XCTAssertThrowsError(try IntRange.parse(c.range), c.range) }
    }

    func testIntegerRouting() {
        func rel(_ id: String, _ value: String) -> ManifestRelease {
            ManifestRelease(id: id, state: .published, versionMatch: VersionMatch(strategy: "integer-range", value: value),
                            base: id, overlay: id, rollout: 100, snapshot: "s", delta: nil)
        }
        let releases = [rel("B1", ">=42 <50"), rel("B2", ">=50")]
        XCTAssertEqual(Matching.selectRelease(releases, .init(buildNumber: 45)).releaseId, "B1")
        XCTAssertEqual(Matching.selectRelease(releases, .init(buildNumber: 60)).releaseId, "B2")
    }

    func testCanaryGateAndTelemetry() {
        let bundle = Snapshot(schemaVersion: 1, release: "R1", base: "b0", defaultLocale: "en", locales: ["en": ["greet": .text("old")]])
        let store = InMemoryDeliveryStore()
        store.put(delta: Delta(schemaVersion: 1, release: "R1", from: "b0", to: "b1", ops: [DeltaOp(op: "set", key: "greet", locale: "en", value: .text("new"))]),
                  at: "releases/R1/delta-b0-b1.json")
        func manifest(_ rollout: Int) -> Manifest {
            Manifest(schemaVersion: 1, project: "p", defaultLocale: "en", updatedAt: "T", releases: [
                ManifestRelease(id: "R1", state: .published, versionMatch: VersionMatch(strategy: "semver-range", value: ">=1.0.0"),
                                base: "b0", overlay: "b1", rollout: rollout, snapshot: "releases/R1/snapshot-b0.json", delta: "releases/R1/delta-b0-b1.json")])
        }
        // rollout 0 → 미수신
        let c0 = RynL10nClient(bundle: bundle, store: store, context: .init(appVersion: "1.0.0"), installId: "x", telemetry: "aggregate")
        c0.refresh(manifest: manifest(0))
        XCTAssertEqual(c0.t("greet"), "old")
        // rollout 100 → 수신 + overlay_applied 텔레메트리
        let c1 = RynL10nClient(bundle: bundle, store: store, context: .init(appVersion: "1.0.0"), installId: "x", telemetry: "aggregate")
        c1.refresh(manifest: manifest(100))
        XCTAssertEqual(c1.t("greet"), "new")
        _ = c1.t("missing.key")
        let tel = c1.drainTelemetry()
        XCTAssertEqual(tel.overlayApplied, 1)
        XCTAssertEqual(tel.releaseApplied, 1)
        XCTAssertEqual(tel.keyUnresolved, 1)

        // rollout 밖이라 오버레이를 못 받은 기기도 그 릴리스의 base를 쓰고 있다.
        let tel0 = c0.drainTelemetry()
        XCTAssertEqual(tel0.releaseApplied, 1)
        XCTAssertEqual(tel0.overlayApplied, 0)
    }

    /// 한 번만 게시한 릴리스(overlay == base)에는 delta가 없어 overlayApplied가 영영 0이다.
    /// 그 침묵을 "안 쓰인다"로 읽으면 쓰이는 릴리스를 보관 후보로 올리게 된다.
    func testDeltaLessReleaseStillReportsApplied() {
        let bundle = Snapshot(schemaVersion: 1, release: "R1", base: "b0", defaultLocale: "en", locales: ["en": ["greet": .text("old")]])
        let manifest = Manifest(schemaVersion: 1, project: "p", defaultLocale: "en", updatedAt: "T", releases: [
            ManifestRelease(id: "R1", state: .published, versionMatch: VersionMatch(strategy: "semver-range", value: ">=1.0.0"),
                            base: "b0", overlay: "b0", rollout: 100, snapshot: "releases/R1/snapshot-b0.json", delta: nil)])
        let c = RynL10nClient(bundle: bundle, store: InMemoryDeliveryStore(), context: .init(appVersion: "1.0.0"), telemetry: "aggregate")
        XCTAssertTrue(c.refresh(manifest: manifest))

        let tel = c.drainTelemetry()
        XCTAssertEqual(tel.releaseApplied, 1)
        XCTAssertEqual(tel.overlayApplied, 0)
    }
}
