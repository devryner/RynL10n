import Foundation

/// 정수(빌드 넘버) 범위 매칭 — M4. 포함 정수 하한/상한으로 정규화(정확한 인접 판정).
/// semver와 동일한 부분집합 문법. 미지원 문법(`||`·`^`·`~`·범위표기)은 거부.
public enum IntRange {
    public struct Comparator { public let op: String; public let n: Int }
    public struct Interval { public let lower: Int?; public let upper: Int? }

    public enum IntRangeError: Error { case unsupported(String); case invalid(String) }

    public static func parse(_ input: String) throws -> [Comparator] {
        let raw = input.trimmingCharacters(in: .whitespaces)
        if raw.isEmpty { throw IntRangeError.invalid("빈 정수 범위식") }
        for pat in ["||", "^", "~", " - "] where raw.contains(pat) { throw IntRangeError.unsupported(pat) }
        return try raw.split(whereSeparator: { $0 == " " }).map { tok in
            guard let m = firstMatch(String(tok), #"^(>=|<=|>|<|=)?(-?\d+)$"#), let n = Int(m[2]!) else {
                throw IntRangeError.invalid(String(tok))
            }
            return Comparator(op: m[1] ?? "=", n: n)
        }
    }

    public static func interval(_ comparators: [Comparator]) -> Interval {
        var lower: Int?; var upper: Int?
        for c in comparators {
            switch c.op {
            case ">=": if lower == nil || c.n > lower! { lower = c.n }
            case ">": let v = c.n + 1; if lower == nil || v > lower! { lower = v }
            case "<=": if upper == nil || c.n < upper! { upper = c.n }
            case "<": let v = c.n - 1; if upper == nil || v < upper! { upper = v }
            default: if lower == nil || c.n > lower! { lower = c.n }; if upper == nil || c.n < upper! { upper = c.n }
            }
        }
        return Interval(lower: lower, upper: upper)
    }

    public static func satisfies(_ n: Int, _ comparators: [Comparator]) -> Bool {
        let iv = interval(comparators)
        if let lo = iv.lower, n < lo { return false }
        if let hi = iv.upper, n > hi { return false }
        return true
    }

    public static func inRange(_ n: Int, _ range: String) -> Bool {
        (try? satisfies(n, parse(range))) ?? false
    }

    public static func overlaps(_ a: Interval, _ b: Interval) -> Bool {
        let lo: Int? = a.lower == nil ? b.lower : (b.lower == nil ? a.lower : Swift.max(a.lower!, b.lower!))
        let hi: Int? = a.upper == nil ? b.upper : (b.upper == nil ? a.upper : Swift.min(a.upper!, b.upper!))
        guard let lo, let hi else { return true }
        return lo <= hi
    }
}
