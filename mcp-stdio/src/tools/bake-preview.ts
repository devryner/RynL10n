/**
 * `bake_preview` — "다음 빌드가 무엇을 구울 것이고, 지금 디스크에 있는 것과 무엇이 다른가"
 *
 * 빌드 플러그인(SPM build tool plugin · Gradle task)이 빌드마다 스냅샷을 네이티브 산출물로
 * 굽는데(6.3), **그 결과를 빌드 전에 볼 자리가 지금 아무 데도 없다.** 빌드를 돌려 봐야 알고,
 * 돌리고 나면 이미 덮어써져 있다. 이 도구는 같은 코어를 **쓰지 않고** 돌려 그 자리를 채운다.
 *
 * **판정은 새로 쓰지 않는다** — 커버리지 갭·base 무결성은 `bake()`가, 카탈로그 diff는
 * `buildDelta()`가, 네이티브 바이트는 `convert`가 낸다. 여기서 다시 구현하면 미리보기와 실제
 * 빌드가 갈라지는 순간 도구가 거짓말을 시작한다(HTTP 표면의 `resolve_preview`와 같은 규칙).
 *
 * **경로 규약은 bake CLI를 그대로 따른다** — 두 CLI(`sdks/ios/Sources/rynl10n-bake/main.swift` ·
 * `sdks/android/src/cli/kotlin/com/rynl10n/BakeCli.kt`)가 쓰는 자리와 어긋나면 "변경 없음"이라고
 * 답해 놓고 빌드가 다른 파일을 덮어쓴다:
 *
 *   <outDir>/rynl10n/snapshot-<base>.json   (--stable-name이면 snapshot.json)
 *   <outDir>/rynl10n/rynl10n.lock
 *   <outDir>/rynl10n/Localizable.xcstrings              (ios, --emit-native)
 *   <outDir>/rynl10n/res/values[-<locale>]/strings.xml  (android, --emit-native)
 *
 * 두 CLI 모두 `--descriptions`로 키 설명 주석을 함께 굽는다(5.3). 빌드가 그 플래그를 쓰지 않으면
 * 미리보기도 쓰면 안 된다 — 그 차이가 그대로 가짜 "변경"이 된다.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { bake, type Lockfile } from "../../../src/builder/bake.ts";
import { buildDelta } from "../../../src/builder/builder.ts";
import { toAndroidStringsXml, toXcstrings, type Descriptions } from "../../../src/builder/convert.ts";
import type { Snapshot } from "../../../src/core/types.ts";

export type Platform = "ios" | "android";

export interface BakePreviewInput {
  readonly snapshot: string;
  readonly outDir: string;
  readonly platform?: Platform;
  /** 키 설명 사이드카 경로(5.1). 빌드가 `--descriptions` 없이 돈다면 **여기도 주지 말 것**. */
  readonly descriptions?: string;
  readonly strict?: boolean;
  readonly stableName?: boolean;
}

/** 산출물 하나의 상태. `동일`이면 다음 빌드가 그 파일을 바꾸지 않는다. */
export type FileStatus = "추가" | "변경" | "동일";

export interface FileDiff {
  readonly path: string;
  readonly status: FileStatus;
  readonly bytes: number;
}

export interface CatalogDiff {
  readonly from: string;
  readonly to: string;
  readonly opCount: number;
  readonly byLocale: Readonly<Record<string, { readonly set: number; readonly delete: number }>>;
  readonly sample: readonly string[];
}

export interface BakePreviewResult {
  readonly release: string;
  readonly base: string;
  readonly keyCount: number;
  readonly locales: readonly string[];
  readonly warnings: readonly string[];
  readonly bundle: FileDiff;
  readonly lockfile: FileDiff & { readonly current: Lockfile | null; readonly next: Lockfile };
  readonly native: readonly FileDiff[];
  readonly catalogDiff: CatalogDiff | null;
  readonly unchanged: boolean;
}

/** 델타 샘플 상한 — 전부 실으면 모델 컨텍스트만 먹고 판단에 보태는 게 없다. */
const SAMPLE_LIMIT = 20;

export function bakePreview(input: BakePreviewInput): BakePreviewResult {
  const snap = readSnapshot(input.snapshot);
  const descriptions = readDescriptions(input.descriptions);

  // bake()가 커버리지 갭·base 무결성을 판정한다. strict면 던지고, 아니면 경고로 남긴다.
  const result = bake(snap, input.strict === true ? { strict: true } : {});

  const bundleDir = join(input.outDir, "rynl10n");
  const bundleName = input.stableName === true ? "snapshot.json" : `snapshot-${snap.base}.json`;

  const bundle = compare(join(bundleDir, bundleName), result.bundle);
  const lockPath = join(bundleDir, "rynl10n.lock");
  const lockfile = {
    ...compare(lockPath, result.lockfileText),
    current: readLockfile(lockPath),
    next: result.lockfile,
  };

  const native = input.platform === undefined ? [] : nativeDiffs(snap, bundleDir, input.platform, descriptions);

  // 디스크에 이미 번들이 있으면 카탈로그 수준으로 무엇이 바뀌는지까지 낸다.
  // 없으면(첫 빌드) 비교 대상이 없으니 null — "전부 추가"를 델타로 부풀리지 않는다.
  const previous = readPreviousSnapshot(bundleDir, bundleName);
  const catalogDiff = previous === null ? null : summarizeDelta(previous, snap);

  const files = [bundle, lockfile, ...native];
  return {
    release: snap.release,
    base: snap.base,
    keyCount: result.lockfile.keyCount,
    locales: result.lockfile.locales,
    warnings: result.warnings,
    bundle,
    lockfile,
    native,
    catalogDiff,
    unchanged: files.every((f) => f.status === "동일"),
  };
}

/** 사람이 먼저 읽는 한 줄. 구조는 structuredContent로 따로 나간다. */
export function summarize(r: BakePreviewResult): string {
  if (r.unchanged) {
    return `release=${r.release} base=${r.base} — 다음 빌드가 바꿀 산출물이 없다(키 ${r.keyCount} · 로케일 ${r.locales.length}).`;
  }
  const changed = [r.bundle, r.lockfile, ...r.native].filter((f) => f.status !== "동일");
  const ops = r.catalogDiff === null ? "첫 빌드(비교 대상 없음)" : `카탈로그 변경 ${r.catalogDiff.opCount}건`;
  const warn = r.warnings.length > 0 ? ` · 경고 ${r.warnings.length}건` : "";
  return `release=${r.release} base=${r.base} — 파일 ${changed.length}개가 바뀐다(${ops})${warn}.`;
}

// ── 입력 읽기 ────────────────────────────────────────────────────────────────

function readSnapshot(path: string): Snapshot {
  if (!existsSync(path)) throw new Error(`스냅샷을 찾을 수 없다: ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`스냅샷 JSON 파싱 실패: ${path} — ${e instanceof Error ? e.message : String(e)}`);
  }
  const s = parsed as Partial<Snapshot>;
  if (typeof s?.release !== "string" || typeof s?.base !== "string"
      || typeof s?.defaultLocale !== "string" || typeof s?.locales !== "object" || s.locales === null) {
    throw new Error(`스냅샷 형식이 아니다(release·base·defaultLocale·locales 필요): ${path}`);
  }
  return parsed as Snapshot;
}

/**
 * 설명 사이드카(5.1). 없거나 못 읽으면 **주석 없이 계속한다** — bake CLI와 같은 실패 정책이다
 * (설명은 스냅샷과 분리돼 있고 없다고 빌드가 멈추지 않는다).
 */
function readDescriptions(path: string | undefined): Descriptions {
  if (path === undefined || !existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const raw = (parsed.descriptions ?? parsed) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function readLockfile(path: string): Lockfile | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Lockfile;
  } catch {
    return null;
  }
}

/**
 * 디스크의 직전 번들. `--stable-name` 빌드는 파일명이 고정이라 그대로 읽고, 내용해시 이름이면
 * **이번 base의 파일이 아니라 그 디렉토리에 있는 번들**을 찾아야 한다 — 이름이 다르면 비교
 * 대상이 없다고 보는 게 아니라 직전 빌드의 것과 비교해야 "무엇이 바뀌나"에 답이 된다.
 */
function readPreviousSnapshot(bundleDir: string, bundleName: string): Snapshot | null {
  const exact = join(bundleDir, bundleName);
  if (existsSync(exact)) return tryParseSnapshot(exact);
  if (!existsSync(bundleDir)) return null;
  const candidates = readdirSync(bundleDir)
    .filter((f) => f === "snapshot.json" || (f.startsWith("snapshot-") && f.endsWith(".json")))
    .sort();
  for (const c of candidates) {
    const snap = tryParseSnapshot(join(bundleDir, c));
    if (snap !== null) return snap;
  }
  return null;
}

function tryParseSnapshot(path: string): Snapshot | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Snapshot>;
    return typeof parsed?.base === "string" && typeof parsed?.locales === "object" ? (parsed as Snapshot) : null;
  } catch {
    return null;
  }
}

// ── 비교 ─────────────────────────────────────────────────────────────────────

/** 바이트 비교 — 굽는 쪽이 우리가 만든 문자열을 그대로 쓰는 산출물에만 쓴다. */
function compare(path: string, next: string): FileDiff {
  const bytes = Buffer.byteLength(next, "utf8");
  if (!existsSync(path)) return { path, status: "추가", bytes };
  return { path, status: readFileSync(path, "utf8") === next ? "동일" : "변경", bytes };
}

/**
 * 구조 비교 — `.xcstrings` 전용.
 *
 * iOS bake CLI는 변환 결과를 `JSONEncoder(.prettyPrinted, .sortedKeys, .withoutEscapingSlashes)`로
 * 쓴다. Foundation의 pretty print는 `"key" : value`(콜론 앞 공백)라 Node의 `JSON.stringify`와
 * **바이트가 절대 같아지지 않는다.** 바이트로 비교하면 내용이 똑같아도 매번 "변경"이라 답하게 되고,
 * 그건 도구가 조용히 거짓말하는 것이다. Foundation 포맷을 흉내내는 건 더 나쁜 길이라 **의미로**
 * 비교한다 — 개발자가 묻는 것도 서식이 아니라 내용이다.
 */
function compareJson(path: string, next: unknown): FileDiff {
  const text = JSON.stringify(next, null, 2);
  const bytes = Buffer.byteLength(text, "utf8");
  if (!existsSync(path)) return { path, status: "추가", bytes };
  try {
    const current = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return { path, status: canonical(current) === canonical(next) ? "동일" : "변경", bytes };
  } catch {
    return { path, status: "변경", bytes }; // 못 읽는 파일은 덮어써질 것이므로 변경으로 본다
  }
}

/** 키 순서에 의존하지 않는 비교용 정규 문자열. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonical(val)}`).join(",")}}`;
}

function nativeDiffs(
  snap: Snapshot,
  bundleDir: string,
  platform: Platform,
  descriptions: Descriptions,
): FileDiff[] {
  if (platform === "ios") {
    return [compareJson(join(bundleDir, "Localizable.xcstrings"), toXcstrings(snap, descriptions).output)];
  }
  // android — 로케일별 `res/values[-locale]/strings.xml`.
  // 설명은 두 CLI 모두 `--descriptions`로 받는다. **빌드가 그 플래그 없이 돌면 여기서도 주지 말 것** —
  // 미리보기만 주석을 넣으면 "변경"이라 답하고 빌드는 안 바꾼다.
  const out: FileDiff[] = [];
  for (const locale of Object.keys(snap.locales).sort()) {
    const catalog = snap.locales[locale];
    if (catalog === undefined) continue;
    const dir = locale === snap.defaultLocale ? "values" : `values-${locale}`;
    out.push(compare(join(bundleDir, "res", dir, "strings.xml"), toAndroidStringsXml(catalog, descriptions).output));
  }
  return out;
}

function summarizeDelta(from: Snapshot, to: Snapshot): CatalogDiff {
  const delta = buildDelta(from, to);
  const byLocale: Record<string, { set: number; delete: number }> = {};
  for (const op of delta.ops) {
    const bucket = byLocale[op.locale] ?? { set: 0, delete: 0 };
    if (op.op === "set") bucket.set += 1;
    else bucket.delete += 1;
    byLocale[op.locale] = bucket;
  }
  return {
    from: delta.from,
    to: delta.to,
    opCount: delta.ops.length,
    byLocale,
    sample: delta.ops.slice(0, SAMPLE_LIMIT).map((op) => `${op.locale} ${op.key} ${op.op}`),
  };
}
