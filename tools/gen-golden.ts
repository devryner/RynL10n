/**
 * 골든 벡터 생성기 — M0 TS 참조 구현이 정규화·해시·resolve·매칭·semver의 기대 출력을
 * 언어 무관 JSON으로 방출한다. Swift/Kotlin SDK는 이 벡터로 바이트/해시/동작 정합성을 검증한다.
 *
 * 실행: `npm run gen:golden` → fixtures/golden/*.json
 *
 * 이 파일이 크로스 언어 계약의 단일 원천이다. 스키마/알고리즘이 바뀌면 재생성하고 커밋한다.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { canonicalStringify } from "../src/serialize/jcs.ts";
import { contentHash, fileId, snapshotHash } from "../src/serialize/hash.ts";
import { buildDelta, buildSnapshot } from "../src/builder/builder.ts";
import { OverlayLayer, resolveValue, formatValue } from "../src/core/resolve.ts";
import { selectRelease } from "../src/core/matching.ts";
import { parseRange, versionInRange } from "../src/core/semver.ts";
import { baseLocaleCoverage, verifyBase, buildLockfile, lockfileString, bundleString } from "../src/builder/bake.ts";
import { toAndroidStringsXml, toXcstrings, toWebJson, toArb } from "../src/builder/convert.ts";
import type { ManifestRelease, Snapshot, TranslationValue } from "../src/core/types.ts";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "golden");
function write(name: string, data: unknown) {
  writeFileSync(join(OUT, name), JSON.stringify(data, null, 2) + "\n");
  console.log(`  ✓ ${name}`);
}

// ── 1) 직렬화 & 해시 ──────────────────────────────────────────────────────────
const canonCases = [
  { name: "정렬+삽입순서무관", value: { b: 1, a: 2, locales: { ko: { x: "1" }, en: { y: "2" } } } },
  { name: "정수키_UTF16정렬", value: { "10": 3, "2": 4, a: 2 } },
  { name: "비ASCII_UTF8리터럴", value: { k: "장바구니", j: "支払い" } },
  { name: "제어문자_이스케이프", value: { s: "a\tb\nc\"d\\e" } },
  { name: "중첩배열", value: { ops: [{ op: "set", k: "a" }, { op: "delete", k: "b" }], n: 1 } },
];
write("serialize.json", {
  description: "canonicalStringify(value) === canonical, sha256(canonical UTF-8) === sha256, fileId(sha256)===fileId16",
  cases: canonCases.map((c) => {
    const canonical = canonicalStringify(c.value);
    const sha256 = contentHash(c.value);
    return { name: c.name, value: c.value, canonical, sha256, fileId16: fileId(sha256) };
  }),
});

// ── 2) NFC 정규화 ────────────────────────────────────────────────────────────
write("nfc.json", {
  description: "NFC 정규화 후 같은 해시. Swift/Kotlin은 입력을 NFC 정규화해야 동일 해시가 나온다.",
  cases: [
    { name: "café_완성형vs조합형", composed: "café", decomposed: "café", sha256: contentHash({ v: "café" }) },
    { name: "한글_조합형", composed: "한글", decomposed: "한글", sha256: contentHash({ v: "한글" }) },
  ],
});

// ── 3) 스냅샷 base 해시 (빌드 결정성) ─────────────────────────────────────────
const snapCatalogs: Array<{ name: string; release: string; defaultLocale: string; locales: Record<string, Record<string, TranslationValue>> }> = [
  {
    name: "cart", release: "R42", defaultLocale: "en",
    locales: {
      en: { "cart.title": "Cart", "cart.items": { one: "{n} item", other: "{n} items" }, "cart.empty": "" },
      ko: { "cart.title": "장바구니", "cart.items": { other: "{n}개" } },
    },
  },
  { name: "home", release: "R50", defaultLocale: "en", locales: { en: { "home.title": "Home", "home.newBadge": "NEW" } } },
];
write("snapshot-hash.json", {
  description: "buildSnapshot(catalog).base === base16, snapshotHash===fullHash. 키 순서 무관·NFC 후 동일.",
  cases: snapCatalogs.map((c) => {
    const snap = buildSnapshot({ release: c.release, defaultLocale: c.defaultLocale, locales: c.locales });
    return {
      name: c.name,
      input: { release: c.release, defaultLocale: c.defaultLocale, locales: c.locales },
      canonical: canonicalStringify({ release: c.release, defaultLocale: c.defaultLocale, locales: c.locales }),
      fullHash: snapshotHash({ release: c.release, defaultLocale: c.defaultLocale, locales: c.locales }),
      base16: snap.base,
    };
  }),
});

// ── 4) 델타 (sparse diff, 정렬) ──────────────────────────────────────────────
const v0 = buildSnapshot({ release: "R42", defaultLocale: "en", locales: { en: { a: "1", b: "2", del: "x" }, ko: { a: "가" } } });
const v1 = buildSnapshot({ release: "R42", defaultLocale: "en", locales: { en: { a: "1", b: "22" }, ko: { a: "가", c: "다" } } });
write("delta.json", {
  description: "buildDelta(from,to).ops === ops ((locale,key,op) 사전순). from/to는 base16.",
  case: { from: v0, to: v1, delta: buildDelta(v0, v1) },
});

// ── 5) 2계층 resolve (로케일 우선·포맷 가드·tombstone) ────────────────────────
const rBundle: Snapshot = {
  schemaVersion: 1, release: "R42", base: "0000000000000000", defaultLocale: "en",
  locales: {
    en: { "cart.title": "Cart", "cart.items": { one: "{n} item", other: "{n} items" }, "cart.empty": "" },
    ko: { "cart.title": "장바구니" },
    "ko-KR": {},
  },
};
type OverlayInput = Array<{ locale: string; key: string; value?: TranslationValue; tombstone?: true }>;
function buildOverlayFrom(inp: OverlayInput): OverlayLayer {
  const o = new OverlayLayer();
  for (const e of inp) { if (e.tombstone) o.tombstone(e.locale, e.key); else o.set(e.locale, e.key, e.value!); }
  return o;
}
const resolveCases: Array<{ name: string; overlay: OverlayInput; key: string; locale: string }> = [
  { name: "오버레이_우선", overlay: [{ locale: "ko", key: "cart.title", value: "카트" }], key: "cart.title", locale: "ko" },
  { name: "번들_fallback", overlay: [], key: "cart.title", locale: "ko" },
  { name: "로케일우선_koKR→ko", overlay: [], key: "cart.title", locale: "ko-KR" },
  { name: "로케일우선_구체적기존>일반최신", overlay: [{ locale: "en", key: "cart.title", value: "CART-NEW" }], key: "cart.title", locale: "ko-KR" },
  { name: "포맷가드_불일치→번들", overlay: [{ locale: "en", key: "cart.items", value: { one: "{n} item", other: "{count} items" } }], key: "cart.items", locale: "en" },
  { name: "포맷가드_일치→오버레이", overlay: [{ locale: "en", key: "cart.items", value: { one: "{n} thing", other: "{n} things" } }], key: "cart.items", locale: "en" },
  { name: "tombstone_가림→다음로케일", overlay: [{ locale: "ko", key: "cart.title", tombstone: true }], key: "cart.title", locale: "ko" },
  { name: "빈문자열_유효", overlay: [], key: "cart.empty", locale: "en" },
  { name: "미해결", overlay: [], key: "no.such", locale: "ko-KR" },
];
write("resolve.json", {
  description: "resolveValue(bundle, overlay(from ops), key, locale) → {value, source, matchedLocale, guardFallback}",
  bundle: rBundle,
  cases: resolveCases.map((c) => {
    const r = resolveValue(rBundle, buildOverlayFrom(c.overlay), c.key, c.locale);
    return {
      name: c.name, overlay: c.overlay, key: c.key, locale: c.locale,
      expected: { value: r.value ?? null, source: r.source, matchedLocale: r.matchedLocale ?? null, guardFallback: r.guardFallback },
    };
  }),
});

// ── 6) 포맷팅 (ICU named + CLDR 복수형) ───────────────────────────────────────
const fmtCases: Array<{ name: string; value: TranslationValue; locale: string; args: Record<string, unknown> }> = [
  { name: "en_one", value: { one: "{n} item", other: "{n} items" }, locale: "en", args: { n: 1 } },
  { name: "en_other", value: { one: "{n} item", other: "{n} items" }, locale: "en", args: { n: 5 } },
  { name: "ko_other", value: { other: "{n}개" }, locale: "ko", args: { n: 3 } },
  { name: "named_치환", value: "Hello {name}", locale: "en", args: { name: "Sol" } },
  { name: "sharp_치환", value: { one: "# item", other: "# items" }, locale: "en", args: { count: 7 } },
];
write("format.json", {
  description: "formatValue(value, locale, args) → string",
  cases: fmtCases.map((c) => ({ name: c.name, value: c.value, locale: c.locale, args: c.args, expected: formatValue(c.value, c.locale, c.args) })),
});

// ── 7) semver 부분집합 매칭 & 파싱 거부 ───────────────────────────────────────
const semverSat: Array<{ version: string; range: string; matchPrerelease?: boolean }> = [
  { version: "3.2.5", range: ">=3.2.0 <3.3.0" },
  { version: "3.3.0", range: ">=3.2.0 <3.3.0" },
  { version: "3.2.0", range: ">=3.2.0 <3.3.0" },
  { version: "9.9.9", range: ">=3.2.0" },
  { version: "3.2.0", range: "=3.2.0" },
  { version: "3.2.0-rc1", range: ">=3.2.0 <3.3.0" },
  { version: "3.2.0-rc1", range: ">=3.2.0-rc0 <3.3.0", matchPrerelease: true },
];
const semverReject = [">=3.2.0 || >=4.0.0", "^3.2.0", "~3.2.0", "3.2.x", "3.2.0 - 3.3.0", "1.2"];
write("semver.json", {
  description: "versionInRange(version, range, {matchPrerelease}) === satisfies. reject[]는 parseRange가 예외.",
  satisfies: semverSat.map((c) => ({ ...c, expected: versionInRange(c.version, c.range, c.matchPrerelease ? { matchPrerelease: true } : {}) })),
  reject: semverReject.map((range) => {
    let threw = false;
    try { parseRange(range); } catch { threw = true; }
    return { range, expectedThrow: threw };
  }),
});

// ── 8) 클라이언트 릴리스 판정 (manifest 라우팅) ───────────────────────────────
function rel(id: string, value: string, state: ManifestRelease["state"] = "published", strategy: "semver-range" | "exact-label" = "semver-range"): ManifestRelease {
  return { id, state, versionMatch: { strategy, value }, base: id.toLowerCase(), overlay: id.toLowerCase(), rollout: 100, snapshot: `releases/${id}/snapshot-${id.toLowerCase()}.json` };
}
const routeCases: Array<{ name: string; releases: ManifestRelease[]; ctx: Parameters<typeof selectRelease>[1] }> = [
  { name: "버전격리_구버전", releases: [rel("R42", ">=3.2.0 <3.3.0"), rel("R50", ">=3.3.0")], ctx: { appVersion: "3.2.5" } },
  { name: "버전격리_신버전", releases: [rel("R42", ">=3.2.0 <3.3.0"), rel("R50", ">=3.3.0")], ctx: { appVersion: "3.3.1" } },
  { name: "superseded도_후보", releases: [rel("R42", ">=3.2.0 <3.3.0", "superseded"), rel("R50", ">=3.3.0")], ctx: { appVersion: "3.2.5" } },
  { name: "archived_제외", releases: [rel("R42", ">=3.2.0 <3.3.0", "archived")], ctx: { appVersion: "3.2.5" } },
  { name: "미매칭_bundle_only", releases: [rel("R42", ">=3.2.0 <3.3.0")], ctx: { appVersion: "5.0.0" } },
  { name: "미매칭_nearest_lower", releases: [rel("R42", ">=3.2.0 <3.3.0")], ctx: { appVersion: "5.0.0", fallbackPolicy: "nearest-lower" } },
  { name: "exact_label", releases: [rel("W1", "web-stable", "published", "exact-label")], ctx: { releaseLabel: "web-stable" } },
  { name: "방어적_가장좁은범위", releases: [rel("WIDE", ">=3.0.0 <4.0.0"), rel("NARROW", ">=3.2.0 <3.3.0")], ctx: { appVersion: "3.2.5" } },
];
write("routing.json", {
  description: "selectRelease(releases, ctx) → {kind, releaseId}",
  cases: routeCases.map((c) => {
    const r = selectRelease(c.releases, c.ctx);
    return { name: c.name, releases: c.releases, ctx: c.ctx, expected: { kind: r.kind, releaseId: r.kind === "bundle-only" ? null : r.release.id } };
  }),
});

// ── 9) bake (빌드타임 자동 번들링 코어) ───────────────────────────────────────
const bakeValid = buildSnapshot({
  release: "R42", defaultLocale: "en",
  locales: { en: { "a": "A", "b": "B" }, ko: { "a": "가" } },
});
const bakeGap = buildSnapshot({
  release: "R7", defaultLocale: "en",
  locales: { en: { "a": "A" }, ko: { "a": "가", "ko.only": "코" }, ja: { "ko.only": "コ" } },
});
const bakeBadBase: Snapshot = { ...bakeValid, base: "deadbeefdeadbeef" };
write("bake.json", {
  description: "baseLocaleCoverage/verifyBase/buildLockfile/lockfileString/bundleString 정합성",
  cases: [
    { name: "valid", snapshot: bakeValid,
      coverageGaps: baseLocaleCoverage(bakeValid),
      baseOk: verifyBase(bakeValid).ok,
      lockfileText: lockfileString(buildLockfile(bakeValid)),
      bundle: bundleString(bakeValid) },
    { name: "coverage-gap", snapshot: bakeGap,
      coverageGaps: baseLocaleCoverage(bakeGap),
      baseOk: verifyBase(bakeGap).ok,
      lockfileText: lockfileString(buildLockfile(bakeGap)),
      bundle: bundleString(bakeGap) },
    { name: "bad-base", snapshot: bakeBadBase,
      coverageGaps: baseLocaleCoverage(bakeBadBase),
      baseOk: verifyBase(bakeBadBase).ok,
      expectedBase: verifyBase(bakeBadBase).expected,
      lockfileText: lockfileString(buildLockfile(bakeBadBase)),
      bundle: bundleString(bakeBadBase) },
  ],
});

// ── 10) 네이티브 포맷 변환 (5.3) ──────────────────────────────────────────────
const convSnap: Snapshot = {
  schemaVersion: 1, release: "R1", base: "x", defaultLocale: "en",
  locales: {
    en: {
      "home.title": "Home",
      "greet": "Hello {name}",
      "cart.items": { one: "{n} item", other: "{n} items" },
      "files": "{count, number} files in {folder}",
    },
    ko: {
      "home.title": "홈",
      "cart.items": { other: "{n}개" },
    },
  },
};
write("convert.json", {
  description: "toAndroidStringsXml(로케일별 정확 문자열) · toXcstrings(구조) · toWebJson · toArb",
  snapshot: convSnap,
  androidXml: {
    en: toAndroidStringsXml(convSnap.locales.en!).output,
    ko: toAndroidStringsXml(convSnap.locales.ko!).output,
  },
  xcstrings: toXcstrings(convSnap).output,
  webJson: {
    en: toWebJson(convSnap.locales.en!).output,
    ko: toWebJson(convSnap.locales.ko!).output,
  },
  arb: {
    en: toArb(convSnap.locales.en!, "en").output,
    ko: toArb(convSnap.locales.ko!, "ko").output,
  },
});

console.log("golden vectors 생성 완료 →", OUT);
