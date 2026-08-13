package com.rynl10n

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.Test
import java.io.File

/**
 * M0 TS 참조 구현과의 정합성 검증 — fixtures/golden 아래 골든 벡터.
 * 통과하면 Android(Kotlin) 코어가 참조 구현과 바이트/해시/동작 단위로 일치한다.
 */
class GoldenTest {
    private val json = Json { ignoreUnknownKeys = true }

    private fun goldenDir(): File {
        var dir = File(System.getProperty("user.dir"))
        repeat(12) {
            val candidate = File(dir, "fixtures/golden")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile ?: return@repeat
        }
        error("fixtures/golden 을 찾지 못함")
    }

    private inline fun <reified T> load(file: String): T =
        json.decodeFromString(File(goldenDir(), file).readText())

    @Serializable data class SerCase(val name: String, val value: JsonElement, val canonical: String, val sha256: String, val fileId16: String)
    @Serializable data class SerFile(val cases: List<SerCase>)

    @Test fun serialize() {
        for (c in load<SerFile>("serialize.json").cases) {
            assertEquals(c.canonical, Jcs.canonicalString(c.value), "canonical: ${c.name}")
            assertEquals(c.sha256, ContentHash.sha256Hex(c.value), "sha256: ${c.name}")
            assertEquals(c.fileId16, ContentHash.fileId(c.sha256), "fileId: ${c.name}")
        }
    }

    @Serializable data class NfcCase(val name: String, val composed: String, val decomposed: String, val sha256: String)
    @Serializable data class NfcFile(val cases: List<NfcCase>)

    @Test fun nfc() {
        for (c in load<NfcFile>("nfc.json").cases) {
            val objComposed = JsonObject(mapOf("v" to JsonPrimitive(c.composed)))
            val objDecomposed = JsonObject(mapOf("v" to JsonPrimitive(c.decomposed)))
            assertEquals(c.sha256, ContentHash.sha256Hex(objComposed), "composed: ${c.name}")
            assertEquals(c.sha256, ContentHash.sha256Hex(objDecomposed), "decomposed: ${c.name}")
        }
    }

    @Serializable data class SnapInput(val release: String, val defaultLocale: String, val locales: JsonElement)
    @Serializable data class SnapCase(val name: String, val input: SnapInput, val canonical: String, val fullHash: String, val base16: String)
    @Serializable data class SnapFile(val cases: List<SnapCase>)

    @Test fun snapshotHash() {
        for (c in load<SnapFile>("snapshot-hash.json").cases) {
            val obj = buildJsonObject {
                put("release", JsonPrimitive(c.input.release))
                put("defaultLocale", JsonPrimitive(c.input.defaultLocale))
                put("locales", c.input.locales)
            }
            assertEquals(c.canonical, Jcs.canonicalString(obj), "canonical: ${c.name}")
            val full = ContentHash.snapshotHash(c.input.release, c.input.defaultLocale, c.input.locales)
            assertEquals(c.fullHash, full, "fullHash: ${c.name}")
            assertEquals(c.base16, ContentHash.fileId(full), "base16: ${c.name}")
        }
    }

    @Serializable data class DeltaCaseWrap(val from: Snapshot, val to: Snapshot, val delta: Delta)
    @Serializable data class DeltaFile(val case: DeltaCaseWrap)

    @Test fun deltaApplication() {
        val (from, to, delta) = load<DeltaFile>("delta.json").case.let { Triple(it.from, it.to, it.delta) }
        assertEquals(from.base, delta.from)
        assertEquals(to.base, delta.to)
        val overlay = OverlayLayer.from(delta)
        for (op in delta.ops) {
            val r = Resolve.resolveValue(from, overlay, op.key, op.locale)
            if (op.op == "set") {
                assertEquals("overlay", r.source, "set: ${op.locale}/${op.key}")
                assertEquals(op.value, r.value)
            } else {
                assertNotEquals(op.locale, r.matchedLocale, "tombstone: ${op.locale}/${op.key}")
            }
        }
    }

    @Serializable data class OverlayInput(val locale: String, val key: String, val value: TranslationValue? = null, val tombstone: Boolean? = null)
    @Serializable data class ResExpected(val value: TranslationValue? = null, val source: String, val matchedLocale: String? = null, val guardFallback: Boolean)
    @Serializable data class ResCase(val name: String, val overlay: List<OverlayInput>, val key: String, val locale: String, val expected: ResExpected)
    @Serializable data class ResFile(val bundle: Snapshot, val cases: List<ResCase>)

    @Test fun resolve() {
        val f = load<ResFile>("resolve.json")
        for (c in f.cases) {
            val overlay = OverlayLayer()
            for (e in c.overlay) {
                if (e.tombstone == true) overlay.tombstone(e.locale, e.key)
                else if (e.value != null) overlay.set(e.locale, e.key, e.value)
            }
            val r = Resolve.resolveValue(f.bundle, overlay, c.key, c.locale)
            assertEquals(c.expected.source, r.source, "source: ${c.name}")
            assertEquals(c.expected.matchedLocale, r.matchedLocale, "matchedLocale: ${c.name}")
            assertEquals(c.expected.guardFallback, r.guardFallback, "guardFallback: ${c.name}")
            assertEquals(c.expected.value, r.value, "value: ${c.name}")
        }
    }

    @Serializable data class FmtCase(val name: String, val value: TranslationValue, val locale: String, val args: JsonObject, val expected: String)
    @Serializable data class FmtFile(val cases: List<FmtCase>)

    @Test fun format() {
        for (c in load<FmtFile>("format.json").cases) {
            val args = c.args.mapValues { (_, v) -> jsonPrimitiveToAny(v as JsonPrimitive) }
            assertEquals(c.expected, Resolve.format(c.value, c.locale, args), "format: ${c.name}")
        }
    }

    @Serializable data class SatCase(val version: String, val range: String, val matchPrerelease: Boolean? = null, val expected: Boolean)
    @Serializable data class RejCase(val range: String, val expectedThrow: Boolean)
    @Serializable data class SemverFile(val satisfies: List<SatCase>, val reject: List<RejCase>)

    @Test fun semver() {
        val f = load<SemverFile>("semver.json")
        for (c in f.satisfies) {
            assertEquals(c.expected, SemVerParser.versionInRange(c.version, c.range, c.matchPrerelease ?: false), "sat: ${c.version} in ${c.range}")
        }
        for (c in f.reject) if (c.expectedThrow) {
            assertThrows<SemVerException>("reject: ${c.range}") { SemVerParser.parseRange(c.range) }
        }
    }

    @Serializable data class Ctx(val appVersion: String? = null, val releaseLabel: String? = null, val buildNumber: Int? = null, val matchPrerelease: Boolean? = null, val fallbackPolicy: String? = null)
    @Serializable data class RouteExpected(val kind: String, val releaseId: String? = null)
    @Serializable data class RouteCase(val name: String, val releases: List<ManifestRelease>, val ctx: Ctx, val expected: RouteExpected)
    @Serializable data class RouteFile(val cases: List<RouteCase>)

    @Test fun routing() {
        for (c in load<RouteFile>("routing.json").cases) {
            val policy = if (c.ctx.fallbackPolicy == "nearest-lower") FallbackPolicy.NEAREST_LOWER else FallbackPolicy.BUNDLE_ONLY
            val ctx = Matching.ClientContext(appVersion = c.ctx.appVersion, releaseLabel = c.ctx.releaseLabel, buildNumber = c.ctx.buildNumber, matchPrerelease = c.ctx.matchPrerelease ?: false, fallbackPolicy = policy)
            val sel = Matching.selectRelease(c.releases, ctx)
            assertEquals(c.expected.kind, sel.kind, "kind: ${c.name}")
            assertEquals(c.expected.releaseId, sel.releaseId, "releaseId: ${c.name}")
        }
    }

    private fun jsonPrimitiveToAny(p: JsonPrimitive): Any? =
        if (p.isString) p.content else p.content.toLongOrNull()?.toInt() ?: p.content.toDouble()
}
