import Foundation
import XCTest
@testable import RynL10n

/// iOS .xcstrings 변환 정합성 — fixtures/golden/convert.json (기획서 5.3).
/// JSON 정형화(들여쓰기·키 순서)는 언어별로 다르므로 **구조(JSONValue)** 로 비교한다.
final class ConvertTests: XCTestCase {
    struct File: Decodable { let snapshot: Snapshot; let xcstrings: JSONValue }

    func testXcstringsStructure() throws {
        let f = try Golden.load("convert.json", as: File.self)
        let produced = Convert.toXcstrings(f.snapshot)
        XCTAssertEqual(produced, f.xcstrings, "xcstrings 구조가 참조와 일치해야 한다")
    }
}
