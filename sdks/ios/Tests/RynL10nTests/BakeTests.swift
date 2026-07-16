import Foundation
import XCTest
@testable import RynL10n

/// bake 코어 정합성 — fixtures/golden/bake.json (기획서 3.2/6.3).
final class BakeTests: XCTestCase {
    struct GapJ: Decodable { let key: String; let presentIn: [String] }
    struct Case: Decodable {
        let name: String; let snapshot: Snapshot; let coverageGaps: [GapJ]
        let baseOk: Bool; let lockfileText: String; let bundle: String; let expectedBase: String?
    }
    struct File: Decodable { let cases: [Case] }

    func testBakeGolden() throws {
        let f = try Golden.load("bake.json", as: File.self)
        for c in f.cases {
            let gaps = Bake.baseLocaleCoverage(c.snapshot)
            XCTAssertEqual(gaps.count, c.coverageGaps.count, "gap count: \(c.name)")
            for (g, e) in zip(gaps, c.coverageGaps) {
                XCTAssertEqual(g.key, e.key, "gap key: \(c.name)")
                XCTAssertEqual(g.presentIn, e.presentIn, "gap presentIn: \(c.name)")
            }
            let base = Bake.verifyBase(c.snapshot)
            XCTAssertEqual(base.ok, c.baseOk, "baseOk: \(c.name)")
            if let expected = c.expectedBase { XCTAssertEqual(base.expected, expected, "expectedBase: \(c.name)") }
            XCTAssertEqual(Bake.lockfileString(Bake.buildLockfile(c.snapshot)), c.lockfileText, "lockfile: \(c.name)")
            XCTAssertEqual(Bake.bundleString(c.snapshot), c.bundle, "bundle: \(c.name)")
        }
    }

    func testStrictThrowsOnGap() throws {
        let f = try Golden.load("bake.json", as: File.self)
        let gapCase = f.cases.first { !$0.coverageGaps.isEmpty }!
        XCTAssertThrowsError(try Bake.run(gapCase.snapshot, strict: true))
        XCTAssertFalse(try Bake.run(gapCase.snapshot, strict: false).warnings.isEmpty)
    }
}
