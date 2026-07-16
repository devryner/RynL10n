/**
 * 프레임워크 무관 store — 기획서 6.2.
 * React `useSyncExternalStore(subscribe, getVersion)` 계약과 호환. 카탈로그 갱신 시 version이 올라
 * 구독자(React 컴포넌트 등)가 리렌더한다. React 어댑터는 README 참조(peer, 이 패키지에 의존성 없음).
 */
import { HttpRynL10n, type WebConfig, type Unsubscribe } from "./http.ts";

export interface L10nStore {
  t(key: string, args?: Readonly<Record<string, unknown>>, locale?: string): string;
  /** React useSyncExternalStore용 구독. 카탈로그 갱신 시 콜백 호출. */
  subscribe(onChange: () => void): Unsubscribe;
  /** React useSyncExternalStore용 스냅샷(단조 증가 버전). */
  getVersion(): number;
  refresh(): Promise<boolean>;
  start(): void;
  stop(): void;
}

export function createStore(cfg: WebConfig): L10nStore {
  const sdk = new HttpRynL10n(cfg);
  let version = 0;
  const subscribers = new Set<() => void>();
  sdk.onCatalogUpdated(() => {
    version++;
    for (const cb of subscribers) cb();
  });
  return {
    t: (key, args, locale) => sdk.t(key, args, locale),
    subscribe(onChange) { subscribers.add(onChange); return () => subscribers.delete(onChange); },
    getVersion: () => version,
    refresh: () => sdk.refresh(),
    start: () => sdk.start(),
    stop: () => sdk.stop(),
  };
}
