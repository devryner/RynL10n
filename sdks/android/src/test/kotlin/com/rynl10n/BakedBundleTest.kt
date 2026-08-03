package com.rynl10n

import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.io.File
import java.nio.file.Files

/**
 * 번들 로더([BakedBundle]) 검증 — 기획서 3.2 / 6.3.
 *
 * bake 산출물을 **실제로 구워서**(`Bake.run`) 그 결과를 다시 읽는 왕복 테스트다 —
 * 빌드타임(bake)과 런타임(load)이 같은 파일 규약을 보는지가 검증 대상이다.
 */
class BakedBundleTest {

    private lateinit var dir: File

    private val snap = Snapshot(
        1, "R42", "", "en",
        mapOf(
            "en" to mapOf("pay.button" to TranslationValue.Text("Pay"), "cart.title" to TranslationValue.Text("Cart")),
            "ko" to mapOf("pay.button" to TranslationValue.Text("결제"), "cart.title" to TranslationValue.Text("장바구니")),
        ),
    )

    @BeforeEach fun setUp() {
        dir = Files.createTempDirectory("rynl10n-baked").toFile()
    }

    @AfterEach fun tearDown() {
        dir.deleteRecursively()
    }

    /** CLI가 하는 일과 동일하게 배치한다(BakeCli: `<out>/rynl10n/<name>` + `rynl10n.lock`). */
    private fun bake(stableName: Boolean): Bake.Result {
        val result = Bake.run(snap)
        val bundleDir = File(dir, "rynl10n").apply { mkdirs() }
        val name = if (stableName) "snapshot.json" else "snapshot-${snap.base}.json"
        File(bundleDir, name).writeText(result.bundle)
        File(bundleDir, "rynl10n.lock").writeText(result.lockfileText)
        return result
    }

    @Test fun stableName_산출물을_로드한다() {
        bake(stableName = true)

        val loaded = BakedBundle.snapshot(dir)

        assertEquals("R42", loaded.release)
        assertEquals("en", loaded.defaultLocale)
        assertEquals(TranslationValue.Text("결제"), loaded.locales["ko"]?.get("pay.button"))
    }

    @Test fun 내용해시_파일명도_로드한다() {
        bake(stableName = false)

        val loaded = BakedBundle.snapshot(dir)

        assertEquals("R42", loaded.release)
        assertEquals(TranslationValue.Text("Cart"), loaded.locales["en"]?.get("cart.title"))
    }

    @Test fun lockfile을_판독한다() {
        bake(stableName = true)

        val lock = requireNotNull(BakedBundle.lockfile(dir)) { "lockfile을 읽지 못했다" }

        assertEquals("R42", lock.release)
        assertEquals(2, lock.keyCount)
        assertEquals(listOf("en", "ko"), lock.locales)
    }

    @Test fun lockfile이_없으면_null이다() {
        File(dir, "rynl10n").mkdirs()
        File(dir, "rynl10n/snapshot.json").writeText(Bake.run(snap).bundle)

        assertNull(BakedBundle.lockfile(dir), "lockfile은 진단용 — 없어도 런타임은 동작해야 한다")
        assertEquals("R42", BakedBundle.snapshot(dir).release)
    }

    @Test fun 산출물이_없으면_안내_메시지와_함께_실패한다() {
        val error = assertThrows(BakedBundle.BakedException::class.java) { BakedBundle.snapshot(dir) }

        assertTrue(error.message!!.contains("rynl10nBake"), "무엇을 확인해야 하는지 알려줘야 한다")
        assertNull(BakedBundle.locate(dir))
    }

    @Test fun 깨진_JSON은_디코딩_실패로_표면화된다() {
        File(dir, "rynl10n").mkdirs()
        File(dir, "rynl10n/snapshot.json").writeText("{ not json")

        val error = assertThrows(BakedBundle.BakedException::class.java) { BakedBundle.snapshot(dir) }

        assertTrue(error.message!!.contains("디코딩"))
    }

    @Test fun assets_경로_후보는_bake_출력과_일치한다() {
        // AAR의 Context 확장이 AssetManager.open에 넘기는 이름 — bake 산출 규약과 어긋나면 런타임에만 드러난다.
        assertTrue(BakedBundle.ASSET_CANDIDATES.contains("rynl10n/snapshot.json"))
        assertTrue(BakedBundle.LOCKFILE_CANDIDATES.contains("rynl10n/rynl10n.lock"))
    }

    @Test fun 로드한_번들로_클라이언트가_바로_조회한다() {
        bake(stableName = true)

        val client = RynL10nClient(
            BakedBundle.snapshot(dir),
            InMemoryDeliveryStore(),
            Matching.ClientContext(appVersion = "1.0.0"),
        )

        assertEquals("결제", client.t("pay.button", locale = "ko"))
        assertEquals("Pay", client.t("pay.button"))
    }
}
