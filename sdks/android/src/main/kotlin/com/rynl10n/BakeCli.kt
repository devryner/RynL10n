package com.rynl10n

import kotlinx.serialization.json.Json
import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import kotlin.system.exitProcess

/**
 * bake CLI — Gradle 태스크가 호출하는 엔트리(빌드타임 자동 번들링, 6.3).
 * 사용:
 *   rynl10n-bake <source-snapshot.json> <output-dir> [--strict] [--emit-native]   (vendored/에어갭)
 *   rynl10n-bake --fetch <url> --cache <path> --token <t> <output-dir> [...]        (서버 fetch)
 *
 * 서버 fetch(6.3): --fetch로 현재 릴리스 스냅샷을 받아 --cache에 저장. **fetch 실패 시 마지막 캐시로 진행**
 * → 빌드가 번역 서버 가용성에 종속되지 않음. 둘 다 없으면 positional source 파일(vendored).
 */
fun main(args: Array<String>) {
    val flags = mutableMapOf<String, String>()
    val bools = mutableSetOf<String>()
    val positionals = mutableListOf<String>()
    var i = 0
    while (i < args.size) {
        val a = args[i]
        when {
            a == "--strict" || a == "--emit-native" || a == "--stable-name" -> bools.add(a.removePrefix("--"))
            a.startsWith("--") && i + 1 < args.size -> { flags[a.removePrefix("--")] = args[i + 1]; i++ }
            else -> positionals.add(a)
        }
        i++
    }
    if (positionals.isEmpty()) {
        System.err.println("사용: rynl10n-bake [<source.json>|--fetch <url>] <output-dir> [--cache <p>] [--token <t>] [--strict] [--emit-native]")
        exitProcess(2)
    }
    val outDir = File(positionals.last())
    val strict = "strict" in bools
    val emitNative = "emit-native" in bools

    val snapText = resolveSnapshotText(flags, positionals) ?: run {
        System.err.println("[rynl10n] 스냅샷 소스를 확보하지 못함(fetch 실패·캐시 없음·source 파일 없음)")
        exitProcess(1)
    }

    val snap = try {
        Json { ignoreUnknownKeys = true }.decodeFromString<Snapshot>(snapText)
    } catch (e: Exception) {
        System.err.println("[rynl10n] 스냅샷 파싱 실패: ${e.message}"); exitProcess(1)
    }

    val result = try {
        Bake.run(snap, strict = strict)
    } catch (e: Bake.BakeException) {
        System.err.println("[rynl10n] bake 실패(strict): ${e.message}"); exitProcess(1)
    }
    result.warnings.forEach { System.err.println("[rynl10n] 경고: $it") }

    val bundleDir = File(outDir, "rynl10n").apply { mkdirs() }
    // --stable-name: 내용해시 대신 고정 파일명(빌드 그래프 output 선언용). 번들은 base 필드로 자기식별.
    val bundleName = if ("stable-name" in bools) "snapshot.json" else "snapshot-${snap.base}.json"
    File(bundleDir, bundleName).writeText(result.bundle)
    File(bundleDir, "rynl10n.lock").writeText(result.lockfileText)

    if (emitNative) {
        for ((locale, catalog) in snap.locales) {
            val valuesDir = if (locale == snap.defaultLocale) "values" else "values-$locale"
            val resDir = File(bundleDir, "res/$valuesDir").apply { mkdirs() }
            File(resDir, "strings.xml").writeText(Convert.toAndroidStringsXml(catalog).output)
        }
        println("[rynl10n] strings.xml 방출 → ${File(bundleDir, "res").path}")
    }
    println("[rynl10n] bake 완료: release=${snap.release} base=${snap.base} keys=${result.lockfile.keyCount} → ${bundleDir.path}")
}

/** 서버 fetch(실패 시 캐시) 또는 vendored source 파일에서 스냅샷 텍스트 확보(6.3). */
private fun resolveSnapshotText(flags: Map<String, String>, positionals: List<String>): String? {
    val url = flags["fetch"]
    val cache = flags["cache"]
    if (url != null) {
        val fetched = tryFetch(url, flags["token"])
        if (fetched != null) {
            if (cache != null) File(cache).apply { parentFile?.mkdirs() }.writeText(fetched)
            return fetched
        }
        if (cache != null && File(cache).exists()) {
            System.err.println("[rynl10n] 서버 fetch 실패 → 마지막 캐시로 진행: $cache")
            return File(cache).readText()
        }
        return null
    }
    // vendored: positionals = [source, outDir]
    return if (positionals.size >= 2) File(positionals.first()).takeIf { it.exists() }?.readText() else null
}

private fun tryFetch(url: String, token: String?): String? = try {
    val req = HttpRequest.newBuilder(URI.create(url)).GET()
    if (token != null) req.header("authorization", "Bearer $token")
    val res = HttpClient.newHttpClient().send(req.build(), HttpResponse.BodyHandlers.ofString())
    if (res.statusCode() == 200) res.body() else null
} catch (e: Exception) {
    null
}
