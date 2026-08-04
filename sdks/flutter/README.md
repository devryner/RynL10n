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
- **`dart:io` 의존은 어댑터에만** 있다. 코어(`rynl10n.dart`)는 `DeliveryFetch`·`ArtifactCache`를
  주입받는 순수 Dart라, Flutter Web은 `rynl10n_io.dart` 대신 `package:http` 어댑터를 꽂으면 된다.
- 번들 로더의 파일 시스템 버전(`loadBakedSnapshot(Directory)`·`loadBakedLockfile`)도 어댑터에 있다.

## 검증

```bash
cd sdks/flutter && dart pub get && dart test   # 골든 10 + 시나리오 5 + 앱 적용 경로 19 = 34 tests
```

## M4 기능

- **정수 버전 매칭**: `ClientContext(buildNumber: 4210)` + `VersionMatch('integer-range', '>=42 <50')`.
- **카나리(8.4)**: manifest `rollout<100`이면 `hash(installId+releaseId) mod 100 < rollout%`만 오버레이 수신.
  안전 기본값 rollout 100(전체). installId=기기 로컬 익명 난수(서버 미전송).
