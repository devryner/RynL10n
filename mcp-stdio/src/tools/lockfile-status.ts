/**
 * `lockfile_status` — "지금 이 빌드에 무엇이 구워져 있나, 그리고 앱이 실제로 그걸 집는가"
 *
 * `bake_preview`가 **다음** 빌드를 보는 도구라면 이건 **지금** 상태를 보는 도구다. lockfile은
 * 빌드가 의도한 릴리스·base의 기록이고(런타임도 번들 선택 기준으로 읽는다),
 * 그래서 "의도한 것"과 "디스크에 있는 것"이 어긋났는지 볼 수 있는 자리도 여기뿐이다.
 *
 * **진단의 핵심은 SDK가 어느 파일을 집느냐다.** `--stable-name` 없이 구우면 파일명이
 * `snapshot-<base>.json`이라 빌드를 거듭할수록 산출물 디렉토리에 **쌓인다**. 두 SDK 모두
 * lockfile의 release·base와 일치하는 번들만 선택한다. lockfile이 없거나 깨졌으면 stable-name,
 * 그것도 없으면 내용해시 후보 하나만 허용한다. 복수 후보에서 임의 선택하지 않는다.
 *
 * 탐색 순서는 두 SDK가 같다(`mcp-stdio/README.md`):
 *   ① `<dir>/rynl10n/snapshot.json` ② `<dir>/snapshot.json` ③ `snapshot-<base>.json`
 * lockfile은 ① `<dir>/rynl10n/rynl10n.lock` ② `<dir>/rynl10n.lock`.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { verifyBase, type Lockfile } from "../../../src/builder/bake.ts";
import type { Snapshot } from "../../../src/core/types.ts";

export interface LockfileStatusInput {
  readonly outDir: string;
}

export type DiagnosisCode =
  | "ok"
  | "lockfile_missing"
  | "lockfile_unreadable"
  | "bundle_missing"
  | "base_mismatch"
  | "base_integrity_failed"
  | "stale_candidates";

export interface Diagnosis {
  readonly code: DiagnosisCode;
  readonly message: string;
}

export interface BundleCandidate {
  readonly path: string;
  readonly base: string | null;
  /** 로더 탐색 순서에서 먼저 걸리는 파일인가. */
  readonly wouldLoad: boolean;
}

export interface LockfileStatusResult {
  readonly lockfile: (Lockfile & { readonly path: string }) | null;
  readonly bundle: {
    readonly path: string;
    readonly release: string;
    readonly base: string;
    readonly matchesLockfile: boolean;
    readonly baseIntegrity: { readonly ok: boolean; readonly expected: string };
  } | null;
  readonly candidates: readonly BundleCandidate[];
  readonly diagnosis: readonly Diagnosis[];
  readonly ok: boolean;
}

const LOCKFILE_CANDIDATES = [join("rynl10n", "rynl10n.lock"), "rynl10n.lock"] as const;
const STABLE_CANDIDATES = [join("rynl10n", "snapshot.json"), "snapshot.json"] as const;

export function lockfileStatus(input: LockfileStatusInput): LockfileStatusResult {
  const diagnosis: Diagnosis[] = [];
  const lockfile = readLockfile(input.outDir, diagnosis);
  const candidates = findBundleCandidates(input.outDir, lockfile);
  const loaded = candidates.find((c) => c.wouldLoad) ?? null;

  if (candidates.length === 0) {
    diagnosis.push({
      code: "bundle_missing",
      message: `${input.outDir} 아래에서 bake된 스냅샷을 찾지 못했다. 빌드가 돌지 않았거나(플러그인 미연결) 산출물이 다른 곳으로 갔다.`,
    });
    return { lockfile, bundle: null, candidates, diagnosis, ok: false };
  }

  if (loaded === null && lockfile !== null) {
    diagnosis.push({
      code: "base_mismatch",
      message: `lockfile의 release=${lockfile.release} base=${lockfile.base}와 일치하는 번들이 없다 — SDK는 오래된 번들로 대체하지 않는다.`,
    });
  } else if (loaded === null && candidates.length > 1) {
    diagnosis.push({
      code: "stale_candidates",
      message: `내용해시 번들이 ${candidates.length}개여서 의도한 번들을 고를 수 없다. 올바른 lockfile을 포함하거나 오래된 산출물을 지울 것.`,
    });
  }

  const snap = loaded === null ? null : tryParseSnapshot(loaded.path);
  if (snap === null) {
    diagnosis.push({
      code: "bundle_missing",
      message: `번들을 읽지 못했다: ${loaded?.path ?? "(없음)"}`,
    });
    return { lockfile, bundle: null, candidates, diagnosis, ok: false };
  }

  const integrity = verifyBase(snap);
  if (!integrity.ok) {
    diagnosis.push({
      code: "base_integrity_failed",
      message: `번들의 선언 base(${snap.base})가 실제 콘텐츠 해시(${integrity.expected})와 다르다 — 손으로 고쳤거나 전송 중 깨졌다.`,
    });
  }

  const matchesLockfile = lockfile !== null && lockfile.base === snap.base && lockfile.release === snap.release;

  if (diagnosis.length === 0) {
    diagnosis.push({
      code: "ok",
      message: `release=${snap.release} base=${snap.base} — lockfile과 번들이 일치하고 앱이 그것을 집는다.`,
    });
  }
  return {
    lockfile,
    bundle: {
      path: loaded!.path,
      release: snap.release,
      base: snap.base,
      matchesLockfile,
      baseIntegrity: integrity,
    },
    candidates,
    diagnosis,
    ok: diagnosis.every((d) => d.code === "ok"),
  };
}

export function summarize(r: LockfileStatusResult): string {
  if (r.ok && r.bundle !== null) {
    return `release=${r.bundle.release} base=${r.bundle.base} — 구워진 것과 앱이 집는 것이 일치한다(키 ${r.lockfile?.keyCount ?? "?"}).`;
  }
  const codes = r.diagnosis.filter((d) => d.code !== "ok").map((d) => d.code).join(", ");
  return `문제 ${r.diagnosis.length}건: ${codes}`;
}

// ── 탐색 ─────────────────────────────────────────────────────────────────────

function readLockfile(outDir: string, diagnosis: Diagnosis[]): (Lockfile & { path: string }) | null {
  for (const rel of LOCKFILE_CANDIDATES) {
    const path = join(outDir, rel);
    if (!isFile(path)) continue;
    try {
      const parsed = parseLockfile(readFileSync(path, "utf8"));
      if (parsed === null) {
        diagnosis.push({ code: "lockfile_unreadable", message: `lockfile 형식이 아니다: ${path}` });
        return null;
      }
      return { ...parsed, path };
    } catch {
      diagnosis.push({ code: "lockfile_unreadable", message: `lockfile을 파싱하지 못했다: ${path}` });
      return null;
    }
  }
  diagnosis.push({
    code: "lockfile_missing",
    message:
      `${outDir} 아래에 rynl10n.lock이 없다. 어느 릴리스·base가 구워졌는지 대조할 근거가 없다 — ` +
      `빌드가 돌지 않았거나 lockfile이 산출물에서 빠졌다.`,
  });
  return null;
}

/** SDK의 Decodable/serialization 필수 필드와 같은 범위로 판독한다. */
export function parseLockfile(text: string): Lockfile | null {
  try {
    const parsed = JSON.parse(text) as Lockfile;
    return typeof parsed?.base === "string" && typeof parsed?.release === "string"
      && Number.isInteger(parsed.schemaVersion) && Number.isInteger(parsed.keyCount)
      && Array.isArray(parsed.locales) && parsed.locales.every((locale) => typeof locale === "string")
      ? parsed : null;
  } catch {
    return null;
  }
}

/** SDK의 lockfile 기준 선택. bake_preview도 같은 선택으로 현재 카탈로그를 찾는다. */
function findBundleCandidates(outDir: string, lockfile: Lockfile | null): BundleCandidate[] {
  const found: string[] = [];
  for (const rel of STABLE_CANDIDATES) {
    const path = join(outDir, rel);
    if (isFile(path)) found.push(path);
  }
  // 내용해시 파일명 — 두 SDK 모두 `rynl10n/` 먼저, 그 다음 루트를 본다.
  for (const dir of [join(outDir, "rynl10n"), outDir]) {
    if (!isDir(dir)) continue;
    const hits = readdirSync(dir)
      .filter((f) => f.startsWith("snapshot-") && f.endsWith(".json"))
      .sort()
      .map((f) => join(dir, f)).filter(isFile);
    found.push(...hits);
  }
  const snapshots = new Map(found.map((path) => [path, tryParseSnapshot(path)]));
  const selected = lockfile !== null
    ? found.find((path) => {
      const snap = snapshots.get(path);
      return snap?.base === lockfile.base && snap.release === lockfile.release;
    })
    : found.find(isStableName) ?? (found.length === 1 ? found[0] : undefined);
  return found.map((path) => ({ path, base: snapshots.get(path)?.base ?? null, wouldLoad: path === selected }));
}

/** `--stable-name` 산출물인가. 내용해시 이름은 `snapshot-<base>.json`이라 여기 걸리지 않는다. */
function isStableName(path: string): boolean {
  return path.endsWith("snapshot.json");
}

function tryParseSnapshot(path: string): Snapshot | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Snapshot>;
    const record = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    return Number.isInteger(parsed?.schemaVersion) && typeof parsed.base === "string" && typeof parsed.release === "string"
      && typeof parsed.defaultLocale === "string" && record(parsed.locales)
      && Object.values(parsed.locales).every((catalog) => record(catalog) && Object.values(catalog).every((value) =>
        typeof value === "string" || (record(value) && Object.values(value).every((text) => typeof text === "string"))))
      ? (parsed as Snapshot)
      : null;
  } catch {
    return null;
  }
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function isDir(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}
