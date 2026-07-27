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
    @Serializable data class ConvertFile(
        val snapshot: Snapshot,
        val androidXml: AndroidXml,
        val descriptions: Map<String, String>,
        val androidXmlWithDescriptions: AndroidXml,
    )

    private fun load(): ConvertFile = Json { ignoreUnknownKeys = true }
        .decodeFromString(File(goldenDir(), "convert.json").readText())

    @Test fun androidStringsXml() {
        val f = load()
        assertEquals(f.androidXml.en, Convert.toAndroidStringsXml(f.snapshot.locales.getValue("en")).output, "en strings.xml")
        assertEquals(f.androidXml.ko, Convert.toAndroidStringsXml(f.snapshot.locales.getValue("ko")).output, "ko strings.xml")
    }

    /** 키 설명(5.1) → XML 주석. `--`는 하이픈 사이 공백으로 보존(XML 1.0 §2.5), 개행은 한 줄로 접힌다. */
    @Test fun androidStringsXmlWithDescriptions() {
        val f = load()
        assertEquals(
            f.androidXmlWithDescriptions.en,
            Convert.toAndroidStringsXml(f.snapshot.locales.getValue("en"), f.descriptions).output,
            "en strings.xml(설명 주석 포함)",
        )
        assertEquals(
            f.androidXmlWithDescriptions.ko,
            Convert.toAndroidStringsXml(f.snapshot.locales.getValue("ko"), f.descriptions).output,
            "ko strings.xml(설명 주석 포함)",
        )
    }

    /** 설명을 주지 않으면 산출물은 설명 도입 이전과 동일해야 한다(하위호환). */
    @Test fun androidStringsXmlWithoutDescriptionsIsUnchanged() {
        val f = load()
        assertEquals(f.androidXml.en, Convert.toAndroidStringsXml(f.snapshot.locales.getValue("en"), emptyMap()).output)
    }
}
