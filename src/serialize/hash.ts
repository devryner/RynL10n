/**
 * 콘텐츠 해시 — 기획서 11.1
 *
 *  - SHA-256 소문자 hex.
 *  - 파일 식별자는 앞 16 hex(64bit) 절단 (`snapshot-a1b2c3d4e5f60718`), 전체 해시는 메타에 보존.
 *  - 해시 입력에서 제외: `createdAt`·`base`(자기참조) 등 순수 메타.
 *    스냅샷의 해시 대상은 `{release, defaultLocale, locales}` 정규화 직렬화뿐.
 *  - 절단 충돌 대비: 업로드 시 동일 접두 존재 확인, 충돌 시 20 hex 확장(방어 규칙).
 */

import { createHash } from "node:crypto";
import { canonicalBytes } from "./jcs.ts";

export const FILE_ID_HEX = 16; // 앞 64bit 절단
export const FILE_ID_HEX_EXTENDED = 20; // 절단 충돌 시 확장

/** 임의 값의 전체 SHA-256(소문자 hex). 입력은 JCS 정규화 바이트열. */
export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalBytes(value)).digest("hex");
}

/**
 * 파일 식별자 = 전체 해시의 앞 16 hex 절단.
 * `taken`에 동일 접두가 이미 있으면 20 hex로 확장(11.1 방어 규칙).
 */
export function fileId(fullHash: string, taken?: ReadonlySet<string>): string {
  const short = fullHash.slice(0, FILE_ID_HEX);
  if (taken && taken.has(short)) {
    return fullHash.slice(0, FILE_ID_HEX_EXTENDED);
  }
  return short;
}

/**
 * 스냅샷 콘텐츠 해시 — 해시 대상은 {release, defaultLocale, locales}뿐.
 * schemaVersion·base·createdAt 등은 제외(11.1).
 */
export function snapshotHash(input: {
  release: string;
  defaultLocale: string;
  locales: unknown;
}): string {
  return contentHash({
    release: input.release,
    defaultLocale: input.defaultLocale,
    locales: input.locales,
  });
}
