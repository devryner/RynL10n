/// 배포 플레인(CDN/오브젝트 스토리지) 참조 구현 — 기획서 4.1 / 6.4 / 7.2.
///
/// **관리 API는 절대 호출하지 않는다.** 읽는 것은 정적 파일 세 종류뿐이다(11.2):
/// ```
/// {baseUrl}/{project}/manifest.json                            짧은 TTL + ETag
/// {baseUrl}/{project}/releases/{r}/snapshot-{hash}.json        불변 → 영구 캐시
/// {baseUrl}/{project}/releases/{r}/delta-{base}-{target}.json  불변 → 영구 캐시
/// ```
///
/// [DeliveryStore]는 동기 인터페이스다(`refresh(manifest)`가 동기라 화면이 절대 네트워크를 기다리지
/// 않는다). 그래서 이 타입은 **비동기 다운로드와 동기 조회를 분리**한다 — [RemoteDeliveryStore.update]가
/// 필요한 산출물을 먼저 캐시에 채운 뒤 `refresh`를 호출하고, 인터페이스 메서드는 캐시만 들여다본다.
///
/// **HTTP와 저장소를 주입받는다**(`dart:io` 직접 의존 없음). 기본 어댑터는 `rynl10n_io.dart`에 있고
/// (`ioDeliveryFetch()` + `FileArtifactCache`), Flutter Web처럼 `dart:io`가 없는 타깃은
/// `package:http` 등으로 [DeliveryFetch]만 채워 넣으면 나머지 동작은 동일하다.
import 'dart:async';
import 'dart:convert';

import 'client.dart';
import 'matching.dart';
import 'types.dart';

/// 배포 플레인 응답(상태·본문·ETag)만 담은 최소 형태.
class DeliveryResponse {
  final int status;
  final String body;
  final String? etag;
  const DeliveryResponse(this.status, this.body, {this.etag});
}

/// 정적 파일 한 개를 가져오는 함수. 실패(오프라인·타임아웃)는 **던져서** 알린다.
typedef DeliveryFetch = Future<DeliveryResponse> Function(String url, {String? ifNoneMatch});

/// 산출물·manifest 영속 저장소. 이름은 캐시 내부 키다(경로가 아니다).
abstract class ArtifactCache {
  String? read(String name);
  void write(String name, String text);
  void clear();
}

/// 메모리 캐시 — 저장소가 없는 타깃·테스트용. 프로세스 수명과 함께 사라진다.
class MemoryArtifactCache implements ArtifactCache {
  final Map<String, String> _entries = {};
  @override
  String? read(String name) => _entries[name];
  @override
  void write(String name, String text) => _entries[name] = text;
  @override
  void clear() => _entries.clear();
}

/// 앱이 이미 쓰는 키-값 저장소를 [ArtifactCache]로 감싼다 — **SDK가 저장소 패키지를 고르지
/// 않기 위한 이음새**다. 웹은 `package:web`의 `window.localStorage`, 모바일은
/// `shared_preferences`, 서버는 파일… 무엇이든 세 개의 클로저로 꽂으면 된다.
///
/// ```dart
/// import 'package:web/web.dart' as web;
///
/// final cache = CallbackArtifactCache(
///   read: (k) => web.window.localStorage.getItem('rynl10n:shop:$k'),
///   write: (k, v) => web.window.localStorage.setItem('rynl10n:shop:$k', v),
///   clear: () => web.window.localStorage.clear(),
/// );
/// ```
///
/// 저장소가 던지는 실패(사생활 모드·용량 초과·권한)는 **조용히 삼킨다** — 캐시는 가속일 뿐이고
/// 번들 fallback이 항상 살아 있어 번역 공백이 생기지 않는다(3.1). `dart:io`·`package:web`에
/// 의존하지 않으므로 이 클래스는 코어에 있다.
class CallbackArtifactCache implements ArtifactCache {
  final String? Function(String name) _read;
  final void Function(String name, String text) _write;
  final void Function() _clear;

  CallbackArtifactCache({
    required String? Function(String name) read,
    required void Function(String name, String text) write,
    required void Function() clear,
  })  : _read = read,
        _write = write,
        _clear = clear;

  @override
  String? read(String name) {
    try {
      return _read(name);
    } catch (_) {
      return null; // 읽기 실패는 캐시 미스와 같다
    }
  }

  @override
  void write(String name, String text) {
    try {
      _write(name, text);
    } catch (_) {
      // 용량 초과·사생활 모드 — 캐시 없이 계속 진행한다.
    }
  }

  @override
  void clear() {
    try {
      _clear();
    } catch (_) {
      /* 무시 */
    }
  }
}

enum DeliveryErrorKind {
  /// 2xx가 아닌 응답.
  badStatus,

  /// 네트워크 실패이고 캐시도 없음.
  unavailable,

  /// 본문을 기대 타입으로 디코딩하지 못함.
  malformed,
}

class DeliveryException implements Exception {
  final DeliveryErrorKind kind;
  final String path;
  final int? status;
  final Object? cause;
  const DeliveryException(this.kind, this.path, {this.status, this.cause});

  @override
  String toString() => switch (kind) {
        DeliveryErrorKind.badStatus => '배포 플레인이 $status 를 반환했습니다: $path',
        DeliveryErrorKind.unavailable => '배포 플레인에 접근할 수 없고 캐시도 없습니다: $path',
        DeliveryErrorKind.malformed => '배포 플레인 응답을 디코딩하지 못했습니다: $path',
      };
}

const String _manifestKey = 'manifest';
const String _etagKey = 'manifest.etag';

class RemoteDeliveryStore implements DeliveryStore {
  final String _projectUrl;
  final DeliveryFetch _fetch;
  final ArtifactCache _cache;
  final Map<String, Snapshot> _snapshots = {};
  final Map<String, Delta> _deltas = {};

  /// [baseUrl]은 배포 플레인 루트(로컬 셀프호스트는 `http://localhost:8788`, 운영은 CDN 도메인),
  /// [project]는 정적 레이아웃의 첫 경로 세그먼트다.
  /// [cache]를 생략하면 메모리 캐시라 앱 재시작 시 사라진다 — 영속성이 필요하면
  /// `rynl10n_io.dart`의 `FileArtifactCache`를 넘긴다.
  RemoteDeliveryStore({
    required String baseUrl,
    required String project,
    required DeliveryFetch fetch,
    ArtifactCache? cache,
  })  : _projectUrl = '${_trimTrailing(baseUrl)}/${_trimSlashes(project)}',
        _fetch = fetch,
        _cache = cache ?? MemoryArtifactCache();

  // --- DeliveryStore (동기 — 캐시만 조회, 네트워크 접근 없음) ---

  @override
  Snapshot? getSnapshot(String path) {
    final memo = _snapshots[path];
    if (memo != null) return memo;
    final decoded = _decodeCached(path, Snapshot.fromJson);
    if (decoded != null) _snapshots[path] = decoded;
    return decoded;
  }

  @override
  Delta? getDelta(String path) {
    final memo = _deltas[path];
    if (memo != null) return memo;
    final decoded = _decodeCached(path, Delta.fromJson);
    if (decoded != null) _deltas[path] = decoded;
    return decoded;
  }

  // --- 갱신 사이클 (6.4) ---

  /// manifest 조회 → 내 앱 버전에 맞는 릴리스 선택 → 필요한 산출물만 내려받기 → 원자적 스왑.
  ///
  /// 릴리스 선택은 **클라이언트가 정적 manifest만으로** 수행한다(서버 라우팅 없음, 4.3).
  /// 반환값은 카탈로그가 실제로 바뀌었는지 여부다. 네트워크 실패는 던지지 않고 마지막 캐시로
  /// 진행하며, 캐시조차 없으면 [DeliveryException]을 던진다 — 어느 경우든 화면의 번역은 깨지지
  /// 않는다(번들 fallback이 항상 살아 있다).
  ///
  /// 호출 시점은 앱 시작 직후와 포그라운드 복귀가 기본이다.
  Future<bool> update(RynL10nClient client) async {
    final manifest = await loadManifest();

    final selection = selectRelease(manifest.releases, client.context);
    final release = switch (selection) {
      Matched(:final release) => release,
      NearestLower(:final release) => release,
      // 매칭 릴리스 없음 → 번들만. 내려받을 산출물이 없다.
      BundleOnly() => null,
    };

    if (release != null) {
      // 활성 번들과 base가 같으면 스냅샷은 이미 손에 있다(빌드타임에 구운 것) → 받지 않는다.
      if (release.base != client.activeBase) {
        await fetchSnapshot(release.snapshot);
      }
      // 델타는 sparse라 작다. 카나리 미대상이면 refresh가 무시하므로 실패해도 그냥 진행한다.
      final deltaPath = release.delta;
      if (deltaPath != null && release.overlay != release.base) {
        try {
          await fetchDelta(deltaPath);
        } catch (_) {
          /* 캐시/번들로 계속 진행 */
        }
      }
    }

    return client.refresh(manifest);
  }

  // --- 주기 폴링 ---

  Timer? _pollTimer;

  /// 주기 폴링 시작(기본 60초). 즉시 한 번 갱신한 뒤 간격마다 반복한다.
  ///
  /// 실패는 삼킨다 — 실패 = 이전 상태 유지이고 다음 주기에 다시 시도하면 되기 때문이다.
  /// 앱이 [update]를 직접 부르는 것(앱 시작·포그라운드 복귀)과 배타적이지 않다: 산출물은 내용해시
  /// URL이라 이미 가진 것은 다시 받지 않고, manifest는 ETag로 재검증된다.
  ///
  /// 배터리·트래픽은 **호출자가 정한다** — `AppLifecycleState.paused`에서 [stopPolling],
  /// `resumed`에서 다시 [startPolling]이 기본 패턴이다. SDK가 앱 생명주기를 가로채지 않는다.
  void startPolling(
    RynL10nClient client, {
    Duration interval = const Duration(seconds: 60),
    void Function(bool changed)? onUpdate,
  }) {
    stopPolling();
    Future<void> cycle() async {
      bool changed;
      try {
        changed = await update(client);
      } catch (_) {
        changed = false; // 다음 주기에 다시 시도한다
      }
      if (_pollTimer == null) return; // stopPolling 직후 콜백이 한 번 더 나가지 않게
      onUpdate?.call(changed);
    }

    _pollTimer = Timer.periodic(interval, (_) => unawaited(cycle()));
    unawaited(cycle());
  }

  /// 폴링 중단(백그라운드 전환·로그아웃). 이미 적용된 카탈로그는 그대로 남는다.
  void stopPolling() {
    _pollTimer?.cancel();
    _pollTimer = null;
  }

  /// manifest 조회(짧은 TTL + ETag 재검증, 7.2). 네트워크 실패·304면 캐시본을 쓴다.
  Future<Manifest> loadManifest() async {
    final cached = _cachedManifest();
    // 304를 받아도 되돌릴 캐시본이 실제로 있을 때만 조건부 요청을 보낸다
    // (ETag만 남고 본문 캐시가 사라진 상태에서 304가 오면 복원할 것이 없다).
    final etag = cached != null ? _cache.read(_etagKey) : null;

    DeliveryResponse response;
    try {
      response = await _fetch('$_projectUrl/manifest.json', ifNoneMatch: etag);
    } catch (e) {
      // 오프라인·타임아웃 — 마지막으로 성공한 manifest로 진행한다.
      if (cached != null) return cached;
      throw DeliveryException(DeliveryErrorKind.unavailable, 'manifest.json', cause: e);
    }

    if (response.status == 200) {
      final manifest = _tryDecode(response.body, Manifest.fromJson);
      if (manifest == null) {
        throw const DeliveryException(DeliveryErrorKind.malformed, 'manifest.json');
      }
      _cache.write(_manifestKey, response.body);
      final fresh = response.etag;
      if (fresh != null) _cache.write(_etagKey, fresh);
      return manifest;
    }
    if (response.status == 304) {
      if (cached != null) return cached;
      throw const DeliveryException(DeliveryErrorKind.malformed, 'manifest.json');
    }
    // 서버가 살아 있으나 응답이 이상함 → 캐시가 있으면 캐시로 진행.
    if (cached != null) return cached;
    throw DeliveryException(DeliveryErrorKind.badStatus, 'manifest.json', status: response.status);
  }

  /// 스냅샷 내려받기(불변 → 이미 캐시에 있으면 네트워크를 타지 않는다).
  Future<Snapshot> fetchSnapshot(String path) async {
    final hit = getSnapshot(path);
    if (hit != null) return hit;
    final body = await _download(path);
    final decoded = _tryDecode(body, Snapshot.fromJson);
    if (decoded == null) throw DeliveryException(DeliveryErrorKind.malformed, path);
    _cache.write(_artifactKey(path), body);
    _snapshots[path] = decoded;
    return decoded;
  }

  /// 델타 내려받기(불변 → 이미 캐시에 있으면 네트워크를 타지 않는다).
  Future<Delta> fetchDelta(String path) async {
    final hit = getDelta(path);
    if (hit != null) return hit;
    final body = await _download(path);
    final decoded = _tryDecode(body, Delta.fromJson);
    if (decoded == null) throw DeliveryException(DeliveryErrorKind.malformed, path);
    _cache.write(_artifactKey(path), body);
    _deltas[path] = decoded;
    return decoded;
  }

  /// 캐시 비우기(로그아웃·프로젝트 전환 등). 번들 fallback은 그대로라 번역 공백은 생기지 않는다.
  void clearCache() {
    _snapshots.clear();
    _deltas.clear();
    _cache.clear();
  }

  Future<String> _download(String path) async {
    DeliveryResponse response;
    try {
      response = await _fetch('$_projectUrl/$path');
    } catch (e) {
      throw DeliveryException(DeliveryErrorKind.unavailable, path, cause: e);
    }
    if (response.status != 200) {
      throw DeliveryException(DeliveryErrorKind.badStatus, path, status: response.status);
    }
    return response.body;
  }

  Manifest? _cachedManifest() {
    final raw = _cache.read(_manifestKey);
    return raw == null ? null : _tryDecode(raw, Manifest.fromJson);
  }

  T? _decodeCached<T>(String path, T Function(Map) build) {
    final raw = _cache.read(_artifactKey(path));
    return raw == null ? null : _tryDecode(raw, build);
  }

  T? _tryDecode<T>(String body, T Function(Map) build) {
    try {
      final decoded = jsonDecode(body);
      return decoded is Map ? build(decoded) : null;
    } catch (_) {
      return null;
    }
  }
}

/// 산출물 경로(`releases/R1/snapshot-<hash>.json`)를 평평한 캐시 키로.
/// 내용해시가 들어 있어 충돌하지 않는다.
String _artifactKey(String path) => 'artifact:$path';

String _trimTrailing(String s) => s.replaceAll(RegExp(r'/+$'), '');
String _trimSlashes(String s) => s.replaceAll(RegExp(r'^/+|/+$'), '');
