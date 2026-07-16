import Foundation

/// 2계층 resolve + ICU/CLDR 포맷팅 — 기획서 3.1.
public enum OverlayEntry: Sendable {
    case value(TranslationValue)
    case tombstone
}

/// 오버레이 계층: locale → key → 값/tombstone. 델타를 번들 위에 적용한 sparse 결과.
public final class OverlayLayer: @unchecked Sendable {
    private var map: [String: [String: OverlayEntry]] = [:]

    public init() {}

    public func set(_ locale: String, _ key: String, _ value: TranslationValue) {
        map[locale, default: [:]][key] = .value(value)
    }
    public func tombstone(_ locale: String, _ key: String) {
        map[locale, default: [:]][key] = .tombstone
    }
    public func get(_ locale: String, _ key: String) -> OverlayEntry? {
        map[locale]?[key]
    }

    /// 델타 → 오버레이 계층(set=값, delete=tombstone).
    public static func from(delta: Delta) -> OverlayLayer {
        let o = OverlayLayer()
        for op in delta.ops {
            if op.op == "set", let v = op.value { o.set(op.locale, op.key, v) }
            else if op.op == "delete" { o.tombstone(op.locale, op.key) }
        }
        return o
    }
}

public struct ResolveResult: Sendable {
    public let value: TranslationValue?
    public let source: String // "overlay" | "bundle" | "unresolved"
    public let matchedLocale: String?
    public let guardFallback: Bool
}

public enum Resolve {
    /// BCP 47 fallback 체인: 구체→일반 절단 + 기본 로케일. overrides로 명시적 부모 재지정(5.1).
    public static func fallbackChain(_ locale: String, defaultLocale: String,
                                     overrides: [String: String] = [:]) -> [String] {
        var chain: [String] = []
        var seen = Set<String>()
        var cur: String? = locale
        while let c = cur, !seen.contains(c) {
            seen.insert(c)
            chain.append(c)
            if let parent = overrides[c] { cur = parent; continue }
            if let dash = c.lastIndex(of: "-"), dash != c.startIndex {
                cur = String(c[c.startIndex..<dash])
            } else {
                cur = nil
            }
        }
        if !seen.contains(defaultLocale) { chain.append(defaultLocale) }
        return chain
    }

    /// (key, locale)을 2계층 + 로케일 우선 fallback으로 해석.
    public static func resolveValue(bundle: Snapshot, overlay: OverlayLayer, key: String,
                                    locale: String, localeOverrides: [String: String] = [:]) -> ResolveResult {
        let chain = fallbackChain(locale, defaultLocale: bundle.defaultLocale, overrides: localeOverrides)
        for loc in chain {
            let bundleVal = bundle.locales[loc]?[key]
            let entry = overlay.get(loc, key)

            if case .tombstone = entry {
                continue // 삭제됨: 번들까지 가리고 다음 로케일로
            }
            if case .value(let ov) = entry {
                if let bundleVal, !Placeholder.matches(ov, bundleVal) {
                    // 포맷 가드: 서명 불일치 → 오버레이 무시, 번들로 fallback
                    return ResolveResult(value: bundleVal, source: "bundle", matchedLocale: loc, guardFallback: true)
                }
                return ResolveResult(value: ov, source: "overlay", matchedLocale: loc, guardFallback: false)
            }
            if let bundleVal {
                return ResolveResult(value: bundleVal, source: "bundle", matchedLocale: loc, guardFallback: false)
            }
        }
        return ResolveResult(value: nil, source: "unresolved", matchedLocale: nil, guardFallback: false)
    }

    // ── ICU named 치환 + CLDR 복수형(스파이크 최소 규칙) ─────────────────────

    public static func format(_ value: TranslationValue, locale: String, args: [String: JSONValue] = [:]) -> String {
        switch value {
        case .text(let s):
            return substitute(s, args: args, count: nil)
        case .plural(let map):
            let count = pickCount(args)
            let cat = pluralCategory(locale: locale, n: count)
            let template = map[cat] ?? map["other"] ?? ""
            return substitute(template, args: args, count: count)
        }
    }

    static func pluralCategory(locale: String, n: Int) -> String {
        let lang = locale.lowercased().split(separator: "-").first.map(String.init) ?? locale.lowercased()
        if ["ko", "ja", "zh", "vi", "th", "id", "ms"].contains(lang) { return "other" }
        if ["en", "de", "nl", "sv", "da", "no", "es", "it", "pt"].contains(lang) { return n == 1 ? "one" : "other" }
        return "other"
    }

    static let subRe = try! NSRegularExpression(pattern: #"\{\s*([A-Za-z0-9_]+)\s*\}"#)

    static func substitute(_ template: String, args: [String: JSONValue], count: Int?) -> String {
        let ns = template as NSString
        var result = ""
        var last = 0
        subRe.enumerateMatches(in: template, range: NSRange(location: 0, length: ns.length)) { m, _, _ in
            guard let m else { return }
            let whole = m.range
            result += ns.substring(with: NSRange(location: last, length: whole.location - last))
            let name = ns.substring(with: m.range(at: 1))
            if let v = args[name] { result += stringOf(v) } else { result += "{\(name)}" }
            last = whole.location + whole.length
        }
        result += ns.substring(from: last)
        if let count { result = result.replacingOccurrences(of: "#", with: String(count)) }
        return result
    }

    static func pickCount(_ args: [String: JSONValue]) -> Int {
        for name in ["count", "n"] {
            if let v = args[name], let i = intOf(v) { return i }
        }
        for v in args.values { if let i = intOf(v) { return i } }
        return 0
    }

    static func intOf(_ v: JSONValue) -> Int? {
        switch v {
        case .int(let i): return i
        case .double(let d) where d.rounded() == d: return Int(d)
        default: return nil
        }
    }

    static func stringOf(_ v: JSONValue) -> String {
        switch v {
        case .string(let s): return s
        case .int(let i): return String(i)
        case .double(let d): return d.rounded() == d ? String(Int(d)) : String(d)
        case .bool(let b): return b ? "true" : "false"
        case .null: return ""
        default: return ""
        }
    }
}
