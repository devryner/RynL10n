/**
 * node-semver 부분집합 — 기획서 4.3 / 11.3
 *
 * 지원: 비교자 `>= > <= < =` + 공백 AND 결합 (`>=3.2.0 <3.3.0`).
 * 미지원(파싱 거부): `||`(OR) · `^` · `~` · x-range · hyphen-range.
 * → 범위를 항상 명시적 하한·상한으로 강제해 충돌 검사(8.2)를 단순·안전하게.
 *
 * 프리릴리스(`3.2.0-rc1`)는 기본 미매칭, matchPrerelease=true일 때만 평가(11.3).
 */

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** 프리릴리스 식별자 배열(비어있으면 정식 릴리스). 예: 3.2.0-rc.1 → ["rc", 1] */
  readonly prerelease: readonly (string | number)[];
}

const CORE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(input: string): SemVer {
  const m = CORE.exec(input.trim());
  if (!m) throw new Error(`유효하지 않은 버전: "${input}"`);
  const pre = m[4];
  const prerelease =
    pre === undefined
      ? []
      : pre.split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id));
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease };
}

export function isPrerelease(v: SemVer): boolean {
  return v.prerelease.length > 0;
}

/** semver 우선순위 비교: a<b → -1, a>b → 1, 동일 → 0 (프리릴리스 규칙 포함). */
export function compare(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  // 프리릴리스가 있는 쪽이 낮다.
  const ap = a.prerelease, bp = b.prerelease;
  if (ap.length === 0 && bp.length === 0) return 0;
  if (ap.length === 0) return 1;
  if (bp.length === 0) return -1;
  const n = Math.min(ap.length, bp.length);
  for (let i = 0; i < n; i++) {
    const x = ap[i]!, y = bp[i]!;
    const xn = typeof x === "number", yn = typeof y === "number";
    if (xn && yn) { if (x !== y) return (x as number) < (y as number) ? -1 : 1; }
    else if (xn) return -1; // 숫자 식별자는 비숫자보다 낮다
    else if (yn) return 1;
    else if (x !== y) return (x as string) < (y as string) ? -1 : 1;
  }
  if (ap.length !== bp.length) return ap.length < bp.length ? -1 : 1;
  return 0;
}

export type Op = ">=" | "<=" | ">" | "<" | "=";
export interface Comparator {
  readonly op: Op;
  readonly version: SemVer;
}

const REJECT = [
  { pat: "||", why: "OR(||)는 미지원 — 명시적 하한·상한만 허용" },
  { pat: "^", why: "캐럿(^) 범위는 미지원 — 명시적 비교자로 표기" },
  { pat: "~", why: "틸드(~) 범위는 미지원 — 명시적 비교자로 표기" },
  { pat: " - ", why: "hyphen-range는 미지원 — 명시적 비교자로 표기" },
];

const COMPARATOR = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/**
 * 부분집합 범위식을 Comparator[]로 파싱. 미지원 문법은 즉시 예외(11.3 '파싱 거부').
 * 반환된 비교자들은 AND로 결합된다.
 */
export function parseRange(input: string): Comparator[] {
  const raw = input.trim();
  if (raw === "") throw new Error("빈 범위식");
  for (const { pat, why } of REJECT) {
    if (raw.includes(pat)) throw new Error(`미지원 범위 문법 "${pat}": ${why} (11.3)`);
  }
  const tokens = raw.split(/\s+/);
  const comparators: Comparator[] = [];
  for (const tok of tokens) {
    const m = COMPARATOR.exec(tok);
    if (!m) {
      // x-range(1.2.x / 1.2.* / 1) 및 기타 미지원 형태를 여기서 거부.
      throw new Error(`미지원/유효하지 않은 비교자 "${tok}" — x-range·부분버전 거부 (11.3)`);
    }
    comparators.push({ op: (m[1] ?? "=") as Op, version: parseVersion(m[2]!) });
  }
  return comparators;
}

function satisfiesComparator(v: SemVer, c: Comparator): boolean {
  const cmp = compare(v, c.version);
  switch (c.op) {
    case ">=": return cmp >= 0;
    case "<=": return cmp <= 0;
    case ">": return cmp > 0;
    case "<": return cmp < 0;
    case "=": return cmp === 0;
  }
}

/**
 * 버전이 범위(AND 결합)를 만족하는가.
 * 프리릴리스 앱 버전은 기본 미매칭. matchPrerelease=true면 평가하되,
 * node-semver 관례처럼 '같은 (major,minor,patch) 튜플에 프리릴리스를 명시한 비교자가
 * 하나라도 있을 때만' 프리릴리스가 범위에 들어올 수 있게 한다.
 */
export function satisfies(
  version: SemVer,
  comparators: readonly Comparator[],
  opts: { matchPrerelease?: boolean } = {},
): boolean {
  if (isPrerelease(version)) {
    if (!opts.matchPrerelease) return false;
    const tupleMatch = comparators.some(
      (c) =>
        isPrerelease(c.version) &&
        c.version.major === version.major &&
        c.version.minor === version.minor &&
        c.version.patch === version.patch,
    );
    if (!tupleMatch) return false;
  }
  return comparators.every((c) => satisfiesComparator(version, c));
}

/** 편의: 문자열 버전 + 문자열 범위. */
export function versionInRange(
  version: string,
  range: string,
  opts?: { matchPrerelease?: boolean },
): boolean {
  return satisfies(parseVersion(version), parseRange(range), opts);
}
