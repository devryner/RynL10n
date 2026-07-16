import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot } from "../src/builder/builder.ts";
import { bake, baseLocaleCoverage, verifyBase, buildLockfile, BakeError } from "../src/builder/bake.ts";
import type { Snapshot } from "../src/core/types.ts";

test("커버리지: 기본 로케일에 모든 키가 있으면 갭 없음", () => {
  const snap = buildSnapshot({ release: "R1", defaultLocale: "en", locales: { en: { a: "A", b: "B" }, ko: { a: "가" } } });
  assert.deepEqual(baseLocaleCoverage(snap), []);
});

test("커버리지: 기본 로케일에 없는 키를 갭으로 보고(정렬)", () => {
  const snap = buildSnapshot({ release: "R1", defaultLocale: "en", locales: { en: { a: "A" }, ko: { z: "ز", a: "가" }, ja: { z: "ぜ" } } });
  const gaps = baseLocaleCoverage(snap);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]!.key, "z");
  assert.deepEqual(gaps[0]!.presentIn, ["ja", "ko"]);
});

test("verifyBase: 올바른 base는 ok, 조작된 base는 불일치", () => {
  const snap = buildSnapshot({ release: "R1", defaultLocale: "en", locales: { en: { a: "A" } } });
  assert.equal(verifyBase(snap).ok, true);
  const bad: Snapshot = { ...snap, base: "0000000000000000" };
  const r = verifyBase(bad);
  assert.equal(r.ok, false);
  assert.equal(r.expected, snap.base);
});

test("lockfile: release·base·keyCount·locales 결정적", () => {
  const snap = buildSnapshot({ release: "R42", defaultLocale: "en", locales: { en: { a: "A", b: "B" }, ko: { a: "가" } } });
  const lock = buildLockfile(snap);
  assert.equal(lock.release, "R42");
  assert.equal(lock.base, snap.base);
  assert.equal(lock.keyCount, 2);
  assert.deepEqual(lock.locales, ["en", "ko"]);
});

test("bake: 정상 스냅샷은 번들+lockfile 산출, 경고 없음", () => {
  const snap = buildSnapshot({ release: "R1", defaultLocale: "en", locales: { en: { a: "A" }, ko: { a: "가" } } });
  const r = bake(snap);
  assert.equal(r.warnings.length, 0);
  assert.equal(r.bundlePath, `rynl10n/snapshot-${snap.base}.json`);
  assert.ok(r.lockfileText.startsWith("{"));
});

test("bake strict: 커버리지 갭이면 BakeError", () => {
  const snap = buildSnapshot({ release: "R1", defaultLocale: "en", locales: { en: {}, ko: { a: "가" } } });
  assert.throws(() => bake(snap, { strict: true }), BakeError);
  // 비strict는 경고만
  assert.equal(bake(snap).warnings.length, 1);
});
