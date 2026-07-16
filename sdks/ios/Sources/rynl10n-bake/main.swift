import Foundation
import RynL10n

/// bake CLI — SPM build tool plugin이 호출하는 엔트리(빌드타임 자동 번들링, 6.3).
/// 사용: rynl10n-bake <source-snapshot.json> <output-dir> [--strict]
/// 산출: <output-dir>/rynl10n/snapshot-<base>.json (SDK 번들) + rynl10n.lock

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write(Data("사용: rynl10n-bake <source-snapshot.json> <output-dir> [--strict]\n".utf8))
    exit(2)
}
let sourcePath = args[1]
let outDir = args[2]
let strict = args.contains("--strict")

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("[rynl10n] \(message)\n".utf8))
    exit(1)
}

guard let data = FileManager.default.contents(atPath: sourcePath) else { fail("스냅샷을 읽지 못함: \(sourcePath)") }
let snapshot: Snapshot
do {
    snapshot = try JSONDecoder().decode(Snapshot.self, from: data)
} catch {
    fail("스냅샷 파싱 실패: \(error)")
}

let result: Bake.Result
do {
    result = try Bake.run(snapshot, strict: strict)
} catch {
    fail("bake 실패(strict): \(error)")
}
for w in result.warnings { FileHandle.standardError.write(Data("[rynl10n] 경고: \(w)\n".utf8)) }

let bundleDir = (outDir as NSString).appendingPathComponent("rynl10n")
try? FileManager.default.createDirectory(atPath: bundleDir, withIntermediateDirectories: true)
let snapPath = (bundleDir as NSString).appendingPathComponent("snapshot-\(snapshot.base).json")
let lockPath = (bundleDir as NSString).appendingPathComponent("rynl10n.lock")
do {
    try result.bundle.write(toFile: snapPath, atomically: true, encoding: .utf8)
    try result.lockfileText.write(toFile: lockPath, atomically: true, encoding: .utf8)
} catch {
    fail("산출물 쓰기 실패: \(error)")
}
print("[rynl10n] bake 완료: release=\(snapshot.release) base=\(snapshot.base) keys=\(result.lockfile.keyCount) → \(bundleDir)")
