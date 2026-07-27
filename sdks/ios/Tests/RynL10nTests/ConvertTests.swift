import Foundation
import XCTest
@testable import RynL10n

/// iOS .xcstrings 변환 정합성 — fixtures/golden/convert.json (기획서 5.3).
/// JSON 정형화(들여쓰기·키 순서)는 언어별로 다르므로 **구조(JSONValue)** 로 비교한다.
final class ConvertTests: XCTestCase {
    struct File: Decodable {
        let snapshot: Snapshot
        let xcstrings: JSONValue
        let descriptions: [String: String]
        let xcstringsWithDescriptions: JSONValue
    }

    func testXcstringsStructure() throws {
        let f = try Golden.load("convert.json", as: File.self)
        let produced = Convert.toXcstrings(f.snapshot)
        XCTAssertEqual(produced, f.xcstrings, "xcstrings 구조가 참조와 일치해야 한다")
    }

    /// 키 설명(5.1) → .xcstrings 표준 `comment` 필드. 참조 구현과 바이트 정합(골든 계약).
    func testXcstringsWithDescriptions() throws {
        let f = try Golden.load("convert.json", as: File.self)
        let produced = Convert.toXcstrings(f.snapshot, descriptions: f.descriptions)
        XCTAssertEqual(produced, f.xcstringsWithDescriptions, "설명 주입 시 comment 포함 구조가 참조와 일치해야 한다")
    }

    /// 설명을 주지 않으면 산출물은 설명 도입 이전과 동일해야 한다(하위호환).
    func testXcstringsWithoutDescriptionsIsUnchanged() throws {
        let f = try Golden.load("convert.json", as: File.self)
        XCTAssertEqual(Convert.toXcstrings(f.snapshot, descriptions: [:]), f.xcstrings)
    }
}
