/**
 * Web SDK (M4 α) — 기획서 6.2 / 6.4.
 * 프레임워크 무관. 동기 코어(RynL10nClient)를 감싸 async fetch/ETag 폴링을 담당한다.
 * 철칙 준수: 배포 플레인(정적 manifest·snapshot·delta)만 읽고 관리 API는 호출하지 않는다.
 * 코어 알고리즘(resolve·매칭·카나리)은 참조 구현을 그대로 재사용 → 골든 벡터로 검증된 동작 공유.
 *
 * 읽는 것은 정적 파일 세 종류뿐이다(11.2):
 * ```
 * {endpoint}/{project}/manifest.json                            짧은 TTL + ETag
 * {endpoint}/{project}/releases/{r}/snapshot-{hash}.json        불변 → 영구 캐시
 * {endpoint}/{project}/releases/{r}/delta-{base}-{target}.json  불변 → 영구 캐시
 * ```
 *
 * `DeliveryStore`는 동기 인터페이스다(`refresh(manifest)`가 동기라 화면이 절대 네트워크를 기다리지
 * 않는다). 그래서 이 타입은 **비동기 다운로드와 동기 조회를 분리**한다 — [refresh]가 필요한 산출물을
 * 먼저 캐시에 채운 뒤 동기 코어를 호출하고, 스토어는 캐시만 들여다본다(네트워크 접근 없음).
 *
 * 산출물은 내용해시 URL이라 한 번 받으면 영구 유효하다 → [PersistentCache](기본 `localStorage`)에
 * 그대로 둔다. manifest만 ETag로 재검증하며, 네트워크가 없으면 **마지막 캐시로 진행**한다.
 */
import { RynL10nClient, type DeliveryStore, type TelemetryCounts } from "../../../src/client/client.ts";
import { selectRelease, type ClientContext } from "../../../src/core/matching.ts";
import type { Manifest, Snapshot, Delta } from "../../../src/core/types.ts";
import { defaultCache, type PersistentCache } from "./cache.ts";

const MANIFEST_KEY = "manifest";
const ETAG_KEY = "manifest.etag";

/** 배포 플레인 접근 실패 — iOS `DeliveryError` · Android `DeliveryException`과 같은 3분류. */
export class DeliveryError extends Error {
  /** `bad-status`(2xx 아님) · `unavailable`(네트워크 실패 + 캐시 없음) · `malformed`(디코딩 실패). */
  readonly kind: "bad-status" | "unavailable" | "malformed";
  readonly path: string;
  readonly status?: number;
  readonly cause?: unknown;

  constructor(
    kind: "bad-status" | "unavailable" | "malformed",
    path: string,
    detail: { status?: number; cause?: unknown } = {},
  ) {
    super(
      kind === "bad-status"
        ? `배포 플레인이 ${detail.status} 를 반환했습니다: ${path}`
        : kind === "unavailable"
          ? `배포 플레인에 접근할 수 없고 캐시도 없습니다: ${path}`
          : `배포 플레인 응답을 디코딩하지 못했습니다: ${path}`,
    );
    this.name = "DeliveryError";
    this.kind = kind;
    this.path = path;
    if (detail.status !== undefined) this.status = detail.status;
    if (detail.cause !== undefined) this.cause = detail.cause;
  }
}

/**
 * 영속 캐시를 뒤에 둔 동기 스토어. 메모리 맵은 파싱 결과 memo일 뿐이고
 * 진실은 캐시에 있다 — 새 탭·새 인스턴스가 같은 카탈로그를 네트워크 없이 이어받는다.
 */
class CachedStore implements DeliveryStore {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly deltas = new Map<string, Delta>();
  private readonly cache: PersistentCache;

  constructor(cache: PersistentCache) {
    this.cache = cache;
  }

  getSnapshot(path: string): Snapshot | undefined {
    return this.read(path, this.snapshots, isSnapshotShape);
  }
  getDelta(path: string): Delta | undefined {
    return this.read(path, this.deltas, isDeltaShape);
  }

  putSnapshot(path: string, value: Snapshot, raw: string): void {
    this.snapshots.set(path, value);
    this.cache.set(artifactKey(path), raw);
  }
  putDelta(path: string, value: Delta, raw: string): void {
    this.deltas.set(path, value);
    this.cache.set(artifactKey(path), raw);
  }

  clear(): void {
    this.snapshots.clear();
    this.deltas.clear();
  }

  private read<T>(path: string, memo: Map<string, T>, guard: (v: unknown) => v is T): T | undefined {
    const hit = memo.get(path);
    if (hit !== undefined) return hit;
    const raw = this.cache.get(artifactKey(path));
    if (raw === undefined) return undefined;
    const decoded = safeJson(raw);
    if (!guard(decoded)) return undefined;
    memo.set(path, decoded);
    return decoded;
  }
}

function artifactKey(path: string): string {
  return `artifact:${path}`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isSnapshotShape(value: unknown): value is Snapshot {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return typeof o["base"] === "string" && typeof o["locales"] === "object" && o["locales"] !== null;
}

function isDeltaShape(value: unknown): value is Delta {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return typeof o["from"] === "string" && typeof o["to"] === "string" && Array.isArray(o["ops"]);
}

function isManifestShape(value: unknown): value is Manifest {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return typeof o["project"] === "string" && Array.isArray(o["releases"]);
}

export interface WebConfig {
  /** 프로젝트 키(id). */
  readonly projectKey: string;
  /** 배포 플레인 base URL(끝 슬래시 없이). 예: https://cdn.example.com */
  readonly endpoint: string;
  /** 빌드타임 bake된 번들 스냅샷(항상 존재하는 fallback). `BakedBundle.parse`로 검증해 넘긴다. */
  readonly bundle: Snapshot;
  readonly context: ClientContext;
  readonly installId?: string;
  readonly telemetry?: "off" | "aggregate";
  readonly pollIntervalMs?: number;
  /** 실시간 푸시(옵트인) 알림 채널 base URL(관리/알림 플레인). 없으면 폴링만. */
  readonly pushEndpoint?: string;
  /** 테스트/커스텀용 fetch 주입(기본 전역 fetch). */
  readonly fetchImpl?: typeof fetch;
  /**
   * 산출물·manifest 영속 캐시. 기본은 `localStorage`(없으면 메모리).
   * 캐시가 없어도 번들 fallback이 살아 있어 번역 공백은 생기지 않는다.
   */
  readonly cache?: PersistentCache;
}

export type Unsubscribe = () => void;

export class HttpRynL10n {
  private readonly cfg: WebConfig;
  private readonly client: RynL10nClient;
  private readonly cache: PersistentCache;
  private readonly store: CachedStore;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(cfg: WebConfig) {
    this.cfg = cfg;
    this.cache = cfg.cache ?? defaultCache(cfg.projectKey);
    this.store = new CachedStore(this.cache);
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

  /**
   * manifest 조회(짧은 TTL + ETag 재검증, 7.2). 네트워크 실패·304면 캐시본을 쓴다.
   * 캐시조차 없으면 [DeliveryError]를 던진다 — 진단·수동 갱신용 경로이고,
   * 폴링 루프가 쓰는 [refresh]는 이 실패를 삼킨다.
   */
  async loadManifest(): Promise<Manifest> {
    const cached = this.cachedManifest();
    const headers: Record<string, string> = {};
    // 304를 받아도 되돌릴 캐시본이 실제로 있을 때만 조건부 요청을 보낸다
    // (ETag만 남고 본문 캐시가 사라진 상태에서 304가 오면 복원할 것이 없다).
    const etag = this.cache.get(ETAG_KEY);
    if (cached && etag !== undefined) headers["if-none-match"] = etag;

    let res: Response;
    try {
      res = await this.fetchImpl(this.url("manifest.json"), { headers });
    } catch (cause) {
      // 오프라인·타임아웃 — 마지막으로 성공한 manifest로 진행한다.
      if (cached) return cached;
      throw new DeliveryError("unavailable", "manifest.json", { cause });
    }

    if (res.status === 304) {
      if (cached) return cached;
      throw new DeliveryError("malformed", "manifest.json");
    }
    if (!res.ok) {
      // 서버가 살아 있으나 응답이 이상함 → 캐시가 있으면 캐시로 진행.
      if (cached) return cached;
      throw new DeliveryError("bad-status", "manifest.json", { status: res.status });
    }

    const text = await res.text();
    const parsed = safeJson(text);
    if (!isManifestShape(parsed)) throw new DeliveryError("malformed", "manifest.json");
    this.cache.set(MANIFEST_KEY, text);
    const freshEtag = res.headers.get("etag");
    if (freshEtag !== null) this.cache.set(ETAG_KEY, freshEtag);
    return parsed;
  }

  /**
   * 갱신 사이클: manifest 조건부 요청(ETag) → 내 앱 버전에 맞는 릴리스 선택 → 필요한 산출물만
   * 프리페치 → 동기 코어 refresh. 릴리스 선택은 **클라이언트가 정적 manifest만으로** 수행한다(4.3).
   *
   * 실패는 던지지 않는다(폴링 루프에서 호출되는 자리다) — 어느 경로로 실패해도 화면의 번역은
   * 번들 fallback으로 그대로 살아 있다.
   * @returns 카탈로그가 실제로 바뀌었으면 true.
   */
  async refresh(): Promise<boolean> {
    let manifest: Manifest;
    try {
      manifest = await this.loadManifest();
    } catch {
      return false; // 네트워크도 캐시도 없음 → 번들 유지
    }

    const sel = selectRelease(manifest.releases, this.cfg.context);
    if (sel.kind !== "bundle-only") {
      const r = sel.release;
      // 활성 번들과 base가 같으면 스냅샷은 이미 손에 있다(빌드타임에 구운 것) → 받지 않는다.
      if (r.base !== this.client.status().activeBase && !this.store.getSnapshot(r.snapshot)) {
        await this.fetchArtifact(r.snapshot, isSnapshotShape, (v, raw) => this.store.putSnapshot(r.snapshot, v, raw));
      }
      // 델타는 sparse라 작다. 카나리 미대상이면 refresh가 무시하므로 실패해도 그냥 진행한다.
      if (r.delta !== undefined && r.overlay !== r.base && !this.store.getDelta(r.delta)) {
        const deltaPath = r.delta;
        await this.fetchArtifact(deltaPath, isDeltaShape, (v, raw) => this.store.putDelta(deltaPath, v, raw));
      }
    }
    return this.client.refresh(manifest);
  }

  /** 불변 산출물 내려받기 — 실패는 삼킨다(캐시/번들로 계속 진행). */
  private async fetchArtifact<T>(
    path: string,
    guard: (v: unknown) => v is T,
    put: (value: T, raw: string) => void,
  ): Promise<void> {
    try {
      const res = await this.fetchImpl(this.url(path));
      if (!res.ok) return;
      const raw = await res.text();
      const decoded = safeJson(raw);
      if (guard(decoded)) put(decoded, raw);
    } catch {
      /* 오프라인 — 캐시/번들로 계속 진행 */
    }
  }

  private cachedManifest(): Manifest | undefined {
    const raw = this.cache.get(MANIFEST_KEY);
    if (raw === undefined) return undefined;
    const decoded = safeJson(raw);
    return isManifestShape(decoded) ? decoded : undefined;
  }

  /** 포그라운드/주기 폴링 시작. */
  start(): void {
    const iv = this.cfg.pollIntervalMs ?? 60_000;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), iv);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.disconnectServerPush(); }

  /** 캐시 비우기(로그아웃·프로젝트 전환 등). 번들 fallback은 그대로라 번역 공백은 생기지 않는다. */
  clearCache(): void {
    this.store.clear();
    this.cache.clear();
  }

  private pushAbort: AbortController | undefined;

  /**
   * 실시간 푸시 연결(옵트인, M4). SSE 'manifest' 신호 수신 시 즉시 refresh → 폴링 지연 없이 갱신.
   * 신호는 캐시 무효화용일 뿐, 번역 데이터는 여전히 배포 플레인에서 fetch한다.
   */
  async connectServerPush(onEvent?: () => void): Promise<void> {
    if (!this.cfg.pushEndpoint) return;
    this.pushAbort = new AbortController();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.pushEndpoint}/projects/${this.cfg.projectKey}/events`,
        { signal: this.pushAbort.signal, headers: { accept: "text/event-stream" } });
    } catch { return; }
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (/(^|\n)event: manifest/.test(frame)) { await this.refresh(); onEvent?.(); }
        }
      }
    } catch { /* abort/네트워크 종료 → 폴링으로 폴백 */ }
  }
  disconnectServerPush(): void { this.pushAbort?.abort(); this.pushAbort = undefined; }
}
