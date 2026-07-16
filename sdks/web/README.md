# @rynl10n/web (M4 α)

Web(JS/TS) SDK. **프레임워크 무관 코어 + fetch/ETag 폴링 + React 어댑터.** 코어 알고리즘
(resolve·매칭·카나리)은 참조 구현(`../../src`)을 재사용 — 골든 벡터로 검증된 동작을 그대로 공유한다.

## 사용

```ts
import { HttpRynL10n } from "@rynl10n/web";
import bundle from "./rynl10n/snapshot.json"; // 빌드타임 bake된 번들(fallback)

const sdk = new HttpRynL10n({
  projectKey: "shop",
  endpoint: "https://cdn.example.com",   // 배포 플레인(정적) — 관리 API 아님
  bundle,
  context: { appVersion: "3.2.1" },      // 또는 releaseLabel / buildNumber
  installId: localStorage.getItem("rynl10n_iid") ?? undefined, // 카나리용(옵션)
});
sdk.start();                              // 포그라운드 폴링(ETag 조건부)
sdk.onCatalogUpdated(() => rerender());
sdk.t("cart.title");                       // 동기 — 항상 번들 fallback
```

- 갱신 = manifest 조건부 요청(If-None-Match) → 변경 시 필요한 델타/스냅샷만 프리페치 → 동기 코어 적용.
- 플레인 분리 준수: 배포 플레인의 정적 파일만 읽는다.

## React 어댑터 (peer, 3줄)

`createStore`는 `useSyncExternalStore` 계약(subscribe + getVersion)과 호환된다:

```tsx
import { useSyncExternalStore } from "react";
import { createStore } from "@rynl10n/web";

const store = createStore({ projectKey: "shop", endpoint, bundle, context: { appVersion } });
store.start();

export function useTranslation() {
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  return store.t;
}
// const t = useTranslation(); t("cart.title")
```

## i18next 마이그레이션

`t(key, args)` 표면은 i18next와 유사하다. 기존 리소스 JSON을 릴리스 스냅샷으로 import하면
동일 키로 조회가 그대로 동작한다(ICU 플레이스홀더 `{name}` 보존).

## 테스트

```bash
cd sdks/web && node --test "test/*.test.ts"   # 정적 서버 기동 → fetch/ETag/resolve/카나리 (4 tests)
```
