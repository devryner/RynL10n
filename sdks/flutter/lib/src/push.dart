/// 실시간 푸시 신호 구독(옵트인) — 기획서 4.1 / 8, M4. iOS·Android `ServerPushChannel`과 동작 대칭.
///
/// **데이터 없는 신호만 받는다.** SSE 프레임이 전하는 것은 "manifest가 바뀌었다"는 사실뿐이고,
/// 번역 데이터는 여전히 배포 플레인의 정적 파일에서 내려받는다 → 읽기 데이터 경로는 정적으로
/// 유지된다(4.1). 그래서 이 채널의 엔드포인트는 배포 플레인이 **아니라** 알림(관리) 플레인이다.
///
/// 폴링([RemoteDeliveryStore.startPolling])이 갱신의 보장선이고 이 채널은 **지연 단축용**이다.
///
/// HTTP는 [DeliveryFetch]와 같은 이유로 주입받는다(코어는 `dart:io`·`package:http`를 모른다).
/// 기본 어댑터는 `rynl10n_io.dart`(`ioPushConnect`)와 `rynl10n_http.dart`(`httpPushConnect`)에 있다.
library;

import 'dart:async';

import 'client.dart';
import 'delivery.dart';

/// SSE 응답 — 상태 코드 + 본문 청크 스트림(문자열로 디코딩된 상태).
/// 청크 경계는 줄 경계와 무관하다(파서가 버퍼링한다).
class PushResponse {
  final int status;
  final Stream<String> body;
  const PushResponse(this.status, this.body);
}

/// SSE 연결을 여는 함수. 연결 실패(오프라인·타임아웃)는 **던져서** 알린다.
typedef PushConnect = Future<PushResponse> Function(String url);

enum PushErrorKind { badStatus, unavailable }

class PushException implements Exception {
  final PushErrorKind kind;
  final int? status;
  final Object? cause;
  const PushException(this.kind, {this.status, this.cause});

  @override
  String toString() => switch (kind) {
        PushErrorKind.badStatus => '알림 플레인이 $status 를 반환했습니다',
        PushErrorKind.unavailable => '알림 플레인에 접근할 수 없습니다',
      };
}

class ServerPushChannel {
  final String _eventsUrl;
  final PushConnect _connect;

  StreamIterator<String>? _iterator;
  bool _stopped = false;

  /// [endpoint]는 알림(관리) 플레인 루트(로컬 셀프호스트는 `http://localhost:8787`).
  /// 배포 플레인/CDN이 아니다 — 신호만 오가는 다른 축이다.
  ServerPushChannel({
    required String endpoint,
    required String project,
    required PushConnect connect,
  })  : _eventsUrl = '${_trimTrailing(endpoint)}/projects/${_trimSlashes(project)}/events',
        _connect = connect;

  /// 연결 하나를 붙잡고 신호를 처리한다. 스트림이 끝나거나 [stop]으로 끊기면 반환한다(재연결 없음).
  ///
  /// `event: manifest` 프레임만 신호로 센다 — 알림 플레인이 다른 이벤트를 추가해도 조용히 무시된다.
  /// 반환값은 처리한 신호 수다.
  Future<int> receive(Future<void> Function() onSignal) async {
    final PushResponse response;
    try {
      response = await _connect(_eventsUrl);
    } catch (e) {
      throw PushException(PushErrorKind.unavailable, cause: e);
    }
    if (response.status != 200) {
      throw PushException(PushErrorKind.badStatus, status: response.status);
    }

    final iterator = StreamIterator(response.body);
    _iterator = iterator;
    var signals = 0;
    var buffer = '';
    var isManifestFrame = false;

    Future<void> handleLine(String line) async {
      if (line.isEmpty) {
        // 빈 줄 = 프레임 경계(SSE).
        if (isManifestFrame) {
          signals++;
          await onSignal();
        }
        isManifestFrame = false;
      } else if (line.startsWith('event:')) {
        isManifestFrame = line.substring('event:'.length).trim() == 'manifest';
      }
    }

    try {
      while (await iterator.moveNext()) {
        // 청크는 줄 중간에서 끊길 수 있다 → 마지막 조각은 버퍼에 남긴다.
        buffer += iterator.current;
        var newline = buffer.indexOf('\n');
        while (newline >= 0) {
          final line = buffer.substring(0, newline).replaceAll('\r', '');
          buffer = buffer.substring(newline + 1);
          await handleLine(line);
          newline = buffer.indexOf('\n');
        }
      }
    } catch (_) {
      // 끊김(stop·네트워크) — 폴링이 안전망이므로 받은 데까지만 반환한다.
    } finally {
      await iterator.cancel();
      if (identical(_iterator, iterator)) _iterator = null;
    }

    // 서버가 프레임 경계(빈 줄) 없이 스트림을 닫아도 신호는 잃지 않는다.
    if (isManifestFrame) {
      signals++;
      await onSignal();
    }
    return signals;
  }

  /// 백그라운드 구독 시작 — 끊기면 백오프(3초 → 최대 60초)로 재연결한다.
  /// 신호를 실제로 받으면 백오프를 초기화한다.
  void start(Future<void> Function() onSignal) {
    stop();
    _stopped = false;
    unawaited(() async {
      var backoff = const Duration(seconds: 3);
      while (!_stopped) {
        try {
          if (await receive(onSignal) > 0) backoff = const Duration(seconds: 3);
        } catch (_) {
          // 알림 플레인이 없거나 끊김 — 폴링이 안전망이므로 조용히 재시도한다.
        }
        if (_stopped) return;
        await Future<void>.delayed(backoff);
        final doubled = backoff * 2;
        backoff = doubled > const Duration(seconds: 60) ? const Duration(seconds: 60) : doubled;
      }
    }());
  }

  /// 신호를 받을 때마다 배포 플레인에서 갱신 사이클을 한 번 돌리는 기본 배선.
  void startUpdating(RynL10nClient client, RemoteDeliveryStore store) {
    start(() async {
      try {
        await store.update(client);
      } catch (_) {
        /* 이전 상태 유지 — 화면 번역은 깨지지 않는다 */
      }
    });
  }

  /// 구독 중단(백그라운드 전환·로그아웃). 붙잡고 있던 스트림을 끊는다.
  void stop() {
    _stopped = true;
    unawaited(_iterator?.cancel());
    _iterator = null;
  }
}

String _trimTrailing(String s) => s.replaceAll(RegExp(r'/+$'), '');
String _trimSlashes(String s) => s.replaceAll(RegExp(r'^/+|/+$'), '');
