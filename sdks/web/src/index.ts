/** RynL10n Web SDK (M4 α) 공개 표면. */
export { HttpRynL10n, DeliveryError, browserLocale, type WebConfig, type Unsubscribe } from "./http.ts";
export { createStore, type L10nStore } from "./store.ts";
// 앱 적용 경로 ③ 익명 집계 텔레메트리 업로드(9.3) — 옵트인. HttpRynL10n에 telemetryEndpoint를 주면 자동.
export {
  TelemetryReporter,
  telemetryEvents,
  versionBucket,
  type TelemetryConfig,
  type TelemetryEvent,
  type TelemetrySource,
} from "./telemetry.ts";
// 앱 적용 경로 ① 빌드타임 번들 로더(6.3)
export {
  BakedBundle,
  BakedError,
  parseBakedSnapshot,
  parseBakedLockfile,
  loadBakedSnapshot,
  loadBakedLockfile,
  BAKED_CANDIDATES,
  BAKED_LOCKFILE_CANDIDATES,
  type BakedLockfile,
  type LoadOptions,
} from "./baked.ts";
// 앱 적용 경로 ② 영속 캐시(6.4) — 기본은 localStorage, 필요하면 직접 꽂는다.
export {
  defaultCache,
  memoryCache,
  storageCache,
  type PersistentCache,
  type StorageLike,
} from "./cache.ts";
export type { Snapshot, Manifest, TranslationValue } from "../../../src/core/types.ts";
export type { ClientContext } from "../../../src/core/matching.ts";
