/**
 * 빌드타임 자동 번들링 — bake 코어 (기획서 3.2 / 6.3, 차별점 ①)
 *
 * 빌드마다 현재 릴리스 스냅샷을 fetch → (1) 기본 로케일 100% 커버리지 검증(3.1)
 * (2) base 해시 무결성 확인 (3) SDK가 읽는 번들 리소스 방출 (4) lockfile에 release·base 기록.
 * 산출물은 결정적: 같은 스냅샷 → 같은 번들 바이트·같은 lockfile (CI 재현성 · 6.3).
 *
 * bake의 1차 산출물은 **우리 스냅샷 JSON**이다. SDK 런타임의 2계층 resolve가 이 번들을 그대로 읽는다.
 * (네이티브 포맷 변환 5.3은 별도 산출물 — 이 모듈 범위 밖.)
 */

import { canonicalStringify } from "../serialize/jcs.ts";
import { snapshotHash, fileId } from "../serialize/hash.ts";
import type { Snapshot } from "../core/types.ts";

export interface CoverageGap {
  readonly key: string;
  /** 이 키가 존재하는(=기본 로케일엔 없는) 로케일들. */
  readonly presentIn: readonly string[];
}

/** 기본 로케일 커버리지 검사: 다른 로케일엔 있으나 기본 로케일에 없는 키 목록(3.1). */
export function baseLocaleCoverage(snap: Snapshot): CoverageGap[] {
  const baseKeys = new Set(Object.keys(snap.locales[snap.defaultLocale] ?? {}));
  const gaps = new Map<string, string[]>();
  for (const [locale, keys] of Object.entries(snap.locales)) {
    if (locale === snap.defaultLocale) continue;
    for (const key of Object.keys(keys)) {
      if (!baseKeys.has(key)) {
        const arr = gaps.get(key) ?? [];
        arr.push(locale);
        gaps.set(key, arr);
      }
    }
  }
  return [...gaps.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, presentIn]) => ({ key, presentIn: presentIn.sort() }));
}

/** 스냅샷의 선언 base가 콘텐츠 해시와 일치하는가(무결성). */
export function verifyBase(snap: Snapshot): { ok: boolean; expected: string } {
  const full = snapshotHash({ release: snap.release, defaultLocale: snap.defaultLocale, locales: snap.locales });
  const expected = fileId(full);
  return { ok: expected === snap.base, expected };
}

/** lockfile — CI 재현성용 결정적 기록. */
export interface Lockfile {
  readonly schemaVersion: 1;
  readonly release: string;
  readonly base: string;
  readonly keyCount: number;
  readonly locales: readonly string[];
}

export function buildLockfile(snap: Snapshot): Lockfile {
  const locales = Object.keys(snap.locales).sort();
  const allKeys = new Set<string>();
  for (const keys of Object.values(snap.locales)) for (const k of Object.keys(keys)) allKeys.add(k);
  return { schemaVersion: 1, release: snap.release, base: snap.base, keyCount: allKeys.size, locales };
}

/** lockfile 결정적 직렬화 바이트(JCS). */
export function lockfileString(lock: Lockfile): string {
  return canonicalStringify(lock);
}

/** SDK가 읽는 번들 리소스 바이트(정규화 스냅샷). */
export function bundleString(snap: Snapshot): string {
  return canonicalStringify(snap);
}

export class BakeError extends Error {
  readonly gaps: readonly CoverageGap[];
  constructor(message: string, gaps: readonly CoverageGap[]) {
    super(message);
    this.name = "BakeError";
    this.gaps = gaps;
  }
}

export interface BakeResult {
  readonly bundlePath: string; // 번들 리소스 상대 경로
  readonly bundle: string; // 정규화 스냅샷 바이트
  readonly lockfile: Lockfile;
  readonly lockfileText: string;
  readonly warnings: readonly string[];
}

export interface BakeOptions {
  /** strict면 커버리지 갭·base 불일치 시 빌드 실패. 아니면 경고만(3.1). */
  readonly strict?: boolean;
}

/**
 * bake 실행: 검증 → 산출물 생성. strict 모드는 갭/무결성 위반 시 BakeError.
 * 서버 fetch·마지막 캐시 fallback(6.3)은 이 순수 코어를 감싸는 플러그인 계층이 담당.
 */
export function bake(snap: Snapshot, opts: BakeOptions = {}): BakeResult {
  const warnings: string[] = [];
  const gaps = baseLocaleCoverage(snap);
  if (gaps.length > 0) {
    const msg = `기본 로케일(${snap.defaultLocale}) 커버리지 갭 ${gaps.length}건: ${gaps.map((g) => g.key).join(", ")}`;
    if (opts.strict) throw new BakeError(msg, gaps);
    warnings.push(msg);
  }
  const base = verifyBase(snap);
  if (!base.ok) {
    const msg = `base 해시 불일치: 선언=${snap.base} 실제=${base.expected}`;
    if (opts.strict) throw new BakeError(msg, gaps);
    warnings.push(msg);
  }
  const lockfile = buildLockfile(snap);
  return {
    bundlePath: `rynl10n/snapshot-${snap.base}.json`,
    bundle: bundleString(snap),
    lockfile,
    lockfileText: lockfileString(lockfile),
    warnings,
  };
}
