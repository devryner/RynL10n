/** 네이티브 번역 파일 → 기존 import 입력. DB 판정·저장은 translation-import.ts가 전담한다. */
import type { TranslationValue } from "../../../src/core/types.ts";
import { BadRequestError } from "./errors.ts";
import { arbMessage, i18nextMessage, nativeMessage } from "./native-import/messages.ts";
import { androidText, parseXml } from "./native-import/xml.ts";

export type NativeImportFormat = "xcstrings" | "android-xml" | "arb" | "i18next" | "rynl10n";
export interface NativeImportWarning { file: string; key?: string; message: string; }
export interface NativeImportResult { data: unknown; warnings: NativeImportWarning[]; }
interface SourceFile { name: string; content: string; locale?: string; }
interface Entry { locale: string; value: TranslationValue; state: string; }
interface Key { name: string; description?: string; translations: Entry[]; }
const CATEGORIES = new Set(["zero", "one", "two", "few", "many", "other"]);
const FORMATS = new Set(["xcstrings", "android-xml", "arb", "i18next", "rynl10n"]);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function bad(message: string): never { throw new BadRequestError(`번역 파일 형식: ${message}`); }

/** JSON.parse의 조용한 중복 키 덮어쓰기를 막고 입력 중첩을 제한한다. */
function json(source: string, fail: (message: string) => never): unknown {
  const text = source.replace(/^\uFEFF/u, "");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return fail("JSON 문법이 잘못되었습니다"); }
  let cursor = 0;
  const space = () => { while (cursor < text.length && /\s/u.test(text[cursor]!)) cursor++; };
  const string = (): string => {
    const start = cursor++;
    while (cursor < text.length) {
      if (text[cursor] === "\\") { cursor += 2; continue; }
      if (text[cursor++] === '"') break;
    }
    return JSON.parse(text.slice(start, cursor)) as string;
  };
  const visit = (depth: number): void => {
    if (depth > 64) fail("JSON 중첩은 64단계까지만 지원합니다");
    space();
    if (text[cursor] === '"') { string(); return; }
    if (text[cursor] === "{") {
      cursor++; space();
      const names = new Set<string>();
      if (text[cursor] === "}") { cursor++; return; }
      while (true) {
        space(); const name = string();
        if (names.has(name)) fail(`JSON 키 ${name}가 중복되었습니다`);
        names.add(name); space(); cursor++; visit(depth + 1); space();
        if (text[cursor++] === "}") return;
      }
    }
    if (text[cursor] === "[") {
      cursor++; space();
      if (text[cursor] === "]") { cursor++; return; }
      while (true) { visit(depth + 1); space(); if (text[cursor++] === "]") return; }
    }
    while (cursor < text.length && !/[\s,}\]]/u.test(text[cursor]!)) cursor++;
  };
  visit(0);
  return parsed;
}

export function parseNativeImport(body: unknown): NativeImportResult {
  if (!record(body) || typeof body.format !== "string" || !FORMATS.has(body.format)) bad("지원 포맷은 xcstrings·android-xml·arb·i18next·rynl10n입니다");
  if (!Array.isArray(body.files) || body.files.length < 1 || body.files.length > 100) bad("files는 1~100개여야 합니다");
  const files: SourceFile[] = [];
  let total = 0;
  for (const item of body.files) {
    if (!record(item) || typeof item.name !== "string" || !item.name.trim() || typeof item.content !== "string") bad("각 파일은 name·content 문자열이 필요합니다");
    if (item.locale !== undefined && (typeof item.locale !== "string" || !item.locale.trim())) bad(`${item.name}: locale은 비어 있지 않은 문자열이어야 합니다`);
    const bytes = Buffer.byteLength(item.content, "utf8");
    total += bytes;
    if (bytes > 5 * 1024 * 1024 || total > 10 * 1024 * 1024) bad("파일당 5MiB·전체 10MiB까지만 가져올 수 있습니다");
    files.push({ name: item.name, content: item.content, ...(typeof item.locale === "string" ? { locale: item.locale } : {}) });
  }

  const warnings: NativeImportWarning[] = [];
  const keys = new Map<string, Key>();
  const argumentTypes = new Map<string, Map<number, "string" | "number">>();
  const add = (file: SourceFile, name: string, locale: string, value: TranslationValue, description?: string, state = "draft", types?: Map<number, "string" | "number">) => {
    const fail: (message: string) => never = (message) => bad(`${file.name} / ${name}: ${message}`);
    if (!name.trim() || name !== name.trim()) fail("키는 비어 있거나 바깥 공백을 포함할 수 없습니다");
    if (name === "__proto__") fail("__proto__ 키는 현재 카탈로그에서 안전하게 표현할 수 없습니다");
    if (keys.size >= 100_000 && !keys.has(name)) fail("가져올 키가 너무 많습니다(최대 100000개)");
    let key = keys.get(name);
    if (!key) { key = { name, ...(description !== undefined ? { description } : {}), translations: [] }; keys.set(name, key); }
    if (key.translations.some((entry) => entry.locale === locale)) fail(`로케일 ${locale}가 중복되었습니다`);
    if (description !== undefined) {
      if (key.description !== undefined && key.description !== description) fail("파일 사이 키 설명이 다릅니다. 사용할 설명을 하나로 맞추세요");
      key.description = description;
    }
    const known = argumentTypes.get(name) ?? new Map<number, "string" | "number">();
    for (const [position, type] of types ?? []) {
      if (known.has(position) && known.get(position) !== type) fail(`위치 인자 ${position}의 타입이 로케일마다 다릅니다`);
      known.set(position, type);
    }
    argumentTypes.set(name, known);
    key.translations.push({ locale, value, state });
  };

  for (const file of files) {
    const fail: (message: string) => never = (message) => bad(`${file.name}: ${message}`);
    const warn = (message: string, key?: string): void => { warnings.push({ file: file.name, ...(key === undefined ? {} : { key }), message }); };
    const locale = (embedded?: unknown): string => {
      const normalize = (value: unknown): string => {
        if (typeof value !== "string" || !value.trim()) return fail("locale을 지정하거나 파일의 로케일 메타데이터를 포함하세요");
        try { return Intl.getCanonicalLocales(value.trim().replaceAll("_", "-"))[0]!; }
        catch { return fail(`잘못된 BCP 47 로케일 ${value}`); }
      };
      const chosen = normalize(file.locale ?? embedded);
      if (file.locale !== undefined && embedded !== undefined && chosen !== normalize(embedded)) fail("지정한 로케일과 파일 내부 로케일이 다릅니다");
      return chosen;
    };
    const native = (name: string, loc: string, value: TranslationValue, platform: "ios" | "android", description?: string) => {
      const result = nativeMessage(value, platform, (message) => fail(`${name}: ${message}`));
      if (result.types.size) warn("printf 위치 인자를 argN으로 정규화했습니다. SDK 호출 인자도 변환된 이름을 사용하세요", name);
      if (typeof value !== "string") warn("복수형 선택에는 count를 별도로 전달하세요. printf 위치 인자 argN은 선택용 count로 추측하지 않습니다", name);
      add(file, name, loc, result.value, description, "draft", result.types);
    };

    if (body.format === "android-xml") {
      const root = parseXml(file.content, fail);
      if (root.name !== "resources") fail("XML 루트는 resources여야 합니다");
      for (const attribute of root.attrs.keys()) if (!attribute.startsWith("xmlns:")) fail(`resources 속성 ${attribute}는 지원하지 않습니다`);
      const loc = locale();
      let description: string | undefined;
      for (const child of root.children) {
        if (typeof child === "string") { if (child.trim()) fail("resources 바로 아래에는 텍스트를 넣을 수 없습니다"); continue; }
        if ("comment" in child) { description = description === undefined ? child.comment.trim() : `${description}\n${child.comment.trim()}`; continue; }
        const name = child.attrs.get("name");
        if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) fail("Android 리소스에는 유효한 name이 필요합니다");
        for (const [attribute, value] of child.attrs) {
          if (attribute === "name") continue;
          if (["translatable", "formatted"].includes(attribute) && ["true", "false"].includes(value)) {
            if (attribute === "translatable" && value === "false") warn("translatable=false 메타데이터는 저장하지 않으며 값은 draft로 가져옵니다", name);
            continue;
          }
          fail(`${name}: Android 속성 ${attribute}는 지원하지 않습니다`);
        }
        if (child.name === "string") {
          const value = androidText(child, fail);
          if (child.attrs.get("formatted") === "false") {
            if (/%(?:\d+\$)?(?:@|s|(?:ll|l)?[diu])/u.test(value)) warn("formatted=false이므로 printf 모양 텍스트를 리터럴로 보존했습니다", name);
            if (/[{}]/u.test(value)) fail(`${name}: formatted=false 문자열의 중괄호를 ICU와 구별할 수 없습니다`);
            add(file, name, loc, value, description);
          } else native(name, loc, value, "android", description);
        } else if (child.name === "plurals") {
          const branches: Array<[string, string]> = [];
          for (const item of child.children) {
            if (typeof item === "string") { if (item.trim()) fail(`${name}: plurals 바로 아래 텍스트는 지원하지 않습니다`); continue; }
            if ("comment" in item) continue;
            const category = item.attrs.get("quantity");
            if (item.name !== "item" || !category || !CATEGORIES.has(category) || item.attrs.size !== 1) fail(`${name}: plurals는 CLDR quantity를 가진 item만 지원합니다`);
            if (branches.some(([existing]) => existing === category)) fail(`${name}: 복수형 카테고리가 중복되었습니다`);
            branches.push([category, androidText(item, fail)]);
          }
          if (!branches.some(([category]) => category === "other")) fail(`${name}: 복수형에는 other가 필요합니다`);
          if (child.attrs.get("formatted") === "false") fail(`${name}: formatted=false 복수형은 지원하지 않습니다`);
          native(name, loc, Object.fromEntries(branches), "android", description);
        } else fail(`${name}: ${child.name} 리소스는 지원하지 않습니다(string·plurals만 지원)`);
        description = undefined;
      }
      continue;
    }

    const parsed = json(file.content, fail);
    if (!record(parsed)) fail("JSON 최상위는 객체여야 합니다");
    if (body.format === "xcstrings") {
      if (file.locale !== undefined) fail("xcstrings는 다국어 파일이므로 locale을 별도로 지정하지 마세요");
      const sourceLocale = locale(parsed.sourceLanguage);
      if (!record(parsed.strings)) fail("xcstrings의 strings 객체가 필요합니다");
      for (const [name, raw] of Object.entries(parsed.strings)) {
        if (!record(raw)) fail(`${name}: xcstrings 키는 객체여야 합니다`);
        for (const property of Object.keys(raw)) if (!["comment", "localizations", "extractionState", "shouldTranslate"].includes(property)) fail(`${name}: xcstrings ${property} 구조는 지원하지 않습니다`);
        if (raw.comment !== undefined && typeof raw.comment !== "string") fail(`${name}: comment는 문자열이어야 합니다`);
        const description = raw.comment as string | undefined;
        const translations = raw.localizations ?? {};
        if (!record(translations)) fail(`${name}: localizations는 객체여야 합니다`);
        let sourceFound = false, hasPlural = false;
        for (const [tag, unit] of Object.entries(translations)) {
          if (!record(unit)) fail(`${name}: localization은 객체여야 합니다`);
          const loc = locale(tag);
          if (loc === sourceLocale) sourceFound = true;
          let value: TranslationValue;
          if (record(unit.stringUnit) && Object.keys(unit).length === 1 && typeof unit.stringUnit.value === "string") value = unit.stringUnit.value;
          else if (record(unit.variations) && Object.keys(unit).length === 1 && Object.keys(unit.variations).length === 1 && record(unit.variations.plural)) {
            hasPlural = true;
            const branches: Array<[string, string]> = [];
            for (const [category, variation] of Object.entries(unit.variations.plural)) {
              if (!CATEGORIES.has(category) || !record(variation) || Object.keys(variation).length !== 1 || !record(variation.stringUnit) || typeof variation.stringUnit.value !== "string") fail(`${name}: 단순 CLDR plural stringUnit만 지원합니다`);
              branches.push([category, variation.stringUnit.value]);
            }
            if (!branches.some(([category]) => category === "other")) fail(`${name}: 복수형에는 other가 필요합니다`);
            value = Object.fromEntries(branches);
          } else return fail(`${name}: xcstrings device/substitutions 또는 잘못된 stringUnit은 지원하지 않습니다`);
          native(name, loc, value, "ios", description);
        }
        if (!sourceFound) {
          if (hasPlural) fail(`${name}: 복수형의 원문 로케일은 명시적인 plural 번역이 필요합니다`);
          warn(`원문 로케일 ${sourceLocale}의 값이 없어 키 자체를 원문으로 사용했습니다`, name);
          native(name, sourceLocale, name, "ios", description);
        }
      }
      warn("Xcode 검수·추출·shouldTranslate 메타데이터는 저장하지 않으며 모든 번역은 draft로 가져옵니다");
      continue;
    }

    if (body.format === "arb") {
      const loc = locale(parsed["@@locale"]);
      for (const [name, value] of Object.entries(parsed)) {
        if (name.startsWith("@@")) { if (name !== "@@locale") warn(`ARB ${name} 메타데이터는 저장하지 않습니다`); continue; }
        if (name.startsWith("@")) {
          if (!Object.hasOwn(parsed, name.slice(1))) fail(`${name}: 대응하는 메시지가 없는 메타데이터입니다`);
          continue;
        }
        if (typeof value !== "string") fail(`${name}: ARB 메시지는 문자열이어야 합니다`);
        const meta = parsed[`@${name}`];
        if (meta !== undefined && !record(meta)) fail(`${name}: ARB 메타데이터는 객체여야 합니다`);
        if (record(meta)) {
          if (meta.description !== undefined && typeof meta.description !== "string") fail(`${name}: description은 문자열이어야 합니다`);
          if (meta.placeholders !== undefined && !record(meta.placeholders)) fail(`${name}: placeholders는 객체여야 합니다`);
          for (const [argument, metadata] of Object.entries(record(meta.placeholders) ? meta.placeholders : {})) {
            if (!record(metadata)) fail(`${name}: ${argument} placeholder 메타데이터가 잘못되었습니다`);
            if (metadata.format !== undefined || metadata.optionalParameters !== undefined || metadata.type === "DateTime") fail(`${name}: 숫자·날짜 format 메타데이터는 지원하지 않습니다`);
          }
          if (Object.keys(meta).some((property) => property !== "description")) warn("ARB 코드 생성·placeholder 메타데이터는 저장하지 않습니다", name);
        }
        const converted = arbMessage(value, (message) => fail(`${name}: ${message}`), (message) => warn(message, name));
        add(file, name, loc, converted, record(meta) ? meta.description as string | undefined : undefined);
      }
      continue;
    }

    if (body.format === "i18next") {
      const loc = locale();
      const flat = new Map<string, TranslationValue>();
      const addFlat = (name: string, value: TranslationValue) => {
        if (flat.has(name)) fail(`${name}: 중첩 키와 점으로 구분한 키가 중복되었습니다`);
        flat.set(name, value);
      };
      const visit = (node: Record<string, unknown>, prefix: string) => {
        for (const [segment, value] of Object.entries(node)) {
          const name = prefix ? `${prefix}.${segment}` : segment;
          if (!segment) fail("i18next 키는 비어 있을 수 없습니다");
          if (typeof value === "string") addFlat(name, i18nextMessage(value, (message) => fail(`${name}: ${message}`)));
          else if (record(value) && Object.keys(value).length) visit(value, name);
          else fail(`${name}: i18next는 문자열·중첩 객체·CLDR 맵만 지원합니다(배열은 지원하지 않습니다)`);
        }
      };
      visit(parsed, "");
      const plurals = new Map<string, Map<string, string>>();
      for (const [name, value] of flat) {
        const suffix = /^(.*)_(zero|one|two|few|many|other)$/u.exec(name);
        if (!suffix) { if (name.endsWith("_plural")) fail(`${name}: i18next v3 plural은 지원하지 않습니다(v4 카테고리를 사용하세요)`); continue; }
        if (typeof value !== "string" || suffix[1]!.endsWith("_ordinal")) fail(`${name}: ordinal 또는 중첩 복수형은 지원하지 않습니다`);
        if (suffix[2] === "zero" && new Intl.PluralRules(loc).select(0) !== "zero") fail(`${name}: i18next의 정확한 0 분기는 CLDR zero와 달라 지원하지 않습니다`);
        const group = plurals.get(suffix[1]!) ?? new Map<string, string>();
        group.set(suffix[2]!, value); plurals.set(suffix[1]!, group);
      }
      for (const [name, branches] of plurals) {
        if (!branches.has("other")) fail(`${name}: v4 복수형에는 _other가 필요합니다`);
        if (flat.has(name)) fail(`${name}: 일반 키와 복수형 키가 충돌합니다`);
        for (const category of branches.keys()) flat.delete(`${name}_${category}`);
        if ([...branches.values()].some((branch) => branch.includes("#"))) fail(`${name}: i18next 복수형의 리터럴 #은 ICU count 기호와 구별할 수 없습니다`);
        flat.set(name, Object.fromEntries(branches));
      }
      for (const [name, value] of flat) add(file, name, loc, value);
      if (file.content.includes("{{")) warn("i18next 보간을 ICU {name}으로 변환했습니다. HTML escape 설정은 이전하지 않으며 SDK는 평문을 반환합니다");
      warn("i18next context 라우팅은 이전하지 않습니다. context 이름으로 보이는 키도 독립된 리터럴 키로 보존합니다");
      continue;
    }

    if (!Array.isArray(parsed.keys) || !parsed.keys.length) fail("rynl10n JSON에는 비어 있지 않은 keys 배열이 필요합니다");
    const names = new Set<string>();
    for (const raw of parsed.keys) {
      if (!record(raw) || typeof raw.name !== "string" || !Array.isArray(raw.translations) || !raw.translations.length) fail("각 키에는 name·translations가 필요합니다");
      if (names.has(raw.name)) fail(`키 ${raw.name}가 중복되었습니다`);
      names.add(raw.name);
      if (raw.description !== undefined && typeof raw.description !== "string") fail(`${raw.name}: description은 문자열이어야 합니다`);
      for (const entry of raw.translations) {
        if (!record(entry) || typeof entry.locale !== "string" || (typeof entry.value !== "string" && !record(entry.value))) fail(`${raw.name}: 잘못된 번역입니다`);
        if (entry.state !== undefined && typeof entry.state !== "string") fail(`${raw.name}: state는 문자열이어야 합니다`);
        add(file, raw.name, entry.locale, entry.value as TranslationValue, raw.description as string | undefined, entry.state as string | undefined);
      }
    }
  }
  if (!keys.size) bad("가져올 번역이 없습니다");
  return { data: { keys: [...keys.values()] }, warnings };
}
