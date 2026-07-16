/**
 * 정수(빌드 넘버) 범위 매칭 — 기획서 5.2 확장 지점(M4).
 * semver-range와 동일한 부분집합 문법(비교자 + 공백 AND), 단 값은 정수.
 * 정수는 이산이라 모든 경계를 **포함 정수 하한/상한**으로 정규화 → 인접 판정이 정확하다.
 * (`>n`→`>=n+1`, `<n`→`<=n-1`) 미지원 문법(`||`·`^`·`~`·범위표기)은 거부.
 */

export interface IntComparator {
  readonly op: ">=" | "<=" | ">" | "<" | "=";
  readonly n: number;
}
/** 포함 정수 구간 [lower, upper]. null=무한. */
export interface IntInterval {
  readonly lower: number | null;
  readonly upper: number | null;
}

const REJECT = ["||", "^", "~", " - "];
const COMPARATOR = /^(>=|<=|>|<|=)?(-?\d+)$/;

export function parseIntRange(input: string): IntComparator[] {
  const raw = input.trim();
  if (raw === "") throw new Error("빈 정수 범위식");
  for (const pat of REJECT) if (raw.includes(pat)) throw new Error(`미지원 정수 범위 문법 "${pat}"`);
  const tokens = raw.split(/\s+/);
  return tokens.map((tok) => {
    const m = COMPARATOR.exec(tok);
    if (!m) throw new Error(`유효하지 않은 정수 비교자 "${tok}"`);
    return { op: (m[1] ?? "=") as IntComparator["op"], n: Number(m[2]) };
  });
}

/** 포함 정수 구간으로 정규화. */
export function intInterval(comparators: readonly IntComparator[]): IntInterval {
  let lower: number | null = null;
  let upper: number | null = null;
  const raiseLower = (v: number) => { if (lower === null || v > lower) lower = v; };
  const lowerUpper = (v: number) => { if (upper === null || v < upper) upper = v; };
  for (const c of comparators) {
    switch (c.op) {
      case ">=": raiseLower(c.n); break;
      case ">": raiseLower(c.n + 1); break;
      case "<=": lowerUpper(c.n); break;
      case "<": lowerUpper(c.n - 1); break;
      case "=": raiseLower(c.n); lowerUpper(c.n); break;
    }
  }
  return { lower, upper };
}

export function intSatisfies(n: number, comparators: readonly IntComparator[]): boolean {
  const { lower, upper } = intInterval(comparators);
  if (lower !== null && n < lower) return false;
  if (upper !== null && n > upper) return false;
  return true;
}

export function intInRange(n: number, range: string): boolean {
  return intSatisfies(n, parseIntRange(range));
}

/** 두 포함 정수 구간이 공통 정수를 갖는가. */
export function intIntervalsOverlap(a: IntInterval, b: IntInterval): boolean {
  const lo = a.lower === null ? (b.lower ?? -Infinity) : b.lower === null ? a.lower : Math.max(a.lower, b.lower);
  const hi = a.upper === null ? (b.upper ?? Infinity) : b.upper === null ? a.upper : Math.min(a.upper, b.upper);
  return lo <= hi;
}
