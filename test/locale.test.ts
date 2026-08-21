/**
 * 조회 로케일 축 — 기획서 6.1(configure options의 로케일) / 3.1(fallback 체인).
 *
 * 회귀 방지가 목적이다. 이전 구현은 `t()`의 기본 조회 로케일을
 * `locale ?? context.releaseLabel ?? bundle.defaultLocale`로 계산했는데, `releaseLabel`은
 * 5.2의 `versionMatch.strategy = 'exact-label'` 판정값이지 로케일이 아니다.
 * **릴리스 매칭 축(4.3)과 로케일 축(3.1)은 서로 새면 안 된다** — 새면 exact-label을 쓰는 앱이
 * 조용히 기본 로케일로 떨어지고(크래시가 없어 드러나지 않는다) 로케일 설정 수단도 사라진다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RynL10nClient, InMemoryDeliveryStore } from "../src/client/client.ts";
import type { Snapshot } from "../src/core/types.ts";

const bundle: Snapshot = {
  schemaVersion: 1,
  release: "R1",
  base: "b0",
  defaultLocale: "en",
  locales: {
    en: { "cart.title": "Cart" },
    ko: { "cart.title": "장바구니" },
    "ko-KR": { "cart.title": "장바구니(KR)" },
  },
};

const store = new InMemoryDeliveryStore();

test("locale 미지정이면 번들 기본 로케일 — 코어는 환경을 읽지 않는다", () => {
  const c = new RynL10nClient({ bundle, store, context: { appVersion: "1.0.0" } });
  assert.equal(c.t("cart.title"), "Cart");
});

test("config.locale이 t()의 기본 조회 로케일이 된다(6.1)", () => {
  const c = new RynL10nClient({ bundle, store, context: { appVersion: "1.0.0" }, locale: "ko" });
  assert.equal(c.t("cart.title"), "장바구니");
  // 호출 인자는 여전히 config를 이긴다.
  assert.equal(c.t("cart.title", {}, "en"), "Cart");
});

test("config.locale도 fallback 체인을 탄다(3.1) — 구체→일반→기본", () => {
  const c = new RynL10nClient({ bundle, store, context: { appVersion: "1.0.0" }, locale: "ko-KR" });
  assert.equal(c.t("cart.title"), "장바구니(KR)");

  // 번들에 없는 지역 변종은 부모로 절단된다.
  const c2 = new RynL10nClient({ bundle, store, context: { appVersion: "1.0.0" }, locale: "ko-Hang-KR" });
  assert.equal(c2.t("cart.title"), "장바구니");

  // 어디에도 없으면 기본 로케일.
  const c3 = new RynL10nClient({ bundle, store, context: { appVersion: "1.0.0" }, locale: "fr-FR" });
  assert.equal(c3.t("cart.title"), "Cart");
});

test("회귀: releaseLabel은 조회 로케일로 새지 않는다(매칭 축 ≠ 로케일 축)", () => {
  // exact-label 전략을 쓰는 앱. 이전 구현은 조회 로케일을 "2024-spring"으로 삼아
  // 체인 ["2024-spring", "en"]을 타고 기본 로케일로 떨어졌다 — 로케일 설정 자체가 불가능했다.
  const c = new RynL10nClient({
    bundle,
    store,
    context: { releaseLabel: "2024-spring" },
    locale: "ko",
  });
  assert.equal(c.t("cart.title"), "장바구니", "releaseLabel이 config.locale을 가리면 안 된다");

  // locale을 안 주면 releaseLabel이 아니라 번들 기본 로케일이다.
  const c2 = new RynL10nClient({ bundle, store, context: { releaseLabel: "2024-spring" } });
  assert.equal(c2.t("cart.title"), "Cart");
});
