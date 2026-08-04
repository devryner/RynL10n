/// `package:http` 어댑터 — 기획서 6.4 (Flutter Web 포함 전 플랫폼).
///
/// `dart:io` 어댑터(`io_adapters.dart`)는 브라우저에서 컴파일되지 않는다. 이 어댑터는
/// `package:http`가 플랫폼마다 알아서 백엔드를 고르는 성질을 이용해(웹=`BrowserClient`/fetch,
/// 그 외=`dart:io`) **하나의 코드로 Flutter Web까지 덮는다**.
///
/// ```dart
/// import 'package:rynl10n/rynl10n.dart';
/// import 'package:rynl10n/rynl10n_http.dart';
///
/// final store = RemoteDeliveryStore(
///   baseUrl: 'https://cdn.example.com',
///   project: 'shop',
///   fetch: httpDeliveryFetch(),
///   cache: CallbackArtifactCache(...),   // 웹은 파일 시스템이 없다 — 아래 "영속 캐시"
/// );
/// ```
///
/// ## 브라우저에서 반드시 확인할 것 (배포 플레인 CORS)
///
/// 배포 플레인이 앱과 다른 오리진이면(= CDN을 쓰면 거의 항상) 다음 응답 헤더가 필요하다.
/// 셀프호스트 참조 서버(`backend/src/storage/delivery-server.ts`)는 이미 셋 다 보낸다.
///
/// - `Access-Control-Allow-Origin` — 없으면 브라우저가 응답 자체를 막는다.
/// - `Access-Control-Expose-Headers: ETag` — **ETag는 CORS 안전목록 헤더가 아니다.**
///   노출하지 않으면 JS가 `etag`를 읽지 못해 조건부 요청이 영영 성립하지 않는다
///   (동작은 하지만 폴링마다 manifest를 전량 다시 받는다).
/// - `Access-Control-Allow-Headers: If-None-Match` — `if-none-match`는 안전목록 요청 헤더가
///   아니라 preflight(OPTIONS)를 유발한다. 허용하지 않으면 조건부 요청이 실패한다.
///
/// 헤더가 갖춰지지 않아도 SDK는 죽지 않는다 — etag가 null이면 조건부 요청을 보내지 않고,
/// 응답 자체가 막히면 마지막 캐시(또는 번들 fallback)로 진행한다.
///
/// ## 영속 캐시
///
/// 웹에는 파일 시스템이 없으므로 `FileArtifactCache` 대신 `CallbackArtifactCache`(코어,
/// `rynl10n.dart`)에 앱이 이미 쓰는 저장소를 꽂는다 — 웹은 `package:web`의
/// `window.localStorage`, 모바일은 `shared_preferences` 식이다. SDK는 저장소 패키지를 고르지
/// 않는다. 생략하면 `MemoryArtifactCache`라 탭 수명 동안만 유지되며, 불변 산출물은 브라우저
/// HTTP 캐시가 대신 받아 주지만(`cache-control: immutable`) **오프라인 재진입 시 마지막
/// manifest 복원**은 영속 캐시가 있어야 동작한다.
library;

import 'package:http/http.dart' as http;

import 'delivery.dart';

/// `package:http` 기반 [DeliveryFetch]. 웹·모바일·데스크톱·서버 모두에서 동작한다.
///
/// [client]를 넘기면 그대로 쓴다(테스트 주입, 커스텀 인터셉터, 연결 재사용).
/// 넘기지 않으면 내부에서 하나를 만들어 이 어댑터가 사는 동안 재사용한다.
DeliveryFetch httpDeliveryFetch({
  http.Client? client,
  Duration timeout = const Duration(seconds: 15),
}) {
  final c = client ?? http.Client();
  return (String url, {String? ifNoneMatch}) async {
    final response = await c
        .get(
          Uri.parse(url),
          headers: {
            if (ifNoneMatch != null) 'if-none-match': ifNoneMatch,
          },
        )
        .timeout(timeout);
    // package:http는 응답 헤더 키를 소문자로 정규화한다.
    return DeliveryResponse(response.statusCode, response.body, etag: response.headers['etag']);
  };
}
