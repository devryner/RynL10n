import Foundation
import XCTest
import Combine
@testable import RynL10n

/// SwiftUI 바인딩 검증 — 카탈로그 갱신 시 version 증가 + objectWillChange 발화.
final class ObservableTests: XCTestCase {
    func testVersionBumpsOnUpdate() {
        let bundle = Snapshot(schemaVersion: 1, release: "R1", base: "b0", defaultLocale: "en", locales: ["en": ["greet": .text("Hello")]])
        let store = InMemoryDeliveryStore()
        store.put(delta: Delta(schemaVersion: 1, release: "R1", from: "b0", to: "b1", ops: [DeltaOp(op: "set", key: "greet", locale: "en", value: .text("Hi"))]),
                  at: "releases/R1/delta-b0-b1.json")
        let manifest = Manifest(schemaVersion: 1, project: "p", defaultLocale: "en", updatedAt: "T", releases: [
            ManifestRelease(id: "R1", state: .published, versionMatch: VersionMatch(strategy: "semver-range", value: ">=1.0.0"),
                            base: "b0", overlay: "b1", rollout: 100, snapshot: "releases/R1/snapshot-b0.json", delta: "releases/R1/delta-b0-b1.json")])

        let obs = RynL10nObservable(client: RynL10nClient(bundle: bundle, store: store, context: .init(appVersion: "1.0.0")))
        var willChangeCount = 0
        let c = obs.objectWillChange.sink { willChangeCount += 1 }

        XCTAssertEqual(obs.version, 0)
        XCTAssertEqual(obs.t("greet"), "Hello")
        obs.refresh(manifest: manifest)
        XCTAssertEqual(obs.version, 1)           // 카탈로그 갱신 → version 증가
        XCTAssertGreaterThanOrEqual(willChangeCount, 1) // SwiftUI 리렌더 신호
        XCTAssertEqual(obs.t("greet"), "Hi")
        c.cancel()
    }
}
