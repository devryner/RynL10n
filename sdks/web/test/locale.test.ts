/**
 * 조회 로케일 축 — 기획서 6.1(configure options의 로케일) / 3.1(fallback 체인).
 *
 * 회귀 방지가 목적이다. 이전 구현은 `t()`의 기본 조회 로케일을
 * `locale ?? context.releaseLabel ?? bundle.defaultLocale`로 계산했는데, `releaseLabel`은
 * 5.2의 `versionMatch.strategy = "exact-label"` 판정값이지 로케일이 아니다.
 * **릴리스 매칭 축(4.3)과 로케일 축(3.1)이 서로 새면 안 된다.** 4개 SDK가 같은 축을 본다(파리티).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot } from "../../../src/builder/builder.ts";
import { HttpRynL10n, browserLocale } from "../src/http.ts";
import { memoryCache } from "../src/cache.ts";

const bundle = buildSnapshot({
  release: "R1",
  defaultLocale: "en",
  locales: {
    en: { "cart.title": "Cart" },
    ko: { "cart.title": "장바구니" },
    "ko-KR": { "cart.title": "장바구니(KR)" },
  },
});

// 네트워크는 쓰지 않는다 — t()는 동기이고 번들만으로 답한다. 캐시는 테스트 간 격리를 위해 메모리로.
function sdk(locale?: string, context: { appVersion?: string; releaseLabel?: string } = { appVersion: "1.0.0" }) {
  return new HttpRynL10n({
    projectKey: "shop",
    endpoint: "http://127.0.0.1:1", // 호출되지 않는다
    bundle,
    context,
    cache: memoryCache(),
    ...(locale !== undefined ? { locale } : {}),
  });
}

test("locale 미지정 + 브라우저 아님 → 번들 기본 로케일", () => {
  // Node에는 window가 없다 → browserLocale()이 undefined → 코어가 기본 로케일을 쓴다.
  assert.equal(browserLocale(), undefined);
  assert.equal(sdk().t("cart.title"), "Cart");
});

test("config.locale이 t()의 기본 조회 로케일이 된다(6.1)", () => {
  const s = sdk("ko");
  assert.equal(s.t("cart.title"), "장바구니");
  assert.equal(s.t("cart.title", {}, "en"), "Cart", "호출 인자가 설정을 이긴다");
});

test("config.locale도 fallback 체인을 탄다(3.1) — 구체→일반→기본", () => {
  assert.equal(sdk("ko-KR").t("cart.title"), "장바구니(KR)");
  assert.equal(sdk("ko-Hang-KR").t("cart.title"), "장바구니");
  assert.equal(sdk("fr-FR").t("cart.title"), "Cart");
});

test("회귀: releaseLabel은 조회 로케일로 새지 않는다(매칭 축 ≠ 로케일 축)", () => {
  const ctx = { releaseLabel: "2024-spring" };
  assert.equal(sdk("ko", ctx).t("cart.title"), "장바구니", "releaseLabel이 설정 로케일을 가리면 안 된다");
  assert.equal(sdk(undefined, ctx).t("cart.title"), "Cart", "미지정이면 releaseLabel이 아니라 기본 로케일");
});

test("browserLocale: window.navigator를 보고, globalThis.navigator는 보지 않는다", () => {
  const g = globalThis as { window?: unknown; navigator?: unknown };
  const hadWindow = "window" in g;
  const prevWindow = g.window;
  try {
    g.window = { navigator: { language: "ko-KR" } };
    assert.equal(browserLocale(), "ko-KR");
    assert.equal(sdk().t("cart.title"), "장바구니(KR)", "브라우저면 기기 언어가 기본 조회 로케일");

    // 빈 문자열은 값이 아니다 → 코어가 기본 로케일로 물러난다.
    g.window = { navigator: { language: "" } };
    assert.equal(browserLocale(), undefined);
  } finally {
    if (hadWindow) g.window = prevWindow;
    else delete g.window;
  }
});
