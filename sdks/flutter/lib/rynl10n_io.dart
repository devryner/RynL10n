/// RynL10n Flutter/Dart SDK — `dart:io` 어댑터 진입점.
///
/// 코어(`rynl10n.dart`)는 HTTP·저장소를 주입받는 순수 Dart라 모든 타깃에서 쓰인다.
/// 이 진입점은 그 구멍을 표준 라이브러리로 메운 기본 구현을 준다 — 모바일·데스크톱·서버용이며,
/// **Flutter Web에서는 import하지 않는다**(그 경우 `package:http` 등으로 `DeliveryFetch`만 채운다).
///
/// ```dart
/// import 'package:rynl10n/rynl10n.dart';
/// import 'package:rynl10n/rynl10n_io.dart';
///
/// final store = RemoteDeliveryStore(
///   baseUrl: 'https://cdn.example.com',   // 배포 플레인(정적) — 관리 API 아님
///   project: 'shop',
///   fetch: ioDeliveryFetch(),
///   cache: FileArtifactCache(cacheDir, project: 'shop'),
/// );
/// final client = RynL10nClient(bundle: bakedBundle, store: store, context: ctx);
/// await store.update(client);            // manifest → 릴리스 선택 → 산출물 → 스왑
/// ```
library;

export 'src/io_adapters.dart';
