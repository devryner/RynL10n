/** 네이티브 파일 → 기존 검증기 → 충돌 미리보기. 쓰기는 확인한 revision에서만 허용한다. */
import { createHash } from "node:crypto";
import { canonicalStringify } from "../../../src/serialize/jcs.ts";
import type { TranslationValue } from "../../../src/core/types.ts";
import type { Repo, TranslationImport, KeyDetail } from "../db/repo.ts";
import { BadRequestError, ConflictError } from "./errors.ts";
import { parseNativeImport } from "./native-import.ts";
import { requireTranslationImport } from "./translation-import.ts";

interface ImportChange {
  key: string;
  locale: string;
  type: "added" | "changed" | "unchanged";
  before?: TranslationValue;
  after: TranslationValue;
  beforeState?: string;
  afterState: string;
}

const equal = (a: unknown, b: unknown) => canonicalStringify(a) === canonicalStringify(b);

function prepareImport(body: any, repo: Repo, projectId: string, expectedRevision?: string) {
  const parsed = parseNativeImport(body);
  const existing = new Map(repo.listKeyDetails(projectId).map((key) => [key.name, key]));
  const raw = parsed.data as { keys?: Array<{ name?: unknown }> } | null;
  const names = Array.isArray(raw?.keys)
    ? [...new Set(raw.keys.map((key) => typeof key?.name === "string" ? key.name.trim() : ""))].sort()
    : [];
  // 입력과 변경 대상의 값·상태·설명을 묶는다. 다른 키 편집은 이 확인을 무효화하지 않는다.
  const revision = createHash("sha256").update(JSON.stringify({
    projectId, format: body.format, source: parsed.data, locales: repo.listLocales(projectId),
    existing: names.map((name) => existing.get(name) ?? null),
  })).digest("hex");
  if (expectedRevision !== undefined && expectedRevision !== revision) {
    throw new ConflictError("미리보기 이후 번역·검수 상태·키 설명이 바뀌었습니다. 다시 미리보기한 뒤 가져오세요");
  }

  const normalized = requireTranslationImport(parsed.data, repo, projectId);
  // 원문과 같은 값은 재검수할 이유가 없다. 새 값·변경 값만 native parser의 draft를 유지한다.
  const data: TranslationImport = body.format === "rynl10n" ? normalized.data : {
    keys: normalized.data.keys.map((key) => ({ ...key, translations: key.translations.map((translation) => {
      const current = existing.get(key.name)?.translations[translation.locale];
      return current && equal(current.value, translation.value) && current.state === "reviewed"
        ? { ...translation, state: "reviewed" }
        : translation;
    }) })),
  };

  const changes: ImportChange[] = [];
  const metadataChanges: Array<{ key: string; beforeDescription: string; afterDescription: string }> = [];
  for (const key of data.keys) {
    const currentKey: KeyDetail | undefined = existing.get(key.name);
    if (currentKey && key.description !== undefined && key.description !== currentKey.description) {
      metadataChanges.push({ key: key.name, beforeDescription: currentKey.description, afterDescription: key.description });
    }
    for (const translation of key.translations) {
      const current = currentKey?.translations[translation.locale];
      changes.push({
        key: key.name, locale: translation.locale,
        type: !current ? "added" : equal(current.value, translation.value) && current.state === translation.state ? "unchanged" : "changed",
        ...(current ? { before: current.value, beforeState: current.state } : {}),
        after: translation.value, afterState: translation.state,
      });
    }
  }
  return {
    data,
    preview: {
      createdKeys: normalized.createdKeys, updatedKeys: normalized.updatedKeys, translations: normalized.translations,
      locales: [...new Set(changes.map((change) => change.locale))].sort(),
      warnings: parsed.warnings, changes, conflicts: changes.filter((change) => change.type === "changed"),
      metadataChanges, revision,
    },
  };
}

export function previewNativeImport(body: unknown, repo: Repo, projectId: string) {
  return prepareImport(body, repo, projectId).preview;
}

export function applyNativeImport(body: any, repo: Repo, projectId: string) {
  if (typeof body?.revision !== "string" || !/^[a-f0-9]{64}$/.test(body.revision)) {
    throw new BadRequestError("가져오기 전에 미리보기로 revision을 확인하세요");
  }
  if (body.overwrite !== undefined && typeof body.overwrite !== "boolean") {
    throw new BadRequestError("overwrite는 boolean이어야 합니다");
  }
  const { data, preview } = prepareImport(body, repo, projectId, body.revision);
  if ((preview.conflicts.length > 0 || preview.metadataChanges.length > 0) && body.overwrite !== true) {
    throw new ConflictError("기존 번역·검수 상태·키 설명을 덮어쓰려면 미리보기에서 덮어쓰기에 동의하세요");
  }
  repo.importTranslations(projectId, data);
  return { createdKeys: preview.createdKeys, updatedKeys: preview.updatedKeys, translations: preview.translations };
}
