import Foundation
import XCTest
@testable import RynL10n

/// DoD ① — 시나리오 A/B/C를 public API(RynL10nClient)로 재현.
final class ScenarioTests: XCTestCase {

    private func snap(_ release: String, _ base: String, _ locales: [String: [String: TranslationValue]]) -> Snapshot {
        Snapshot(schemaVersion: 1, release: release, base: base, defaultLocale: "en", locales: locales)
    }

    func testScenarioA_OTAHotfix() {
        let v0 = snap("R42", "base0", ["en": ["pay.button": .text("Pay")], "ja": ["pay.button": .text("支払―")]])
        let v1 = snap("R42", "base1", ["en": ["pay.button": .text("Pay")], "ja": ["pay.button": .text("支払い")]])
        let delta = Delta(schemaVersion: 1, release: "R42", from: "base0", to: "base1",
                          ops: [DeltaOp(op: "set", key: "pay.button", locale: "ja", value: .text("支払い"))])

        let store = InMemoryDeliveryStore()
        store.put(snapshot: v0, at: "releases/R42/snapshot-base0.json")
        store.put(delta: delta, at: "releases/R42/delta-base0-base1.json")

        let published = ManifestRelease(id: "R42", state: .published,
            versionMatch: VersionMatch(strategy: "semver-range", value: ">=3.2.0 <3.3.0"),
            base: "base0", overlay: "base1", rollout: 100,
            snapshot: "releases/R42/snapshot-base0.json", delta: "releases/R42/delta-base0-base1.json")
        let manifest = Manifest(schemaVersion: 1, project: "shop", defaultLocale: "en", updatedAt: "T1", releases: [published])

        let client = RynL10nClient(bundle: v0, store: store, context: .init(appVersion: "3.2.1"))
        var notified = 0
        client.onCatalogUpdated { _ in notified += 1 }

        XCTAssertEqual(client.t("pay.button", locale: "ja"), "支払―") // 번들 오타
        XCTAssertTrue(client.refresh(manifest: manifest))
        XCTAssertEqual(client.t("pay.button", locale: "ja"), "支払い") // OTA 수정
        XCTAssertEqual(notified, 1)

        // 롤백: overlay 포인터를 base0로 되돌린 manifest 재게시
        let rolledBack = ManifestRelease(id: "R42", state: .published,
            versionMatch: VersionMatch(strategy: "semver-range", value: ">=3.2.0 <3.3.0"),
            base: "base0", overlay: "base0", rollout: 100,
            snapshot: "releases/R42/snapshot-base0.json", delta: nil)
        client.refresh(manifest: Manifest(schemaVersion: 1, project: "shop", defaultLocale: "en", updatedAt: "T2", releases: [rolledBack]))
        XCTAssertEqual(client.t("pay.button", locale: "ja"), "支払―") // 이전 상태 복귀
    }

    func testScenarioB_DeterministicBake() {
        // 같은 카탈로그 → 같은 base 해시(키 순서 무관). 빌드 재현성·lockfile 고정의 근거.
        let a: JSONValue = .object(["en": .object(["greet": .string("Hello")]), "ko": .object(["greet": .string("안녕하세요")])])
        let b: JSONValue = .object(["ko": .object(["greet": .string("안녕하세요")]), "en": .object(["greet": .string("Hello")])])
        let ha = ContentHash.snapshotHash(release: "R1", defaultLocale: "en", locales: a)
        let hb = ContentHash.snapshotHash(release: "R1", defaultLocale: "en", locales: b)
        XCTAssertEqual(ha, hb)
        XCTAssertEqual(ContentHash.fileId(ha).count, 16)
        // NFC: 조합형으로 들어와도 같은 해시
        let decomposed: JSONValue = .object(["en": .object(["greet": .string("Hello")]),
                                             "ko": .object(["greet": .string("안녕하세요".decomposedStringWithCanonicalMapping)])])
        XCTAssertEqual(ContentHash.snapshotHash(release: "R1", defaultLocale: "en", locales: decomposed), ha)
    }

    func testScenarioC_VersionIsolation() {
        let r42 = snap("R42", "r42", ["en": ["home.title": .text("Home")]])
        let r50 = snap("R50", "r50", ["en": ["home.title": .text("Home"), "home.newBadge": .text("NEW")]])
        let store = InMemoryDeliveryStore()
        store.put(snapshot: r42, at: "releases/R42/snapshot-r42.json")
        store.put(snapshot: r50, at: "releases/R50/snapshot-r50.json")

        // R42는 자동 상한 닫힘 후 superseded, R50은 published. 둘 다 서빙.
        let releases = [
            ManifestRelease(id: "R42", state: .superseded,
                versionMatch: VersionMatch(strategy: "semver-range", value: ">=3.2.0 <3.3.0"),
                base: "r42", overlay: "r42", rollout: 100, snapshot: "releases/R42/snapshot-r42.json", delta: nil),
            ManifestRelease(id: "R50", state: .published,
                versionMatch: VersionMatch(strategy: "semver-range", value: ">=3.3.0"),
                base: "r50", overlay: "r50", rollout: 100, snapshot: "releases/R50/snapshot-r50.json", delta: nil),
        ]
        let manifest = Manifest(schemaVersion: 1, project: "app", defaultLocale: "en", updatedAt: "T", releases: releases)

        // 구버전 앱(3.2.5) → R42, 신규 키 미노출(격리)
        let oldApp = RynL10nClient(bundle: r42, store: store, context: .init(appVersion: "3.2.5"))
        oldApp.refresh(manifest: manifest)
        XCTAssertEqual(oldApp.status().releaseId, "R42")
        XCTAssertEqual(oldApp.t("home.title"), "Home")
        XCTAssertEqual(oldApp.t("home.newBadge"), "⟪home.newBadge⟫")

        // 신규 앱(3.3.1) → R50, 신규 키 노출
        let newApp = RynL10nClient(bundle: r50, store: store, context: .init(appVersion: "3.3.1"))
        newApp.refresh(manifest: manifest)
        XCTAssertEqual(newApp.status().releaseId, "R50")
        XCTAssertEqual(newApp.t("home.newBadge"), "NEW")
    }

    func testRangeConflictDetection() {
        let overlapping = [
            Matching.ConflictInput(id: "R42", versionMatch: VersionMatch(strategy: "semver-range", value: ">=3.2.0 <3.4.0")),
            Matching.ConflictInput(id: "R60", versionMatch: VersionMatch(strategy: "semver-range", value: ">=3.3.0 <3.5.0")),
        ]
        XCTAssertEqual(Matching.findRangeConflicts(overlapping).count, 1)
        let adjacent = [
            Matching.ConflictInput(id: "R42", versionMatch: VersionMatch(strategy: "semver-range", value: ">=3.2.0 <3.3.0")),
            Matching.ConflictInput(id: "R50", versionMatch: VersionMatch(strategy: "semver-range", value: ">=3.3.0")),
        ]
        XCTAssertEqual(Matching.findRangeConflicts(adjacent).count, 0)
    }
}
