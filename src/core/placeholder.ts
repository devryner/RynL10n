/**
 * 플레이스홀더 서명 & 포맷 안전 가드 — 기획서 3.1 / 5.1 / 5.3
 *
 * 내부 표준은 ICU MessageFormat이고 플레이스홀더는 이름 있는 형태 `{name}`으로 정규화된다(5.3).
 * 서명 = 값에 등장하는 (인자 이름, 인자 타입) 집합. 오버레이 값의 서명이 번들 값과 다르면
 * 그 키만 오버레이를 무시하고 번들로 fallback → 잘못된 원격 문자열로 인한 런타임 크래시 차단(3.1).
 */

import type { TranslationValue } from "./types.ts";
import { isPluralMap } from "./types.ts";

/**
 * ICU 인자 추출: `{name}`, `{name, plural, ...}`, `{name, number}` 등에서
 * (이름, 타입) 쌍을 뽑는다. 타입 미지정은 "simple"로 취급.
 * 복수형/select 하위 분기 안의 중첩 인자도 재귀적으로 수집한다.
 */
function collectArgs(icu: string, into: Map<string, string>): void {
  // 최상위 인자만 정확히 파싱하기보다, 도메인에 충분한 근사: `{ name , type ...}` 패턴 스캔.
  const re = /\{\s*([A-Za-z0-9_]+)\s*(?:,\s*(plural|selectordinal|select|number|date|time|spellout|ordinal|duration))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(icu)) !== null) {
    const name = m[1]!;
    const type = m[2] ?? "simple";
    // 같은 이름이 서로 다른 타입으로 등장하면 충돌 신호로 남긴다(서명에 반영).
    const prev = into.get(name);
    if (prev === undefined) into.set(name, type);
    else if (prev !== type) into.set(name, `${prev}|${type}`);
  }
}

/** 값의 플레이스홀더 서명을 결정적 문자열로 반환. 복수형 맵은 전 카테고리를 합쳐 계산. */
export function signature(value: TranslationValue): string {
  const args = new Map<string, string>();
  if (isPluralMap(value)) {
    for (const cat of Object.keys(value).sort()) {
      const s = value[cat as keyof typeof value];
      if (typeof s === "string") collectArgs(s, args);
    }
  } else {
    collectArgs(value, args);
  }
  return [...args.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([n, t]) => `${n}:${t}`)
    .join(",");
}

/** 두 값의 플레이스홀더 서명이 일치하는가 (3.1 포맷 가드). */
export function signaturesMatch(a: TranslationValue, b: TranslationValue): boolean {
  return signature(a) === signature(b);
}
