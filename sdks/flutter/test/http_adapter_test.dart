/// `package:http` 어댑터(Flutter Web 경로) — 기획서 6.4.
///
/// 브라우저 자체는 여기서 띄우지 않는다(그건 `package:http`의 백엔드 선택 책임이다). 대신
/// **어댑터가 계약을 지키는지**를 VM에서 검증한다 — 조건부 요청 헤더를 실어 보내고, 응답의
/// status·body·etag를 [DeliveryResponse]로 정확히 옮기는지. 그 위의 갱신 사이클은 io 어댑터와
/// 같은 코어를 타므로 `delivery_test.dart`가 이미 덮는다.
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:rynl10n/rynl10n.dart';
import 'package:rynl10n/rynl10n_http.dart';
import 'package:test/test.dart';

const snap0 = {
  'schemaVersion': 1,
  'release': 'R1',
  'base': 'base0',
  'defaultLocale': 'en',
  'locales': {
    'en': {'greet': 'Hello'}
  },
};
const delta01 = {
  'release': 'R1',
  'from': 'base0',
  'to': 'base1',
  'ops': [
    {'op': 'set', 'key': 'greet', 'locale': 'en', 'value': 'Hi'}
  ],
};
const manifestJson = {
  'project': 'shop',
  'defaultLocale': 'en',
  'releases': [
    {
      'id': 'R1',
      'state': 'published',
      'versionMatch': {'strategy': 'semver-range', 'value': '>=1.0.0'},
      'base': 'base0',
      'overlay': 'base1',
      'rollout': 100,
      'snapshot': 'releases/R1/snapshot-base0.json',
      'delta': 'releases/R1/delta-base0-base1.json',
    }
  ],
};

void main() {
  late HttpServer server;
  late String endpoint;
  final seenIfNoneMatch = <String?>[];

  const etag = '"m1"';

  setUpAll(() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    endpoint = 'http://127.0.0.1:${server.port}';
    server.listen((request) async {
      final res = request.response;
      final path = request.uri.path;
      if (path == '/shop/manifest.json') {
        final inm = request.headers.value(HttpHeaders.ifNoneMatchHeader);
        seenIfNoneMatch.add(inm);
        // 배포 플레인 참조 서버와 같은 거동(ETag + 조건부 304 + CORS 노출).
        res.headers.set('access-control-expose-headers', 'ETag');
        res.headers.set(HttpHeaders.etagHeader, etag);
        if (inm == etag) {
          res.statusCode = 304;
          await res.close();
          return;
        }
        res.statusCode = 200;
        res.write(jsonEncode(manifestJson));
        await res.close();
        return;
      }
      final body = {
        '/shop/releases/R1/snapshot-base0.json': jsonEncode(snap0),
        '/shop/releases/R1/delta-base0-base1.json': jsonEncode(delta01),
      }[path];
      if (body == null) {
        res.statusCode = 404;
      } else {
        res.statusCode = 200;
        res.write(body);
      }
      await res.close();
    });
  });

  tearDownAll(() async => server.close(force: true));
  setUp(seenIfNoneMatch.clear);

  RynL10nClient clientFor(RemoteDeliveryStore store) => RynL10nClient(
        bundle: Snapshot.fromJson(snap0),
        store: store,
        context: ClientContext(appVersion: '1.0.0'),
      );

  test('httpDeliveryFetch: 갱신 사이클이 끝까지 돈다', () async {
    final store = RemoteDeliveryStore(
      baseUrl: endpoint,
      project: 'shop',
      fetch: httpDeliveryFetch(),
    );
    final client = clientFor(store);
    expect(client.t('greet'), 'Hello');
    expect(await store.update(client), true);
    expect(client.t('greet'), 'Hi');
  });

  test('httpDeliveryFetch: ETag를 읽어 조건부 요청을 보낸다', () async {
    final store = RemoteDeliveryStore(
      baseUrl: endpoint,
      project: 'shop',
      fetch: httpDeliveryFetch(),
    );
    final client = clientFor(store);
    await store.update(client);
    await store.update(client);
    // 1회차는 조건부 없이, 2회차는 받은 ETag를 실어 보낸다 → 서버가 304로 답한다.
    expect(seenIfNoneMatch, [null, etag]);
  });

  test('httpDeliveryFetch: 주입한 client를 그대로 쓴다', () async {
    var used = 0;
    final counting = _CountingClient(() => used++);
    final store = RemoteDeliveryStore(
      baseUrl: endpoint,
      project: 'shop',
      fetch: httpDeliveryFetch(client: counting),
    );
    await store.update(clientFor(store));
    expect(used, greaterThan(0));
    counting.close();
  });

  test('httpDeliveryFetch: 서버가 없으면 던진다(코어가 캐시/번들로 강등)', () async {
    final store = RemoteDeliveryStore(
      baseUrl: 'http://127.0.0.1:1', // 닫힌 포트
      project: 'shop',
      fetch: httpDeliveryFetch(timeout: const Duration(seconds: 2)),
    );
    final client = clientFor(store);
    await expectLater(
      () => store.update(client),
      throwsA(isA<DeliveryException>().having((e) => e.kind, 'kind', DeliveryErrorKind.unavailable)),
    );
    expect(client.t('greet'), 'Hello'); // 화면은 번들 fallback으로 멀쩡하다
  });

  group('CallbackArtifactCache', () {
    test('앱이 준 저장소로 오프라인 재진입까지 이어진다', () async {
      final backing = <String, String>{};
      cacheOf() => CallbackArtifactCache(
            read: (k) => backing[k],
            write: (k, v) => backing[k] = v,
            clear: backing.clear,
          );

      final warm = RemoteDeliveryStore(
        baseUrl: endpoint, project: 'shop', fetch: httpDeliveryFetch(), cache: cacheOf(),
      );
      expect(await warm.update(clientFor(warm)), true);
      expect(backing, isNotEmpty);

      // 오프라인 재진입 — 같은 저장소를 물려받은 새 스토어.
      final cold = RemoteDeliveryStore(
        baseUrl: 'http://127.0.0.1:1', project: 'shop',
        fetch: httpDeliveryFetch(timeout: const Duration(seconds: 2)), cache: cacheOf(),
      );
      final client = clientFor(cold);
      expect(await cold.update(client), true, reason: '캐시된 manifest+델타로 복원돼야 한다');
      expect(client.t('greet'), 'Hi');
    });

    test('저장소가 던져도 삼키고 계속 진행한다(사생활 모드·용량 초과)', () {
      final cache = CallbackArtifactCache(
        read: (_) => throw StateError('locked'),
        write: (_, __) => throw StateError('quota exceeded'),
        clear: () => throw StateError('denied'),
      );
      expect(cache.read('manifest'), isNull);
      expect(() => cache.write('manifest', '{}'), returnsNormally);
      expect(cache.clear, returnsNormally);
    });
  });
}

/// `get` 호출 수만 세는 얇은 래퍼 — 주입 경로가 실제로 쓰이는지 확인한다.
class _CountingClient extends http.BaseClient {
  final void Function() _onSend;
  final http.Client _inner = http.Client();
  _CountingClient(this._onSend);

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    _onSend();
    return _inner.send(request);
  }

  @override
  void close() => _inner.close();
}
