import Foundation
import CryptoKit

/// RFC 8785 JSON Canonicalization Scheme + 콘텐츠 해시 — 기획서 11.1.
/// M0 TS 참조 구현과 **바이트 단위로 동일**해야 한다(fixtures/golden로 검증).
public enum JCS {
    /// JCS 정규화 문자열. 키는 UTF-16 코드유닛 순 정렬, 문자열은 NFC, 최소 공백.
    public static func canonicalString(_ value: JSONValue) -> String {
        var out = ""
        emit(value, into: &out)
        return out
    }

    /// JCS 정규화 UTF-8 바이트열(해시 입력).
    public static func canonicalBytes(_ value: JSONValue) -> Data {
        Data(canonicalString(value).utf8)
    }

    private static func emit(_ value: JSONValue, into out: inout String) {
        switch value {
        case .null:
            out += "null"
        case .bool(let b):
            out += b ? "true" : "false"
        case .int(let i):
            out += String(i)
        case .double(let d):
            // 도메인 불변식: 산출물 스키마엔 정수만. 정수형 실수는 정수로, 그 외는 실패.
            precondition(d.rounded() == d && d.isFinite, "JCS: 비정수 number는 이 스파이크 범위 밖 (\(d))")
            out += String(Int(d))
        case .string(let s):
            emitString(s, into: &out)
        case .array(let arr):
            out += "["
            for (i, el) in arr.enumerated() {
                if i > 0 { out += "," }
                emit(el, into: &out)
            }
            out += "]"
        case .object(let obj):
            out += "{"
            let keys = obj.keys.sorted(by: utf16Less)
            for (i, k) in keys.enumerated() {
                if i > 0 { out += "," }
                emitString(k, into: &out)
                out += ":"
                emit(obj[k]!, into: &out)
            }
            out += "}"
        }
    }

    /// JS JSON.stringify와 동일한 문자열 이스케이프(= JCS): 짧은 형태 + 소문자 \u00xx, 비ASCII 리터럴.
    private static func emitString(_ s: String, into out: inout String) {
        out += "\""
        for scalar in s.precomposedStringWithCanonicalMapping.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{09}": out += "\\t"
            case "\u{0A}": out += "\\n"
            case "\u{0C}": out += "\\f"
            case "\u{0D}": out += "\\r"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
    }

    /// UTF-16 코드유닛 사전순 비교(JCS 키 정렬).
    private static func utf16Less(_ a: String, _ b: String) -> Bool {
        var ai = a.utf16.makeIterator()
        var bi = b.utf16.makeIterator()
        while true {
            let x = ai.next(), y = bi.next()
            switch (x, y) {
            case (nil, nil): return false
            case (nil, _): return true
            case (_, nil): return false
            case let (xv?, yv?):
                if xv != yv { return xv < yv }
            }
        }
    }
}

/// 콘텐츠 해시 — SHA-256 소문자 hex, 파일 식별자는 앞 16 hex 절단.
public enum ContentHash {
    public static let fileIdHex = 16
    public static let fileIdHexExtended = 20

    public static func sha256Hex(_ value: JSONValue) -> String {
        let digest = SHA256.hash(data: JCS.canonicalBytes(value))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    public static func fileId(_ fullHash: String, taken: Set<String> = []) -> String {
        let short = String(fullHash.prefix(fileIdHex))
        if taken.contains(short) { return String(fullHash.prefix(fileIdHexExtended)) }
        return short
    }

    /// 스냅샷 콘텐츠 해시 — 해시 대상은 {release, defaultLocale, locales}뿐(base·createdAt 제외).
    public static func snapshotHash(release: String, defaultLocale: String, locales: JSONValue) -> String {
        sha256Hex(.object([
            "release": .string(release),
            "defaultLocale": .string(defaultLocale),
            "locales": locales,
        ]))
    }
}
