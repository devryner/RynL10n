/// RynL10n Flutter/Dart SDK — `package:http` 어댑터 진입점 (**Flutter Web 포함**).
///
/// 코어(`rynl10n.dart`)는 HTTP·저장소를 주입받는 순수 Dart라 모든 타깃에서 쓰인다.
/// 진입점은 둘 중 하나를 고르면 된다:
///
/// | 진입점 | HTTP 백엔드 | 웹 | 추가 의존성 |
/// | --- | --- | --- | --- |
/// | `rynl10n_io.dart` | `dart:io` `HttpClient` | ✗ | 없음 |
/// | `rynl10n_http.dart` | `package:http` | ✓ | `http` |
///
/// 웹을 포함해 **하나로 가고 싶으면 이 진입점**을 쓴다 — `package:http`가 플랫폼마다 백엔드를
/// 알아서 고른다(웹=`BrowserClient`/fetch, 그 외=`dart:io`).
///
/// ```dart
/// import 'package:rynl10n/rynl10n.dart';
/// import 'package:rynl10n/rynl10n_http.dart';
///
/// final store = RemoteDeliveryStore(
///   baseUrl: 'https://cdn.example.com',   // 배포 플레인(정적) — 관리 API 아님
///   project: 'shop',
///   fetch: httpDeliveryFetch(),
///   cache: CallbackArtifactCache(         // 웹은 파일 시스템이 없다
///     read: (k) => web.window.localStorage.getItem('rynl10n:shop:$k'),
///     write: (k, v) => web.window.localStorage.setItem('rynl10n:shop:$k', v),
///     clear: () => web.window.localStorage.clear(),
///   ),
/// );
/// await store.update(client);
/// ```
///
/// 브라우저에서는 배포 플레인의 CORS 설정이 필요하다(특히 `Access-Control-Expose-Headers: ETag`)
/// — 자세한 내용은 `src/http_adapter.dart`의 문서 주석 참조.
library;

export 'src/http_adapter.dart';
