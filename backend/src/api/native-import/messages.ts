import { ARG_NAME } from "../../../../src/core/icu.ts";
import type { TranslationValue } from "../../../../src/core/types.ts";

type Fail = (message: string) => never;
const ARG = new RegExp(`^${ARG_NAME}$`, "u");
const SIMPLE = new RegExp(`^\\{\\s*(${ARG_NAME})\\s*\\}`, "u");

/** 현재 SDK가 실제로 치환할 수 있는 단순 ICU만 통과시킨다. 복합 표현을 리터럴로 배포하지 않는다. */
function simpleIcu(text: string, fail: Fail): void {
  if (/''|'[{}#]/u.test(text)) fail("ICU apostrophe escape는 지원하지 않습니다. 리터럴과 표현을 먼저 분리하세요");
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "}") fail("닫는 중괄호에 대응하는 ICU 인자가 없습니다");
    if (text[i] !== "{") continue;
    const match = SIMPLE.exec(text.slice(i));
    if (!match) fail("단순 {name} 외의 ICU number/date/select/중첩 표현은 지원하지 않습니다");
    i += match[0].length - 1;
  }
}

export function arbMessage(text: string, fail: Fail, warn: (message: string) => void): TranslationValue {
  if (/''|'[{}#]/u.test(text)) fail("ICU apostrophe escape는 지원하지 않습니다");
  const plural = new RegExp(`\\{\\s*(${ARG_NAME})\\s*,\\s*plural\\s*,`, "u").exec(text);
  if (!plural) { simpleIcu(text, fail); return text; }
  const prefix = text.slice(0, plural.index);
  simpleIcu(prefix, fail);
  let cursor = plural.index + plural[0].length;
  const branches = new Map<string, string>();
  while (true) {
    while (/\s/u.test(text[cursor] ?? "") && cursor < text.length) cursor++;
    if (text[cursor] === "}") { cursor++; break; }
    const category = /^(zero|one|two|few|many|other)\s*\{/u.exec(text.slice(cursor));
    if (!category) fail("ICU plural은 CLDR 카테고리만 지원합니다(=n·offset·중첩 표현은 지원하지 않습니다)");
    if (branches.has(category[1]!)) fail(`복수형 카테고리 ${category[1]}가 중복되었습니다`);
    cursor += category[0].length;
    const start = cursor;
    let depth = 1;
    while (cursor < text.length && depth > 0) {
      if (text[cursor] === "{") depth++;
      if (text[cursor] === "}") depth--;
      cursor++;
    }
    if (depth !== 0) fail("ICU plural의 중괄호가 닫히지 않았습니다");
    const branch = text.slice(start, cursor - 1);
    simpleIcu(branch, fail);
    branches.set(category[1]!, branch);
  }
  if (!branches.has("other")) fail("복수형에는 other 카테고리가 필요합니다");
  const suffix = text.slice(cursor);
  simpleIcu(suffix, fail);
  if (prefix.includes("#") || suffix.includes("#")) fail("plural 바깥의 리터럴 #은 CLDR 맵으로 옮기면 count로 바뀌므로 지원하지 않습니다");
  const argument = plural[1]!;
  const rename = argument !== "count" && argument !== "n";
  const combined = [...branches].map(([category, value]) => [category, prefix + value + suffix] as const);
  if (rename) {
    const simpleArg = new RegExp(`\\{\\s*(${ARG_NAME})\\s*\\}`, "gu");
    for (const [, value] of combined) {
      if ([...value.matchAll(simpleArg)].some((match) => match[1] === "count")) fail("plural 인자를 count로 정규화할 때 기존 count 인자와 충돌합니다");
    }
    warn(`복수형 인자 ${argument}를 SDK 공통 count로 정규화했습니다. 호출 인자도 count를 사용하세요`);
    return Object.fromEntries(combined.map(([category, value]) => [category,
      value.replace(simpleArg, (match, name: string) => name === argument ? "{count}" : match)]));
  }
  return Object.fromEntries(combined);
}

export function i18nextMessage(text: string, fail: Fail): string {
  if (text.includes("$t(")) fail("i18next $t() 재사용은 지원하지 않습니다. 먼저 값을 펼치세요");
  let out = "";
  for (let i = 0; i < text.length;) {
    if (text.startsWith("{{", i)) {
      const end = text.indexOf("}}", i + 2);
      if (end === -1) fail("i18next 인자가 닫히지 않았습니다");
      const name = text.slice(i + 2, end).trim().replace(/^-\s*/u, "");
      if (!ARG.test(name)) fail("i18next 인자는 단순 이름만 지원합니다(모델 경로·format은 지원하지 않습니다)");
      out += `{${name}}`; i = end + 2;
    } else {
      if (text[i] === "{" || text[i] === "}") fail("i18next의 리터럴 중괄호는 ICU 인자와 구별할 수 없습니다");
      out += text[i++];
    }
  }
  return out;
}

interface Ref { position: number; type: "string" | "number"; }
type Token = string | Ref;

/** 위치 인자는 argN으로 보존한다. 복수형 선택 count는 printf 인자와 별개라 추측하지 않는다. */
export function nativeMessage(
  value: TranslationValue, platform: "ios" | "android", fail: Fail,
): { value: TranslationValue; types: Map<number, "string" | "number"> } {
  const types = new Map<number, "string" | "number">();
  const tokenize = (text: string): Token[] => {
    if (new RegExp(`\\{\\s*${ARG_NAME}\\s*(?:[,}])`, "u").test(text)) fail("네이티브 문자열의 리터럴 ICU 모양 중괄호는 안전하게 변환할 수 없습니다");
    const tokens: Token[] = [];
    let literal = "", implicit = 0, mode: "implicit" | "explicit" | undefined;
    for (let i = 0; i < text.length;) {
      if (text[i] !== "%") { literal += text[i++]; continue; }
      if (text.startsWith("%%", i)) { literal += "%"; i += 2; continue; }
      const match = /^%(?:(\d+)\$)?(@|s|(?:ll|l|hh|h)?[diu])/u.exec(text.slice(i));
      if (!match) {
        if (/^%[\d$+\-#0.,<A-Za-z@]/u.test(text.slice(i))) fail("지원하지 않는 printf 형식입니다(폭·소수점·날짜 등은 먼저 단순 문자열로 바꾸세요)");
        literal += text[i++]; continue;
      }
      if ((platform === "android" && match[2] === "@") || (platform === "ios" && match[2] === "s")) fail("플랫폼에 맞지 않는 printf 문자열 인자입니다");
      const nextMode = match[1] === undefined ? "implicit" : "explicit";
      if (mode !== undefined && mode !== nextMode) fail("위치가 명시된 printf 인자와 암시적 인자를 섞을 수 없습니다");
      mode = nextMode;
      const position = match[1] === undefined ? ++implicit : Number(match[1]);
      if (!Number.isSafeInteger(position) || position < 1 || position > 1000) fail("printf 인자 위치는 1~1000이어야 합니다");
      const type = match[2] === "@" || match[2] === "s" ? "string" : "number";
      const before = types.get(position);
      if (before !== undefined && before !== type) fail(`위치 인자 ${position}의 타입이 다릅니다`);
      types.set(position, type);
      if (literal) tokens.push(literal);
      literal = "";
      tokens.push({ position, type }); i += match[0].length;
    }
    if (literal) tokens.push(literal);
    return tokens;
  };
  const plural = typeof value !== "string";
  const branches = typeof value === "string" ? [["", value] as const] : Object.entries(value);
  const tokenized = branches.map(([category, text]) => [category, tokenize(text!)] as const);
  const converted = tokenized.map(([category, tokens]) => {
    if (plural && tokens.some((token) => typeof token === "string" && token.includes("#"))) fail("네이티브 복수형의 리터럴 #은 ICU count 기호와 구별할 수 없습니다");
    const text = tokens.map((token) => typeof token === "string" ? token : `{arg${token.position}}`).join("");
    return [category, text] as const;
  });
  return { value: plural ? Object.fromEntries(converted) : converted[0]![1], types };
}
