/**
 * 익명 집계 텔레메트리 전송(옵트인) — 기획서 9.3, 카나리 판정(8.4)의 입력.
 *
 * 클라이언트가 모으는 것은 4종 카운트뿐이고(`TelemetryCounts`), 이 모듈은 그것을 관리 플레인의
 * `POST /projects/{p}/telemetry` 한 곳으로 보낸다. 본문 필드는 서버가 정의한 5개가 전부다
 * (`projectId`·`releaseId`·`event`·`count`·`appVersionBucket`) — **그 외 필드는 서버가 거부하므로**
 * 키 이름·번역 값·기기 식별자는 구조적으로 나갈 수 없다(프라이버시 가드).
 * 카나리 버킷의 `installId`도 포함되지 않는다(기기 로컬 값, 8.4).
 *
 * 옵트인은 두 겹이다: 수집은 `RynL10nClient({ telemetry: "aggregate" })`, 전송은 이 리포터를
 * 만들어야(또는 `HttpRynL10n`에 `telemetryEndpoint`를 주어야) 일어난다.
 *
 * **읽기 경로(배포 플레인)와 다른 축이다** — 전송은 쓰기라 관리 플레인으로 간다. 실패해도 화면의
 * 번역은 아무 영향을 받지 않는다.
 */
import type { TelemetryCounts } from "../../../src/client/client.ts";

/** 서버 스키마(9.3) 그대로의 이벤트 1건. 필드가 더 늘면 서버가 배치를 거부한다. */
export interface TelemetryEvent {
  readonly projectId: string;
  readonly releaseId: string;
  readonly event: keyof TelemetryCounts;
  readonly count: number;
  readonly appVersionBucket: string;
}

/** 리포터가 필요로 하는 클라이언트 표면(코어 `RynL10nClient`가 그대로 만족한다). */
export interface TelemetrySource {
  status(): { readonly releaseId: string | undefined };
  drainTelemetry(): TelemetryCounts;
  mergeTelemetry(counts: TelemetryCounts): void;
}

export interface TelemetryConfig {
  /** 관리 플레인 루트(끝 슬래시 없이). 배포 플레인/CDN이 아니다. */
  readonly endpoint: string;
  readonly projectKey: string;
  /** 앱 버전 — 버전군 라벨(`3.2.1` → `3.2`)로 축약해 보낸다. */
  readonly appVersion?: string;
  readonly fetchImpl?: typeof fetch;
  /** `start()`의 전송 주기(기본 5분). */
  readonly intervalMs?: number;
}

/** 앱 버전군 라벨(`3.2.1` → `3.2`). 개별 빌드가 아니라 **군**이라야 익명 집계로 남는다. */
export function versionBucket(appVersion?: string): string {
  if (appVersion === undefined || appVersion === "") return "unknown";
  const parts = appVersion.split(".");
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : parts[0]!;
}

/** 카운트 → 서버 이벤트 배치. 0인 이벤트는 보내지 않는다(빈 행으로 집계를 부풀리지 않기 위해). */
export function telemetryEvents(
  counts: TelemetryCounts,
  meta: { projectId: string; releaseId: string; bucket: string },
): TelemetryEvent[] {
  return (Object.keys(counts) as (keyof TelemetryCounts)[])
    .filter((event) => counts[event] > 0)
    .map((event) => ({
      projectId: meta.projectId,
      releaseId: meta.releaseId,
      event,
      count: counts[event],
      appVersionBucket: meta.bucket,
    }));
}

export class TelemetryReporter {
  private readonly cfg: TelemetryConfig;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(cfg: TelemetryConfig) {
    this.cfg = cfg;
  }

  /**
   * 누적 카운트를 비우고 한 번 전송한다.
   *
   * 전송에 실패하면 드레인한 카운트를 **되돌려** 다음 주기에 다시 시도한다.
   * @returns 서버가 수용했으면 true. 보낼 것이 없어도 true(할 일 없음).
   */
  async flush(source: TelemetrySource): Promise<boolean> {
    // 릴리스가 정해지기 전(번들만)에는 귀속시킬 릴리스가 없다 → 드레인하지 않고 다음 기회로 미룬다.
    const releaseId = source.status().releaseId;
    if (releaseId === undefined) return true;

    const counts = source.drainTelemetry();
    const events = telemetryEvents(counts, {
      projectId: this.cfg.projectKey,
      releaseId,
      bucket: versionBucket(this.cfg.appVersion),
    });
    if (events.length === 0) return true;

    const doFetch = this.cfg.fetchImpl ?? fetch;
    try {
      const res = await doFetch(`${this.cfg.endpoint}/projects/${this.cfg.projectKey}/telemetry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(events),
      });
      if (!res.ok) {
        source.mergeTelemetry(counts);
        return false;
      }
      return true;
    } catch {
      source.mergeTelemetry(counts);
      return false;
    }
  }

  /**
   * 주기 전송 시작(기본 5분). 첫 전송은 한 주기 뒤다 — 부팅 직후엔 보낼 것이 거의 없다.
   * 탭이 닫히기 직전처럼 확실히 올리고 싶은 시점에는 `flush`를 직접 부른다.
   */
  start(source: TelemetrySource): void {
    this.stop();
    this.timer = setInterval(() => void this.flush(source), this.cfg.intervalMs ?? 300_000);
  }

  /** 주기 전송 중단. 아직 안 보낸 카운트는 클라이언트에 남는다(다음 `flush`에서 함께 나간다). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
