package com.rynl10n

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/**
 * 조회 로케일 축 — 기획서 6.1(configure options의 로케일) / 3.1(fallback 체인).
 *
 * 회귀 방지가 목적이다. 이전 구현은 `t()`의 기본 조회 로케일을
 * `locale ?: context.releaseLabel ?: bundle.defaultLocale`로 계산했는데, `releaseLabel`은
 * 5.2의 `versionMatch.strategy = "exact-label"` 판정값이지 로케일이 아니다.
 * **릴리스 매칭 축(4.3)과 로케일 축(3.1)이 서로 새면 안 된다** — 새면 exact-label을 쓰는 앱이
 * 조용히 기본 로케일로 떨어지고(크래시가 없어 드러나지 않는다) 로케일 설정 수단도 사라진다.
 * 4개 SDK가 같은 축을 본다(파리티).
 */
class LocaleTest {
    private fun text(v: String): TranslationValue = TranslationValue.Text(v)

    private val bundle = Snapshot(
        1, "R1", "b0", "en",
        mapOf(
            "en" to mapOf("cart.title" to text("Cart")),
            "ko" to mapOf("cart.title" to text("장바구니")),
            "ko-KR" to mapOf("cart.title" to text("장바구니(KR)")),
        ),
    )

    private fun client(
        locale: String? = null,
        context: Matching.ClientContext = Matching.ClientContext(appVersion = "1.0.0"),
    ) = RynL10nClient(bundle, InMemoryDeliveryStore(), context, locale = locale)

    @Test fun defaultsToBundleLocale() {
        // 코어는 환경을 읽지 않는다 — 기기 로케일 주입은 Android 바인딩(RynL10n.configure)의 일이다.
        assertEquals("Cart", client().t("cart.title"))
    }

    @Test fun configuredLocaleIsDefaultLookupLocale() {
        val c = client(locale = "ko")
        assertEquals("장바구니", c.t("cart.title"))
        assertEquals("Cart", c.t("cart.title", locale = "en"), "호출 인자가 설정을 이긴다")
    }

    @Test fun configuredLocaleWalksFallbackChain() {
        assertEquals("장바구니(KR)", client(locale = "ko-KR").t("cart.title"))
        assertEquals("장바구니", client(locale = "ko-Hang-KR").t("cart.title"), "구체→일반 절단")
        assertEquals("Cart", client(locale = "fr-FR").t("cart.title"), "어디에도 없으면 기본 로케일")
    }

    @Test fun releaseLabelDoesNotLeakIntoLocale() {
        // exact-label 전략을 쓰는 앱. 이전 구현은 조회 로케일을 "2024-spring"으로 삼아
        // 체인 ["2024-spring", "en"]을 타고 기본 로케일로 떨어졌다.
        val ctx = Matching.ClientContext(releaseLabel = "2024-spring")
        assertEquals("장바구니", client(locale = "ko", context = ctx).t("cart.title"),
            "releaseLabel이 설정 로케일을 가리면 안 된다")
        assertEquals("Cart", client(context = ctx).t("cart.title"),
            "로케일 미지정이면 releaseLabel이 아니라 번들 기본 로케일")
    }
}
