package com.rynl10n

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * 빌드타임 자동 번들링 — bake 코어 (기획서 3.2 / 6.3, 차별점 ①).
 * 1차 산출물은 우리 스냅샷 JSON(SDK 번들). 커버리지 검증·base 무결성·lockfile 담당.
 * 서버 fetch·마지막 캐시 fallback은 이 순수 코어를 감싸는 Gradle 태스크가 처리.
 */
object Bake {
    data class CoverageGap(val key: String, val presentIn: List<String>)

    /** 기본 로케일 커버리지 검사: 다른 로케일엔 있으나 기본 로케일에 없는 키(3.1). */
    fun baseLocaleCoverage(snap: Snapshot): List<CoverageGap> {
        val baseKeys = snap.locales[snap.defaultLocale]?.keys ?: emptySet()
        val gaps = mutableMapOf<String, MutableList<String>>()
        for ((locale, keys) in snap.locales) if (locale != snap.defaultLocale) {
            for (key in keys.keys) if (key !in baseKeys) gaps.getOrPut(key) { mutableListOf() }.add(locale)
        }
        return gaps.keys.sorted().map { CoverageGap(it, gaps.getValue(it).sorted()) }
    }

    /** 선언 base가 콘텐츠 해시와 일치하는가. */
    fun verifyBase(snap: Snapshot): Pair<Boolean, String> {
        val full = ContentHash.snapshotHash(snap.release, snap.defaultLocale, localesJson(snap))
        val expected = ContentHash.fileId(full)
        return (expected == snap.base) to expected
    }

    data class Lockfile(
        val schemaVersion: Int,
        val release: String,
        val base: String,
        val keyCount: Int,
        val locales: List<String>,
    )

    fun buildLockfile(snap: Snapshot): Lockfile {
        val allKeys = mutableSetOf<String>()
        for (keys in snap.locales.values) allKeys.addAll(keys.keys)
        return Lockfile(1, snap.release, snap.base, allKeys.size, snap.locales.keys.sorted())
    }

    fun lockfileString(lock: Lockfile): String = Jcs.canonicalString(
        JsonObject(
            mapOf(
                "schemaVersion" to JsonPrimitive(lock.schemaVersion),
                "release" to JsonPrimitive(lock.release),
                "base" to JsonPrimitive(lock.base),
                "keyCount" to JsonPrimitive(lock.keyCount),
                "locales" to JsonArray(lock.locales.map { JsonPrimitive(it) }),
            )
        )
    )

    fun bundleString(snap: Snapshot): String = Jcs.canonicalString(snapshotJson(snap))

    sealed class BakeException(message: String) : Exception(message) {
        class CoverageGaps(val gaps: List<CoverageGap>) : BakeException("커버리지 갭 ${gaps.size}건")
        class BaseMismatch(declared: String, actual: String) : BakeException("base 불일치: 선언=$declared 실제=$actual")
    }

    data class Result(
        val bundlePath: String,
        val bundle: String,
        val lockfile: Lockfile,
        val lockfileText: String,
        val warnings: List<String>,
    )

    fun run(snap: Snapshot, strict: Boolean = false): Result {
        val warnings = mutableListOf<String>()
        val gaps = baseLocaleCoverage(snap)
        if (gaps.isNotEmpty()) {
            if (strict) throw BakeException.CoverageGaps(gaps)
            warnings.add("기본 로케일(${snap.defaultLocale}) 커버리지 갭 ${gaps.size}건: ${gaps.joinToString(", ") { it.key }}")
        }
        val (ok, expected) = verifyBase(snap)
        if (!ok) {
            if (strict) throw BakeException.BaseMismatch(snap.base, expected)
            warnings.add("base 해시 불일치: 선언=${snap.base} 실제=$expected")
        }
        val lock = buildLockfile(snap)
        return Result("rynl10n/snapshot-${snap.base}.json", bundleString(snap), lock, lockfileString(lock), warnings)
    }

    // ── Snapshot/TranslationValue → JsonElement ──────────────────────────────
    private fun snapshotJson(snap: Snapshot): JsonElement = JsonObject(
        mapOf(
            "schemaVersion" to JsonPrimitive(snap.schemaVersion),
            "release" to JsonPrimitive(snap.release),
            "base" to JsonPrimitive(snap.base),
            "defaultLocale" to JsonPrimitive(snap.defaultLocale),
            "locales" to localesJson(snap),
        )
    )
    private fun localesJson(snap: Snapshot): JsonElement = JsonObject(
        snap.locales.mapValues { (_, keys) -> JsonObject(keys.mapValues { tvJson(it.value) }) }
    )
    private fun tvJson(v: TranslationValue): JsonElement = when (v) {
        is TranslationValue.Text -> JsonPrimitive(v.value)
        is TranslationValue.Plural -> JsonObject(v.map.mapValues { JsonPrimitive(it.value) })
    }
}
