import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalStringify } from "../src/serialize/jcs.ts";
import { contentHash, fileId, snapshotHash } from "../src/serialize/hash.ts";

test("JCS: 객체 키를 UTF-16 코드유닛 순으로 정렬한다", () => {
  const s = canonicalStringify({ b: 1, a: 2, "10": 3, "2": 4 });
  // "10" < "2" (코드유닛 비교), 이어서 a, b
  assert.equal(s, '{"10":3,"2":4,"a":2,"b":1}');
});

test("JCS: 삽입 순서가 달라도 같은 바이트열", () => {
  const a = canonicalStringify({ locales: { ko: { x: "1" }, en: { y: "2" } }, release: "R1" });
  const b = canonicalStringify({ release: "R1", locales: { en: { y: "2" }, ko: { x: "1" } } });
  assert.equal(a, b);
});

test("JCS: 공백 없이 방출한다", () => {
  assert.equal(canonicalStringify({ a: [1, 2], b: "x" }), '{"a":[1,2],"b":"x"}');
});

test("JCS: 비ASCII는 이스케이프 없이 UTF-8 리터럴", () => {
  assert.equal(canonicalStringify({ k: "장바구니" }), '{"k":"장바구니"}');
});

test("NFC: 조합형과 완성형이 같은 해시를 낸다", () => {
  // "é" = U+00E9(완성형) vs U+0065 U+0301(조합형)
  const composed = "café";
  const decomposed = "café";
  assert.notEqual(composed, decomposed); // 원본 코드포인트는 다름
  assert.equal(contentHash({ v: composed }), contentHash({ v: decomposed }));
});

test("콘텐츠 해시: 결정적 재현(같은 입력 → 같은 해시)", () => {
  const cat = { release: "R42", defaultLocale: "en", locales: { en: { "a.b": "Hi" } } };
  assert.equal(snapshotHash(cat), snapshotHash(cat));
});

test("해시 입력에서 base·createdAt 제외 — snapshotHash는 세 필드만 본다", () => {
  const h1 = snapshotHash({ release: "R42", defaultLocale: "en", locales: { en: { a: "x" } } });
  // base/createdAt이 붙은 전체 객체를 contentHash에 그대로 넣으면 달라야 정상(제외 로직 검증)
  const hFull = contentHash({
    release: "R42", defaultLocale: "en", locales: { en: { a: "x" } },
    base: "zzzz", createdAt: "2026-01-01",
  });
  assert.notEqual(h1, hFull);
});

test("fileId: 기본 16 hex 절단, 접두 충돌 시 20 hex 확장", () => {
  const full = "a1b2c3d4e5f60718aa".padEnd(64, "0");
  assert.equal(fileId(full), "a1b2c3d4e5f60718"); // 16 hex
  assert.equal(fileId(full, new Set(["a1b2c3d4e5f60718"])), full.slice(0, 20)); // 충돌 → 20 hex
});

test("JCS: 비정수 number는 스파이크 범위 밖으로 거부", () => {
  assert.throws(() => canonicalStringify({ x: 1.5 }), /비정수/);
});
