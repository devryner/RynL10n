# @rynl10n/web (M4 α)

Web(JS/TS) SDK. **프레임워크 무관 코어 + fetch/ETag 폴링 + 영속 캐시 + React 어댑터.** 코어 알고리즘
(resolve·매칭·카나리)은 참조 구현(`../../src`)을 재사용 — 골든 벡터로 검증된 동작을 그대로 공유한다.

## 사용

```ts
import { HttpRynL10n, BakedBundle } from "@rynl10n/web";
import raw from "./rynl10n/snapshot.json"; // 빌드타임 bake된 번들(fallback)

const sdk = new HttpRynL10n({
  projectKey: "shop",
  endpoint: "https://cdn.example.com",   // 배포 플레인(정적) — 관리 API 아님
  bundle: BakedBundle.parse(raw),        // import 값 검증(아래 "번들 로더")
  context: { appVersion: "3.2.1" },      // 또는 releaseLabel / buildNumber
  installId: localStorage.getItem("rynl10n_iid") ?? undefined, // 카나리용(옵션)
});
sdk.start();                              // 포그라운드 폴링(ETag 조건부)
sdk.onCatalogUpdated(() => rerender());
sdk.t("cart.title");                       // 동기 — 항상 번들 fallback
```

- 갱신 = manifest 조건부 요청(If-None-Match) → 변경 시 필요한 델타/스냅샷만 프리페치 → 동기 코어 적용.
- 플레인 분리 준수: 배포 플레인의 정적 파일만 읽는다.

## 앱 적용 경로 (6.3 / 6.4)

앱이 실제로 쓰는 조각은 두 개다 — **번들 로더**와 **영속 캐시**. iOS `RemoteDeliveryStore` ·
Android `RemoteDeliveryStore`와 같은 계약을 지키며, 시나리오 테스트도 1:1로 맞춰 두었다.

### ① 번들 로더

빌드 산출물(`snapshot.json`)을 쓰는 길은 두 갈래이고 둘 다 같은 검증 관문을 지난다 — 잘못된 JSON을
import해도 런타임 깊은 곳이 아니라 여기서 안내 메시지와 함께 실패한다.

```ts
import { BakedBundle } from "@rynl10n/web";

// 번들러 import (권장 — 네트워크 왕복 0)
const bundle = BakedBundle.parse(raw);

// 정적 자산에서 fetch (vendored 배치·번들러 없는 환경)
const bundle = await BakedBundle.load("/assets");     // rynl10n/snapshot.json → snapshot.json 순
const lock = await BakedBundle.loadLockfile("/assets"); // 어느 릴리스가 구워졌는지(진단용)
```

### ② 영속 캐시

배포 플레인 산출물은 **내용해시 URL이라 한 번 받으면 영구 유효**하다. 기본값은 `localStorage`이며
탭을 새로 열거나 오프라인으로 다시 들어와도 마지막 카탈로그가 그대로 살아 있다.

```ts
new HttpRynL10n({ ...cfg });                       // 기본: localStorage(브라우저) / 메모리(SSR·Node)
new HttpRynL10n({ ...cfg, cache: memoryCache() }); // 직접 지정
sdk.clearCache();                                   // 로그아웃·프로젝트 전환
```

- 저장 실패(사생활 모드·용량 초과)는 **조용히 삼킨다** — 캐시는 가속일 뿐이고 번들 fallback이 항상 있다.
- `refresh()`는 던지지 않는다(폴링 루프 자리). 오프라인이면 마지막 캐시 manifest로 진행하고,
  캐시조차 없으면 `false`를 돌려주며 화면은 번들 그대로 유지된다.
- 진단·수동 갱신용으로 `loadManifest()`는 실패를 `DeliveryError`(`bad-status` · `unavailable` ·
  `malformed`)로 던진다.

### ③ 배포 플레인 CORS (교차 오리진이면 필수)

배포 플레인이 앱과 다른 오리진이면(= CDN을 쓰면 거의 항상) 다음 응답 헤더가 필요하다.
셀프호스트 참조 서버는 이미 셋 다 보낸다(`backend/src/storage/delivery-server.ts`).

- `Access-Control-Allow-Origin` — 없으면 브라우저가 응답 자체를 막는다.
- `Access-Control-Expose-Headers: ETag` — **ETag는 CORS 안전목록 응답 헤더가 아니다.** 노출하지
  않으면 `res.headers.get("etag")`가 `null`이라 조건부 요청이 영영 성립하지 않는다(동작은 하지만
  폴링마다 manifest를 전량 다시 받는다).
- `Access-Control-Allow-Headers: If-None-Match` — 이 요청 헤더는 preflight(OPTIONS)를 유발한다.

헤더가 없어도 SDK는 죽지 않는다 — etag가 없으면 조건부 요청을 생략하고, 응답이 막히면 마지막
캐시(또는 번들 fallback)로 진행한다.

### 실시간 푸시 (옵트인, M4)

```ts
const sdk = new HttpRynL10n({ ...cfg, pushEndpoint: "https://api.example.com" });
sdk.connectServerPush(() => rerender());  // SSE 'manifest' 신호 → 즉시 refresh(폴링 지연 0)
```
신호는 캐시 무효화용일 뿐(번역 데이터 없음) — 데이터는 여전히 배포 플레인에서 fetch. 연결 실패 시 폴링으로 폴백.

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
cd sdks/web && node --test "test/*.test.ts"   # 정적 서버 기동 → fetch/ETag/캐시/번들 로더/카나리 (23 tests)
```
