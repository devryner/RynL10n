/**
 * `validate_translation` — 번역 값을 **쓰지 않고** 검사한다 (MCP 도구 1/2).
 *
 * 존재 이유: 포맷 안전 가드(3.1)의 쓰기 경로 방어선인 422를, 쓰기를 시도하기 전에
 * 구조화된 형태로 돌려준다. 서버가 지금 던지는 422 메시지는
 * `기대 "count:plural,name:simple" 실제 "count:plural"` 같은 문자열 하나인데, 사람은 읽지만
 * 호출자에게는 두 문자열을 diff하라는 숙제다. 서명은 정렬된 `이름:타입` 목록이라 구조적으로
 * 비교할 수 있고, "`{name}`이 빠졌다"까지 말해 주면 재시도가 한 번에 끝난다.
 *
 * **판정은 단일 원천이다.** ok 여부는 실제 쓰기 경로가 쓰는 `requireTranslationImport`가
 * 정한다 — 여기서 규칙을 다시 구현하면 "미리보기는 통과, 실제 쓰기는 422"라는 최악의 조합이
 * 생긴다. 문제를 로케일별로 쪼개는 것도 규칙 복제가 아니라 **같은 검증기를 슬라이스마다 다시
 * 부르는 것**이다(엔트리 1개짜리 페이로드 → 그 엔트리만의 문제, 전체 페이로드 → 엔트리 간 문제).
 * 아래 `code` 분류만 관찰로 붙인다 — 라벨일 뿐 판정이 아니다.
 */
import type { Repo } from "../db/repo.ts";
import { requireTranslationImport, PLURAL_CATEGORIES, TRANSLATION_STATES } from "../api/translation-import.ts";
import { HttpError } from "../api/errors.ts";
import { NotFoundError } from "../pipeline/publish.ts";
import { signature } from "../../../src/core/placeholder.ts";
import { isPluralMap, type TranslationValue } from "../../../src/core/types.ts";

export interface ValidateEntry {
  readonly locale: string;
  readonly value: unknown;
  readonly state?: string;
}
export interface ValidateInput {
  readonly project: string;
  readonly key: string;
  readonly entries: readonly ValidateEntry[];
}

export type ProblemCode =
  | "signature_mismatch"
  | "signature_inconsistent_across_locales"
  | "plural_shape_mismatch"
  | "plural_missing_other"
  | "plural_unknown_category"
  | "locale_not_supported"
  | "duplicate_locale"
  | "invalid_state"
  | "invalid_value"
  | "signature_will_be_established";

export interface ValidateProblem {
  readonly code: ProblemCode;
  readonly severity: "error" | "warning";
  /** 어느 엔트리의 문제인지. 엔트리 간 문제(중복·서명 불일치)는 undefined. */
  readonly locale?: string;
  readonly message: string;
  /** 기대 서명엔 있는데 값에 없는 인자. */
  readonly missingArgs?: readonly string[];
  /** 값에 있는데 기대 서명엔 없는 인자. */
  readonly extraArgs?: readonly string[];
  /** 이름은 같은데 ICU 타입이 달라진 인자(예: plural → simple). */
  readonly changedArgs?: ReadonlyArray<{ name: string; expected: string; actual: string }>;
}

export interface ValidateResult {
  readonly ok: boolean;
  readonly signature: {
    /** 키에 이미 확정된 서명이 있는가. 없으면 이 쓰기가 확정시킨다. */
    readonly established: boolean;
    readonly expected: string | null;
    readonly actual: string | null;
  };
  readonly isPlural: { readonly expected: boolean | null; readonly actual: boolean | null };
  readonly problems: readonly ValidateProblem[];
  readonly key: {
    readonly exists: boolean;
    /** 번역자용 설명(5.1). 검증하러 온 호출자가 "그럼 뭐라고 쓰나"의 맥락을 같은 호출에서 얻는다. */
    readonly description: string | null;
    readonly referencedByReleases: number;
  };
  readonly wouldCreateKey: boolean;
}

/** `{key, entries}` → import 검증기가 받는 본문. 새 형식을 만들지 않는다(쓰기 도구와 인자 공유). */
function toImportBody(key: string, entries: readonly ValidateEntry[]): unknown {
  return { keys: [{ name: key, translations: entries.map((e) => ({ locale: e.locale, value: e.value, state: e.state ?? "draft" })) }] };
}

/** 서명 문자열 `이름:타입,이름:타입` → Map. 순서는 signature()가 이미 정렬해 둔다. */
function parseSignature(sig: string): Map<string, string> {
  const out = new Map<string, string>();
  if (sig === "") return out;
  for (const part of sig.split(",")) {
    const idx = part.indexOf(":");
    if (idx > 0) out.set(part.slice(0, idx), part.slice(idx + 1));
  }
  return out;
}

function diffSignature(expected: string, actual: string): Pick<ValidateProblem, "missingArgs" | "extraArgs" | "changedArgs"> {
  const e = parseSignature(expected);
  const a = parseSignature(actual);
  const missingArgs = [...e.keys()].filter((n) => !a.has(n));
  const extraArgs = [...a.keys()].filter((n) => !e.has(n));
  const changedArgs = [...e.entries()]
    .filter(([n, t]) => a.has(n) && a.get(n) !== t)
    .map(([n, t]) => ({ name: n, expected: t, actual: a.get(n)! }));
  return { missingArgs, extraArgs, changedArgs };
}

/**
 * 400 실패에 코드를 붙인다. **판정이 아니라 라벨이다** — 검증기는 이미 실패를 확정했고,
 * 여기서는 엔트리를 관찰해 어느 규칙에 걸렸는지 이름만 고른다(메시지 문자열 파싱 금지 —
 * 문구가 바뀌면 조용히 오분류된다). 어떤 probe에도 안 걸리면 `invalid_value`로 떨어지되
 * 원문 메시지는 그대로 실어 보낸다.
 */
function classify(entry: ValidateEntry, supported: ReadonlySet<string>): ProblemCode {
  if (!supported.has(entry.locale)) return "locale_not_supported";
  if (entry.state !== undefined && !TRANSLATION_STATES.includes(entry.state)) return "invalid_state";
  const v = entry.value;
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const cats = Object.keys(v as Record<string, unknown>);
    if (cats.some((c) => !PLURAL_CATEGORIES.has(c))) return "plural_unknown_category";
    if (!cats.includes("other")) return "plural_missing_other";
  }
  return "invalid_value";
}

export function validateTranslation(repo: Repo, input: ValidateInput): ValidateResult {
  if (!repo.getProject(input.project)) throw new NotFoundError(`project ${input.project}`);

  const supported = new Set(repo.listLocales(input.project));
  const details = repo.listKeyDetails(input.project);
  const current = details.find((k) => k.name === input.key);
  const existingValues = current ? Object.values(current.translations) : [];

  // 기대 서명 = 검증기가 쓰는 것과 **같은 식**(translation-import.ts의 establishedSignature).
  // 빈 문자열은 값이 아니라 "미확정" 센티널이라 `||`로 넘긴다.
  const expected = current
    ? (current.signature || (existingValues.length ? signature(existingValues[0]!.value) : null))
    : null;
  const established = expected !== null && expected !== "";

  const values = input.entries.map((e) => e.value).filter((v): v is TranslationValue => typeof v === "string" || (!!v && typeof v === "object"));
  const actual = values.length ? signature(values[0]!) : null;
  const actualPlural = values.length ? isPluralMap(values[0]!) : null;

  const problems: ValidateProblem[] = [];
  let ok = true;
  try {
    requireTranslationImport(toImportBody(input.key, input.entries), repo, input.project);
  } catch (e) {
    ok = false;
    const seen = new Set<string>();
    // 실패했을 때만 엔트리별로 다시 부른다 — 통과 경로는 검증기 호출 1회로 끝난다.
    for (const entry of input.entries) {
      const dup = seen.has(entry.locale);
      seen.add(entry.locale);
      if (dup) {
        problems.push({ code: "duplicate_locale", severity: "error", locale: entry.locale,
          message: `로케일 "${entry.locale}"가 같은 키에 두 번 들어 있습니다` });
        continue;
      }
      try {
        requireTranslationImport(toImportBody(input.key, [entry]), repo, input.project);
      } catch (inner) {
        problems.push(problemFor(inner as HttpError, entry, supported, expected, current?.isPlural ?? null));
      }
    }
    // 엔트리 각각은 통과했는데 전체가 실패 → 엔트리 **간** 문제(로케일끼리 서명 불일치 등).
    if (problems.length === 0) {
      const err = e as HttpError;
      problems.push({
        // 엔트리는 각각 통과했으므로 남은 실패 원인은 엔트리 **간** 축뿐이다.
        code: "signature_inconsistent_across_locales",
        severity: "error",
        message: err.message,
        ...(actual !== null ? crossLocaleDiff(values, actual) : {}),
      });
    }
  }

  // 통과했지만 부작용이 있는 경우 — 이 쓰기가 서명을 **확정**시킨다(server.ts의 PUT과 같은 규칙).
  // 실패는 아니지만 되돌리기 번거로우므로 경고로 알린다.
  if (ok && !established && actual !== null) {
    problems.push({
      code: "signature_will_be_established", severity: "warning",
      message: `키 "${input.key}"의 플레이스홀더 서명이 아직 미확정입니다 — 이 값이 "${actual}"로 확정시킵니다`,
    });
  }

  return {
    ok,
    signature: { established, expected, actual },
    isPlural: { expected: current?.isPlural ?? null, actual: actualPlural },
    problems,
    key: {
      exists: current !== undefined,
      description: current ? (current.description || null) : null,
      referencedByReleases: current?.refCount ?? 0,
    },
    wouldCreateKey: current === undefined,
  };
}

/** 엔트리 하나의 실패를 구조화. 422는 서명/복수형 축을 **값 비교로** 갈라 라벨을 고른다. */
function problemFor(
  err: HttpError,
  entry: ValidateEntry,
  supported: ReadonlySet<string>,
  expected: string | null,
  expectedPlural: boolean | null,
): ValidateProblem {
  if (err.status === 422) {
    const v = entry.value as TranslationValue;
    const actual = signature(v);
    const plural = isPluralMap(v);
    if (expectedPlural !== null && expectedPlural !== plural) {
      return {
        code: "plural_shape_mismatch", severity: "error", locale: entry.locale,
        message: `복수형 형태가 다릅니다: 키는 ${expectedPlural ? "복수형 맵" : "단순 문자열"}인데 값은 ${plural ? "복수형 맵" : "단순 문자열"}입니다`,
      };
    }
    return {
      code: "signature_mismatch", severity: "error", locale: entry.locale,
      message: err.message,
      ...(expected !== null ? diffSignature(expected, actual) : {}),
    };
  }
  return { code: classify(entry, supported), severity: "error", locale: entry.locale, message: err.message };
}

/** 엔트리끼리 서명이 갈릴 때, 첫 엔트리를 기준으로 어느 인자가 어긋났는지 보여준다. */
function crossLocaleDiff(values: readonly TranslationValue[], base: string): Pick<ValidateProblem, "missingArgs" | "extraArgs" | "changedArgs"> {
  const odd = values.find((v) => signature(v) !== base);
  return odd === undefined ? {} : diffSignature(base, signature(odd));
}
