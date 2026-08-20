/// 익명 집계 텔레메트리 전송(옵트인) — 기획서 9.3, 카나리 판정(8.4)의 입력.
/// iOS·Android `TelemetryReporter`와 동작 대칭.
///
/// 클라이언트가 모으는 것은 4종 카운트뿐이고([TelemetryCounts]), 이 모듈은 그것을 관리 플레인의
/// `POST /projects/{p}/telemetry` 한 곳으로 보낸다. 본문 필드는 서버가 정의한 5개가 전부다
/// (`projectId`·`releaseId`·`event`·`count`·`appVersionBucket`) — **그 외 필드는 서버가 거부하므로**
/// 키 이름·번역 값·기기 식별자는 구조적으로 나갈 수 없다(프라이버시 가드).
/// 카나리 버킷의 `installId`도 포함되지 않는다(기기 로컬 값, 8.4).
///
/// 옵트인은 두 겹이다: 수집은 `RynL10nClient(telemetry: 'aggregate')`, 전송은 이 리포터를 만들어야 한다.
/// HTTP는 코어가 모르므로 주입받는다 — 기본 어댑터는 `ioTelemetryPost()` · `httpTelemetryPost()`.
library;

import 'dart:async';
import 'dart:convert';

import 'client.dart';

/// 본문을 POST하고 상태 코드를 돌려주는 함수. 실패(오프라인)는 **던져서** 알린다.
typedef TelemetryPost = Future<int> Function(String url, String body);

/// 서버 스키마(9.3) 그대로의 이벤트 1건. 필드가 더 늘면 서버가 배치를 거부한다.
class TelemetryEvent {
  final String projectId;
  final String releaseId;
  final String event;
  final int count;
  final String appVersionBucket;

  const TelemetryEvent({
    required this.projectId,
    required this.releaseId,
    required this.event,
    required this.count,
    required this.appVersionBucket,
  });

  Map<String, Object> toJson() => {
        'projectId': projectId,
        'releaseId': releaseId,
        'event': event,
        'count': count,
        'appVersionBucket': appVersionBucket,
      };
}

/// 카운트 → 서버 이벤트 배치. 0인 이벤트는 보내지 않는다(빈 행으로 집계를 부풀리지 않기 위해).
List<TelemetryEvent> telemetryEvents(
  TelemetryCounts counts, {
  required String projectId,
  required String releaseId,
  required String bucket,
}) {
  final pairs = <String, int>{
    'overlay_applied': counts.overlayApplied,
    'format_guard_rejected': counts.formatGuardRejected,
    'key_unresolved': counts.keyUnresolved,
    'delta_failed': counts.deltaFailed,
  };
  return [
    for (final entry in pairs.entries)
      if (entry.value > 0)
        TelemetryEvent(
          projectId: projectId,
          releaseId: releaseId,
          event: entry.key,
          count: entry.value,
          appVersionBucket: bucket,
        ),
  ];
}

/// 앱 버전군 라벨(`3.2.1` → `3.2`). 개별 빌드가 아니라 **군**이라야 익명 집계로 남는다.
/// 관측성 탭의 "릴리스 × 앱 버전군" 표가 이 라벨을 그대로 쓴다.
String versionBucket(String? appVersion) {
  if (appVersion == null || appVersion.isEmpty) return 'unknown';
  final parts = appVersion.split('.');
  return parts.length >= 2 ? '${parts[0]}.${parts[1]}' : parts[0];
}

class TelemetryReporter {
  final String _url;
  final String _project;
  final TelemetryPost _post;
  Timer? _timer;

  /// [endpoint]는 관리 플레인 루트(로컬 셀프호스트는 `http://localhost:8787`).
  /// 읽기가 아니라 쓰기(집계 업로드) 경로라 배포 플레인이 아니다.
  TelemetryReporter({
    required String endpoint,
    required String project,
    required TelemetryPost post,
  })  : _url = '${_trimTrailing(endpoint)}/projects/${_trimSlashes(project)}/telemetry',
        _project = _trimSlashes(project),
        _post = post;

  /// 누적 카운트를 비우고 한 번 전송한다.
  ///
  /// 전송에 실패하면 드레인한 카운트를 **되돌려** 다음 주기에 다시 시도한다 — 그러지 않으면
  /// 네트워크가 끊긴 구간의 거부율이 통째로 사라져 카나리 판정(8.4)이 실제보다 건강해 보인다.
  /// 서버가 수용했으면 true. 보낼 것이 없어도 true(할 일 없음).
  Future<bool> flush(RynL10nClient client) async {
    // 릴리스가 정해지기 전(번들만)에는 귀속시킬 릴리스가 없다 → 드레인하지 않고 다음 기회로 미룬다.
    final releaseId = client.releaseId;
    if (releaseId == null) return true;

    final counts = client.drainTelemetry();
    final events = telemetryEvents(
      counts,
      projectId: _project,
      releaseId: releaseId,
      bucket: versionBucket(client.context.appVersion),
    );
    if (events.isEmpty) return true;

    final body = jsonEncode([for (final e in events) e.toJson()]);
    try {
      final status = await _post(_url, body);
      if (status != 200) {
        client.mergeTelemetry(counts);
        return false;
      }
      return true;
    } catch (_) {
      client.mergeTelemetry(counts);
      return false;
    }
  }

  /// 주기 전송 시작(기본 5분). 첫 전송은 한 주기 뒤다 — 부팅 직후엔 보낼 것이 거의 없다.
  /// 백그라운드 전환처럼 마지막 카운트를 확실히 올리고 싶은 시점에는 [flush]를 직접 부른다.
  void start(RynL10nClient client, {Duration interval = const Duration(minutes: 5)}) {
    stop();
    _timer = Timer.periodic(interval, (_) => unawaited(flush(client)));
  }

  /// 주기 전송 중단. 아직 안 보낸 카운트는 클라이언트에 남는다(다음 [flush]에서 함께 나간다).
  void stop() {
    _timer?.cancel();
    _timer = null;
  }
}

String _trimTrailing(String s) => s.replaceAll(RegExp(r'/+$'), '');
String _trimSlashes(String s) => s.replaceAll(RegExp(r'^/+|/+$'), '');
