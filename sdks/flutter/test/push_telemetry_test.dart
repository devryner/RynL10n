/// 주기 폴링(6.4) · 실시간 푸시 신호(4.1/M4) · 익명 집계 텔레메트리 전송(9.3) 검증.
/// iOS `PushTelemetryTests` · Android `PushTelemetryTest` · Web `telemetry.test.ts`와 같은 축을 본다.
/// 네트워크는 `dart:io` [HttpServer]로 **실제 스택**을 지난다(io 어댑터까지 함께 검증된다).
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:rynl10n/rynl10n.dart';
import 'package:rynl10n/rynl10n_io.dart';
import 'package:test/test.dart';

const bundleJson = {
  'schemaVersion': 1,
  'release': 'R42',
  'base': 'b0',
  'defaultLocale': 'en',
  'locales': {
    'en': {'pay.button': 'Pay'}
  },
};

const manifestJson = {
  'schemaVersion': 1,
  'project': 'demo',
  'defaultLocale': 'en',
  'updatedAt': '2026-08-20T00:00:00Z',
  'releases': [
    {
      'id': 'R42',
      'state': 'published',
      'versionMatch': {'strategy': 'semver-range', 'value': '>=1.0.0 <2.0.0'},
      'base': 'b0',
      'overlay': 'b0',
      'rollout': 100,
      'snapshot': 'releases/R42/snapshot-b0.json',
      'delta': null,
    }
  ],
};

void main() {
  late HttpServer server;
  late String endpoint;

  final requested = <String>[];
  final posted = <String>[];
  String? sseBody;
  int telemetryStatus = 200;

  Snapshot bundle() => Snapshot.fromJson(bundleJson);
  Manifest manifest() => Manifest.fromJson(manifestJson);

  RemoteDeliveryStore makeStore() => RemoteDeliveryStore(
        baseUrl: endpoint,
        project: 'demo',
        fetch: ioDeliveryFetch(),
      );

  /// 릴리스가 정해진 클라이언트 + 미해결 키 1건.
  RynL10nClient reportingClient({String telemetry = 'aggregate', String appVersion = '1.2.3'}) {
    final client = RynL10nClient(
      bundle: bundle(),
      store: InMemoryDeliveryStore(),
      context: ClientContext(appVersion: appVersion),
      telemetry: telemetry,
    );
    client.refresh(manifest());
    client.t('missing.key');
    return client;
  }

  setUpAll(() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    endpoint = 'http://127.0.0.1:${server.port}';
    server.listen((request) async {
      final path = request.uri.path;
      requested.add(path);

      if (request.method == 'POST') {
        posted.add(await utf8.decoder.bind(request).join());
        request.response.statusCode = telemetryStatus;
        request.response.write('{"accepted":1,"rejected":0}');
        await request.response.close();
        return;
      }
      if (path.endsWith('/events')) {
        final body = sseBody;
        if (body == null) {
          request.response.statusCode = 404;
          await request.response.close();
          return;
        }
        request.response.headers.contentType = ContentType('text', 'event-stream');
        // 청크를 일부러 줄 중간에서 끊어 보낸다 — 파서가 버퍼링하는지 확인하는 자리다.
        final half = body.length ~/ 3;
        request.response.write(body.substring(0, half));
        await request.response.flush();
        request.response.write(body.substring(half));
        await request.response.close();
        return;
      }
      if (path == '/demo/manifest.json') {
        request.response.headers.contentType = ContentType.json;
        request.response.write(jsonEncode(manifestJson));
        await request.response.close();
        return;
      }
      request.response.statusCode = 404;
      await request.response.close();
    });
  });

  tearDownAll(() async => server.close(force: true));

  setUp(() {
    requested.clear();
    posted.clear();
    sseBody = null;
    telemetryStatus = 200;
  });

  // --- 주기 폴링 ---

  test('주기 폴링은 간격마다 갱신하고 stop이 확실히 멈춘다', () async {
    final store = makeStore();
    final client = RynL10nClient(
      bundle: bundle(),
      store: store,
      context: ClientContext(appVersion: '1.2.3'),
    );

    var cycles = 0;
    store.startPolling(client, interval: const Duration(milliseconds: 50), onUpdate: (_) => cycles++);
    while (cycles < 2) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }

    store.stopPolling();
    // 중단 시점에 이미 나가 있던 사이클 하나는 착지할 수 있다. 계약은 **새 주기를 더 잡지 않는다**이지
    // "진행 중인 요청이 사라진다"가 아니므로, 드레인한 뒤에 스냅샷을 찍어야 그 착지가 실패로 둔갑하지
    // 않는다(스냅샷을 즉시 찍으면 느린 CI에서 실제로 그렇게 됐다).
    await Future<void>.delayed(const Duration(milliseconds: 300));
    final afterStop = requested.where((p) => p == '/demo/manifest.json').length;
    await Future<void>.delayed(const Duration(milliseconds: 300)); // 간격 6회분
    expect(requested.where((p) => p == '/demo/manifest.json').length, afterStop,
        reason: 'stopPolling 이후 새 주기가 잡히면 안 된다');
    expect(afterStop, greaterThanOrEqualTo(2), reason: '멈추기 전에 주기가 실제로 돌았다');
    expect(client.releaseId, 'R42', reason: '폴링이 실제 갱신 사이클을 돌린다');
  });

  // --- 실시간 푸시 신호(SSE) ---

  test('manifest 프레임만 신호로 센다 (청크가 줄 중간에서 끊겨도)', () async {
    sseBody = 'retry: 3000\n\n'
        'event: manifest\ndata: {"seq":1}\n\n'
        'event: something-else\ndata: {}\n\n'
        'event: manifest\ndata: {"seq":2}\n\n';
    final channel = ServerPushChannel(endpoint: endpoint, project: 'demo', connect: ioPushConnect());

    var seen = 0;
    expect(await channel.receive(() async => seen++), 2);
    expect(seen, 2, reason: 'manifest 프레임 수만큼 갱신이 트리거돼야 한다');
  });

  test('신호를 받으면 배포 플레인에서 갱신한다', () async {
    sseBody = 'event: manifest\ndata: {"seq":1}\n\n';
    final store = makeStore();
    final client = RynL10nClient(
      bundle: bundle(),
      store: store,
      context: ClientContext(appVersion: '1.2.3'),
    );
    final channel = ServerPushChannel(endpoint: endpoint, project: 'demo', connect: ioPushConnect());

    await channel.receive(() async => store.update(client));

    expect(client.releaseId, 'R42');
    // 신호 자체는 데이터를 나르지 않는다 — 번역은 배포 플레인에서 받아 온다(4.1).
    expect(requested, contains('/demo/manifest.json'));
  });

  test('알림 플레인이 없으면 badStatus', () async {
    final channel = ServerPushChannel(endpoint: endpoint, project: 'demo', connect: ioPushConnect());
    await expectLater(
      channel.receive(() async {}),
      throwsA(isA<PushException>()
          .having((e) => e.kind, 'kind', PushErrorKind.badStatus)
          .having((e) => e.status, 'status', 404)),
    );
  });

  // --- 텔레메트리 전송(9.3) ---

  test('익명 집계만 5개 필드로 올린다', () async {
    final client = reportingClient();
    final reporter = TelemetryReporter(endpoint: endpoint, project: 'demo', post: ioTelemetryPost());

    expect(await reporter.flush(client), isTrue);
    expect(posted, hasLength(1));

    final batch = jsonDecode(posted.first) as List;
    expect(batch, hasLength(1), reason: '0인 이벤트는 보내지 않는다');
    final event = batch.first as Map;
    expect(event.keys.toSet(), {'projectId', 'releaseId', 'event', 'count', 'appVersionBucket'},
        reason: '서버의 프라이버시 가드가 거부하는 필드가 하나라도 있으면 배치 전체가 버려진다');
    expect(event['event'], 'key_unresolved');
    expect(event['releaseId'], 'R42');
    expect(event['count'], 1);
    expect(event['appVersionBucket'], '1.2', reason: '개별 빌드가 아니라 버전군이어야 익명이다');
    expect(posted.first.contains('missing.key'), isFalse, reason: '키 이름은 실리지 않는다');

    expect(client.drainTelemetry().keyUnresolved, 0, reason: '성공하면 카운트는 비워진다');
  });

  test('전송 실패면 카운트를 되돌린다', () async {
    telemetryStatus = 500;
    final client = reportingClient();
    final reporter = TelemetryReporter(endpoint: endpoint, project: 'demo', post: ioTelemetryPost());

    expect(await reporter.flush(client), isFalse);
    expect(client.drainTelemetry().keyUnresolved, 1,
        reason: '실패 구간이 사라지면 카나리 판정(8.4)이 실제보다 건강해 보인다');
  });

  test('릴리스가 없으면 드레인하지 않고, 수집이 off면 보낼 것이 없다', () async {
    // ① 번들만 쓰는 상태(매칭 릴리스 없음) → 귀속시킬 릴리스가 없다.
    final bundleOnly = RynL10nClient(
      bundle: bundle(),
      store: InMemoryDeliveryStore(),
      context: ClientContext(appVersion: '9.9.9'),
      telemetry: 'aggregate',
    );
    bundleOnly.refresh(manifest());
    bundleOnly.t('missing.key');
    final reporter = TelemetryReporter(endpoint: endpoint, project: 'demo', post: ioTelemetryPost());

    expect(await reporter.flush(bundleOnly), isTrue);
    expect(posted, isEmpty);
    expect(bundleOnly.drainTelemetry().keyUnresolved, 1, reason: '다음 기회에 릴리스와 함께 나가야 한다');

    // ② 수집 옵트인이 아니면 카운트 자체가 0이라 네트워크로 아무것도 나가지 않는다.
    expect(await reporter.flush(reportingClient(telemetry: 'off')), isTrue);
    expect(posted, isEmpty);
  });

  test('앱 버전군 라벨', () {
    expect(versionBucket('3.2.1'), '3.2');
    expect(versionBucket('3.2.1-beta.4'), '3.2');
    expect(versionBucket('4'), '4');
    expect(versionBucket(null), 'unknown');
    expect(versionBucket(''), 'unknown');
  });
}
