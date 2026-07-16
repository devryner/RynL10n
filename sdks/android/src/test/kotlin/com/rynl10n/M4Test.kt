package com.rynl10n

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.Test
import java.io.File

/** M4 코어 파리티 — 카나리(8.4)·정수 매칭·텔레메트리. fixtures/golden/canary.json·intrange.json. */
class M4Test {
    private val json = Json { ignoreUnknownKeys = true }
    private fun goldenDir(): File {
        var dir = File(System.getProperty("user.dir"))
        repeat(12) { val c = File(dir, "fixtures/golden"); if (c.isDirectory) return c; dir = dir.parentFile ?: return@repeat }
        error("fixtures/golden 없음")
    }

    @Serializable data class Bucket(val installId: String, val releaseId: String, val bucket: Int)
    @Serializable data class Roll(val rollout: Int, val installId: String? = null, val releaseId: String, val expected: Boolean)
    @Serializable data class CanaryFile(val buckets: List<Bucket>, val inRollout: List<Roll>)

    @Test fun canaryGolden() {
        val f = json.decodeFromString<CanaryFile>(File(goldenDir(), "canary.json").readText())
        for (b in f.buckets) assertEquals(b.bucket, Canary.bucket(b.installId, b.releaseId), "${b.installId}/${b.releaseId}")
        for (r in f.inRollout) assertEquals(r.expected, Canary.inRollout(r.rollout, r.installId, r.releaseId))
    }

    @Serializable data class Sat(val n: Int, val range: String, val expected: Boolean)
    @Serializable data class Rej(val range: String, val expectedThrow: Boolean)
    @Serializable data class IntFile(val satisfies: List<Sat>, val reject: List<Rej>)

    @Test fun intRangeGolden() {
        val f = json.decodeFromString<IntFile>(File(goldenDir(), "intrange.json").readText())
        for (c in f.satisfies) assertEquals(c.expected, IntRangeMatch.inRange(c.n, c.range), "${c.n} in ${c.range}")
        for (c in f.reject) if (c.expectedThrow) assertThrows<IntRangeMatch.IntRangeException> { IntRangeMatch.parse(c.range) }
    }

    private fun rel(id: String, value: String, strategy: String = "integer-range") =
        ManifestRelease(id, ReleaseState.PUBLISHED, VersionMatch(strategy, value), id, id, 100, "s", null)

    @Test fun integerRouting() {
        val releases = listOf(rel("B1", ">=42 <50"), rel("B2", ">=50"))
        assertEquals("B1", Matching.selectRelease(releases, Matching.ClientContext(buildNumber = 45)).releaseId)
        assertEquals("B2", Matching.selectRelease(releases, Matching.ClientContext(buildNumber = 60)).releaseId)
    }

    @Test fun canaryGateAndTelemetry() {
        val bundle = Snapshot(1, "R1", "b0", "en", mapOf("en" to mapOf("greet" to TranslationValue.Text("old"))))
        val store = InMemoryDeliveryStore()
        store.put(Delta(1, "R1", "b0", "b1", listOf(DeltaOp("set", "greet", "en", TranslationValue.Text("new")))), "releases/R1/delta-b0-b1.json")
        fun manifest(rollout: Int) = Manifest(1, "p", "en", "T", listOf(
            ManifestRelease("R1", ReleaseState.PUBLISHED, VersionMatch("semver-range", ">=1.0.0"), "b0", "b1", rollout, "releases/R1/snapshot-b0.json", "releases/R1/delta-b0-b1.json")))

        val c0 = RynL10nClient(bundle, store, Matching.ClientContext(appVersion = "1.0.0"), installId = "x", telemetry = "aggregate")
        c0.refresh(manifest(0))
        assertEquals("old", c0.t("greet")) // rollout 0 → 미수신

        val c1 = RynL10nClient(bundle, store, Matching.ClientContext(appVersion = "1.0.0"), installId = "x", telemetry = "aggregate")
        c1.refresh(manifest(100))
        assertEquals("new", c1.t("greet"))
        c1.t("missing.key")
        val tel = c1.drainTelemetry()
        assertEquals(1, tel.overlayApplied)
        assertEquals(1, tel.keyUnresolved)
    }
}
