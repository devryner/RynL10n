/**
 * 버전 매칭 · 범위 충돌 검사 · 클라이언트 릴리스 판정 — 기획서 4.3 / 8.2 / 11.3
 */

import type { Comparator, SemVer } from "./semver.ts";
import { compare, parseRange, parseVersion, satisfies } from "./semver.ts";
import type { ManifestRelease, VersionMatch, FallbackPolicy } from "./types.ts";

// ── 구간(interval) 표현: semver-range를 [lower, upper) 명시 구간으로 환원 ──────────

interface Bound {
  readonly version: SemVer;
  readonly inclusive: boolean;
}
interface Interval {
  readonly lower: Bound | null; // null = -infinity
  readonly upper: Bound | null; // null = +infinity
}

/** AND 결합 비교자들을 하나의 명시 구간으로 환원. 부분집합이라 항상 단일 구간(11.3). */
export function comparatorsToInterval(comparators: readonly Comparator[]): Interval {
  let lower: Bound | null = null;
  let upper: Bound | null = null;
  const tightenLower = (b: Bound) => {
    if (lower === null) { lower = b; return; }
    const c = compare(b.version, lower.version);
    if (c > 0 || (c === 0 && !b.inclusive && lower.inclusive)) lower = b;
  };
  const tightenUpper = (b: Bound) => {
    if (upper === null) { upper = b; return; }
    const c = compare(b.version, upper.version);
    if (c < 0 || (c === 0 && !b.inclusive && upper.inclusive)) upper = b;
  };
  for (const c of comparators) {
    switch (c.op) {
      case ">=": tightenLower({ version: c.version, inclusive: true }); break;
      case ">": tightenLower({ version: c.version, inclusive: false }); break;
      case "<=": tightenUpper({ version: c.version, inclusive: true }); break;
      case "<": tightenUpper({ version: c.version, inclusive: false }); break;
      case "=":
        tightenLower({ version: c.version, inclusive: true });
        tightenUpper({ version: c.version, inclusive: true });
        break;
    }
  }
  return { lower, upper };
}

/** 두 구간이 하나라도 공통 버전을 갖는가(경계 포함성 고려). */
export function intervalsOverlap(a: Interval, b: Interval): boolean {
  // 유효 하한 = 더 높은 하한, 유효 상한 = 더 낮은 상한.
  const lo = maxLower(a.lower, b.lower);
  const hi = minUpper(a.upper, b.upper);
  if (lo === null || hi === null) return true; // 한쪽이 무한이면 반대편 방향은 항상 겹칠 여지
  const c = compare(lo.version, hi.version);
  if (c < 0) return true;
  if (c > 0) return false;
  // 같은 경계값: 양쪽 모두 포함일 때만 겹침(예: <3.3.0 와 >=3.3.0 → 겹치지 않음).
  return lo.inclusive && hi.inclusive;
}

function maxLower(a: Bound | null, b: Bound | null): Bound | null {
  if (a === null) return b;
  if (b === null) return a;
  const c = compare(a.version, b.version);
  if (c !== 0) return c > 0 ? a : b;
  return a.inclusive ? b : a; // 같은 값이면 배타(>)가 더 높은 하한
}
function minUpper(a: Bound | null, b: Bound | null): Bound | null {
  if (a === null) return b;
  if (b === null) return a;
  const c = compare(a.version, b.version);
  if (c !== 0) return c < 0 ? a : b;
  return a.inclusive ? b : a; // 같은 값이면 배타(<)가 더 낮은 상한
}

// ── publish 시 범위 충돌 검사 (서버, 8.2 / 11.3) ──────────────────────────────

export interface ConflictInput {
  readonly id: string;
  readonly versionMatch: VersionMatch;
}

/**
 * 동시에 published가 될 릴리스 집합에서 충돌을 찾는다.
 *  - semver-range끼리: 구간 교집합이 있으면 충돌.
 *  - exact-label끼리: 라벨이 완전히 같으면 충돌.
 *  - 서로 다른 strategy: 대상 앱군이 분리되므로 상호 배제(충돌 아님).
 * 반환: 충돌하는 (a,b) id 쌍 목록(비어있으면 충돌 없음 → publish 허용).
 */
export function findRangeConflicts(releases: readonly ConflictInput[]): Array<[string, string]> {
  const conflicts: Array<[string, string]> = [];
  const semver = releases.filter((r) => r.versionMatch.strategy === "semver-range");
  const intervals = semver.map((r) => comparatorsToInterval(parseRange(r.versionMatch.value)));
  for (let i = 0; i < semver.length; i++) {
    for (let j = i + 1; j < semver.length; j++) {
      if (intervalsOverlap(intervals[i]!, intervals[j]!)) {
        conflicts.push([semver[i]!.id, semver[j]!.id]);
      }
    }
  }
  const byLabel = new Map<string, string[]>();
  for (const r of releases) {
    if (r.versionMatch.strategy !== "exact-label") continue;
    const arr = byLabel.get(r.versionMatch.value) ?? [];
    arr.push(r.id);
    byLabel.set(r.versionMatch.value, arr);
  }
  for (const ids of byLabel.values()) {
    for (let i = 1; i < ids.length; i++) conflicts.push([ids[0]!, ids[i]!]);
  }
  return conflicts;
}

// ── 클라이언트 릴리스 판정 (SDK, manifest 기준, 11.3) ─────────────────────────

export interface ClientContext {
  readonly appVersion?: string; // semver-range 후보 평가용
  readonly releaseLabel?: string; // exact-label 후보 평가용
  readonly matchPrerelease?: boolean;
  readonly fallbackPolicy?: FallbackPolicy; // 미매칭 시 (기본 bundle-only)
}

export type SelectionResult =
  | { readonly kind: "matched"; readonly release: ManifestRelease }
  | { readonly kind: "nearest-lower"; readonly release: ManifestRelease }
  | { readonly kind: "bundle-only" };

/**
 * manifest에서 클라이언트에 맞는 릴리스를 판정(11.3).
 *  1) state=="published"만 후보
 *  2) strategy별 평가
 *  3) 정상 최대 1개. 방어적으로 2개↑이면 가장 좁은 범위 → 그다음 id 최신
 *  4) 0개면 fallbackPolicy(nearest-lower | bundle-only)
 */
export function selectRelease(
  releases: readonly ManifestRelease[],
  ctx: ClientContext,
): SelectionResult {
  // 라우팅 후보 = 서빙 중인 릴리스. 11.3은 "published만"이라 표기하지만, 8.1은 superseded
  // 산출물이 구버전 앱에 계속 서빙된다고 못박는다(자동 상한 닫힘 후에도 옛 앱이 매칭돼야 함).
  // 스파이크 조정: draft/archived만 제외하고 published·superseded를 후보로 둔다(README 참조).
  const published = releases.filter((r) => r.state === "published" || r.state === "superseded");
  const matched: ManifestRelease[] = [];
  for (const r of published) {
    if (r.versionMatch.strategy === "exact-label") {
      if (ctx.releaseLabel !== undefined && ctx.releaseLabel === r.versionMatch.value) matched.push(r);
    } else {
      if (ctx.appVersion === undefined) continue;
      const opts = ctx.matchPrerelease === undefined ? {} : { matchPrerelease: ctx.matchPrerelease };
      if (satisfies(parseVersion(ctx.appVersion), parseRange(r.versionMatch.value), opts)) matched.push(r);
    }
  }

  if (matched.length === 1) return { kind: "matched", release: matched[0]! };
  if (matched.length > 1) return { kind: "matched", release: tiebreak(matched) };

  // 미매칭 → fallback 정책
  const policy: FallbackPolicy = ctx.fallbackPolicy ?? "bundle-only";
  if (policy === "nearest-lower" && ctx.appVersion !== undefined) {
    const nl = nearestLower(published, ctx.appVersion);
    if (nl) return { kind: "nearest-lower", release: nl };
  }
  return { kind: "bundle-only" };
}

/** 방어적 다중 매칭 tiebreak: 가장 좁은 범위 → id 최신. */
function tiebreak(candidates: readonly ManifestRelease[]): ManifestRelease {
  const scored = candidates.map((r) => {
    if (r.versionMatch.strategy !== "semver-range") return { r, iv: null as Interval | null };
    return { r, iv: comparatorsToInterval(parseRange(r.versionMatch.value)) };
  });
  scored.sort((x, y) => {
    // 더 높은 하한이 더 좁다.
    const lo = compareBoundForNarrow(x.iv?.lower ?? null, y.iv?.lower ?? null, "lower");
    if (lo !== 0) return -lo;
    const hi = compareBoundForNarrow(x.iv?.upper ?? null, y.iv?.upper ?? null, "upper");
    if (hi !== 0) return hi;
    return x.r.id < y.r.id ? 1 : x.r.id > y.r.id ? -1 : 0; // id 최신(사전 역순)
  });
  return scored[0]!.r;
}

function compareBoundForNarrow(a: Bound | null, b: Bound | null, side: "lower" | "upper"): number {
  // 하한: null(-inf)이 가장 낮음. 상한: null(+inf)이 가장 높음.
  if (a === null && b === null) return 0;
  if (a === null) return side === "lower" ? -1 : 1;
  if (b === null) return side === "lower" ? 1 : -1;
  return compare(a.version, b.version);
}

/** nearest-lower: 상한이 앱 버전 이하인 가장 가까운(상한이 가장 높은) 릴리스. */
function nearestLower(published: readonly ManifestRelease[], appVersion: string): ManifestRelease | null {
  const v = parseVersion(appVersion);
  let best: { r: ManifestRelease; upper: SemVer } | null = null;
  for (const r of published) {
    if (r.versionMatch.strategy !== "semver-range") continue;
    const iv = comparatorsToInterval(parseRange(r.versionMatch.value));
    if (iv.upper === null) continue;
    // 상한이 앱 버전 이하(구버전 릴리스)인 것만.
    if (compare(iv.upper.version, v) <= 0) {
      if (best === null || compare(iv.upper.version, best.upper) > 0) best = { r, upper: iv.upper.version };
    }
  }
  return best?.r ?? null;
}
