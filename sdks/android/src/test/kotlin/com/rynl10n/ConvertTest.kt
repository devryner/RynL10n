package com.rynl10n

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import java.io.File

/** Android strings.xml 변환 정합성 — fixtures/golden/convert.json (기획서 5.3). */
class ConvertTest {
    private fun goldenDir(): File {
        var dir = File(System.getProperty("user.dir"))
        repeat(12) { val c = File(dir, "fixtures/golden"); if (c.isDirectory) return c; dir = dir.parentFile ?: return@repeat }
        error("fixtures/golden 없음")
    }

    @Serializable data class AndroidXml(val en: String, val ko: String)
    @Serializable data class ConvertFile(val snapshot: Snapshot, val androidXml: AndroidXml)

    @Test fun androidStringsXml() {
        val f = Json { ignoreUnknownKeys = true }
            .decodeFromString<ConvertFile>(File(goldenDir(), "convert.json").readText())
        assertEquals(f.androidXml.en, Convert.toAndroidStringsXml(f.snapshot.locales.getValue("en")).output, "en strings.xml")
        assertEquals(f.androidXml.ko, Convert.toAndroidStringsXml(f.snapshot.locales.getValue("ko")).output, "ko strings.xml")
    }
}
