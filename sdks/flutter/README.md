# rynl10n (Flutter/Dart SDK, M4 α)

Flutter/Dart SDK. 순수 Dart 코어라 `dart test`로 검증 가능(Flutter 위젯 불요). 코어 알고리즘
(JCS·resolve·매칭·카나리·정수 매칭)은 M0 TS 참조 구현과 **골든 벡터로 바이트·해시·동작 정합**.

## 사용

```dart
import 'package:rynl10n/rynl10n.dart';

final client = RynL10nClient(
  bundle: Snapshot.fromJson(jsonDecode(bakedSnapshotJson)), // 빌드타임 bake된 fallback
  store: myDeliveryStore,                                   // 배포 플레인(정적) 접근 — 아래 "앱 적용 경로"
  context: ClientContext(appVersion: '3.2.1'),             // 또는 releaseLabel / buildNumber
  installId: localInstallId,                                // 카나리용(옵션)
);
client.refresh(manifest);
final s = client.t('cart.title', locale: 'ja');            // 동기 — 항상 번들 fallback
```

- 갱신 이벤트: `client.onCatalogUpdated((info) => ...)`. Flutter는 이를 `ValueNotifier<int>`로 감싸
  `ValueListenableBuilder`로 리빌드(어댑터는 위젯 레이어, 이 패키지는 위젯 의존성 없음).
- NFC 정규화는 `package:unorm_dart`, SHA-256은 `package:crypto` — JCS 결정성이 타 플랫폼과 일치.

## 앱 적용 경로 (6.3 / 6.4)

`myDeliveryStore` 자리를 앱이 손수 채울 필요가 없다. 두 조각이 SDK에 들어 있다 —
**번들 로더**와 **배포 플레인 HTTP 구현**. iOS·Android·Web과 같은 계약을 지키며 시나리오 테스트도
1:1로 맞춰 두었다.

```dart
import 'package:rynl10n/rynl10n.dart';
import 'package:rynl10n/rynl10n_io.dart';   // dart:io 기본 어댑터

// ① 번들 로더 — Flutter 자산은 문자열로 온다
final bundle = parseBakedSnapshot(
  await rootBundle.loadString('assets/rynl10n/snapshot.json'),
  source: 'assets/rynl10n/snapshot.json',
);

// ② 배포 플레인 HTTP — manifest(ETag) → 릴리스 자가 선택 → 필요한 산출물만 → 원자적 스왑
final store = RemoteDeliveryStore(
  baseUrl: 'https://cdn.example.com',       // 배포 플레인(정적) — 관리 API 아님
  project: 'shop',
  fetch: ioDeliveryFetch(),
  cache: FileArtifactCache(await getApplicationCacheDirectory(), project: 'shop'),
);
final client = RynL10nClient(bundle: bundle, store: store, context: ClientContext(appVersion: '3.2.1'));
await store.update(client);                  // 앱 시작 직후·포그라운드 복귀에 호출
```

- **동기 조회 / 비동기 다운로드 분리**: `DeliveryStore`는 동기 인터페이스라 화면이 네트워크를 기다리지
  않는다. `update()`가 산출물을 먼저 캐시에 채운 뒤 동기 코어를 호출한다.
- **불변 산출물은 영구 캐시**(내용해시 URL). manifest만 ETag로 재검증하고, 오프라인이면 **마지막
  캐시로 진행**한다. 캐시조차 없으면 `DeliveryException`(`badStatus`·`unavailable`·`malformed`).
- **HTTP·저장소 의존은 어댑터에만** 있다. 코어(`rynl10n.dart`)는 `DeliveryFetch`·`ArtifactCache`를
  주입받는 순수 Dart다.
- 번들 로더의 파일 시스템 버전(`loadBakedSnapshot(Directory)`·`loadBakedLockfile`)도 어댑터에 있다.

### 어댑터 진입점 고르기

| 진입점 | HTTP 백엔드 | Flutter Web | 추가 의존성 | 채우는 구멍 |
| --- | --- | --- | --- | --- |
| `package:rynl10n/rynl10n_io.dart` | `dart:io` `HttpClient` | ✗ (컴파일 불가) | 없음 | `ioDeliveryFetch` · `ioPushConnect` · `ioTelemetryPost` · `FileArtifactCache` |
| `package:rynl10n/rynl10n_http.dart` | `package:http` | ✓ | `http` | `httpDeliveryFetch` · `httpPushConnect` · `httpTelemetryPost` |

웹을 포함해 하나로 가려면 `rynl10n_http.dart`를 쓴다 — `package:http`가 플랫폼마다 백엔드를
알아서 고른다(웹=`BrowserClient`/fetch, 그 외=`dart:io`).

```dart
import 'package:rynl10n/rynl10n.dart';
import 'package:rynl10n/rynl10n_http.dart';
import 'package:web/web.dart' as web;

final store = RemoteDeliveryStore(
  baseUrl: 'https://cdn.example.com',
  project: 'shop',
  fetch: httpDeliveryFetch(),              // 웹·모바일·데스크톱·서버 공통
  cache: CallbackArtifactCache(            // 웹은 파일 시스템이 없다
    read: (k) => web.window.localStorage.getItem('rynl10n:shop:$k'),
    write: (k, v) => web.window.localStorage.setItem('rynl10n:shop:$k', v),
    clear: () => web.window.localStorage.clear(),
  ),
);
```

`CallbackArtifactCache`는 코어에 있고 의존성이 없다 — SDK가 저장소 패키지를 고르지 않기 위한
이음새라, 모바일에서 `shared_preferences`를 꽂는 데도 같은 클래스를 쓴다. 저장소가 던지는 실패
(사생활 모드·용량 초과)는 조용히 삼킨다.

### 갱신 자동화 — 폴링 · 실시간 푸시 (옵트인)

`update()`를 앱이 직접 부르는 것 외에, 켜 두면 알아서 따라오는 두 갈래가 있다.

```dart
// ① 주기 폴링(기본 60초) — 갱신의 보장선. 배터리·트래픽은 앱이 정한다.
store.startPolling(client, interval: const Duration(seconds: 60));
// AppLifecycleState.paused 에서 store.stopPolling(), resumed 에서 다시 startPolling.

// ② 실시간 푸시(SSE) — publish 즉시 반영. 지연 단축용이라 폴링과 함께 켠다.
final push = ServerPushChannel(
  endpoint: 'https://admin.example.com',   // 알림(관리) 플레인 — CDN이 아니다
  project: 'shop',
  connect: ioPushConnect(),                // 또는 httpPushConnect()
);
push.startUpdating(client, store);         // 신호 → store.update(client)
// 백그라운드 전환 등에서 push.stop()
```

**프레임은 "manifest가 바뀌었다"는 신호뿐이고, 번역 데이터는 여전히 배포 플레인에서 받는다** —
데이터 경로는 정적으로 유지된다(4.1). 연결이 끊기면 3초 → 최대 60초 백오프로 재연결하고,
그 사이 갱신은 폴링이 덮는다.

> **Flutter Web에서 `httpPushConnect`**: 브라우저 백엔드는 XHR 기반이라 응답을 끝까지 모아 넘긴다 —
> SSE가 제때 도착하지 않는다. 웹에서는 `EventSource`를 `PushConnect`로 감싸 넣는다(코어는 함수
> 하나만 요구한다 — 예시는 `lib/src/http_adapter.dart` 문서 주석). 폴링이 보장선이라 그대로 둬도
> 기능은 깨지지 않고 지연만 남는다.

### 배포 건전성 텔레메트리 (옵트인, 9.3)

대시보드 **관측성** 탭과 `releases/{r}/health`(카나리 판정의 입력)를 채우는 익명 집계다.
두 번 옵트인해야 한다 — **수집**(`RynL10nClient(telemetry: 'aggregate')`)과 **전송**(리포터 생성).

```dart
final reporter = TelemetryReporter(
  endpoint: 'https://admin.example.com',   // 관리 플레인(업로드는 쓰기 경로)
  project: 'shop',
  post: ioTelemetryPost(),                 // 또는 httpTelemetryPost()
);
reporter.start(client);                    // 기본 5분 주기
// 백그라운드 전환처럼 확실히 올리고 싶은 시점: await reporter.flush(client);
```

올라가는 것은 서버가 정의한 **5개 필드가 전부**다(`projectId`·`releaseId`·`event`·`count`·
`appVersionBucket`). 그 외 필드는 서버가 배치째 거부하므로(프라이버시 가드) **키 이름·번역 값·기기
식별자는 구조적으로 나갈 수 없다.** 카나리 버킷의 `installId`도 보내지 않는다.
`appVersionBucket`은 개별 빌드가 아니라 버전군이다(`3.2.1` → `3.2`).
전송 실패 시 카운트를 되돌려 다음 주기에 다시 올린다(실패 구간이 사라지면 거부율이 실제보다 낮게 보인다).

### 브라우저에서 반드시 확인할 것 — 배포 플레인 CORS

배포 플레인이 앱과 다른 오리진이면(= CDN을 쓰면 거의 항상) 다음 응답 헤더가 필요하다.
셀프호스트 참조 서버는 이미 셋 다 보낸다(`backend/src/storage/delivery-server.ts`).

- `Access-Control-Allow-Origin` — 없으면 브라우저가 응답 자체를 막는다.
- `Access-Control-Expose-Headers: ETag` — **ETag는 CORS 안전목록 응답 헤더가 아니다.** 노출하지
  않으면 JS가 `etag`를 읽지 못해 조건부 요청이 영영 성립하지 않는다(동작은 하지만 폴링마다
  manifest를 전량 다시 받는다).
- `Access-Control-Allow-Headers: If-None-Match` — 이 요청 헤더는 preflight를 유발한다.

헤더가 없어도 SDK는 죽지 않는다 — etag가 null이면 조건부 요청을 생략하고, 응답이 막히면 마지막
캐시(또는 번들 fallback)로 진행한다.

## 검증

```bash
cd sdks/flutter && dart pub get && dart test   # 골든 10 + 시나리오 5 + 앱 적용 경로 19 + http 어댑터 6
                                               # + 폴링·푸시·텔레메트리 8 = 48 tests
```

## M4 기능

- **정수 버전 매칭**: `ClientContext(buildNumber: 4210)` + `VersionMatch('integer-range', '>=42 <50')`.
- **카나리(8.4)**: manifest `rollout<100`이면 `hash(installId+releaseId) mod 100 < rollout%`만 오버레이 수신.
  안전 기본값 rollout 100(전체). installId=기기 로컬 익명 난수(서버 미전송).
