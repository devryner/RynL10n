package com.rynl10n

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.Test
import java.io.File

/** bake 코어 정합성 — fixtures/golden/bake.json (기획서 3.2/6.3). */
class BakeTest {
    private val json = Json { ignoreUnknownKeys = true }
    private fun goldenDir(): File {
        var dir = File(System.getProperty("user.dir"))
        repeat(12) {
            val c = File(dir, "fixtures/golden"); if (c.isDirectory) return c
            dir = dir.parentFile ?: return@repeat
        }
        error("fixtures/golden 없음")
    }

    @Serializable data class GapJ(val key: String, val presentIn: List<String>)
    @Serializable data class BakeCase(
        val name: String, val snapshot: Snapshot, val coverageGaps: List<GapJ>,
        val baseOk: Boolean, val lockfileText: String, val bundle: String, val expectedBase: String? = null,
    )
    @Serializable data class BakeFile(val cases: List<BakeCase>)

    @Test fun bakeGolden() {
        val f = json.decodeFromString<BakeFile>(File(goldenDir(), "bake.json").readText())
        for (c in f.cases) {
            val gaps = Bake.baseLocaleCoverage(c.snapshot)
            assertEquals(c.coverageGaps.size, gaps.size, "gap count: ${c.name}")
            for ((g, e) in gaps.zip(c.coverageGaps)) {
                assertEquals(e.key, g.key, "gap key: ${c.name}")
                assertEquals(e.presentIn, g.presentIn, "gap presentIn: ${c.name}")
            }
            val (ok, expected) = Bake.verifyBase(c.snapshot)
            assertEquals(c.baseOk, ok, "baseOk: ${c.name}")
            c.expectedBase?.let { assertEquals(it, expected, "expectedBase: ${c.name}") }
            assertEquals(c.lockfileText, Bake.lockfileString(Bake.buildLockfile(c.snapshot)), "lockfile: ${c.name}")
            assertEquals(c.bundle, Bake.bundleString(c.snapshot), "bundle: ${c.name}")
        }
    }

    @Test fun strictThrowsOnGap() {
        val f = json.decodeFromString<BakeFile>(File(goldenDir(), "bake.json").readText())
        val gapCase = f.cases.first { it.coverageGaps.isNotEmpty() }
        assertThrows<Bake.BakeException.CoverageGaps> { Bake.run(gapCase.snapshot, strict = true) }
        assertFalse(Bake.run(gapCase.snapshot, strict = false).warnings.isEmpty())
    }
}
