import Foundation
import RynL10n

/// bake CLI — SPM build tool plugin이 호출하는 엔트리(빌드타임 자동 번들링, 6.3).
/// 사용:
///   rynl10n-bake <source.json> <out-dir> [--strict] [--emit-native]            (vendored/에어갭)
///   rynl10n-bake --fetch <url> <out-dir> [--cache <p>] [--token <t>] [...]      (서버 fetch)
/// 서버 fetch 실패 시 --cache의 마지막 스냅샷으로 진행 → 빌드가 서버 가용성에 종속되지 않음(6.3).
///
/// `--descriptions <path|url>` — 키 설명(5.1) 사이드카. --emit-native와 함께 쓰면 .xcstrings의
/// `comment` 필드로 구워져 Xcode에서 번역자가 맥락을 읽는다. 스냅샷과 분리돼 있어(해시 입력 불변)
/// 없거나 읽기 실패해도 bake는 주석 없이 계속된다.

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("[rynl10n] \(message)\n".utf8))
    exit(1)
}

// 인자 파싱: --key value / --bool / positional.
var flags: [String: String] = [:]
var bools: Set<String> = []
var positionals: [String] = []
do {
    let args = Array(CommandLine.arguments.dropFirst())
    var i = 0
    while i < args.count {
        let a = args[i]
        if a == "--strict" || a == "--emit-native" || a == "--stable-name" { bools.insert(String(a.dropFirst(2))) }
        else if a.hasPrefix("--"), i + 1 < args.count { flags[String(a.dropFirst(2))] = args[i + 1]; i += 1 }
        else { positionals.append(a) }
        i += 1
    }
}
guard !positionals.isEmpty else {
    FileHandle.standardError.write(Data("사용: rynl10n-bake [<source.json>|--fetch <url>] <out-dir> [--cache <p>] [--token <t>] [--descriptions <path|url>] [--strict] [--emit-native]\n".utf8))
    exit(2)
}
let outDir = positionals.last!
let strict = bools.contains("strict")
let emitNative = bools.contains("emit-native")

func tryFetch(_ urlString: String, _ token: String?) -> String? {
    guard let url = URL(string: urlString) else { return nil }
    var req = URLRequest(url: url)
    if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
    let sem = DispatchSemaphore(value: 0)
    var body: String?
    URLSession.shared.dataTask(with: req) { data, resp, _ in
        if let http = resp as? HTTPURLResponse, http.statusCode == 200, let data { body = String(data: data, encoding: .utf8) }
        sem.signal()
    }.resume()
    sem.wait()
    return body
}

// 스냅샷 텍스트 확보: 서버 fetch(실패 시 캐시) 또는 vendored source 파일.
func resolveSnapshotText(_ flags: [String: String], _ positionals: [String]) -> String? {
    if let url = flags["fetch"] {
        let cache = flags["cache"]
        if let fetched = tryFetch(url, flags["token"]) {
            if let cache { try? fetched.write(toFile: cache, atomically: true, encoding: .utf8) }
            return fetched
        }
        if let cache, FileManager.default.fileExists(atPath: cache) {
            FileHandle.standardError.write(Data("[rynl10n] 서버 fetch 실패 → 마지막 캐시로 진행: \(cache)\n".utf8))
            return try? String(contentsOfFile: cache, encoding: .utf8)
        }
        return nil
    }
    guard positionals.count >= 2 else { return nil }
    return try? String(contentsOfFile: positionals[0], encoding: .utf8)
}

guard let snapText = resolveSnapshotText(flags, positionals) else { fail("스냅샷 소스를 확보하지 못함(fetch 실패·캐시 없음·source 파일 없음)") }
let snapshot: Snapshot
do {
    snapshot = try JSONDecoder().decode(Snapshot.self, from: Data(snapText.utf8))
} catch { fail("스냅샷 파싱 실패: \(error)") }

let result: Bake.Result
do {
    result = try Bake.run(snapshot, strict: strict)
} catch { fail("bake 실패(strict): \(error)") }
for w in result.warnings { FileHandle.standardError.write(Data("[rynl10n] 경고: \(w)\n".utf8)) }

let bundleDir = (outDir as NSString).appendingPathComponent("rynl10n")
try? FileManager.default.createDirectory(atPath: bundleDir, withIntermediateDirectories: true)
// --stable-name: 내용해시 대신 고정 파일명(빌드 그래프 output 선언용). 번들은 base 필드로 자기식별.
let bundleName = bools.contains("stable-name") ? "snapshot.json" : "snapshot-\(snapshot.base).json"
do {
    try result.bundle.write(toFile: (bundleDir as NSString).appendingPathComponent(bundleName), atomically: true, encoding: .utf8)
    try result.lockfileText.write(toFile: (bundleDir as NSString).appendingPathComponent("rynl10n.lock"), atomically: true, encoding: .utf8)
} catch { fail("산출물 쓰기 실패: \(error)") }

/// 키 설명(5.1) 사이드카 로드 — 파일 경로 또는 URL. 스냅샷과 분리돼 있어 실패해도 bake는 계속된다.
/// 허용 형태: `{"key":"설명"}` 또는 관리 API 응답 봉투 `{"release":..,"descriptions":{...}}`.
func loadDescriptions(_ source: String?, _ token: String?) -> [String: String] {
    guard let source else { return [:] }
    let text: String?
    if source.hasPrefix("http://") || source.hasPrefix("https://") {
        text = tryFetch(source, token)
    } else {
        text = try? String(contentsOfFile: source, encoding: .utf8)
    }
    guard let text, let data = text.data(using: .utf8) else {
        FileHandle.standardError.write(Data("[rynl10n] 경고: 설명 소스를 읽지 못함 → 주석 없이 진행: \(source)\n".utf8))
        return [:]
    }
    // 관리 API 봉투(`release` 같은 부가 필드가 섞여 있어 딕셔너리로는 디코딩되지 않는다).
    struct Envelope: Decodable { let descriptions: [String: String] }
    if let envelope = try? JSONDecoder().decode(Envelope.self, from: data) {
        return envelope.descriptions
    }
    if let flat = try? JSONDecoder().decode([String: String].self, from: data) {
        return flat // 평평한 맵
    }
    FileHandle.standardError.write(Data("[rynl10n] 경고: 설명 JSON 형식을 해석하지 못함 → 주석 없이 진행\n".utf8))
    return [:]
}

if emitNative {
    let descriptions = loadDescriptions(flags["descriptions"], flags["token"])
    if !descriptions.isEmpty { print("[rynl10n] 키 설명 \(descriptions.count)건 → .xcstrings comment") }
    let xcstrings = Convert.toXcstrings(snapshot, descriptions: descriptions)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    let xcPath = (bundleDir as NSString).appendingPathComponent("Localizable.xcstrings")
    do {
        try encoder.encode(xcstrings).write(to: URL(fileURLWithPath: xcPath))
        print("[rynl10n] .xcstrings 방출 → \(xcPath)")
    } catch { fail(".xcstrings 쓰기 실패: \(error)") }
}
print("[rynl10n] bake 완료: release=\(snapshot.release) base=\(snapshot.base) keys=\(result.lockfile.keyCount) → \(bundleDir)")
