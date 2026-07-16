import Foundation
import XCTest
@testable import RynL10n

/// 저장소 루트의 fixtures/golden 을 찾아 골든 벡터 JSON을 디코딩한다.
/// #filePath에서 위로 올라가며 fixtures/golden 디렉토리를 탐색 → 리포 구조 변경에 견고.
enum Golden {
    static func dir() -> URL {
        var url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let fm = FileManager.default
        for _ in 0..<12 {
            let candidate = url.appendingPathComponent("fixtures/golden")
            var isDir: ObjCBool = false
            if fm.fileExists(atPath: candidate.path, isDirectory: &isDir), isDir.boolValue {
                return candidate
            }
            url = url.deletingLastPathComponent()
        }
        fatalError("fixtures/golden 을 찾지 못함")
    }

    static func load<T: Decodable>(_ file: String, as type: T.Type) throws -> T {
        let data = try Data(contentsOf: dir().appendingPathComponent(file))
        return try JSONDecoder().decode(T.self, from: data)
    }
}

/// 골든 벡터가 값을 string | pluralMap | null 로 표현 → TranslationValue? 비교용.
func XCTAssertTranslationEqual(_ a: TranslationValue?, _ b: TranslationValue?,
                               _ msg: String = "", file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(a, b, msg, file: file, line: line)
}
