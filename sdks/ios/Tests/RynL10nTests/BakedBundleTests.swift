import Foundation
import XCTest
@testable import RynL10n

final class BakedBundleTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("rynl10n-\(UUID()).bundle")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("""
        <?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
        <key>CFBundleIdentifier</key><string>com.rynl10n.tests.\(UUID())</string>
        <key>CFBundlePackageType</key><string>BNDL</string></dict></plist>
        """.utf8).write(to: directory.appendingPathComponent("Info.plist"))
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: directory)
    }

    private func snapshot(base: String, release: String = "R42") -> Snapshot {
        Snapshot(schemaVersion: 1, release: release, base: base, defaultLocale: "en", locales: ["en": ["hello": .text(base)]])
    }

    private func write(_ snapshot: Snapshot, stable: Bool = false, lock: Bool = true) throws {
        let name = stable ? "snapshot.json" : "snapshot-\(snapshot.base).json"
        try Data(Bake.bundleString(snapshot).utf8).write(to: directory.appendingPathComponent(name))
        if lock {
            try Data(Bake.lockfileString(Bake.buildLockfile(snapshot)).utf8)
                .write(to: directory.appendingPathComponent("rynl10n.lock"))
        }
    }

    private func bundle() throws -> Bundle { try XCTUnwrap(Bundle(url: directory)) }

    func testLockfileSelectsCurrentHashedBundleAmongOldFiles() throws {
        try write(snapshot(base: "0000000000000000"))
        try write(snapshot(base: "ffffffffffffffff", release: "R43"))

        let loaded = try Snapshot.baked(in: bundle())
        XCTAssertEqual(loaded.base, "ffffffffffffffff")
        XCTAssertEqual(loaded.release, "R43")
    }

    func testLockfileOverridesStaleStableName() throws {
        try write(snapshot(base: "old"), stable: true)
        try write(snapshot(base: "current"))

        XCTAssertEqual(try Snapshot.baked(in: bundle()).base, "current")
    }

    func testMatchingBaseInWrongReleaseIsNotSelected() throws {
        try write(snapshot(base: "same"))
        let lock = Bake.lockfileString(Bake.buildLockfile(snapshot(base: "same", release: "R43")))
        try Data(lock.utf8).write(to: directory.appendingPathComponent("rynl10n.lock"))

        XCTAssertNil(Snapshot.bakedURL(in: try bundle()))
    }

    func testMissingLockedBundleDoesNotFallBackToStaleStableName() throws {
        try write(snapshot(base: "old"), stable: true)
        let lock = Bake.lockfileString(Bake.buildLockfile(snapshot(base: "missing")))
        try Data(lock.utf8).write(to: directory.appendingPathComponent("rynl10n.lock"))

        XCTAssertNil(Snapshot.bakedURL(in: try bundle()))
        XCTAssertThrowsError(try Snapshot.baked(in: bundle()))
    }

    func testMultipleHashedBundlesWithoutLockAreAmbiguous() throws {
        try write(snapshot(base: "old"), lock: false)
        try write(snapshot(base: "new"), lock: false)

        XCTAssertNil(Snapshot.bakedURL(in: try bundle()))
    }

    func testMalformedLockStillAllowsSoleLegacyBundle() throws {
        try write(snapshot(base: "only"), lock: false)
        try Data("{".utf8).write(to: directory.appendingPathComponent("rynl10n.lock"))

        XCTAssertEqual(try Snapshot.baked(in: bundle()).base, "only")
    }

    func testNestedLockfileSelectsAcrossRootAndNestedResources() throws {
        try write(snapshot(base: "stale"), stable: true)
        let nested = directory.appendingPathComponent("rynl10n")
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
        let current = snapshot(base: "current", release: "R43")
        try Data(Bake.bundleString(current).utf8).write(to: nested.appendingPathComponent("snapshot-current.json"))
        try Data(Bake.lockfileString(Bake.buildLockfile(current)).utf8).write(to: nested.appendingPathComponent("rynl10n.lock"))

        let loaded = try Snapshot.baked(in: bundle())
        XCTAssertEqual(loaded.base, "current")
        XCTAssertEqual(loaded.release, "R43")
    }
}
