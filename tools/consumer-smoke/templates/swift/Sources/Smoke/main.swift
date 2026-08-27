import Foundation
import RynL10n

// checks.json의 인자 값. JSONDecoder는 `1`을 Bool로, `true`를 Int로 디코딩하지 않으므로
// 이 순서가 곧 타입 판정이다 — 복수형 케이스의 n은 .int로 들어가야 CLDR 카테고리가 맞는다.
enum ArgValue: Decodable {
    case bool(Bool), int(Int), double(Double), string(String)

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let v = try? c.decode(Bool.self) { self = .bool(v); return }
        if let v = try? c.decode(Int.self) { self = .int(v); return }
        if let v = try? c.decode(Double.self) { self = .double(v); return }
        self = .string(try c.decode(String.self))
    }

    var json: JSONValue {
        switch self {
        case .bool(let v): return .bool(v)
        case .int(let v): return .int(v)
        case .double(let v): return .double(v)
        case .string(let v): return .string(v)
        }
    }
}

struct Check: Decodable {
    let name: String, key: String, expect: String
    let args: [String: ArgValue]
    let locale: String?
}

let dir = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let decoder = JSONDecoder()
let bundle = try decoder.decode(Snapshot.self, from: Data(contentsOf: dir.appendingPathComponent("snapshot.json")))
let checks = try decoder.decode([Check].self, from: Data(contentsOf: dir.appendingPathComponent("checks.json")))

let client = RynL10nClient(bundle: bundle, store: InMemoryDeliveryStore(),
                           context: Matching.ClientContext(appVersion: "3.2.1"), locale: "en")

var bad = 0
for c in checks {
    let got = client.t(c.key, args: c.args.mapValues { $0.json }, locale: c.locale)
    let ok = got == c.expect
    if !ok { bad += 1 }
    print("\(ok ? "PASS" : "FAIL")  \(c.name): \"\(got)\"" + (ok ? "" : " (기대 \"\(c.expect)\")"))
}
exit(bad == 0 ? 0 : 1)
