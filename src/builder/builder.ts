/**
 * 산출물 빌더 (관리 플레인) — 기획서 7.4 / 8.1 / 8.2 / 8.3 / 11
 *
 * DB(SoT) → 정규화 JSON 스냅샷 + 델타 + manifest 생성. 결정적 직렬화라 같은 입력 → 같은 해시.
 * publish 시 버전 범위 충돌 검사, 신규 릴리스 하한에 따른 이전 릴리스 상한 자동 닫힘 + supersede,
 * 롤백(overlay 포인터 되돌리기)까지 이 계층이 담당한다.
 */

import { fileId, snapshotHash } from "../serialize/hash.ts";
import { parseVersion } from "../core/semver.ts";
import { comparatorsToInterval, findRangeConflicts } from "../core/matching.ts";
import { parseRange } from "../core/semver.ts";
import type {
  Delta,
  DeltaOp,
  Manifest,
  ManifestRelease,
  ReleaseState,
  Snapshot,
  TranslationValue,
  VersionMatch,
} from "../core/types.ts";

type Catalog = { [bcp47: string]: { [key: string]: TranslationValue } };

// ── 스냅샷 ────────────────────────────────────────────────────────────────────

/** 카탈로그로부터 자기식별 base 해시를 계산해 스냅샷을 만든다. */
export function buildSnapshot(input: {
  release: string;
  defaultLocale: string;
  locales: Catalog;
  taken?: ReadonlySet<string>;
}): Snapshot {
  const full = snapshotHash({
    release: input.release,
    defaultLocale: input.defaultLocale,
    locales: input.locales,
  });
  const base = fileId(full, input.taken);
  return {
    schemaVersion: 1,
    release: input.release,
    base,
    defaultLocale: input.defaultLocale,
    locales: input.locales,
  };
}

export function snapshotPath(release: string, base: string): string {
  return `releases/${release}/snapshot-${base}.json`;
}
export function deltaPath(release: string, from: string, to: string): string {
  return `releases/${release}/delta-${from}-${to}.json`;
}

// ── 델타 (sparse diff) ────────────────────────────────────────────────────────

function valueEqual(a: TranslationValue | undefined, b: TranslationValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const as = typeof a === "string", bs = typeof b === "string";
  if (as || bs) return a === b;
  // 복수형 맵: 전 카테고리 비교(부분 카테고리 델타 없음 — 원자 교체).
  const ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
    const k = ak[i]! as keyof typeof a;
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/**
 * 두 스냅샷 사이의 sparse 델타. ops는 (locale, key, op) 사전순 정렬(11.1).
 * 복수형은 맵 전체를 하나의 set으로 원자 교체.
 */
export function buildDelta(from: Snapshot, to: Snapshot): Delta {
  const ops: DeltaOp[] = [];
  const locales = new Set<string>([...Object.keys(from.locales), ...Object.keys(to.locales)]);
  for (const locale of locales) {
    const fromKeys = from.locales[locale] ?? {};
    const toKeys = to.locales[locale] ?? {};
    const keys = new Set<string>([...Object.keys(fromKeys), ...Object.keys(toKeys)]);
    for (const key of keys) {
      const fv = fromKeys[key];
      const tv = toKeys[key];
      if (tv !== undefined && !valueEqual(fv, tv)) {
        ops.push({ op: "set", key, locale, value: tv });
      } else if (tv === undefined && fv !== undefined) {
        ops.push({ op: "delete", key, locale });
      }
    }
  }
  ops.sort((x, y) => {
    if (x.locale !== y.locale) return x.locale < y.locale ? -1 : 1;
    if (x.key !== y.key) return x.key < y.key ? -1 : 1;
    return x.op < y.op ? -1 : x.op > y.op ? 1 : 0;
  });
  return { schemaVersion: 1, release: to.release, from: from.base, to: to.base, ops };
}

// ── 관리 플레인 릴리스 레코드 & manifest 컴파일 ────────────────────────────────

export interface ReleaseRecord {
  readonly id: string;
  readonly versionMatch: VersionMatch;
  readonly state: ReleaseState;
  readonly base: string; // 번들 스냅샷 fileId
  readonly overlay: string; // 최신 오버레이 target fileId (없으면 base와 동일)
  readonly rollout?: number; // 8.4 안전 기본값 100
}

/**
 * 릴리스 레코드 → 배포 manifest(11.2). draft/archived 제외.
 * published·superseded는 클라이언트에 계속 서빙되므로 포함(8.1).
 */
export function compileManifest(input: {
  project: string;
  defaultLocale: string;
  updatedAt: string;
  records: readonly ReleaseRecord[];
}): Manifest {
  const releases: ManifestRelease[] = [];
  for (const r of input.records) {
    if (r.state === "draft" || r.state === "archived") continue;
    const entry: ManifestRelease = {
      id: r.id,
      state: r.state,
      versionMatch: r.versionMatch,
      base: r.base,
      overlay: r.overlay,
      rollout: r.rollout ?? 100,
      snapshot: snapshotPath(r.id, r.base),
      ...(r.overlay !== r.base ? { delta: deltaPath(r.id, r.base, r.overlay) } : {}),
    };
    releases.push(entry);
  }
  return {
    schemaVersion: 1,
    project: input.project,
    defaultLocale: input.defaultLocale,
    updatedAt: input.updatedAt,
    releases,
  };
}

// ── publish 절차: 충돌 검사 · 자동 상한 닫힘 · supersede (8.2) ──────────────────

export class RangeConflictError extends Error {
  readonly status = 409;
  readonly pairs: ReadonlyArray<[string, string]>;
  constructor(pairs: ReadonlyArray<[string, string]>) {
    super(`버전 범위 충돌(409): ${pairs.map(([a, b]) => `${a}↔${b}`).join(", ")}`);
    this.name = "RangeConflictError";
    this.pairs = pairs;
  }
}

/** published가 될 집합의 범위 충돌을 검사. 충돌 시 409 예외(11.3/8.2). */
export function assertNoConflicts(records: readonly ReleaseRecord[]): void {
  const serving = records.filter((r) => r.state === "published" || r.state === "superseded");
  const pairs = findRangeConflicts(serving.map((r) => ({ id: r.id, versionMatch: r.versionMatch })));
  if (pairs.length > 0) throw new RangeConflictError(pairs);
}

/**
 * 신규 릴리스(semver-range, 열린 상한)를 publish할 때, 겹치는 이전 릴리스의 상한을
 * 새 릴리스 하한으로 자동으로 닫고 superseded로 전이(8.2). 반환은 갱신된 레코드 배열.
 * 이후 assertNoConflicts로 검증할 것.
 */
export function publishWithAutoClose(
  existing: readonly ReleaseRecord[],
  incoming: ReleaseRecord,
): ReleaseRecord[] {
  if (incoming.versionMatch.strategy !== "semver-range") {
    return [...existing, incoming];
  }
  const newInterval = comparatorsToInterval(parseRange(incoming.versionMatch.value));
  const newLower = newInterval.lower;
  const result: ReleaseRecord[] = [];
  for (const r of existing) {
    if (
      r.versionMatch.strategy === "semver-range" &&
      (r.state === "published" || r.state === "superseded") &&
      newLower !== null
    ) {
      const iv = comparatorsToInterval(parseRange(r.versionMatch.value));
      const opensAbove = iv.upper === null || cmpUpperVsLower(iv.upper.version, newLower.version) > 0;
      const startsBelow = iv.lower === null || compareVersions(iv.lower.version, newLower.version) < 0;
      if (opensAbove && startsBelow) {
        // 상한을 새 하한으로 닫고 superseded 전이.
        const closed = `${r.versionMatch.value} <${fmt(newLower.version)}`;
        result.push({ ...r, versionMatch: { strategy: "semver-range", value: closed }, state: "superseded" });
        continue;
      }
    }
    result.push(r);
  }
  result.push(incoming);
  return result;
}

function compareVersions(a: import("../core/semver.ts").SemVer, b: import("../core/semver.ts").SemVer): number {
  return a.major !== b.major ? (a.major < b.major ? -1 : 1)
    : a.minor !== b.minor ? (a.minor < b.minor ? -1 : 1)
    : a.patch !== b.patch ? (a.patch < b.patch ? -1 : 1)
    : 0;
}
function cmpUpperVsLower(u: import("../core/semver.ts").SemVer, l: import("../core/semver.ts").SemVer): number {
  return compareVersions(u, l);
}
function fmt(v: import("../core/semver.ts").SemVer): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

// ── 롤백 (8.3): manifest overlay 포인터 되돌리기 ──────────────────────────────

/**
 * 특정 릴리스의 overlay 포인터를 이전 target으로 되돌린 manifest를 반환(불변·즉시·무손실).
 * 산출물 파일은 불변이라 이전 상태가 그대로 남아 있음.
 */
export function rollbackOverlay(
  manifest: Manifest,
  releaseId: string,
  previousOverlay: string,
): Manifest {
  const releases = manifest.releases.map((r) => {
    if (r.id !== releaseId) return r;
    return {
      ...r,
      overlay: previousOverlay,
      ...(previousOverlay !== r.base
        ? { delta: deltaPath(r.id, r.base, previousOverlay) }
        : { delta: undefined }),
    };
  });
  // delta:undefined 제거(exactOptionalPropertyTypes).
  const cleaned = releases.map((r) => {
    if (r.delta === undefined) {
      const { delta: _omit, ...rest } = r;
      return rest as ManifestRelease;
    }
    return r as ManifestRelease;
  });
  return { ...manifest, releases: cleaned };
}

/** publish 시 앱 버전 문자열 유효성 사전 검증 헬퍼(422 대비). */
export function assertValidVersion(v: string): void {
  parseVersion(v); // 던지면 상위에서 처리
}
