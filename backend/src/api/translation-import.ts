/**
 * 번역 import 검증기 — 기획서 9.2 / 11.1.
 *
 * `POST /projects/{p}/translations/import`의 본문을 검증하고 DB에 바로 넣을 수 있는 형태로
 * 정규화한다. 형식은 전체 export의 `keys[].translations[]` 부분집합이라 export에서 키 배열만
 * 떼어 재사용할 수 있다.
 *
 * **쓰기와 분리돼 있는 것이 중요하다.** 이 함수는 repo를 읽기만 하고(지원 로케일·기존 키)
 * 적용은 `Repo.importTranslations`가 한다. 그래서 반환값을 버리면 그대로 dry-run이 되고,
 * MCP `validate_translation`이 그 성질을 쓴다 — 검증이 둘로 갈라지면 "미리보기는 통과,
 * 실제 쓰기는 422"라는 조합이 생긴다.
 */
import type { Repo, TranslationImport } from "../db/repo.ts";
import { signature } from "../../../src/core/placeholder.ts";
import { isPluralMap, type TranslationValue } from "../../../src/core/types.ts";
import { BadRequestError, SignatureMismatchError } from "./errors.ts";

export const TRANSLATION_STATES: readonly string[] = ["draft", "reviewed"];
export const PLURAL_CATEGORIES = new Set(["zero", "one", "two", "few", "many", "other"]);

export interface TranslationImportResult {
  data: TranslationImport;
  createdKeys: number;
  updatedKeys: number;
  translations: number;
}

/**
 * 기존 프로젝트용 키·번역 import를 검증하고 DB에 바로 넣을 수 있는 형태로 정규화한다.
 * 형식은 전체 export의 `keys[].translations[]` 부분집합이라 export에서 키 배열만 떼어 재사용할 수 있다.
 */
export function requireTranslationImport(body: any, repo: Repo, projectId: string): {
  data: TranslationImport;
  createdKeys: number;
  updatedKeys: number;
  translations: number;
} {
  const bad = (m: string): never => { throw new BadRequestError(`번역 import 형식이 아닙니다: ${m}`); };
  if (!Array.isArray(body?.keys) || body.keys.length === 0) bad("keys는 비지 않은 배열이어야 합니다");

  const supportedLocales = new Set(repo.listLocales(projectId));
  const existing = new Map(repo.listKeyDetails(projectId).map((k) => [k.name, k]));
  const names = new Set<string>();
  const keys: TranslationImport["keys"][number][] = [];
  let createdKeys = 0;
  let updatedKeys = 0;
  let translationCount = 0;

  const value = (v: unknown, where: string): TranslationValue => {
    if (typeof v === "string") return v;
    if (!v || typeof v !== "object" || Array.isArray(v)) bad(`${where}.value는 문자열 또는 CLDR 복수형 맵이어야 합니다`);
    const entries = Object.entries(v as Record<string, unknown>);
    if (!entries.length || entries.some(([category, text]) => !PLURAL_CATEGORIES.has(category) || typeof text !== "string")) {
      bad(`${where}.value의 복수형 맵은 CLDR 카테고리와 문자열 값만 포함해야 합니다`);
    }
    if (!("other" in (v as object))) bad(`${where}.value의 복수형 맵에는 other가 필요합니다`);
    return v as TranslationValue;
  };

  for (const [keyIndex, rawKey] of body.keys.entries()) {
    const name = typeof rawKey?.name === "string" ? rawKey.name.trim() : "";
    if (!name) bad(`keys[${keyIndex}].name이 필요합니다`);
    if (names.has(name)) bad(`키 "${name}"가 중복되었습니다`);
    names.add(name);
    if (rawKey.description !== undefined && typeof rawKey.description !== "string") bad(`키 "${name}"의 description은 문자열이어야 합니다`);
    if (!Array.isArray(rawKey.translations) || rawKey.translations.length === 0) bad(`키 "${name}"의 translations는 비지 않은 배열이어야 합니다`);

    const locales = new Set<string>();
    const translations: TranslationImport["keys"][number]["translations"][number][] = [];
    let importedSignature: string | undefined;
    let importedPlural: boolean | undefined;
    for (const [translationIndex, rawTranslation] of rawKey.translations.entries()) {
      const where = `키 "${name}" translations[${translationIndex}]`;
      const locale = typeof rawTranslation?.locale === "string" ? rawTranslation.locale.trim() : "";
      if (!locale) bad(`${where}.locale이 필요합니다`);
      if (!supportedLocales.has(locale)) bad(`${where}.locale "${locale}"는 프로젝트 지원 로케일이 아닙니다`);
      if (locales.has(locale)) bad(`키 "${name}"의 로케일 "${locale}"가 중복되었습니다`);
      locales.add(locale);
      const translationValue = value(rawTranslation?.value, where);
      const state = rawTranslation?.state ?? "draft";
      if (!TRANSLATION_STATES.includes(state)) bad(`${where}.state는 ${TRANSLATION_STATES.join(" 또는 ")}여야 합니다`);

      const sig = signature(translationValue);
      const plural = isPluralMap(translationValue);
      if (importedSignature === undefined) { importedSignature = sig; importedPlural = plural; }
      else if (importedSignature !== sig || importedPlural !== plural) {
        throw new SignatureMismatchError(`키 "${name}"의 번역끼리 플레이스홀더 서명 또는 복수형 형태가 다릅니다`);
      }
      translations.push({ locale, value: translationValue, state });
      translationCount += 1;
    }

    const current = existing.get(name);
    let resolvedSignature = importedSignature!;
    let resolvedPlural = importedPlural!;
    if (current) {
      updatedKeys += 1;
      const currentValues = Object.values(current.translations);
      const establishedSignature = current.signature || (currentValues.length ? signature(currentValues[0]!.value) : undefined);
      if (current.isPlural !== resolvedPlural || (establishedSignature !== undefined && establishedSignature !== resolvedSignature)) {
        throw new SignatureMismatchError(`키 "${name}"의 기존 플레이스홀더 서명 또는 복수형 형태와 import 값이 다릅니다`);
      }
      resolvedSignature = establishedSignature ?? resolvedSignature;
      resolvedPlural = current.isPlural;
    } else {
      createdKeys += 1;
    }
    keys.push({
      name,
      signature: resolvedSignature,
      isPlural: resolvedPlural,
      ...(rawKey.description !== undefined ? { description: rawKey.description } : {}),
      translations,
    });
  }

  return { data: { keys }, createdKeys, updatedKeys, translations: translationCount };
}
