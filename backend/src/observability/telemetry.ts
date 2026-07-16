/**
 * 텔레메트리 수집 — 기획서 9.3.
 * 옵트인·익명·집계만. 스키마: {projectId, releaseId, event, count, appVersionBucket}.
 * event ∈ {overlay_applied, format_guard_rejected, key_unresolved, delta_failed}.
 * **프라이버시 가드**: 정의된 5개 키 외의 필드가 있으면 거부(번역 값·키명·기기 식별자 유입 차단).
 * 배포 건전성(카나리 8.4)의 임계 입력이 이 집계다.
 */
import type { Repo } from "../db/repo.ts";
import { Metrics, METRIC } from "./metrics.ts";

export const TELEMETRY_EVENTS = ["overlay_applied", "format_guard_rejected", "key_unresolved", "delta_failed"] as const;
export type TelemetryEvent = (typeof TELEMETRY_EVENTS)[number];

const ALLOWED_KEYS = new Set(["projectId", "releaseId", "event", "count", "appVersionBucket"]);

export interface ValidTelemetry {
  readonly projectId: string;
  readonly releaseId: string;
  readonly event: TelemetryEvent;
  readonly count: number;
  readonly appVersionBucket: string;
}

export class TelemetryError extends Error {
  readonly status = 400;
  constructor(message: string) { super(message); this.name = "TelemetryError"; }
}

/** 이벤트 1건을 엄격 검증. 미정의 키·값/식별자 유입은 즉시 거부. */
export function validateEvent(raw: unknown): ValidTelemetry {
  if (typeof raw !== "object" || raw === null) throw new TelemetryError("이벤트는 객체여야 함");
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(k)) throw new TelemetryError(`허용되지 않은 필드 "${k}" (프라이버시 가드)`);
  }
  const { projectId, releaseId, event, count, appVersionBucket } = obj;
  if (typeof projectId !== "string" || typeof releaseId !== "string") throw new TelemetryError("projectId/releaseId 필요");
  if (typeof event !== "string" || !(TELEMETRY_EVENTS as readonly string[]).includes(event)) {
    throw new TelemetryError(`event는 ${TELEMETRY_EVENTS.join("|")} 중 하나`);
  }
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) throw new TelemetryError("count는 0 이상 정수");
  // appVersionBucket은 앱 버전군 라벨(예: "3.2") 또는 카나리 버킷 — 문자열/숫자 허용, 원본 식별자 금지.
  const bucket = typeof appVersionBucket === "number" ? String(appVersionBucket)
    : typeof appVersionBucket === "string" ? appVersionBucket : "";
  return { projectId, releaseId, event: event as TelemetryEvent, count, appVersionBucket: bucket };
}

/** 이벤트 배치를 검증·집계. 잘못된 이벤트는 개수만 반환(부분 수용). */
export function ingest(repo: Repo, metrics: Metrics, batch: unknown): { accepted: number; rejected: number } {
  const events = Array.isArray(batch) ? batch : [batch];
  let accepted = 0, rejected = 0;
  for (const raw of events) {
    let ev: ValidTelemetry;
    try { ev = validateEvent(raw); } catch { rejected++; continue; }
    repo.addTelemetry(ev.projectId, ev.releaseId, ev.event, ev.appVersionBucket, ev.count);
    metrics.inc(METRIC.telemetryEvents, { event: ev.event }, ev.count);
    accepted++;
  }
  return { accepted, rejected };
}

/** 배포 건전성 지표(8.4 자동 중단 입력). 포맷 가드 거부율·미해결율·델타 실패율. */
export function releaseHealth(repo: Repo, projectId: string, releaseId: string) {
  const byEvent = repo.telemetryByEvent(projectId, releaseId);
  const applied = byEvent.overlay_applied ?? 0;
  const guardRejected = byEvent.format_guard_rejected ?? 0;
  const unresolved = byEvent.key_unresolved ?? 0;
  const deltaFailed = byEvent.delta_failed ?? 0;
  const denom = applied + guardRejected || 1;
  return {
    applied,
    formatGuardRejectedRate: guardRejected / denom,
    keyUnresolvedRate: unresolved / denom,
    deltaFailedRate: deltaFailed / (applied + deltaFailed || 1),
  };
}
