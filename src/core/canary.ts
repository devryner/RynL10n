/**
 * 카나리 버킷팅 — 기획서 8.4
 *
 * 버킷 판정 = `hash(installId + releaseId) mod 100 < rollout%`. **릴리스별 독립 버킷**이라
 * 특정 기기가 매 롤아웃마다 항상 카나리에 걸리는 편향을 방지한다. 판정은 100% 로컬:
 *  - installId = 기기 로컬 익명 난수(UUID v4), **서버 미전송**·광고 ID 아님·앱 삭제 시 소멸.
 *  - 네트워크·서버 조회 없음. 같은 기기·같은 릴리스 → 항상 같은 버킷(배포 중 번역 안 흔들림).
 *
 * 해시는 SHA-256의 앞 32비트 → mod 100. 전 언어(TS/Swift/Kotlin/Dart)에서 동일하게 재현된다.
 *
 * ⚠️ 프라이버시 법무 확인 전 안전 기본값 = **카나리 비활성(rollout 100 고정)**.
 * 버킷팅 코드는 있되 실제 활성화(rollout<100)는 법무 승인 후.
 */
import { createHash } from "node:crypto";

/** installId+releaseId의 결정적 버킷 0..99. */
export function bucketOf(installId: string, releaseId: string): number {
  const digest = createHash("sha256").update(`${installId}:${releaseId}`).digest();
  return digest.readUInt32BE(0) % 100;
}

/**
 * 이 기기가 롤아웃 대상인가.
 * rollout>=100 → 항상 true(전체 배포). installId 없으면 보수적으로 카나리 제외(false, rollout<100일 때).
 */
export function inRollout(rollout: number, installId: string | undefined, releaseId: string): boolean {
  if (rollout >= 100) return true;
  if (rollout <= 0) return false;
  if (installId === undefined) return false; // installId 없음 → 카나리 미수신(안전)
  return bucketOf(installId, releaseId) < rollout;
}
