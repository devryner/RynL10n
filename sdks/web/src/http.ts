/**
 * Web SDK (M4 α) — 기획서 6.2.
 * 프레임워크 무관. 동기 코어(RynL10nClient)를 감싸 async fetch/ETag 폴링을 담당한다.
 * 철칙 준수: 배포 플레인(정적 manifest·snapshot·delta)만 읽고 관리 API는 호출하지 않는다.
 * 코어 알고리즘(resolve·매칭·카나리)은 참조 구현을 그대로 재사용 → 골든 벡터로 검증된 동작 공유.
 */
import { RynL10nClient, type DeliveryStore, type TelemetryCounts } from "../../../src/client/client.ts";
import { selectRelease, type ClientContext } from "../../../src/core/matching.ts";
import type { Manifest, Snapshot, Delta } from "../../../src/core/types.ts";

class MapStore implements DeliveryStore {
  readonly snapshots = new Map<string, Snapshot>();
  readonly deltas = new Map<string, Delta>();
  getSnapshot(path: string): Snapshot | undefined { return this.snapshots.get(path); }
  getDelta(path: string): Delta | undefined { return this.deltas.get(path); }
}

export interface WebConfig {
  /** 프로젝트 키(id). */
  readonly projectKey: string;
  /** 배포 플레인 base URL(끝 슬래시 없이). 예: https://cdn.example.com */
  readonly endpoint: string;
  /** 빌드타임 bake된 번들 스냅샷(항상 존재하는 fallback). */
  readonly bundle: Snapshot;
  readonly context: ClientContext;
  readonly installId?: string;
  readonly telemetry?: "off" | "aggregate";
  readonly pollIntervalMs?: number;
  /** 테스트/커스텀용 fetch 주입(기본 전역 fetch). */
  readonly fetchImpl?: typeof fetch;
}

export type Unsubscribe = () => void;

export class HttpRynL10n {
  private readonly cfg: WebConfig;
  private readonly client: RynL10nClient;
  private readonly store = new MapStore();
  private etag: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(cfg: WebConfig) {
    this.cfg = cfg;
    this.client = new RynL10nClient({
      bundle: cfg.bundle, store: this.store, context: cfg.context,
      ...(cfg.installId !== undefined ? { installId: cfg.installId } : {}),
      ...(cfg.telemetry !== undefined ? { telemetry: cfg.telemetry } : {}),
    });
  }

  /** 동기 조회(6.1) — 항상 번들 fallback. */
  t(key: string, args?: Readonly<Record<string, unknown>>, locale?: string): string {
    return this.client.t(key, args, locale);
  }
  onCatalogUpdated(listener: (info: { release: string; overlayTarget: string }) => void): Unsubscribe {
    return this.client.onCatalogUpdated(listener);
  }
  status() { return this.client.status(); }
  drainTelemetry(): TelemetryCounts { return this.client.drainTelemetry(); }

  private get fetchImpl(): typeof fetch { return this.cfg.fetchImpl ?? fetch; }
  private url(rel: string): string { return `${this.cfg.endpoint}/${this.cfg.projectKey}/${rel}`; }

  private async fetchJson<T>(rel: string): Promise<T | undefined> {
    const res = await this.fetchImpl(this.url(rel));
    return res.ok ? ((await res.json()) as T) : undefined;
  }

  /**
   * 갱신 사이클: manifest 조건부 요청(ETag) → 필요한 산출물 프리페치 → 동기 코어 refresh.
   * @returns 카탈로그가 실제로 바뀌었으면 true.
   */
  async refresh(): Promise<boolean> {
    const headers: Record<string, string> = this.etag ? { "if-none-match": this.etag } : {};
    const res = await this.fetchImpl(this.url("manifest.json"), { headers });
    if (res.status === 304) return false; // 변경 없음
    if (!res.ok) return false; // 실패는 조용히 이전 상태 유지
    this.etag = res.headers.get("etag") ?? undefined;
    const manifest = (await res.json()) as Manifest;

    // 자기 릴리스에 필요한 산출물만 프리페치(동기 코어가 읽을 수 있도록).
    const sel = selectRelease(manifest.releases, this.cfg.context);
    if (sel.kind !== "bundle-only") {
      const r = sel.release;
      if (r.base !== this.cfg.bundle.base && !this.store.getSnapshot(r.snapshot)) {
        const s = await this.fetchJson<Snapshot>(r.snapshot);
        if (s) this.store.snapshots.set(r.snapshot, s);
      }
      if (r.delta && r.overlay !== r.base && !this.store.getDelta(r.delta)) {
        const d = await this.fetchJson<Delta>(r.delta);
        if (d) this.store.deltas.set(r.delta, d);
      }
    }
    return this.client.refresh(manifest);
  }

  /** 포그라운드/주기 폴링 시작. */
  start(): void {
    const iv = this.cfg.pollIntervalMs ?? 60_000;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), iv);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }
}
