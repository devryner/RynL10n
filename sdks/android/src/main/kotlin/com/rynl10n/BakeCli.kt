package com.rynl10n

import kotlinx.serialization.json.Json
import java.io.File
import kotlin.system.exitProcess

/**
 * bake CLI — Gradle 태스크가 호출하는 엔트리(빌드타임 자동 번들링, 6.3).
 * 사용: rynl10n-bake <source-snapshot.json> <output-dir> [--strict]
 *
 * source는 서버에서 fetch한(또는 vendored/airgap로 커밋한) 현재 릴리스 스냅샷.
 * 실제 fetch·마지막 캐시 fallback은 Gradle 태스크 설정에서 결정 — 이 CLI는 파일을 입력으로 받는다.
 * 산출: <output-dir>/rynl10n/snapshot-<base>.json (SDK 번들) + <output-dir>/rynl10n/rynl10n.lock
 */
fun main(args: Array<String>) {
    if (args.size < 2) {
        System.err.println("사용: rynl10n-bake <source-snapshot.json> <output-dir> [--strict]")
        exitProcess(2)
    }
    val source = File(args[0])
    val outDir = File(args[1])
    val strict = args.contains("--strict")

    val snap = try {
        Json { ignoreUnknownKeys = true }.decodeFromString<Snapshot>(source.readText())
    } catch (e: Exception) {
        System.err.println("[rynl10n] 스냅샷 파싱 실패: ${e.message}")
        exitProcess(1)
    }

    val result = try {
        Bake.run(snap, strict = strict)
    } catch (e: Bake.BakeException) {
        System.err.println("[rynl10n] bake 실패(strict): ${e.message}")
        exitProcess(1)
    }
    result.warnings.forEach { System.err.println("[rynl10n] 경고: $it") }

    val bundleDir = File(outDir, "rynl10n").apply { mkdirs() }
    File(bundleDir, "snapshot-${snap.base}.json").writeText(result.bundle)
    File(bundleDir, "rynl10n.lock").writeText(result.lockfileText)
    println("[rynl10n] bake 완료: release=${snap.release} base=${snap.base} keys=${result.lockfile.keyCount} → ${bundleDir.path}")
}
