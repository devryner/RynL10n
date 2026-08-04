/// 앱 적용 경로 — 배포 플레인 HTTP + 영속 캐시 + 번들 로더 (기획서 6.3 / 6.4).
/// 시나리오는 iOS `RemoteDeliveryTests` · Android `RemoteDeliveryTest` · Web `delivery.test.ts`와
/// 1:1로 맞춰 두었다(같은 계약을 4개 플랫폼이 같은 방식으로 지키는지 확인하는 자리다).
import 'dart:convert';
import 'dart:io';

import 'package:rynl10n/rynl10n.dart';
import 'package:rynl10n/rynl10n_io.dart';
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
const snap2 = {
  'schemaVersion': 1,
  'release': 'R2',
  'base': 'base2',
  'defaultLocale': 'en',
  'locales': {
    'en': {'greet': 'Howdy'}
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
const lockfile = {
  'schemaVersion': 1,
  'release': 'R1',
  'base': 'base0',
  'keyCount': 1,
  'locales': ['en'],
};

const snap0Path = 'releases/R1/snapshot-base0.json';
const delta01Path = 'releases/R1/delta-base0-base1.json';
const snap2Path = 'releases/R2/snapshot-base2.json';

/// base==번들 → 스냅샷은 이미 손에 있고 델타만 받으면 되는 형태.
const overlayManifest = {
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
      'snapshot': snap0Path,
      'delta': delta01Path,
    }
  ],
};

/// base!=번들 → 스냅샷을 새로 내려받아야 하는 형태.
const newBaseManifest = {
  'project': 'shop',
  'defaultLocale': 'en',
  'releases': [
    {
      'id': 'R2',
      'state': 'published',
      'versionMatch': {'strategy': 'semver-range', 'value': '>=1.0.0'},
      'base': 'base2',
      'overlay': 'base2',
      'rollout': 100,
      'snapshot': snap2Path,
    }
  ],
};

/// 스냅샷 경로가 서버에 없는(404) 형태.
const missingSnapshotManifest = {
  'project': 'shop',
  'defaultLocale': 'en',
  'releases': [
    {
      'id': 'R9',
      'state': 'published',
      'versionMatch': {'strategy': 'semver-range', 'value': '>=1.0.0'},
      'base': 'gone',
      'overlay': 'gone',
      'rollout': 100,
      'snapshot': 'releases/R9/snapshot-gone.json',
    }
  ],
};

Snapshot bundle() => Snapshot.fromJson(snap0);

void main() {
  late HttpServer server;
  late String endpoint;
  late Directory tmp;

  // 테스트마다 갈아끼우는 서버 거동.
  Map manifest = overlayManifest;
  String manifestEtag = 'm1';
  int manifestStatus = 200;
  String? manifestBodyOverride;
  final requested = <String>[];

  final files = <String, String>{
    '/shop/$snap0Path': jsonEncode(snap0),
    '/shop/$delta01Path': jsonEncode(delta01),
    '/shop/$snap2Path': jsonEncode(snap2),
  };

  void resetServer() {
    manifest = overlayManifest;
    manifestEtag = 'm1';
    manifestStatus = 200;
    manifestBodyOverride = null;
    requested.clear();
  }

  setUpAll(() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    endpoint = 'http://127.0.0.1:${server.port}';
    server.listen((request) async {
      final path = request.uri.path;
      requested.add(path);
      final res = request.response;
      if (path == '/shop/manifest.json') {
        if (manifestStatus != 200) {
          res.statusCode = manifestStatus;
          await res.close();
          return;
        }
        if (request.headers.value(HttpHeaders.ifNoneMatchHeader) == manifestEtag) {
          res.statusCode = 304;
          await res.close();
          return;
        }
        res.statusCode = 200;
        res.headers.set(HttpHeaders.etagHeader, manifestEtag);
        res.write(manifestBodyOverride ?? jsonEncode(manifest));
        await res.close();
        return;
      }
      final body = files[path];
      if (body != null) {
        res.statusCode = 200;
        res.write(body);
      } else {
        res.statusCode = 404;
      }
      await res.close();
    });
  });

  tearDownAll(() async => server.close(force: true));

  setUp(() {
    resetServer();
    tmp = Directory.systemTemp.createTempSync('rynl10n-delivery');
  });
  tearDown(() {
    if (tmp.existsSync()) tmp.deleteSync(recursive: true);
  });

  RemoteDeliveryStore storeWith({DeliveryFetch? fetch, ArtifactCache? cache}) => RemoteDeliveryStore(
        baseUrl: endpoint,
        project: 'shop',
        fetch: fetch ?? ioDeliveryFetch(),
        cache: cache ?? MemoryArtifactCache(),
      );

  RynL10nClient clientWith(RemoteDeliveryStore store, {String appVersion = '1.0.0'}) => RynL10nClient(
        bundle: bundle(),
        store: store,
        context: ClientContext(appVersion: appVersion),
      );

  /// 항상 실패하는 fetch — 오프라인 시뮬레이션.
  DeliveryFetch offlineFetch(List<int> calls) => (String url, {String? ifNoneMatch}) async {
        calls.add(1);
        throw const SocketException('network down');
      };

  test('update: 델타를 받아 오버레이를 적용한다', () async {
    final store = storeWith();
    final client = clientWith(store);
    expect(client.t('greet'), 'Hello');
    expect(await store.update(client), true);
    expect(client.t('greet'), 'Hi');
    expect(client.releaseId, 'R1');
  });

  test('update: base가 다르면 스냅샷을 내려받는다', () async {
    manifest = newBaseManifest;
    manifestEtag = 'm-newbase';
    final store = storeWith();
    final client = clientWith(store);
    expect(await store.update(client), true);
    expect(client.t('greet'), 'Howdy');
    expect(requested, contains('/shop/$snap2Path'));
  });

  test('update: 매칭 릴리스가 없으면 번들만 쓰고 아무것도 받지 않는다', () async {
    final store = storeWith();
    final client = clientWith(store, appVersion: '0.9.0');
    await store.update(client);
    expect(client.t('greet'), 'Hello');
    expect(requested, ['/shop/manifest.json']); // 산출물 요청 0건
  });

  test('update: 불변 산출물은 두 번 받지 않는다', () async {
    final store = storeWith();
    final client = clientWith(store);
    await store.update(client);
    await store.update(client);
    expect(requested.where((p) => p == '/shop/$delta01Path').length, 1,
        reason: '내용해시 URL이라 재요청할 이유가 없다');
  });

  test('loadManifest: ETag 304면 캐시본을 쓴다', () async {
    final store = storeWith();
    final client = clientWith(store);
    expect(await store.update(client), true);
    expect(await store.update(client), false); // If-None-Match → 304 → 변경 없음
    expect(client.t('greet'), 'Hi');
  });

  test('영속 캐시: 새 스토어가 네트워크 없이 마지막 카탈로그를 이어받는다', () async {
    final cache = FileArtifactCache(tmp, project: 'shop');
    final warm = storeWith(cache: cache);
    expect(await warm.update(clientWith(warm)), true);

    final calls = <int>[];
    final cold = storeWith(fetch: offlineFetch(calls), cache: FileArtifactCache(tmp, project: 'shop'));
    final client = clientWith(cold);
    expect(await cold.update(client), true, reason: '캐시된 manifest+델타만으로 오버레이가 복원돼야 한다');
    expect(client.t('greet'), 'Hi');
    expect(calls.length, 1, reason: 'manifest 재검증 1회뿐 — 산출물은 캐시에서 온다');
  });

  test('update: 네트워크가 끊겨도 마지막 캐시로 진행한다', () async {
    final cache = MemoryArtifactCache();
    final online = storeWith(cache: cache);
    await online.update(clientWith(online));

    final offline = storeWith(fetch: offlineFetch(<int>[]), cache: cache);
    final cached = await offline.loadManifest(); // 던지지 않고 캐시본
    expect(cached.releases.first.id, 'R1');
  });

  test('update: 캐시도 네트워크도 없으면 unavailable을 던진다', () async {
    final store = storeWith(fetch: offlineFetch(<int>[]));
    expect(
      () => store.loadManifest(),
      throwsA(isA<DeliveryException>().having((e) => e.kind, 'kind', DeliveryErrorKind.unavailable)),
    );
  });

  test('update: 실패해도 화면의 번역은 깨지지 않는다', () async {
    final store = storeWith(fetch: offlineFetch(<int>[]));
    final client = clientWith(store);
    await expectLater(() => store.update(client), throwsA(isA<DeliveryException>()));
    expect(client.t('greet'), 'Hello'); // 번들 fallback
  });

  test('loadManifest: 2xx가 아니고 캐시도 없으면 bad-status를 던진다', () async {
    manifestStatus = 503;
    final store = storeWith();
    expect(
      () => store.loadManifest(),
      throwsA(isA<DeliveryException>()
          .having((e) => e.kind, 'kind', DeliveryErrorKind.badStatus)
          .having((e) => e.status, 'status', 503)),
    );
  });

  test('loadManifest: 본문이 manifest가 아니면 malformed를 던진다', () async {
    manifestBodyOverride = '{ not json';
    final store = storeWith();
    expect(
      () => store.loadManifest(),
      throwsA(isA<DeliveryException>().having((e) => e.kind, 'kind', DeliveryErrorKind.malformed)),
    );
  });

  test('스냅샷 경로가 404여도 번들로 계속 동작한다', () async {
    manifest = missingSnapshotManifest;
    manifestEtag = 'm-404';
    final store = storeWith();
    final client = clientWith(store);
    await expectLater(() => store.update(client), throwsA(isA<DeliveryException>()));
    expect(client.t('greet'), 'Hello'); // 그래도 화면은 멀쩡하다
  });

  test('clearCache 이후에는 다시 받는다', () async {
    final store = storeWith(cache: FileArtifactCache(tmp, project: 'shop'));
    final client = clientWith(store);
    await store.update(client);
    store.clearCache();
    await store.update(client);
    expect(requested.where((p) => p == '/shop/$delta01Path').length, 2);
  });

  group('번들 로더', () {
    test('parseBakedSnapshot: 텍스트를 검증해 읽는다', () {
      expect(parseBakedSnapshot(jsonEncode(snap0)).base, 'base0');
      expect(() => parseBakedSnapshot('{ not json'), throwsA(isA<BakedException>()));
      expect(() => parseBakedSnapshot('{"nope":true}'), throwsA(isA<BakedException>()));
    });

    test('loadBakedSnapshot: stable-name 산출물을 로드한다', () {
      Directory('${tmp.path}/rynl10n').createSync(recursive: true);
      File('${tmp.path}/rynl10n/snapshot.json').writeAsStringSync(jsonEncode(snap0));
      expect(loadBakedSnapshot(tmp).base, 'base0');
    });

    test('loadBakedSnapshot: 내용해시 파일명도 로드한다', () {
      File('${tmp.path}/snapshot-base0.json').writeAsStringSync(jsonEncode(snap0));
      expect(loadBakedSnapshot(tmp).base, 'base0');
    });

    test('loadBakedSnapshot: 산출물이 없으면 안내 메시지와 함께 실패한다', () {
      expect(
        () => loadBakedSnapshot(tmp),
        throwsA(isA<BakedException>().having((e) => e.message, 'message', contains('rynl10n-bake'))),
      );
    });

    test('lockfile을 판독하고, 없으면 null이다', () {
      expect(loadBakedLockfile(tmp), isNull);
      Directory('${tmp.path}/rynl10n').createSync(recursive: true);
      File('${tmp.path}/rynl10n/rynl10n.lock').writeAsStringSync(jsonEncode(lockfile));
      final lock = loadBakedLockfile(tmp);
      expect(lock?.release, 'R1');
      expect(lock?.base, 'base0');
    });

    test('로드한 번들로 클라이언트가 바로 조회한다', () async {
      Directory('${tmp.path}/rynl10n').createSync(recursive: true);
      File('${tmp.path}/rynl10n/snapshot.json').writeAsStringSync(jsonEncode(snap0));
      final store = storeWith();
      final client = RynL10nClient(
        bundle: loadBakedSnapshot(tmp),
        store: store,
        context: ClientContext(appVersion: '1.0.0'),
      );
      expect(client.t('greet'), 'Hello');
      expect(await store.update(client), true);
      expect(client.t('greet'), 'Hi');
    });
  });
}
