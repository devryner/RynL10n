import Foundation

/// 네이티브 포맷 변환 (bake) — 기획서 5.3. iOS는 `.xcstrings`(Xcode String Catalog)를 방출한다.
/// 플레이스홀더 `{name}` → `%1$@`(string)·`%1$lld`(number) 위치 재매핑. 복수형 → variations/plural.
/// M0 TS 참조 구현과 fixtures/golden/convert.json로 구조 정합.
public enum Convert {
    static let cldrOrder = ["zero", "one", "two", "few", "many", "other"]

    struct Arg { let name: String; let type: String } // "string" | "number"
    enum Token { case lit(String); case ref(String) }

    static func tokenize(_ icu: String) -> (tokens: [Token], args: [Arg]) {
        var tokens: [Token] = []
        var args: [Arg] = []
        var lit = ""
        let chars = Array(icu)
        var i = 0
        func flush() { if !lit.isEmpty { tokens.append(.lit(lit)); lit = "" } }
        while i < chars.count {
            let ch = chars[i]
            if ch == "#" { flush(); tokens.append(.ref("#")); i += 1; continue }
            if ch == "{" {
                if let end = chars[i...].firstIndex(of: "}") {
                    let inner = String(chars[(i + 1)..<end]).trimmingCharacters(in: .whitespaces)
                    if let m = firstMatch(inner, #"^([A-Za-z0-9_]+)\s*(?:,\s*([a-z]+))?"#) {
                        let name = m[1]!
                        let type = (m[2] == "number") ? "number" : "string"
                        flush()
                        tokens.append(.ref(name))
                        if !args.contains(where: { $0.name == name }) { args.append(Arg(name: name, type: type)) }
                        i = end + 1
                        continue
                    }
                }
            }
            lit.append(ch); i += 1
        }
        flush()
        return (tokens, args)
    }

    static func orderedArgs(_ value: TranslationValue) -> [Arg] {
        switch value {
        case .text(let s):
            return tokenize(s).args
        case .plural(let map):
            var seen: [(String, String)] = []
            var seenNames = Set<String>()
            var countName: String?
            for cat in cldrOrder {
                guard let s = map[cat] else { continue }
                let (tokens, args) = tokenize(s)
                if countName == nil {
                    for t in tokens { if case .ref(let n) = t { countName = n; break } }
                }
                for a in args where !seenNames.contains(a.name) { seenNames.insert(a.name); seen.append((a.name, a.type)) }
            }
            var result: [Arg] = []
            if let c = countName {
                result.append(Arg(name: c == "#" ? "#" : c, type: "number"))
            }
            for (name, type) in seen where name != countName { result.append(Arg(name: name, type: type)) }
            return result
        }
    }

    static func indexMap(_ args: [Arg]) -> [String: (index: Int, type: String)] {
        var map: [String: (index: Int, type: String)] = [:]
        for (i, a) in args.enumerated() { map[a.name] = (i + 1, a.type) }
        return map
    }

    static func iosValue(_ icu: String, _ idx: [String: (index: Int, type: String)]) -> String {
        let (tokens, _) = tokenize(icu)
        var out = ""
        for t in tokens {
            switch t {
            case .lit(let s): out += s
            case .ref(let name):
                if let info = idx[name] { out += "%\(info.index)$\(info.type == "number" ? "lld" : "@")" }
                else { out += "{\(name)}" }
            }
        }
        return out
    }

    /// 전 로케일 카탈로그 → .xcstrings 객체(JSONValue 구조).
    /// `descriptions`(키 → 번역자용 설명, 5.1)를 주면 각 키에 .xcstrings 표준 필드 `comment`를 단다.
    /// 생략하면 산출물은 설명 도입 이전과 동일하다.
    public static func toXcstrings(_ snap: Snapshot, descriptions: [String: String] = [:]) -> JSONValue {
        var allKeys = Set<String>()
        for keys in snap.locales.values { allKeys.formUnion(keys.keys) }
        var strings: [String: JSONValue] = [:]
        for key in allKeys {
            var localizations: [String: JSONValue] = [:]
            for locale in snap.locales.keys.sorted() {
                guard let value = snap.locales[locale]?[key] else { continue }
                let idx = indexMap(orderedArgs(value))
                switch value {
                case .plural(let map):
                    var plural: [String: JSONValue] = [:]
                    for cat in cldrOrder {
                        guard let s = map[cat] else { continue }
                        plural[cat] = .object(["stringUnit": .object(["state": .string("translated"), "value": .string(iosValue(s, idx))])])
                    }
                    localizations[locale] = .object(["variations": .object(["plural": .object(plural)])])
                case .text:
                    localizations[locale] = .object(["stringUnit": .object(["state": .string("translated"), "value": .string(iosValue(rawText(value), idx))])])
                }
            }
            if let comment = descriptions[key], !comment.isEmpty {
                strings[key] = .object(["comment": .string(comment), "localizations": .object(localizations)])
            } else {
                strings[key] = .object(["localizations": .object(localizations)])
            }
        }
        return .object([
            "sourceLanguage": .string(snap.defaultLocale),
            "strings": .object(strings),
            "version": .string("1.0"),
        ])
    }

    static func rawText(_ v: TranslationValue) -> String {
        if case .text(let s) = v { return s }
        return ""
    }
}
