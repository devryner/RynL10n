import Foundation

/// node-semver 부분집합 — 기획서 11.3.
/// 지원: 비교자 `>= > <= < =` + 공백 AND. 거부: `||`·`^`·`~`·x-range·hyphen-range.
public struct SemVer: Equatable, Sendable {
    public let major: Int
    public let minor: Int
    public let patch: Int
    public let prerelease: [PreId]

    public enum PreId: Equatable, Sendable {
        case num(Int)
        case text(String)
    }

    public var isPrerelease: Bool { !prerelease.isEmpty }
}

public enum SemVerError: Error, Equatable {
    case invalidVersion(String)
    case unsupportedRange(String)
}

public enum SemVerParser {
    public static func parseVersion(_ input: String) throws -> SemVer {
        let trimmed = input.trimmingCharacters(in: .whitespaces)
        // major.minor.patch(-prerelease)?(+build)?
        let pattern = #"^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$"#
        guard let m = firstMatch(trimmed, pattern) else { throw SemVerError.invalidVersion(input) }
        let major = Int(m[1]!)!, minor = Int(m[2]!)!, patch = Int(m[3]!)!
        var pre: [SemVer.PreId] = []
        if let p = m[4], !p.isEmpty {
            pre = p.split(separator: ".").map { id in
                if let n = Int(id), String(n) == id { return .num(n) }
                return .text(String(id))
            }
        }
        return SemVer(major: major, minor: minor, patch: patch, prerelease: pre)
    }

    public static func compare(_ a: SemVer, _ b: SemVer) -> Int {
        if a.major != b.major { return a.major < b.major ? -1 : 1 }
        if a.minor != b.minor { return a.minor < b.minor ? -1 : 1 }
        if a.patch != b.patch { return a.patch < b.patch ? -1 : 1 }
        let ap = a.prerelease, bp = b.prerelease
        if ap.isEmpty && bp.isEmpty { return 0 }
        if ap.isEmpty { return 1 }
        if bp.isEmpty { return -1 }
        for i in 0..<min(ap.count, bp.count) {
            switch (ap[i], bp[i]) {
            case let (.num(x), .num(y)): if x != y { return x < y ? -1 : 1 }
            case (.num, .text): return -1
            case (.text, .num): return 1
            case let (.text(x), .text(y)): if x != y { return x < y ? -1 : 1 }
            }
        }
        if ap.count != bp.count { return ap.count < bp.count ? -1 : 1 }
        return 0
    }

    public enum Op: String { case gte = ">=", lte = "<=", gt = ">", lt = "<", eq = "=" }
    public struct Comparator: Sendable { public let op: String; public let version: SemVer }

    public static func parseRange(_ input: String) throws -> [Comparator] {
        let raw = input.trimmingCharacters(in: .whitespaces)
        if raw.isEmpty { throw SemVerError.unsupportedRange("빈 범위식") }
        for pat in ["||", "^", "~", " - "] where raw.contains(pat) {
            throw SemVerError.unsupportedRange("미지원 범위 문법 \"\(pat)\"")
        }
        let tokens = raw.split(whereSeparator: { $0 == " " }).map(String.init)
        var comparators: [Comparator] = []
        let compPattern = #"^(>=|<=|>|<|=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$"#
        for tok in tokens {
            guard let m = firstMatch(tok, compPattern) else {
                throw SemVerError.unsupportedRange("미지원/유효하지 않은 비교자 \"\(tok)\"")
            }
            let op = m[1] ?? "="
            comparators.append(Comparator(op: op, version: try parseVersion(m[2]!)))
        }
        return comparators
    }

    public static func satisfies(_ version: SemVer, _ comparators: [Comparator], matchPrerelease: Bool = false) -> Bool {
        if version.isPrerelease {
            if !matchPrerelease { return false }
            let tupleMatch = comparators.contains { c in
                c.version.isPrerelease && c.version.major == version.major
                    && c.version.minor == version.minor && c.version.patch == version.patch
            }
            if !tupleMatch { return false }
        }
        return comparators.allSatisfy { c in
            let cmp = compare(version, c.version)
            switch c.op {
            case ">=": return cmp >= 0
            case "<=": return cmp <= 0
            case ">": return cmp > 0
            case "<": return cmp < 0
            default: return cmp == 0
            }
        }
    }

    public static func versionInRange(_ version: String, _ range: String, matchPrerelease: Bool = false) throws -> Bool {
        satisfies(try parseVersion(version), try parseRange(range), matchPrerelease: matchPrerelease)
    }
}

/// 캡처 그룹을 옵셔널 문자열 배열로 반환하는 정규식 헬퍼(0=전체, 1..=그룹).
func firstMatch(_ s: String, _ pattern: String) -> [String?]? {
    guard let re = try? NSRegularExpression(pattern: pattern) else { return nil }
    let range = NSRange(s.startIndex..<s.endIndex, in: s)
    guard let m = re.firstMatch(in: s, range: range) else { return nil }
    var groups: [String?] = []
    for i in 0..<m.numberOfRanges {
        let r = m.range(at: i)
        if r.location == NSNotFound { groups.append(nil) }
        else if let rr = Range(r, in: s) { groups.append(String(s[rr])) }
        else { groups.append(nil) }
    }
    return groups
}
