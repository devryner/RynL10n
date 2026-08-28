import Foundation

/// 플레이스홀더 서명 & 포맷 안전 가드 — 기획서 3.1 / 5.3.
public enum Placeholder {
    /// ICU 인자 `{name}` / `{name, plural, …}`에서 (이름:타입) 집합을 결정적 문자열로.
    public static func signature(_ value: TranslationValue) -> String {
        var args: [String: String] = [:]
        switch value {
        case .text(let s):
            collect(s, into: &args)
        case .plural(let map):
            for k in map.keys.sorted() { collect(map[k]!, into: &args) }
        }
        return args.keys.sorted().map { "\($0):\(args[$0]!)" }.joined(separator: ",")
    }

    public static func matches(_ a: TranslationValue, _ b: TranslationValue) -> Bool {
        signature(a) == signature(b)
    }

    // 인자 이름의 정의는 `Icu.swift` 한 곳에 있다 — 서명·치환·변환이 갈리면 안 되기 때문(3.1).
    private static let re = try! NSRegularExpression(pattern: Icu.argScan)

    private static func collect(_ icu: String, into args: inout [String: String]) {
        let range = NSRange(icu.startIndex..<icu.endIndex, in: icu)
        re.enumerateMatches(in: icu, range: range) { m, _, _ in
            guard let m,
                  let nameR = Range(m.range(at: 1), in: icu) else { return }
            let name = String(icu[nameR])
            var type = "simple"
            if let typeR = Range(m.range(at: 2), in: icu) { type = String(icu[typeR]) }
            if let prev = args[name] {
                if prev != type { args[name] = "\(prev)|\(type)" }
            } else {
                args[name] = type
            }
        }
    }
}
