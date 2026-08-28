package com.rynl10n

import kotlinx.serialization.Serializable
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
 *
 * `--descriptions <path|url>`: 키 설명(5.1) 사이드카. --emit-native와 함께 쓰면 strings.xml에 XML
 * 주석으로 굽는다(5.3/6.3). **스냅샷과 분리돼 있어 읽지 못해도 bake는 주석 없이 계속한다** —
 * 설명은 런타임 페이로드가 아니고 콘텐츠 해시에도 안 들어간다(그래서 빌드를 멈출 이유가 없다).
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
        System.err.println("사용: rynl10n-bake [<source.json>|--fetch <url>] <output-dir> [--cache <p>] [--token <t>] [--descriptions <path|url>] [--strict] [--emit-native]")
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
        val descriptions = loadDescriptions(flags["descriptions"], flags["token"])
        if (descriptions.isNotEmpty()) println("[rynl10n] 키 설명 ${descriptions.size}건 → strings.xml 주석")
        emitAndroidRes(bundleDir, snap, descriptions)
        println("[rynl10n] strings.xml 방출 → ${File(bundleDir, "res").path}")
    }
    println("[rynl10n] bake 완료: release=${snap.release} base=${snap.base} keys=${result.lockfile.keyCount} → ${bundleDir.path}")
}

/** 로케일별 `res/values[-locale]/strings.xml` 방출. 설명을 주면 XML 주석이 함께 구워진다(5.3). */
internal fun emitAndroidRes(bundleDir: File, snap: Snapshot, descriptions: Map<String, String>) {
    for ((locale, catalog) in snap.locales) {
        val valuesDir = if (locale == snap.defaultLocale) "values" else "values-$locale"
        val resDir = File(bundleDir, "res/$valuesDir").apply { mkdirs() }
        File(resDir, "strings.xml").writeText(Convert.toAndroidStringsXml(catalog, descriptions).output)
    }
}

/**
 * 키 설명(5.1) 사이드카 로드 — 파일 경로 또는 URL. iOS `rynl10n-bake`의 같은 이름 함수와 동작이
 * 같다(허용 형태·실패 정책까지). **읽지 못하거나 형식을 모르면 경고만 내고 빈 맵을 돌려준다** —
 * 스냅샷과 분리된 사이드카라 없다고 빌드를 멈출 이유가 없다.
 *
 * 허용 형태: 평평한 맵 `{"key":"설명"}` 또는 관리 API 응답 봉투 `{"release":..,"descriptions":{...}}`.
 */
internal fun loadDescriptions(source: String?, token: String?): Map<String, String> {
    if (source.isNullOrBlank()) return emptyMap()
    val text = if (source.startsWith("http://") || source.startsWith("https://")) {
        tryFetch(source, token)
    } else {
        File(source).takeIf { it.isFile }?.readText()
    }
    if (text == null) {
        System.err.println("[rynl10n] 경고: 설명 소스를 읽지 못함 → 주석 없이 진행: $source")
        return emptyMap()
    }
    val json = Json { ignoreUnknownKeys = true }
    // 봉투를 먼저 본다 — `release` 같은 부가 필드가 섞여 있어 평평한 맵으로는 디코딩되지 않는다.
    runCatching { json.decodeFromString<DescriptionEnvelope>(text) }.getOrNull()?.let { return it.descriptions }
    runCatching { json.decodeFromString<Map<String, String>>(text) }.getOrNull()?.let { return it }
    System.err.println("[rynl10n] 경고: 설명 JSON 형식을 해석하지 못함 → 주석 없이 진행")
    return emptyMap()
}

@Serializable
internal data class DescriptionEnvelope(val descriptions: Map<String, String>)

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

internal fun tryFetch(url: String, token: String?): String? = try {
    val req = HttpRequest.newBuilder(URI.create(url)).GET()
    if (token != null) req.header("authorization", "Bearer $token")
    val res = HttpClient.newHttpClient().send(req.build(), HttpResponse.BodyHandlers.ofString())
    if (res.statusCode() == 200) res.body() else null
} catch (e: Exception) {
    null
}
