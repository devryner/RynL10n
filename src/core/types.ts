/**
 * 데이터 모델 & 산출물 스키마 타입 — 기획서 5장 / 11.1 / 11.2
 */

/** 번역 값: 단순 문자열(ICU MessageFormat) 또는 CLDR 복수형 카테고리 맵. */
export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";
export type PluralMap = { readonly [C in PluralCategory]?: string };
export type TranslationValue = string | PluralMap;

export function isPluralMap(v: TranslationValue): v is PluralMap {
  return typeof v === "object" && v !== null;
}

/** 스냅샷(전체 카탈로그) — 11.1. tombstone 없음(삭제는 델타 전용). */
export interface Snapshot {
  readonly schemaVersion: 1;
  readonly release: string;
  /** 이 파일의 콘텐츠 해시(자기 식별). 해시 입력에서는 제외된다. */
  readonly base: string;
  readonly defaultLocale: string;
  /** locale(BCP47) → key → value. 빈 문자열 ""은 '의도적 빈 값'으로 유효(키 누락과 구분). */
  readonly locales: { readonly [bcp47: string]: { readonly [key: string]: TranslationValue } };
}

/** 델타 연산(sparse) — 11.1. */
export type DeltaOp =
  | { readonly op: "set"; readonly key: string; readonly locale: string; readonly value: TranslationValue }
  | { readonly op: "delete"; readonly key: string; readonly locale: string };

/** 델타(sparse) — 11.1. ops는 (locale, key, op) 사전순 정렬. */
export interface Delta {
  readonly schemaVersion: 1;
  readonly release: string;
  readonly from: string;
  readonly to: string;
  readonly ops: readonly DeltaOp[];
}

/** 버전 매칭 규칙 — 11.3 + 정수 빌드 넘버(M4). */
export type VersionMatch =
  | { readonly strategy: "semver-range"; readonly value: string }
  | { readonly strategy: "exact-label"; readonly value: string }
  | { readonly strategy: "integer-range"; readonly value: string }; // 빌드 넘버 정수 비교(M4)

/** 릴리스 라이프사이클 상태 — 8.1. */
export type ReleaseState = "draft" | "published" | "superseded" | "archived";

/** manifest의 릴리스 엔트리 — 11.2. */
export interface ManifestRelease {
  readonly id: string;
  readonly state: ReleaseState;
  readonly versionMatch: VersionMatch;
  readonly base: string;
  /** 현재 최신 오버레이 target 해시(없으면 base와 동일). 롤백 = 이 포인터 되돌리기(8.3). */
  readonly overlay: string;
  readonly rollout: number; // 카나리 % (8.4). 안전 기본값 100.
  readonly snapshot: string; // 상대 경로
  readonly delta?: string; // base==overlay면 없음
}

/** 배포 manifest — 11.2. archived 릴리스는 releases에서 제외. */
export interface Manifest {
  readonly schemaVersion: 1;
  readonly project: string;
  readonly defaultLocale: string;
  readonly updatedAt: string;
  readonly releases: readonly ManifestRelease[];
}

/** 미매칭 앱 fallback 정책 — 11.3. */
export type FallbackPolicy = "nearest-lower" | "bundle-only";
