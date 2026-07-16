import Foundation
import RynL10n

/// bake CLI — SPM build tool plugin이 호출하는 엔트리(빌드타임 자동 번들링, 6.3).
/// 사용:
///   rynl10n-bake <source.json> <out-dir> [--strict] [--emit-native]            (vendored/에어갭)
///   rynl10n-bake --fetch <url> <out-dir> [--cache <p>] [--token <t>] [...]      (서버 fetch)
/// 서버 fetch 실패 시 --cache의 마지막 스냅샷으로 진행 → 빌드가 서버 가용성에 종속되지 않음(6.3).

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
        if a == "--strict" || a == "--emit-native" { bools.insert(String(a.dropFirst(2))) }
        else if a.hasPrefix("--"), i + 1 < args.count { flags[String(a.dropFirst(2))] = args[i + 1]; i += 1 }
        else { positionals.append(a) }
        i += 1
    }
}
guard !positionals.isEmpty else {
    FileHandle.standardError.write(Data("사용: rynl10n-bake [<source.json>|--fetch <url>] <out-dir> [--cache <p>] [--token <t>] [--strict] [--emit-native]\n".utf8))
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
do {
    try result.bundle.write(toFile: (bundleDir as NSString).appendingPathComponent("snapshot-\(snapshot.base).json"), atomically: true, encoding: .utf8)
    try result.lockfileText.write(toFile: (bundleDir as NSString).appendingPathComponent("rynl10n.lock"), atomically: true, encoding: .utf8)
} catch { fail("산출물 쓰기 실패: \(error)") }

if emitNative {
    let xcstrings = Convert.toXcstrings(snapshot)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    let xcPath = (bundleDir as NSString).appendingPathComponent("Localizable.xcstrings")
    do {
        try encoder.encode(xcstrings).write(to: URL(fileURLWithPath: xcPath))
        print("[rynl10n] .xcstrings 방출 → \(xcPath)")
    } catch { fail(".xcstrings 쓰기 실패: \(error)") }
}
print("[rynl10n] bake 완료: release=\(snapshot.release) base=\(snapshot.base) keys=\(result.lockfile.keyCount) → \(bundleDir)")
