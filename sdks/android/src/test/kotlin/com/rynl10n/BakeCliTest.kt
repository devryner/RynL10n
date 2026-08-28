package com.rynl10n

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

/**
 * bake CLI의 키 설명 사이드카(5.1/5.3) 배선.
 *
 * 변환기(`Convert.toAndroidStringsXml`)는 설명 인자를 받고 골든 벡터가 그 출력을 3개 언어로
 * 검증하는데, **CLI가 그 인자를 넘기지 않아** 5.3/6.3이 약속한 strings.xml XML 주석이 Android
 * 빌드에서는 실제로 구워지지 않았다(iOS CLI에는 있었다). 여기서 그 배선을 고정한다.
 *
 * 실패 정책은 iOS `rynl10n-bake`와 같아야 한다 — 사이드카는 스냅샷과 분리돼 있고 콘텐츠 해시에도
 * 안 들어가므로 **읽지 못해도 빌드는 주석 없이 계속한다**. 여기서 던지면 설명 서버가 잠깐 흔들릴
 * 때 빌드가 통째로 죽는다.
 */
class BakeCliTest {

    private val snap = Snapshot(
        schemaVersion = 1,
        release = "R1",
        base = "0000000000000000",
        defaultLocale = "en",
        locales = mapOf(
            "en" to mapOf("home.title" to TranslationValue.Text("Home")),
            "ko" to mapOf("home.title" to TranslationValue.Text("홈")),
        ),
    )

    @Test fun `설명을 주면 strings_xml에 XML 주석이 구워진다`(@TempDir dir: File) {
        emitAndroidRes(dir, snap, mapOf("home.title" to "홈 탭 상단 제목."))
        val en = File(dir, "res/values/strings.xml").readText()
        assertTrue(en.contains("<!-- 홈 탭 상단 제목. -->"), "주석이 있어야 한다: $en")
        // 로케일별 파일 모두에 같은 설명이 붙는다(설명은 키 단위지 로케일별이 아니다 — 5.1).
        val ko = File(dir, "res/values-ko/strings.xml").readText()
        assertTrue(ko.contains("<!-- 홈 탭 상단 제목. -->"), "ko에도 있어야 한다: $ko")
    }

    @Test fun `설명이 없으면 산출물이 이전과 바이트 동일하다`(@TempDir dir: File) {
        emitAndroidRes(dir, snap, emptyMap())
        assertEquals(
            Convert.toAndroidStringsXml(snap.locales.getValue("en")).output,
            File(dir, "res/values/strings.xml").readText(),
        )
    }

    @Test fun `평평한 맵을 읽는다`(@TempDir dir: File) {
        val f = File(dir, "d.json").apply { writeText("""{"home.title":"홈 탭 상단 제목."}""") }
        assertEquals(mapOf("home.title" to "홈 탭 상단 제목."), loadDescriptions(f.path, null))
    }

    /** 관리 API `GET /projects/{p}/releases/{r}/descriptions`의 응답 봉투를 그대로 받는다. */
    @Test fun `관리 API 봉투를 읽는다`(@TempDir dir: File) {
        val f = File(dir, "d.json").apply {
            writeText("""{"release":"R1","descriptions":{"home.title":"홈 탭 상단 제목."}}""")
        }
        assertEquals(mapOf("home.title" to "홈 탭 상단 제목."), loadDescriptions(f.path, null))
    }

    @Test fun `없는 파일이면 빈 맵 — 빌드는 계속된다`(@TempDir dir: File) {
        assertEquals(emptyMap<String, String>(), loadDescriptions(File(dir, "없음.json").path, null))
    }

    @Test fun `형식을 모르면 빈 맵 — 빌드는 계속된다`(@TempDir dir: File) {
        val f = File(dir, "d.json").apply { writeText("""{"home.title":{"nested":1}}""") }
        assertEquals(emptyMap<String, String>(), loadDescriptions(f.path, null))
    }

    /** 빈 문자열은 값이 아니다 — CI가 미설정 프로퍼티를 ""로 넘기는 경로가 흔하다. */
    @Test fun `빈 경로는 값 없음으로 본다`() {
        assertEquals(emptyMap<String, String>(), loadDescriptions("", null))
        assertEquals(emptyMap<String, String>(), loadDescriptions("   ", null))
        assertEquals(emptyMap<String, String>(), loadDescriptions(null, null))
    }
}
