/**
 * 2계층 resolve — 기획서 3.1
 *
 * 조회 순서: 원격 오버레이 → 번들 스냅샷, 키 단위 override.
 * 로케일 fallback: BCP 47 태그를 구체→일반으로 절단(ko-KR → ko → 기본 로케일).
 * **로케일 우선 원칙**: 각 로케일 단계 안에서 오버레이+번들을 모두 확인한 뒤에야 다음 로케일로.
 *   (덜 구체적인 로케일의 '최신' 번역보다, 더 구체적인 로케일의 '기존' 번역이 우선 —
 *    유저에겐 '맞는 언어'가 '최신 문구'보다 중요.)
 * 포맷 안전 가드: 오버레이 값의 플레이스홀더 서명이 번들과 불일치하면 그 키만 번들로 fallback.
 * tombstone: 삭제 마커. 오버레이가 (locale,key)를 tombstone하면 그 로케일에서 키를 가린다.
 */

import type { PluralCategory, Snapshot, TranslationValue } from "./types.ts";
import { isPluralMap } from "./types.ts";
import { signaturesMatch } from "./placeholder.ts";

export const TOMBSTONE = Symbol("tombstone");
export type OverlayEntry = TranslationValue | typeof TOMBSTONE;

/** 오버레이 계층: locale → key → 값 또는 tombstone. 델타를 번들 위에 적용한 sparse 결과. */
export class OverlayLayer {
  private readonly map = new Map<string, Map<string, OverlayEntry>>();

  set(locale: string, key: string, value: TranslationValue): void {
    this.bucket(locale).set(key, value);
  }
  tombstone(locale: string, key: string): void {
    this.bucket(locale).set(key, TOMBSTONE);
  }
  get(locale: string, key: string): OverlayEntry | undefined {
    return this.map.get(locale)?.get(key);
  }
  private bucket(locale: string): Map<string, OverlayEntry> {
    let b = this.map.get(locale);
    if (!b) { b = new Map(); this.map.set(locale, b); }
    return b;
  }
}

/**
 * BCP 47 로케일 fallback 체인: 구체→일반 절단 + 기본 로케일.
 * overrides로 명시적 부모 재지정 허용(5.1, 예: pt-BR → en).
 */
export function fallbackChain(
  locale: string,
  defaultLocale: string,
  overrides?: Readonly<Record<string, string>>,
): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = locale;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    const parent: string | undefined = overrides?.[cur];
    if (parent !== undefined) { cur = parent; continue; }
    const idx = cur.lastIndexOf("-");
    cur = idx > 0 ? cur.slice(0, idx) : undefined; // 구체→일반 절단
  }
  if (!seen.has(defaultLocale)) chain.push(defaultLocale);
  return chain;
}

export type ResolveSource = "overlay" | "bundle" | "unresolved";
export interface ResolveResult {
  readonly value: TranslationValue | undefined;
  readonly source: ResolveSource;
  readonly matchedLocale: string | undefined;
  /** 포맷 가드가 발동해 오버레이를 무시하고 번들로 fallback했는가(3.1). */
  readonly guardFallback: boolean;
}

export interface ResolveOptions {
  readonly localeOverrides?: Readonly<Record<string, string>>;
}

/**
 * (key, locale)을 2계층 + 로케일 우선 fallback으로 해석해 원시 값을 반환.
 * 포맷팅(ICU/복수형)은 formatValue로 별도 수행.
 */
export function resolveValue(
  bundle: Snapshot,
  overlay: OverlayLayer,
  key: string,
  locale: string,
  opts: ResolveOptions = {},
): ResolveResult {
  const chain = fallbackChain(locale, bundle.defaultLocale, opts.localeOverrides);
  for (const loc of chain) {
    const bundleVal = bundle.locales[loc]?.[key];
    const overlayEntry = overlay.get(loc, key);

    if (overlayEntry === TOMBSTONE) {
      // 삭제됨: 이 로케일에서 번들까지 가린다. 다음 로케일로.
      continue;
    }
    if (overlayEntry !== undefined) {
      // 오버레이 값 존재 → 포맷 가드 검사.
      if (bundleVal !== undefined && !signaturesMatch(overlayEntry, bundleVal)) {
        // 서명 불일치: 이 키만 오버레이 무시, 번들로 fallback (런타임 크래시 차단).
        return { value: bundleVal, source: "bundle", matchedLocale: loc, guardFallback: true };
      }
      return { value: overlayEntry, source: "overlay", matchedLocale: loc, guardFallback: false };
    }
    if (bundleVal !== undefined) {
      return { value: bundleVal, source: "bundle", matchedLocale: loc, guardFallback: false };
    }
    // 이 로케일엔 아무것도 없음 → 다음 로케일.
  }
  return { value: undefined, source: "unresolved", matchedLocale: undefined, guardFallback: false };
}

// ── ICU / CLDR 복수형 포맷팅 (스파이크 최소 구현) ─────────────────────────────
//
// 내부 저장 포맷은 ICU MessageFormat + CLDR 복수형 맵(5.3/5.4).
// 스파이크는 named 플레이스홀더 치환 + 최소 CLDR 복수 규칙(en/ko/ja/zh 계열)만 구현한다.
// 프로덕션 SDK는 전량 CLDR 규칙 + 완전한 ICU 파서를 쓴다.

type PluralArg = number;

function pluralCategory(locale: string, n: PluralArg): PluralCategory {
  const lang = locale.toLowerCase().split("-")[0]!;
  // 복수 구분 없는 언어군.
  if (["ko", "ja", "zh", "vi", "th", "id", "ms"].includes(lang)) return "other";
  // 영어형(one/other).
  if (["en", "de", "nl", "sv", "da", "no", "es", "it", "pt"].includes(lang)) {
    return n === 1 ? "one" : "other";
  }
  return "other";
}

function substitute(template: string, args: Readonly<Record<string, unknown>>, count?: number): string {
  let out = template.replace(/\{\s*([A-Za-z0-9_]+)\s*\}/g, (_m, name: string) => {
    const v = args[name];
    return v === undefined ? `{${name}}` : String(v);
  });
  if (count !== undefined) out = out.replace(/#/g, String(count)); // ICU 복수 count 축약
  return out;
}

/** 해석된 값을 로케일·인자로 포맷팅. 복수형은 count로 카테고리 선택 후 치환. */
export function formatValue(
  value: TranslationValue,
  locale: string,
  args: Readonly<Record<string, unknown>> = {},
): string {
  if (isPluralMap(value)) {
    const count = pickCount(args);
    const cat = pluralCategory(locale, count);
    const template = value[cat] ?? value.other ?? "";
    return substitute(template, args, count);
  }
  return substitute(value, args);
}

function pickCount(args: Readonly<Record<string, unknown>>): number {
  for (const name of ["count", "n"]) {
    const v = args[name];
    if (typeof v === "number") return v;
  }
  for (const v of Object.values(args)) if (typeof v === "number") return v;
  return 0;
}
