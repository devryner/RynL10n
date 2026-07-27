/**
 * 네이티브 포맷 변환 (bake) — 기획서 5.3
 *
 * 내부 표준(ICU MessageFormat + CLDR 복수형 맵) → 플랫폼 네이티브 포맷.
 *  - iOS `.xcstrings` (전 로케일 1파일, variations/plural)
 *  - Android `strings.xml` (로케일별, <plurals>)
 *  - Web JSON (로케일별, `{name}` 보존)
 *  - Flutter `.arb` (로케일별, ICU in-string + @key 메타)
 *
 * 플레이스홀더 규칙: 내부 `{name}`을 이름 있는 형태로 보고 플랫폼별 위치·타입으로 재매핑(5.3).
 *  - iOS: `%1$@`(string) · `%1$lld`(number)   Android: `%1$s`(string) · `%1$d`(number)
 *  - 복수형 카테고리 문자열의 첫 플레이스홀더(또는 `#`)를 count(number)로 본다.
 * 손실 규칙(5.3): 대상 미지원 CLDR 카테고리는 other로 병합 + 경고. 변환 손실은 warnings로 표면화.
 */

import type { Snapshot, TranslationValue, PluralCategory } from "../core/types.ts";
import { isPluralMap } from "../core/types.ts";

const CLDR_ORDER: PluralCategory[] = ["zero", "one", "two", "few", "many", "other"];

interface Arg {
  readonly name: string; // `#`는 "#"로 표기
  readonly type: "string" | "number";
}

type Token = { readonly lit: string } | { readonly ref: string }; // ref: arg name 또는 "#"

/** ICU 문자열을 리터럴/플레이스홀더 토큰으로 분해. `{name(, type...)}`와 `#`를 인식. */
function tokenize(icu: string): { tokens: Token[]; args: Array<{ name: string; type: "string" | "number" }> } {
  const tokens: Token[] = [];
  const args: Array<{ name: string; type: "string" | "number" }> = [];
  let i = 0;
  let lit = "";
  while (i < icu.length) {
    const ch = icu[i]!;
    if (ch === "#") {
      if (lit) { tokens.push({ lit }); lit = ""; }
      tokens.push({ ref: "#" });
      i++;
      continue;
    }
    if (ch === "{") {
      const end = icu.indexOf("}", i);
      if (end === -1) { lit += ch; i++; continue; }
      const inner = icu.slice(i + 1, end).trim();
      const m = /^([A-Za-z0-9_]+)\s*(?:,\s*([a-z]+))?/.exec(inner);
      if (m) {
        const name = m[1]!;
        const type: "string" | "number" = m[2] === "number" ? "number" : "string";
        if (lit) { tokens.push({ lit }); lit = ""; }
        tokens.push({ ref: name });
        if (!args.some((a) => a.name === name)) args.push({ name, type });
        i = end + 1;
        continue;
      }
    }
    lit += ch;
    i++;
  }
  if (lit) tokens.push({ lit });
  return { tokens, args };
}

/** 키의 순서화된 인자 목록(위치 인덱스 부여용). 복수형은 CLDR 순 카테고리 union, 첫 인자를 count(number). */
function orderedArgs(value: TranslationValue): Arg[] {
  if (!isPluralMap(value)) {
    return tokenize(value).args;
  }
  const seen = new Map<string, "string" | "number">();
  let countName: string | null = null;
  for (const cat of CLDR_ORDER) {
    const s = value[cat];
    if (s === undefined) continue;
    const { tokens, args } = tokenize(s);
    // 이 카테고리의 첫 참조(또는 #)를 count로 지목.
    if (countName === null) {
      const firstRef = tokens.find((t): t is { ref: string } => "ref" in t);
      if (firstRef) countName = firstRef.ref;
    }
    for (const a of args) if (!seen.has(a.name)) seen.set(a.name, a.type);
  }
  const args: Arg[] = [];
  // count 우선 배치(number), `#`는 별도 표기.
  if (countName !== null && countName !== "#") {
    args.push({ name: countName, type: "number" });
  } else if (countName === "#") {
    args.push({ name: "#", type: "number" });
  }
  for (const [name, type] of seen) {
    if (name === countName) continue;
    args.push({ name, type });
  }
  return args;
}

/** arg 이름 → 위치 인덱스(1-base) 맵. `#`도 count로 매핑. */
function indexMap(args: Arg[]): Map<string, { index: number; type: "string" | "number" }> {
  const map = new Map<string, { index: number; type: "string" | "number" }>();
  args.forEach((a, i) => map.set(a.name, { index: i + 1, type: a.type }));
  return map;
}

// ── Android strings.xml ───────────────────────────────────────────────────────

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "\\'");
}

/** Android 리소스 이름: [a-zA-Z0-9_]만, 숫자 시작 금지 → 손실 없이 sanitize. */
function androidName(key: string): string {
  let n = key.replace(/[^A-Za-z0-9_]/g, "_");
  if (/^[0-9]/.test(n)) n = "_" + n;
  return n;
}

function androidValue(icu: string, idx: Map<string, { index: number; type: "string" | "number" }>): string {
  const { tokens } = tokenize(icu);
  let out = "";
  for (const t of tokens) {
    if ("lit" in t) out += xmlEscape(t.lit);
    else {
      const info = idx.get(t.ref);
      if (info) out += `%${info.index}$${info.type === "number" ? "d" : "s"}`;
      else out += xmlEscape(`{${t.ref}}`);
    }
  }
  return out;
}

export interface ConvertResult<T> {
  readonly output: T;
  readonly warnings: readonly string[];
}

/**
 * 키 → 번역자용 설명(5.1). bake 시 각 플랫폼의 **표준 주석 필드**로 방출한다.
 *  - iOS `.xcstrings` → `comment` · Flutter `.arb` → `@key.description` · Android `strings.xml` → XML 주석
 *  - Web JSON은 주석을 담을 표준 자리가 없어 생략한다(조용한 손실이 아니라 포맷의 한계 — 5.3).
 * 생략하면(기본값) 산출물은 설명 도입 이전과 **바이트 동일**하다.
 */
export type Descriptions = Readonly<Record<string, string>>;

/**
 * XML 주석 본문으로 안전하게 만든다(XML 1.0 §2.5: 주석 안에 `--` 불가).
 * 문자를 지우지 않고 하이픈 사이에 공백만 넣어 보존한다 — 조용한 손실 금지(5.3).
 * 개행·연속 공백은 한 칸으로 접어 한 줄 주석으로 만든다(결정적 출력).
 */
function xmlCommentBody(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/-(?=-)/g, "- ");
}

/** 한 로케일의 카탈로그 → strings.xml 문자열. descriptions를 주면 각 항목 위에 XML 주석을 단다. */
export function toAndroidStringsXml(
  catalog: Readonly<Record<string, TranslationValue>>,
  descriptions: Descriptions = {},
): ConvertResult<string> {
  const warnings: string[] = [];
  const lines: string[] = [`<?xml version="1.0" encoding="utf-8"?>`, `<resources>`];
  for (const key of Object.keys(catalog).sort()) {
    const value = catalog[key]!;
    const name = androidName(key);
    if (name !== key) warnings.push(`키 "${key}" → 리소스명 "${name}"로 sanitize`);
    const desc = xmlCommentBody(descriptions[key] ?? "");
    if (desc) lines.push(`  <!-- ${desc} -->`);
    const idx = indexMap(orderedArgs(value));
    if (isPluralMap(value)) {
      lines.push(`  <plurals name="${name}">`);
      for (const cat of CLDR_ORDER) {
        const s = value[cat];
        if (s === undefined) continue;
        lines.push(`    <item quantity="${cat}">${androidValue(s, idx)}</item>`);
      }
      lines.push(`  </plurals>`);
    } else {
      lines.push(`  <string name="${name}">${androidValue(value, idx)}</string>`);
    }
  }
  lines.push(`</resources>`);
  return { output: lines.join("\n") + "\n", warnings };
}

// ── iOS .xcstrings ────────────────────────────────────────────────────────────

function iosValue(icu: string, idx: Map<string, { index: number; type: "string" | "number" }>): string {
  const { tokens } = tokenize(icu);
  let out = "";
  for (const t of tokens) {
    if ("lit" in t) out += t.lit;
    else {
      const info = idx.get(t.ref);
      if (info) out += `%${info.index}$${info.type === "number" ? "lld" : "@"}`;
      else out += `{${t.ref}}`;
    }
  }
  return out;
}

type XcstringsUnit = { stringUnit: { state: string; value: string } };
type XcstringsVariations = { variations: { plural: { [cat: string]: XcstringsUnit } } };
type XcstringsLocalization = XcstringsUnit | XcstringsVariations;

/** 전 로케일 카탈로그 → .xcstrings 객체(구조). descriptions를 주면 각 키에 `comment`를 단다. */
export function toXcstrings(snap: Snapshot, descriptions: Descriptions = {}): ConvertResult<Record<string, unknown>> {
  const warnings: string[] = [];
  const strings: Record<string, { comment?: string; localizations: Record<string, XcstringsLocalization> }> = {};
  const allKeys = new Set<string>();
  for (const keys of Object.values(snap.locales)) for (const k of Object.keys(keys)) allKeys.add(k);
  for (const key of [...allKeys].sort()) {
    const localizations: Record<string, XcstringsLocalization> = {};
    for (const locale of Object.keys(snap.locales).sort()) {
      const value = snap.locales[locale]?.[key];
      if (value === undefined) continue;
      const idx = indexMap(orderedArgs(value));
      if (isPluralMap(value)) {
        const plural: Record<string, XcstringsUnit> = {};
        for (const cat of CLDR_ORDER) {
          const s = value[cat];
          if (s === undefined) continue;
          plural[cat] = { stringUnit: { state: "translated", value: iosValue(s, idx) } };
        }
        localizations[locale] = { variations: { plural } };
      } else {
        localizations[locale] = { stringUnit: { state: "translated", value: iosValue(value, idx) } };
      }
    }
    const comment = descriptions[key];
    strings[key] = comment ? { comment, localizations } : { localizations };
  }
  return { output: { sourceLanguage: snap.defaultLocale, strings, version: "1.0" }, warnings };
}

// ── Web JSON (로케일별, `{name}` 보존) ────────────────────────────────────────

/** 한 로케일 카탈로그 → Web JSON 객체. 단순 문자열은 ICU 유지, 복수형은 카테고리 객체. */
export function toWebJson(catalog: Readonly<Record<string, TranslationValue>>): ConvertResult<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(catalog).sort()) {
    const value = catalog[key]!;
    if (isPluralMap(value)) {
      const m: Record<string, string> = {};
      for (const cat of CLDR_ORDER) if (value[cat] !== undefined) m[cat] = value[cat]!;
      out[key] = m;
    } else {
      out[key] = value;
    }
  }
  return { output: out, warnings: [] };
}

// ── Flutter .arb (ICU in-string + @key 메타) ─────────────────────────────────

/**
 * 한 로케일 카탈로그 → .arb 객체. 복수형은 ICU plural in-string, `@key`에 placeholders 메타.
 * descriptions를 주면 같은 `@key`에 ARB 표준 필드인 `description`을 함께 싣는다.
 */
export function toArb(
  catalog: Readonly<Record<string, TranslationValue>>,
  locale: string,
  descriptions: Descriptions = {},
): ConvertResult<Record<string, unknown>> {
  const out: Record<string, unknown> = { "@@locale": locale };
  for (const key of Object.keys(catalog).sort()) {
    const value = catalog[key]!;
    const args = orderedArgs(value);
    if (isPluralMap(value)) {
      const count = args[0]?.name ?? "count";
      const parts: string[] = [];
      for (const cat of CLDR_ORDER) {
        const s = value[cat];
        if (s === undefined) continue;
        parts.push(`${cat}{${s}}`);
      }
      out[key] = `{${count === "#" ? "count" : count}, plural, ${parts.join(" ")}}`;
    } else {
      out[key] = value;
    }
    const meta: Record<string, unknown> = {};
    if (descriptions[key]) meta.description = descriptions[key];
    if (args.length > 0) {
      const placeholders: Record<string, { type: string }> = {};
      for (const a of args) {
        const nm = a.name === "#" ? "count" : a.name;
        placeholders[nm] = { type: a.type === "number" ? "int" : "String" };
      }
      meta.placeholders = placeholders;
    }
    if (Object.keys(meta).length > 0) out[`@${key}`] = meta;
  }
  return { output: out, warnings: [] };
}
