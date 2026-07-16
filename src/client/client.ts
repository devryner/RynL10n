/**
 * SDK 런타임 (배포 플레인 소비자) — 기획서 3.1 / 4.3 / 6.1 / 6.4 / 11
 *
 * 철칙: 배포 플레인의 정적 파일(manifest·snapshot·delta)만 읽고 관리 API는 절대 호출하지 않는다.
 * 부팅: 번들 스냅샷 즉시 로드 → 첫 프레임부터 번역 완비, 네트워크 대기 없음.
 * 갱신: manifest 조회 → 자기 앱 버전에 맞는 릴리스 자체 선택 → 델타(or 풀 스냅샷) 적용 → 원자적 스왑.
 */

import type { Delta, Manifest, Snapshot } from "../core/types.ts";
import type { ClientContext, SelectionResult } from "../core/matching.ts";
import { selectRelease } from "../core/matching.ts";
import {
  OverlayLayer,
  formatValue,
  resolveValue,
  type ResolveOptions,
  type ResolveResult,
} from "../core/resolve.ts";

/** 배포 플레인(CDN/스토리지)을 흉내내는 정적 파일 저장소. path → 파일 내용. */
export interface DeliveryStore {
  getSnapshot(path: string): Snapshot | undefined;
  getDelta(path: string): Delta | undefined;
}

export class InMemoryDeliveryStore implements DeliveryStore {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly deltas = new Map<string, Delta>();
  putSnapshot(path: string, s: Snapshot): void { this.snapshots.set(path, s); }
  putDelta(path: string, d: Delta): void { this.deltas.set(path, d); }
  getSnapshot(path: string): Snapshot | undefined { return this.snapshots.get(path); }
  getDelta(path: string): Delta | undefined { return this.deltas.get(path); }
}

export interface ClientConfig {
  /** 빌드타임에 bake된 번들 스냅샷(항상 존재하는 fallback). */
  readonly bundle: Snapshot;
  readonly store: DeliveryStore;
  readonly context: ClientContext;
  readonly resolveOptions?: ResolveOptions;
  /** 텔레메트리(9.3): 기본 off. 'aggregate'는 익명 카운트만 집계(값·키명·기기 식별자 없음). */
  readonly telemetry?: "off" | "aggregate";
}

/** 배포 건전성 익명 집계 카운트(9.3). 카나리 판정(8.4) 입력. */
export interface TelemetryCounts {
  overlay_applied: number;
  format_guard_rejected: number;
  key_unresolved: number;
  delta_failed: number;
}

export type UpdateListener = (info: { readonly release: string; readonly overlayTarget: string }) => void;

/** 진단용 현재 상태. */
export interface ClientStatus {
  readonly selection: SelectionResult["kind"];
  readonly releaseId: string | undefined;
  readonly activeBase: string;
  readonly overlayTarget: string | undefined;
}

export class RynL10nClient {
  private readonly config: ClientConfig;
  private activeBundle: Snapshot;
  private overlay = new OverlayLayer();
  private selection: SelectionResult;
  private overlayTarget: string | undefined;
  private readonly listeners = new Set<UpdateListener>();

  private tel: TelemetryCounts = { overlay_applied: 0, format_guard_rejected: 0, key_unresolved: 0, delta_failed: 0 };

  constructor(config: ClientConfig) {
    this.config = config;
    this.activeBundle = config.bundle; // 부팅 = 번들 즉시 로드
    this.selection = { kind: "bundle-only" };
  }

  private bump(event: keyof TelemetryCounts): void {
    if (this.config.telemetry === "aggregate") this.tel[event]++;
  }

  /** 누적된 익명 텔레메트리 카운트를 반환하고 리셋(옵트인 리포터가 배치 전송, 9.3). */
  drainTelemetry(): TelemetryCounts {
    const snapshot = { ...this.tel };
    this.tel = { overlay_applied: 0, format_guard_rejected: 0, key_unresolved: 0, delta_failed: 0 };
    return snapshot;
  }

  onCatalogUpdated(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * manifest를 받아 갱신 사이클 수행(6.4). 실패는 조용히 이전 상태 유지 — 화면 번역은 절대 안 깨짐.
   * @returns 실제로 카탈로그가 바뀌었으면 true.
   */
  refresh(manifest: Manifest): boolean {
    const selection = selectRelease(manifest.releases, this.config.context);
    this.selection = selection;

    if (selection.kind === "bundle-only") {
      return this.swap(this.config.bundle, new OverlayLayer(), undefined, undefined);
    }

    const release = selection.release;

    // 1) 활성 번들 결정: 매칭 릴리스의 base가 bake된 번들과 다르면 풀 스냅샷을 받아온다.
    let bundle = this.config.bundle;
    if (release.base !== this.config.bundle.base) {
      const fetched = this.config.store.getSnapshot(release.snapshot);
      if (fetched === undefined) return false; // 못 받으면 이전 상태 유지
      bundle = fetched;
    }

    // 2) 오버레이 결정: overlay 포인터가 base와 같으면 오버레이 없음.
    if (release.overlay === release.base || release.delta === undefined) {
      return this.swap(bundle, new OverlayLayer(), release.id, release.base);
    }

    const delta = this.config.store.getDelta(release.delta);
    if (delta === undefined) { this.bump("delta_failed"); return false; } // 못 받으면 이전 상태 유지
    // 체크섬 가드: 델타의 from이 활성 번들 base와 일치해야 적용(6.4 원자성).
    if (delta.from !== bundle.base) { this.bump("delta_failed"); return false; }

    const overlay = buildOverlay(delta);
    const changed = this.swap(bundle, overlay, release.id, release.overlay);
    if (changed) this.bump("overlay_applied");
    return changed;
  }

  /** 동기 조회 — 항상 번들 fallback이 있어 블로킹 네트워크 없음(6.1). */
  t(key: string, args?: Readonly<Record<string, unknown>>, locale?: string): string {
    const loc = locale ?? this.config.context.releaseLabel ?? this.activeBundle.defaultLocale;
    const r = this.resolve(key, loc);
    if (r.guardFallback) this.bump("format_guard_rejected");
    if (r.value === undefined) { this.bump("key_unresolved"); return `⟪${key}⟫`; } // 개발 모드 미해결 표면화(3.1)
    return formatValue(r.value, r.matchedLocale ?? loc, args ?? {});
  }

  /** 포맷팅 전 원시 해석 결과(테스트·진단용). */
  resolve(key: string, locale: string): ResolveResult {
    return resolveValue(this.activeBundle, this.overlay, key, locale, this.config.resolveOptions ?? {});
  }

  status(): ClientStatus {
    return {
      selection: this.selection.kind,
      releaseId: this.selection.kind === "bundle-only" ? undefined : this.selection.release.id,
      activeBase: this.activeBundle.base,
      overlayTarget: this.overlayTarget,
    };
  }

  private swap(bundle: Snapshot, overlay: OverlayLayer, releaseId: string | undefined, overlayTarget: string | undefined): boolean {
    const changed = bundle.base !== this.activeBundle.base || overlayTarget !== this.overlayTarget;
    this.activeBundle = bundle;
    this.overlay = overlay;
    this.overlayTarget = overlayTarget;
    if (changed && releaseId !== undefined && overlayTarget !== undefined) {
      for (const l of this.listeners) l({ release: releaseId, overlayTarget });
    }
    return changed;
  }
}

/** 델타 → 오버레이 계층. set=값, delete=tombstone(3.1). */
export function buildOverlay(delta: Delta): OverlayLayer {
  const overlay = new OverlayLayer();
  for (const op of delta.ops) {
    if (op.op === "set") overlay.set(op.locale, op.key, op.value);
    else overlay.tombstone(op.locale, op.key);
  }
  return overlay;
}
