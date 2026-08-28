/**
 * `lockfile_status` — 진단 코드마다 그 원인을 실제로 만들어 대조한다.
 *
 * 여기서 지키는 불변식은 하나다: **탐색 순서가 SDK 로더와 같아야 한다.** 어긋나면 도구가
 * "앱이 이걸 집는다"고 답한 파일과 앱이 실제로 집는 파일이 달라지고, 그건 진단 도구가 낼 수 있는
 * 최악의 오답이다. Android `BakedBundle.locate` · iOS `Snapshot.bakedURL`이 본이다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSnapshot } from "../../src/builder/builder.ts";
import { bake } from "../../src/builder/bake.ts";
import { lockfileStatus, summarize } from "../src/tools/lockfile-status.ts";
import type { Snapshot } from "../../src/core/types.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rynl10n-lockfile-"));
}

const snapA = buildSnapshot({ release: "R42", defaultLocale: "en", locales: { en: { a: "A" } } });
const snapB = buildSnapshot({ release: "R43", defaultLocale: "en", locales: { en: { a: "B" } } });

/** bake CLI가 놓는 자리 그대로. `stable`이면 --stable-name 산출물. */
function seed(outDir: string, snap: Snapshot, opts: { stable?: boolean; lockOf?: Snapshot } = {}): string {
  const bundleDir = join(outDir, "rynl10n");
  mkdirSync(bundleDir, { recursive: true });
  const name = opts.stable === true ? "snapshot.json" : `snapshot-${snap.base}.json`;
  writeFileSync(join(bundleDir, name), bake(snap).bundle, "utf8");
  writeFileSync(join(bundleDir, "rynl10n.lock"), bake(opts.lockOf ?? snap).lockfileText, "utf8");
  return join(bundleDir, name);
}

function codes(r: { diagnosis: readonly { code: string }[] }): string[] {
  return r.diagnosis.map((d) => d.code);
}

test("정상: lockfile과 번들이 일치하고 앱이 그것을 집는다", () => {
  const dir = tmp();
  seed(dir, snapA, { stable: true });
  const r = lockfileStatus({ outDir: dir });
  assert.equal(r.ok, true);
  assert.deepEqual(codes(r), ["ok"]);
  assert.equal(r.bundle?.base, snapA.base);
  assert.equal(r.bundle?.matchesLockfile, true);
  assert.equal(r.lockfile?.release, "R42");
  assert.match(summarize(r), /일치한다/);
});

test("lockfile이 없으면 대조할 근거가 없다고 말한다", () => {
  const dir = tmp();
  const bundleDir = join(dir, "rynl10n");
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(join(bundleDir, "snapshot.json"), bake(snapA).bundle, "utf8");
  const r = lockfileStatus({ outDir: dir });
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("lockfile_missing"));
  assert.equal(r.lockfile, null);
  assert.equal(r.bundle?.base, snapA.base); // 번들 자체는 읽힌다
});

test("번들이 없으면 빌드가 안 돌았거나 산출물이 다른 곳으로 갔다고 말한다", () => {
  const dir = tmp();
  const bundleDir = join(dir, "rynl10n");
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(join(bundleDir, "rynl10n.lock"), bake(snapA).lockfileText, "utf8");
  const r = lockfileStatus({ outDir: dir });
  assert.deepEqual(codes(r), ["bundle_missing"]);
  assert.equal(r.bundle, null);
  assert.equal(r.lockfile?.base, snapA.base);
});

test("lockfile이 깨져 있으면 파싱 실패를 그대로 말한다", () => {
  const dir = tmp();
  seed(dir, snapA, { stable: true });
  writeFileSync(join(dir, "rynl10n", "rynl10n.lock"), "{", "utf8");
  const r = lockfileStatus({ outDir: dir });
  assert.ok(codes(r).includes("lockfile_unreadable"));
  assert.equal(r.lockfile, null);
});

test("lockfile과 번들의 base가 다르면 잡는다 — 빌드가 반쯤 돈 자리", () => {
  const dir = tmp();
  seed(dir, snapA, { stable: true, lockOf: snapB });
  const r = lockfileStatus({ outDir: dir });
  assert.ok(codes(r).includes("base_mismatch"));
  assert.equal(r.bundle?.matchesLockfile, false);
  // lockfile이 가리키는 번들이 디렉토리에 없으므로 loads_stale_bundle은 아니다
  assert.equal(codes(r).includes("loads_stale_bundle"), false);
});

/**
 * 이 도구의 존재 이유. `--stable-name` 없이 구우면 `snapshot-<base>.json`이 쌓이고, Android는
 * **파일명 최소값**(최신이 아니다)을 집는다. lockfile이 가리키는 번들이 바로 옆에 있는데도
 * 앱은 스테일 카탈로그를 들고 조용히 돈다.
 */
test("내용해시 번들이 쌓이면: 로더가 집는 것과 lockfile이 어긋나는 것을 잡는다", () => {
  const dir = tmp();
  const bundleDir = join(dir, "rynl10n");
  mkdirSync(bundleDir, { recursive: true });
  for (const s of [snapA, snapB]) {
    writeFileSync(join(bundleDir, `snapshot-${s.base}.json`), bake(s).bundle, "utf8");
  }
  // lockfile은 "파일명이 큰 쪽"을 가리키게 둔다 — 로더는 최소값을 집으므로 어긋난다.
  const [small, large] = [snapA.base, snapB.base].sort();
  const newer = snapA.base === large ? snapA : snapB;
  writeFileSync(join(bundleDir, "rynl10n.lock"), bake(newer).lockfileText, "utf8");

  const r = lockfileStatus({ outDir: dir });
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("stale_candidates"));
  assert.ok(codes(r).includes("ios_load_order_undefined"));
  assert.ok(codes(r).includes("base_mismatch"));
  assert.ok(codes(r).includes("loads_stale_bundle"), "옆에 있는데 안 집는 경우를 잡아야 한다");
  assert.equal(r.bundle?.base, small, "Android의 minByOrNull { name }과 같은 선택이어야 한다");
  assert.equal(r.candidates.filter((c) => c.wouldLoad).length, 1);
});

test("탐색 순서가 SDK와 같다 — stable-name이 내용해시 파일보다 먼저다", () => {
  const dir = tmp();
  const bundleDir = join(dir, "rynl10n");
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(join(bundleDir, `snapshot-${snapB.base}.json`), bake(snapB).bundle, "utf8");
  writeFileSync(join(bundleDir, "snapshot.json"), bake(snapA).bundle, "utf8");
  writeFileSync(join(bundleDir, "rynl10n.lock"), bake(snapA).lockfileText, "utf8");
  const r = lockfileStatus({ outDir: dir });
  assert.equal(r.candidates[0]?.path, join(bundleDir, "snapshot.json"));
  assert.equal(r.bundle?.base, snapA.base);
});

test("rynl10n/ 없이 루트에 놓인 산출물도 찾는다(vendored 배치)", () => {
  const dir = tmp();
  writeFileSync(join(dir, "snapshot.json"), bake(snapA).bundle, "utf8");
  writeFileSync(join(dir, "rynl10n.lock"), bake(snapA).lockfileText, "utf8");
  const r = lockfileStatus({ outDir: dir });
  assert.equal(r.ok, true);
  assert.equal(r.bundle?.path, join(dir, "snapshot.json"));
  assert.equal(r.lockfile?.path, join(dir, "rynl10n.lock"));
});

test("번들을 손으로 고치면 base 무결성이 걸린다", () => {
  const dir = tmp();
  seed(dir, snapA, { stable: true });
  const tampered = { ...snapA, locales: { en: { a: "손으로 고침" } } };
  writeFileSync(join(dir, "rynl10n", "snapshot.json"), JSON.stringify(tampered), "utf8");
  const r = lockfileStatus({ outDir: dir });
  assert.ok(codes(r).includes("base_integrity_failed"));
  assert.equal(r.bundle?.baseIntegrity.ok, false);
});

test("아무것도 없으면 lockfile·번들 둘 다 없다고 말한다", () => {
  const r = lockfileStatus({ outDir: tmp() });
  assert.deepEqual(codes(r).sort(), ["bundle_missing", "lockfile_missing"]);
  assert.equal(r.ok, false);
  assert.equal(r.candidates.length, 0);
});
