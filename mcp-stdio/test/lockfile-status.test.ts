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
  assert.equal(r.bundle, null, "lockfile과 다른 번들을 읽는다고 답하면 안 된다");
  assert.equal(r.candidates.some((candidate) => candidate.wouldLoad), false);
});

test("내용해시 번들이 쌓여도 lockfile이 가리키는 번들을 SDK와 같이 고른다", () => {
  const dir = tmp();
  const bundleDir = join(dir, "rynl10n");
  mkdirSync(bundleDir, { recursive: true });
  for (const s of [snapA, snapB]) {
    writeFileSync(join(bundleDir, `snapshot-${s.base}.json`), bake(s).bundle, "utf8");
  }
  // 예전의 파일명 최소값 선택과 다른 파일을 의도한 것으로 둔다.
  const large = [snapA.base, snapB.base].sort().at(-1)!;
  const newer = snapA.base === large ? snapA : snapB;
  writeFileSync(join(bundleDir, "rynl10n.lock"), bake(newer).lockfileText, "utf8");

  const r = lockfileStatus({ outDir: dir });
  assert.equal(r.ok, true);
  assert.deepEqual(codes(r), ["ok"]);
  assert.equal(r.bundle?.base, large);
  assert.equal(r.candidates.filter((c) => c.wouldLoad).length, 1);
});

test("오래된 stable-name보다 lockfile과 일치하는 내용해시 번들을 선택한다", () => {
  const dir = tmp();
  seed(dir, snapA, { stable: true });
  const current = seed(dir, snapB);

  const r = lockfileStatus({ outDir: dir });
  assert.equal(r.ok, true);
  assert.equal(r.bundle?.path, current);
});

test("base가 같아도 release가 다른 번들은 선택하지 않는다", () => {
  const dir = tmp();
  seed(dir, snapA);
  const lock = { ...bake(snapA).lockfile, release: "another-release" };
  writeFileSync(join(dir, "rynl10n", "rynl10n.lock"), JSON.stringify(lock));

  const r = lockfileStatus({ outDir: dir });
  assert.equal(r.bundle, null);
  assert.ok(codes(r).includes("base_mismatch"));
});

test("lockfile 없이 내용해시 번들이 여럿이면 SDK처럼 선택을 거절한다", () => {
  const dir = tmp();
  const bundleDir = join(dir, "rynl10n");
  mkdirSync(bundleDir);
  for (const snap of [snapA, snapB]) {
    writeFileSync(join(bundleDir, `snapshot-${snap.base}.json`), bake(snap).bundle);
  }

  const r = lockfileStatus({ outDir: dir });
  assert.equal(r.bundle, null);
  assert.ok(codes(r).includes("stale_candidates"));
  assert.equal(r.candidates.some((candidate) => candidate.wouldLoad), false);
});

test("불완전한 lockfile은 SDK 디코더와 같이 읽기 실패로 진단한다", () => {
  const dir = tmp();
  seed(dir, snapA);
  writeFileSync(join(dir, "rynl10n", "rynl10n.lock"), JSON.stringify({ base: snapB.base, release: snapB.release }));

  const r = lockfileStatus({ outDir: dir });
  assert.ok(codes(r).includes("lockfile_unreadable"));
  assert.equal(r.bundle?.base, snapA.base, "유일한 레거시 번들은 계속 로드한다");
});

test("lockfile과 base·release만 같은 잘못된 스냅샷은 SDK처럼 고르지 않는다", () => {
  const dir = tmp();
  const path = seed(dir, snapA);
  writeFileSync(path, JSON.stringify({ base: snapA.base, release: snapA.release, defaultLocale: "en", locales: null }));

  const r = lockfileStatus({ outDir: dir });
  assert.equal(r.bundle, null);
  assert.equal(r.candidates.some((candidate) => candidate.wouldLoad), false);
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
