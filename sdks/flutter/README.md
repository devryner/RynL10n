# rynl10n (Flutter/Dart SDK, M4 α)

Flutter/Dart SDK. 순수 Dart 코어라 `dart test`로 검증 가능(Flutter 위젯 불요). 코어 알고리즘
(JCS·resolve·매칭·카나리·정수 매칭)은 M0 TS 참조 구현과 **골든 벡터로 바이트·해시·동작 정합**.

## 사용

```dart
import 'package:rynl10n/rynl10n.dart';

final client = RynL10nClient(
  bundle: Snapshot.fromJson(jsonDecode(bakedSnapshotJson)), // 빌드타임 bake된 fallback
  store: myDeliveryStore,                                   // 배포 플레인(정적) 접근
  context: ClientContext(appVersion: '3.2.1'),             // 또는 releaseLabel / buildNumber
  installId: localInstallId,                                // 카나리용(옵션)
);
client.refresh(manifest);
final s = client.t('cart.title', locale: 'ja');            // 동기 — 항상 번들 fallback
```

- 갱신 이벤트: `client.onCatalogUpdated((info) => ...)`. Flutter는 이를 `ValueNotifier<int>`로 감싸
  `ValueListenableBuilder`로 리빌드(어댑터는 위젯 레이어, 이 패키지는 위젯 의존성 없음).
- NFC 정규화는 `package:unorm_dart`, SHA-256은 `package:crypto` — JCS 결정성이 타 플랫폼과 일치.

## 검증

```bash
cd sdks/flutter && dart pub get && dart test   # 골든 10 + 시나리오 5 = 15 tests
```

## M4 기능

- **정수 버전 매칭**: `ClientContext(buildNumber: 4210)` + `VersionMatch('integer-range', '>=42 <50')`.
- **카나리(8.4)**: manifest `rollout<100`이면 `hash(installId+releaseId) mod 100 < rollout%`만 오버레이 수신.
  안전 기본값 rollout 100(전체). installId=기기 로컬 익명 난수(서버 미전송).
