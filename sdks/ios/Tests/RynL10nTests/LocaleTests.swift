import Foundation
import XCTest
@testable import RynL10n

/// 조회 로케일 축 — 기획서 6.1(configure options의 로케일) / 3.1(fallback 체인).
///
/// 회귀 방지가 목적이다. 이전 구현은 `t()`의 기본 조회 로케일을
/// `locale ?? context.releaseLabel ?? bundle.defaultLocale`로 계산했는데, `releaseLabel`은
/// 5.2의 `versionMatch.strategy = "exact-label"` 판정값이지 로케일이 아니다.
/// **릴리스 매칭 축(4.3)과 로케일 축(3.1)이 서로 새면 안 된다** — 새면 exact-label을 쓰는 앱이
/// 조용히 기본 로케일로 떨어지고(크래시가 없어 드러나지 않는다) 로케일 설정 수단도 사라진다.
/// 4개 SDK가 같은 축을 본다(파리티).
final class LocaleTests: XCTestCase {
    private let bundle = Snapshot(
        schemaVersion: 1, release: "R1", base: "b0", defaultLocale: "en",
        locales: [
            "en": ["cart.title": .text("Cart")],
            "ko": ["cart.title": .text("장바구니")],
            "ko-KR": ["cart.title": .text("장바구니(KR)")],
        ])

    private func client(locale: String? = nil, context: Matching.ClientContext = .init(appVersion: "1.0.0")) -> RynL10nClient {
        RynL10nClient(bundle: bundle, store: InMemoryDeliveryStore(), context: context, locale: locale)
    }

    func testDefaultsToBundleLocale() {
        // 코어는 환경을 읽지 않는다 — 기기 로케일 주입은 앱(진입점)의 일이다.
        XCTAssertEqual(client().t("cart.title"), "Cart")
    }

    func testConfiguredLocaleIsDefaultLookupLocale() {
        let c = client(locale: "ko")
        XCTAssertEqual(c.t("cart.title"), "장바구니")
        // 호출 인자는 여전히 설정을 이긴다.
        XCTAssertEqual(c.t("cart.title", locale: "en"), "Cart")
    }

    func testConfiguredLocaleWalksFallbackChain() {
        XCTAssertEqual(client(locale: "ko-KR").t("cart.title"), "장바구니(KR)")
        XCTAssertEqual(client(locale: "ko-Hang-KR").t("cart.title"), "장바구니", "구체→일반 절단")
        XCTAssertEqual(client(locale: "fr-FR").t("cart.title"), "Cart", "어디에도 없으면 기본 로케일")
    }

    func testReleaseLabelDoesNotLeakIntoLocale() {
        // exact-label 전략을 쓰는 앱. 이전 구현은 조회 로케일을 "2024-spring"으로 삼아
        // 체인 ["2024-spring", "en"]을 타고 기본 로케일로 떨어졌다.
        let ctx = Matching.ClientContext(releaseLabel: "2024-spring")
        XCTAssertEqual(client(locale: "ko", context: ctx).t("cart.title"), "장바구니",
                       "releaseLabel이 설정 로케일을 가리면 안 된다")
        XCTAssertEqual(client(context: ctx).t("cart.title"), "Cart",
                       "로케일 미지정이면 releaseLabel이 아니라 번들 기본 로케일")
    }

    func testDeviceLocaleIsBCP47OrNil() {
        // 값 자체는 실행 환경에 달렸다. 계약은 "BCP 47 태그이거나 nil"뿐 —
        // fallback 체인(3.1)이 `-`로 절단할 수 있어야 한다.
        guard let tag = RynL10nClient.deviceLocale() else { return }
        XCTAssertFalse(tag.isEmpty)
        XCTAssertFalse(tag.contains("_"), "POSIX 형식(ko_KR)이면 체인이 절단하지 못한다")
    }
}
