/**
 * 빌드타임에 구운 번들 스냅샷을 런타임에 로드한다 — 기획서 3.2 / 6.3 (차별점 ①의 마지막 구간).
 *
 * `rynl10n-bake`가 빌드마다 `snapshot.json` + `rynl10n.lock`을 앱의 정적 자산 디렉토리에 넣는다.
 * Web에서 그 산출물을 쓰는 길은 두 갈래이고, 둘 다 여기서 같은 관문을 통과한다:
 *
 * ```ts
 * // ① 번들러가 import (권장 — 네트워크 왕복 0)
 * import raw from "./rynl10n/snapshot.json";
 * const bundle = BakedBundle.parse(raw);
 *
 * // ② 정적 자산에서 fetch (vendored 배치·번들러 없는 환경)
 * const bundle = await BakedBundle.load("/assets");
 * ```
 *
 * ①은 타입이 `any`로 새기 쉬운 자리라 **파싱이 아니라 검증**이 요점이다 — 잘못된 JSON을 import해도
 * 런타임 깊은 곳이 아니라 여기서 안내 메시지와 함께 실패한다(iOS `Snapshot.baked(in:)`,
 * Android `BakedBundle.snapshot(...)`과 같은 역할).
 */
import type { Snapshot } from "../../../src/core/types.ts";

/** bake lockfile(`rynl10n.lock`) — 어느 릴리스·base가 이 빌드에 구워졌는지 진단용. */
export interface BakedLockfile {
  readonly schemaVersion: number;
  readonly release: string;
  readonly base: string;
  readonly keyCount: number;
  readonly locales: readonly string[];
}

export class BakedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BakedError";
  }
}

/** 자산 루트 기준 탐색 순서 — iOS·Android의 후보 순서와 동일하게 유지한다. */
export const BAKED_CANDIDATES: readonly string[] = ["rynl10n/snapshot.json", "snapshot.json"];
export const BAKED_LOCKFILE_CANDIDATES: readonly string[] = ["rynl10n/rynl10n.lock", "rynl10n.lock"];

export interface LoadOptions {
  /** 테스트/커스텀용 fetch 주입(기본 전역 fetch). */
  readonly fetchImpl?: typeof fetch;
  /** 탐색 순서 재정의. */
  readonly candidates?: readonly string[];
}

function isSnapshotShape(value: unknown): value is Snapshot {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o["release"] === "string" &&
    typeof o["base"] === "string" &&
    typeof o["defaultLocale"] === "string" &&
    typeof o["locales"] === "object" &&
    o["locales"] !== null &&
    !Array.isArray(o["locales"])
  );
}

function isLockfileShape(value: unknown): value is BakedLockfile {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o["release"] === "string" &&
    typeof o["base"] === "string" &&
    typeof o["keyCount"] === "number" &&
    Array.isArray(o["locales"])
  );
}

function joinUrl(base: string, rel: string): string {
  return `${base.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`;
}

/** 이미 손에 있는 값(번들러 import 결과·파싱된 JSON)을 스냅샷으로 검증한다. */
export function parseBakedSnapshot(value: unknown, source = "bundle"): Snapshot {
  const decoded = typeof value === "string" ? safeJson(value) : value;
  if (!isSnapshotShape(decoded)) {
    throw new BakedError(
      `[rynl10n] ${source} 를 번들 스냅샷으로 읽지 못했습니다.\n` +
        `확인: ① 빌드에 rynl10n-bake가 연결됐는지 ② import 대상이 bake 산출물(snapshot.json)인지 ` +
        `③ 에어갭이면 vendored 스냅샷이 그 자리에 있는지.`,
    );
  }
  return decoded;
}

/** lockfile 판독. 형태가 아니면 undefined(런타임 동작에는 쓰이지 않는 진단 정보다). */
export function parseBakedLockfile(value: unknown): BakedLockfile | undefined {
  const decoded = typeof value === "string" ? safeJson(value) : value;
  return isLockfileShape(decoded) ? decoded : undefined;
}

/**
 * 정적 자산 루트에서 bake 산출물을 찾아 로드한다. 후보를 순서대로 시도하고 전부 실패하면 던진다.
 * (`baseUrl`은 자산 루트 — 배포 플레인 endpoint가 아니다. 번들은 앱과 함께 배포되는 파일이다.)
 */
export async function loadBakedSnapshot(baseUrl: string, opts: LoadOptions = {}): Promise<Snapshot> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const candidates = opts.candidates ?? BAKED_CANDIDATES;
  for (const candidate of candidates) {
    const url = joinUrl(baseUrl, candidate);
    const text = await tryFetchText(fetchImpl, url);
    if (text !== undefined) return parseBakedSnapshot(text, url);
  }
  throw new BakedError(
    `[rynl10n] ${baseUrl} 에서 bake된 스냅샷을 찾지 못했습니다(시도: ${candidates.join(", ")}).\n` +
      `확인: ① 빌드가 rynl10n-bake를 돌리는지 ② 산출물이 정적 자산으로 배포되는지 ` +
      `③ 에어갭이면 vendored 스냅샷이 그 자리에 있는지.`,
  );
}

/** 정적 자산 루트에서 lockfile을 찾아 읽는다. 없으면 undefined. */
export async function loadBakedLockfile(
  baseUrl: string,
  opts: LoadOptions = {},
): Promise<BakedLockfile | undefined> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  for (const candidate of opts.candidates ?? BAKED_LOCKFILE_CANDIDATES) {
    const text = await tryFetchText(fetchImpl, joinUrl(baseUrl, candidate));
    if (text !== undefined) return parseBakedLockfile(text);
  }
  return undefined;
}

async function tryFetchText(fetchImpl: typeof fetch, url: string): Promise<string | undefined> {
  try {
    const res = await fetchImpl(url);
    return res.ok ? await res.text() : undefined;
  } catch {
    return undefined; // 다음 후보로
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** iOS `Snapshot.baked` · Android `BakedBundle`과 짝을 이루는 네임스페이스 표면. */
export const BakedBundle = {
  CANDIDATES: BAKED_CANDIDATES,
  LOCKFILE_CANDIDATES: BAKED_LOCKFILE_CANDIDATES,
  parse: parseBakedSnapshot,
  parseLockfile: parseBakedLockfile,
  load: loadBakedSnapshot,
  loadLockfile: loadBakedLockfile,
} as const;
