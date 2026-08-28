import { test } from "node:test";
import assert from "node:assert/strict";
import { OverlayLayer, resolveValue, formatValue, fallbackChain } from "../src/core/resolve.ts";
import type { Snapshot } from "../src/core/types.ts";

const bundle: Snapshot = {
  schemaVersion: 1,
  release: "R42",
  base: "a1b2c3d4e5f60718",
  defaultLocale: "en",
  locales: {
    en: { "cart.title": "Cart", "cart.items": { one: "{n} item", other: "{n} items" }, "cart.empty": "" },
    ko: { "cart.title": "장바구니" },
    "ko-KR": {},
  },
};

test("오버레이 우선, 없으면 번들 (키 단위 override)", () => {
  const overlay = new OverlayLayer();
  overlay.set("ko", "cart.title", "카트");
  assert.equal(resolveValue(bundle, overlay, "cart.title", "ko").value, "카트");
  assert.equal(resolveValue(bundle, overlay, "cart.title", "ko").source, "overlay");
  // 오버레이에 없는 키는 번들
  assert.equal(resolveValue(bundle, new OverlayLayer(), "cart.title", "ko").value, "장바구니");
});

test("로케일 우선 원칙: ko-KR에 없으면 ko(오버레이+번들)를 먼저, 그 다음 en", () => {
  const overlay = new OverlayLayer();
  // ko-KR엔 아무것도 없음. ko 번들에 값 있음 → en으로 넘어가기 전에 ko가 이긴다.
  const r = resolveValue(bundle, overlay, "cart.title", "ko-KR");
  assert.equal(r.value, "장바구니");
  assert.equal(r.matchedLocale, "ko");
});

test("로케일 우선: 덜 구체적 로케일의 최신보다 더 구체적 로케일의 기존이 우선", () => {
  const overlay = new OverlayLayer();
  overlay.set("en", "cart.title", "CART-NEW"); // en 오버레이(최신)
  const r = resolveValue(bundle, overlay, "cart.title", "ko-KR"); // ko-KR → ko(번들) → en
  assert.equal(r.value, "장바구니"); // ko 기존이 en 최신보다 우선
});

test("fallback 체인: BCP47 절단 + 기본 로케일", () => {
  assert.deepEqual(fallbackChain("ko-KR", "en"), ["ko-KR", "ko", "en"]);
  assert.deepEqual(fallbackChain("en", "en"), ["en"]);
  assert.deepEqual(fallbackChain("zh-Hant-TW", "en"), ["zh-Hant-TW", "zh-Hant", "zh", "en"]);
});

test("로케일 override: pt-BR → en (명시적 부모)", () => {
  assert.deepEqual(fallbackChain("pt-BR", "en", { "pt-BR": "en" }), ["pt-BR", "en"]);
});

test("포맷 안전 가드: 플레이스홀더 서명 불일치 시 해당 키만 번들로 fallback", () => {
  const overlay = new OverlayLayer();
  overlay.set("en", "cart.items", { one: "{n} item", other: "{count} items" }); // {count}로 서명 불일치
  const r = resolveValue(bundle, overlay, "cart.items", "en");
  assert.equal(r.guardFallback, true);
  assert.equal(r.source, "bundle");
  assert.deepEqual(r.value, { one: "{n} item", other: "{n} items" });
});

test("포맷 가드: 서명 일치하면 오버레이 채택", () => {
  const overlay = new OverlayLayer();
  overlay.set("en", "cart.items", { one: "{n} thing", other: "{n} things" });
  const r = resolveValue(bundle, overlay, "cart.items", "en");
  assert.equal(r.guardFallback, false);
  assert.equal(r.source, "overlay");
});

test("tombstone: 삭제된 키는 번들을 가리고 다음 로케일로", () => {
  const overlay = new OverlayLayer();
  overlay.tombstone("ko", "cart.title"); // ko에서 삭제
  const r = resolveValue(bundle, overlay, "cart.title", "ko");
  // ko 번들("장바구니")은 가려지고, en 번들("Cart")로 fallback
  assert.equal(r.value, "Cart");
  assert.equal(r.matchedLocale, "en");
});

test("빈 문자열은 의도적 빈 값(키 누락과 구분)", () => {
  const r = resolveValue(bundle, new OverlayLayer(), "cart.empty", "en");
  assert.equal(r.value, "");
  assert.equal(r.source, "bundle"); // unresolved가 아님
});

test("미해결 키: 체인 소진 시 unresolved", () => {
  const r = resolveValue(bundle, new OverlayLayer(), "no.such.key", "ko-KR");
  assert.equal(r.source, "unresolved");
  assert.equal(r.value, undefined);
});

test("포맷팅: named 치환 + CLDR 복수형(en one/other, ko other)", () => {
  const items = bundle.locales.en!["cart.items"]!;
  assert.equal(formatValue(items, "en", { n: 1 }), "1 item");
  assert.equal(formatValue(items, "en", { n: 5 }), "5 items");
  // ko는 복수 구분 없음 → other
  const koItems = { other: "{n}개" };
  assert.equal(formatValue(koItems, "ko", { n: 3 }), "3개");
});

// ── ICU argName 경계 (5.3) ───────────────────────────────────────────────────
//
// argName은 Pattern_Syntax도 Pattern_White_Space도 아닌 문자 1개 이상이라 비ASCII를 허용한다.
// 스캔이 `[A-Za-z0-9_]+`였을 때는 `{이름}`이 리터럴이었고, 그래서 **번들에 플레이스홀더가
// 없던 키**에서는 양쪽 서명이 모두 ""라 가드가 그냥 열렸다 — 오버레이가 그대로 적용되고
// 런타임에 중괄호가 보였다. 서명·치환·변환이 같은 정의를 봐야 이게 닫힌다(`src/core/icu.ts`).

test("비ASCII 인자: 서명이 없던 키에 새로 넣으면 가드가 잡는다", () => {
  const overlay = new OverlayLayer();
  overlay.set("en", "cart.title", "{이름}의 장바구니");
  const r = resolveValue(bundle, overlay, "cart.title", "en");
  assert.equal(r.guardFallback, true);
  assert.equal(r.source, "bundle");
  assert.equal(r.value, "Cart");
});

test("비ASCII 인자: 서명이 같으면 오버레이가 적용되고 치환까지 된다", () => {
  const overlay = new OverlayLayer();
  overlay.set("ko", "cart.title", "{이름}의 카트");
  const bundleWithArg: Snapshot = {
    ...bundle,
    locales: { ...bundle.locales, ko: { "cart.title": "{이름} 장바구니" } },
  };
  const r = resolveValue(bundleWithArg, overlay, "cart.title", "ko");
  assert.equal(r.guardFallback, false);
  assert.equal(r.source, "overlay");
  assert.equal(formatValue(r.value!, "ko", { 이름: "솔" }), "솔의 카트");
});

test("Pattern_Syntax 기호는 인자가 아니다 — 화살표·기호는 리터럴로 남는다", () => {
  assert.equal(formatValue("{→} {★}", "en", {}), "{→} {★}");
});
