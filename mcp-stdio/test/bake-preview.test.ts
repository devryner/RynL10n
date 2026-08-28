/**
 * `bake_preview` — 미리보기가 실제 빌드와 갈라지지 않는가.
 *
 * 검증 축은 셋이다: ① 경로 규약이 bake CLI와 같은가 ② 아무것도 쓰지 않는가
 * ③ 판정(경고·카탈로그 diff)을 코어에서 가져오는가.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSnapshot } from "../../src/builder/builder.ts";
import { bake } from "../../src/builder/bake.ts";
import { toAndroidStringsXml, toXcstrings } from "../../src/builder/convert.ts";
import { bakePreview, summarize } from "../src/tools/bake-preview.ts";
import type { Snapshot } from "../../src/core/types.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rynl10n-bake-preview-"));
}

const snapV1 = buildSnapshot({
  release: "R42", defaultLocale: "en",
  locales: { en: { "cart.title": "Cart", "cart.note": "Note" }, ko: { "cart.title": "장바구니", "cart.note": "메모" } },
});
const snapV2 = buildSnapshot({
  release: "R42", defaultLocale: "en",
  locales: { en: { "cart.title": "Cart", "cart.note": "Notes" }, ko: { "cart.title": "장바구니" } },
});

/** 스냅샷을 파일로 놓고 경로를 돌려준다. */
function writeSnapshot(dir: string, snap: Snapshot, name = "snapshot-source.json"): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(snap), "utf8");
  return p;
}

/** bake CLI가 하는 것과 같은 자리에 산출물을 놓는다(빌드가 한 번 돈 상태). */
function seedBaked(outDir: string, snap: Snapshot, opts: { android?: boolean } = {}): void {
  const bundleDir = join(outDir, "rynl10n");
  mkdirSync(bundleDir, { recursive: true });
  const result = bake(snap);
  writeFileSync(join(bundleDir, `snapshot-${snap.base}.json`), result.bundle, "utf8");
  writeFileSync(join(bundleDir, "rynl10n.lock"), result.lockfileText, "utf8");
  if (opts.android === true) {
    for (const [locale, catalog] of Object.entries(snap.locales)) {
      const dir = join(bundleDir, "res", locale === snap.defaultLocale ? "values" : `values-${locale}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "strings.xml"), toAndroidStringsXml(catalog).output, "utf8");
    }
  }
}

test("첫 빌드: 산출물이 없으면 전부 추가 · 카탈로그 diff는 null(전부 추가를 델타로 부풀리지 않는다)", () => {
  const dir = tmp();
  const r = bakePreview({ snapshot: writeSnapshot(dir, snapV1), outDir: join(dir, "out") });
  assert.equal(r.bundle.status, "추가");
  assert.equal(r.lockfile.status, "추가");
  assert.equal(r.lockfile.current, null);
  assert.equal(r.catalogDiff, null);
  assert.equal(r.unchanged, false);
  assert.equal(r.release, "R42");
  assert.deepEqual([...r.locales], ["en", "ko"]);
});

test("경로 규약이 bake CLI와 같다 — outDir/rynl10n/{snapshot-<base>.json, rynl10n.lock}", () => {
  const dir = tmp();
  const out = join(dir, "out");
  const r = bakePreview({ snapshot: writeSnapshot(dir, snapV1), outDir: out });
  assert.equal(r.bundle.path, join(out, "rynl10n", `snapshot-${snapV1.base}.json`));
  assert.equal(r.lockfile.path, join(out, "rynl10n", "rynl10n.lock"));
});

test("stableName이면 번들 파일명이 고정된다(빌드 그래프 output 선언용)", () => {
  const dir = tmp();
  const out = join(dir, "out");
  const r = bakePreview({ snapshot: writeSnapshot(dir, snapV1), outDir: out, stableName: true });
  assert.equal(r.bundle.path, join(out, "rynl10n", "snapshot.json"));
});

test("같은 스냅샷을 다시 보면 바뀔 것이 없다 — unchanged", () => {
  const dir = tmp();
  const out = join(dir, "out");
  seedBaked(out, snapV1);
  const r = bakePreview({ snapshot: writeSnapshot(dir, snapV1), outDir: out });
  assert.equal(r.bundle.status, "동일");
  assert.equal(r.lockfile.status, "동일");
  assert.equal(r.unchanged, true);
  assert.equal(r.catalogDiff?.opCount, 0);
  assert.match(summarize(r), /바꿀 산출물이 없다/);
});

test("바뀐 스냅샷: 카탈로그 diff가 로케일별 set/delete로 나온다(buildDelta를 그대로 쓴다)", () => {
  const dir = tmp();
  const out = join(dir, "out");
  seedBaked(out, snapV1);
  const r = bakePreview({ snapshot: writeSnapshot(dir, snapV2), outDir: out });
  assert.equal(r.bundle.status, "추가"); // 내용해시 파일명이라 새 base는 새 파일이다
  assert.equal(r.lockfile.status, "변경");
  assert.equal(r.unchanged, false);
  assert.equal(r.catalogDiff?.from, snapV1.base);
  assert.equal(r.catalogDiff?.to, snapV2.base);
  assert.deepEqual(r.catalogDiff?.byLocale, { en: { set: 1, delete: 0 }, ko: { set: 0, delete: 1 } });
  assert.deepEqual([...(r.catalogDiff?.sample ?? [])], ["en cart.note set", "ko cart.note delete"]);
});

test("직전 lockfile을 함께 돌려준다 — 어느 릴리스·base에서 오는 변경인지", () => {
  const dir = tmp();
  const out = join(dir, "out");
  seedBaked(out, snapV1);
  const r = bakePreview({ snapshot: writeSnapshot(dir, snapV2), outDir: out });
  assert.equal(r.lockfile.current?.base, snapV1.base);
  assert.equal(r.lockfile.next.base, snapV2.base);
});

test("android: 로케일별 res/values[-locale]/strings.xml을 비교한다", () => {
  const dir = tmp();
  const out = join(dir, "out");
  seedBaked(out, snapV1, { android: true });
  const same = bakePreview({ snapshot: writeSnapshot(dir, snapV1), outDir: out, platform: "android" });
  assert.deepEqual(same.native.map((f) => f.status), ["동일", "동일"]);
  assert.equal(same.native[0]?.path, join(out, "rynl10n", "res", "values", "strings.xml"));
  assert.equal(same.native[1]?.path, join(out, "rynl10n", "res", "values-ko", "strings.xml"));

  const changed = bakePreview({ snapshot: writeSnapshot(dir, snapV2, "v2.json"), outDir: out, platform: "android" });
  assert.deepEqual(changed.native.map((f) => f.status), ["변경", "변경"]);
});

/**
 * 설명 사이드카는 **빌드가 `--descriptions`를 쓸 때만** 준다. 두 CLI 모두 그 플래그로 주석을 굽는데
 * (2026-08-28에 Android CLI에도 들어왔다), 빌드가 안 쓰는데 미리보기만 주석을 넣으면 "변경"이라
 * 답해 놓고 빌드는 안 바꾼다. 그 차이가 그대로 가짜 신호가 된다.
 */
test("android: descriptions를 주면 주석까지 반영해 비교한다 — 안 주면 주석 없는 산출물과 같다", () => {
  const dir = tmp();
  const out = join(dir, "out");
  seedBaked(out, snapV1, { android: true }); // 주석 없이 구워진 상태
  const path = writeSnapshot(dir, snapV1);

  const withoutDesc = bakePreview({ snapshot: path, outDir: out, platform: "android" });
  assert.deepEqual(withoutDesc.native.map((f) => f.status), ["동일", "동일"]);

  const descPath = join(dir, "descriptions.json");
  writeFileSync(descPath, JSON.stringify({ "cart.title": "장바구니 상단 제목." }), "utf8");
  const withDesc = bakePreview({ snapshot: path, outDir: out, platform: "android", descriptions: descPath });
  assert.deepEqual(withDesc.native.map((f) => f.status), ["변경", "변경"], "주석이 붙으면 산출물이 달라진다");
});

/**
 * iOS bake CLI는 `.xcstrings`를 Foundation JSONEncoder로 쓴다 — `"key" : value`라 Node의
 * `JSON.stringify`와 바이트가 절대 같지 않다. 바이트로 비교하면 내용이 같아도 매번 "변경"이라
 * 답하게 되므로 **의미로 비교한다.** 여기서 그 불변식을 고정한다.
 */
test("ios: .xcstrings는 서식이 달라도 내용이 같으면 동일 — Foundation 포맷을 흉내내지 않는다", () => {
  const dir = tmp();
  const out = join(dir, "out");
  const bundleDir = join(out, "rynl10n");
  mkdirSync(bundleDir, { recursive: true });
  const preview = bakePreview({ snapshot: writeSnapshot(dir, snapV1), outDir: out, platform: "ios" });
  assert.equal(preview.native[0]?.status, "추가");

  // Foundation 스타일(콜론 앞 공백 + 키 정렬)로 같은 내용을 써 둔다.
  const foundationish = JSON.stringify(toXcstrings(snapV1).output, null, 2).replace(/": /g, '" : ');
  writeFileSync(join(bundleDir, "Localizable.xcstrings"), foundationish, "utf8");
  const again = bakePreview({ snapshot: writeSnapshot(dir, snapV1), outDir: out, platform: "ios" });
  assert.equal(again.native[0]?.status, "동일");
});

test("커버리지 갭은 경고로 남는다 — strict면 실패한다(bake()의 판정을 그대로 쓴다)", () => {
  const dir = tmp();
  const gapped = buildSnapshot({
    release: "R7", defaultLocale: "en",
    locales: { en: { a: "A" }, ko: { a: "가", "ko.only": "코" } },
  });
  const path = writeSnapshot(dir, gapped);
  const r = bakePreview({ snapshot: path, outDir: join(dir, "out") });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /커버리지 갭/);
  assert.throws(() => bakePreview({ snapshot: path, outDir: join(dir, "out"), strict: true }), /커버리지 갭/);
});

test("아무것도 쓰지 않는다 — outDir이 없으면 없는 채로 남는다", () => {
  const dir = tmp();
  const out = join(dir, "out");
  bakePreview({ snapshot: writeSnapshot(dir, snapV1), outDir: out, platform: "android" });
  assert.equal(existsSync(out), false);
});

test("기존 산출물을 건드리지 않는다 — 미리보기 전후 바이트가 같다", () => {
  const dir = tmp();
  const out = join(dir, "out");
  seedBaked(out, snapV1, { android: true });
  const before = snapshotTree(join(out, "rynl10n"));
  bakePreview({ snapshot: writeSnapshot(dir, snapV2), outDir: out, platform: "android" });
  assert.deepEqual(snapshotTree(join(out, "rynl10n")), before);
});

test("스냅샷이 없거나 형식이 아니면 무엇이 문제인지 말한다", () => {
  const dir = tmp();
  assert.throws(() => bakePreview({ snapshot: join(dir, "없음.json"), outDir: dir }), /찾을 수 없다/);
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{}", "utf8");
  assert.throws(() => bakePreview({ snapshot: bad, outDir: dir }), /스냅샷 형식이 아니다/);
  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{", "utf8");
  assert.throws(() => bakePreview({ snapshot: broken, outDir: dir }), /파싱 실패/);
});

/** 디렉토리의 (상대경로 → 내용) 전체. 쓰기가 없었음을 바이트로 확인하기 위한 것. */
function snapshotTree(root: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(out, snapshotTree(join(root, entry.name), rel));
    else out[rel] = readFileSync(join(root, entry.name), "utf8");
  }
  return out;
}
