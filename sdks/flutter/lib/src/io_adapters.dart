/// `dart:io` 어댑터 — 기획서 6.3 / 6.4.
///
/// 순수 Dart 코어([RemoteDeliveryStore]·`parseBakedSnapshot`)가 요구하는 두 구멍
/// (HTTP 한 번 · 저장소 하나)을 표준 라이브러리만으로 메운다. 모바일·데스크톱·서버 타깃용이며,
/// **Flutter Web에서는 import하지 않는다**(`package:http` 등으로 [DeliveryFetch]만 채우면 된다).
library;

import 'dart:convert';
import 'dart:io';

import 'baked.dart';
import 'delivery.dart';
import 'push.dart';
import 'telemetry.dart';
import 'types.dart';

/// `HttpClient` 기반 [DeliveryFetch]. 재검증은 ETag로 직접 하므로 HTTP 캐시는 쓰지 않는다.
DeliveryFetch ioDeliveryFetch({
  Duration connectTimeout = const Duration(seconds: 10),
  Duration readTimeout = const Duration(seconds: 15),
}) {
  return (String url, {String? ifNoneMatch}) async {
    final client = HttpClient()..connectionTimeout = connectTimeout;
    try {
      final request = await client.getUrl(Uri.parse(url));
      if (ifNoneMatch != null) request.headers.set(HttpHeaders.ifNoneMatchHeader, ifNoneMatch);
      final response = await request.close().timeout(readTimeout);
      final body = await response.transform(utf8.decoder).join();
      return DeliveryResponse(
        response.statusCode,
        body,
        etag: response.headers.value(HttpHeaders.etagHeader),
      );
    } finally {
      client.close(force: true);
    }
  };
}

/// 파일 시스템 [ArtifactCache].
///
/// 앱은 캐시 디렉토리(iOS `Library/Caches`, Android `context.cacheDir`, Flutter는
/// `path_provider`의 `getApplicationCacheDirectory()`)를 넘긴다 — OS가 비울 수 있는 자리가 맞다.
/// 번들 fallback이 항상 있으므로 캐시가 사라져도 번역 공백은 생기지 않는다.
class FileArtifactCache implements ArtifactCache {
  final Directory _dir;

  FileArtifactCache(Directory root, {String project = 'default'})
      : _dir = Directory('${root.path}/rynl10n/$project') {
    _dir.createSync(recursive: true);
  }

  @override
  String? read(String name) {
    try {
      final file = _fileFor(name);
      return file.existsSync() ? file.readAsStringSync() : null;
    } catch (_) {
      return null; // 읽기 실패는 캐시 미스와 같다
    }
  }

  @override
  void write(String name, String text) {
    try {
      _dir.createSync(recursive: true);
      final target = _fileFor(name);
      // 원자적 교체 — 반쯤 쓰인 파일을 다음 실행이 읽는 일이 없도록.
      final tmp = File('${target.path}.tmp');
      tmp.writeAsStringSync(text, flush: true);
      tmp.renameSync(target.path);
    } catch (_) {
      // 용량 부족·권한 — 캐시 없이 계속 진행한다.
    }
  }

  @override
  void clear() {
    try {
      if (_dir.existsSync()) _dir.deleteSync(recursive: true);
      _dir.createSync(recursive: true);
    } catch (_) {
      /* 무시 */
    }
  }

  File _fileFor(String name) =>
      File('${_dir.path}/${name.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_')}');
}

/// 디렉토리에서 bake 산출물을 찾아 읽는다(vendored 배치·서버/데스크톱 소비자용).
///
/// 탐색 순서 — ① `rynl10n/snapshot.json` ② `snapshot.json`(둘 다 `--stable-name` 산출물)
/// ③ `snapshot-<base>.json`(CLI 기본, 내용해시 파일명).
Snapshot loadBakedSnapshot(Directory directory) {
  final file = locateBakedSnapshot(directory);
  if (file == null) {
    throw BakedException(
      '[rynl10n] ${directory.path} 에서 bake된 스냅샷을 찾지 못했습니다.\n'
      '확인: ① 빌드가 rynl10n-bake를 돌리는지 ② 출력이 이 디렉토리로 향하는지'
      '(${bakedCandidates.join(', ')}) ③ 에어갭이면 vendored 스냅샷이 그 자리에 있는지.',
    );
  }
  return parseBakedSnapshot(file.readAsStringSync(), source: file.path);
}

/// 디렉토리 안의 bake 산출물 위치. 못 찾으면 null.
File? locateBakedSnapshot(Directory directory) {
  for (final candidate in bakedCandidates) {
    final file = File('${directory.path}/$candidate');
    if (file.existsSync()) return file;
  }
  // 내용해시 파일명(`snapshot-<base>.json`) — CLI를 --stable-name 없이 돌린 경우.
  for (final dir in [Directory('${directory.path}/rynl10n'), directory]) {
    if (!dir.existsSync()) continue;
    final hits = dir
        .listSync()
        .whereType<File>()
        .where((f) {
          final name = f.uri.pathSegments.last;
          return name.startsWith('snapshot-') && name.endsWith('.json');
        })
        .toList()
      ..sort((a, b) => a.path.compareTo(b.path));
    if (hits.isNotEmpty) return hits.first;
  }
  return null;
}

/// 디렉토리에서 lockfile을 찾아 읽는다. 없으면 null.
BakedLockfile? loadBakedLockfile(Directory directory) {
  for (final candidate in bakedLockfileCandidates) {
    final file = File('${directory.path}/$candidate');
    if (file.existsSync()) return parseBakedLockfile(file.readAsStringSync());
  }
  return null;
}

/// `HttpClient` 기반 [PushConnect] — 실시간 푸시 신호(SSE) 연결.
///
/// 스트림이 끝나면(정상 종료·끊김·[ServerPushChannel.stop]) 내부 클라이언트를 닫는다.
/// 무음 상한을 두지 않는다 — 끊긴 연결의 탐지는 [ServerPushChannel]의 재연결 백오프가 맡고,
/// 그 사이 갱신은 폴링이 덮는다.
PushConnect ioPushConnect({Duration connectTimeout = const Duration(seconds: 10)}) {
  return (String url) async {
    final client = HttpClient()..connectionTimeout = connectTimeout;
    final request = await client.getUrl(Uri.parse(url));
    request.headers.set(HttpHeaders.acceptHeader, 'text/event-stream');
    final response = await request.close();

    Stream<String> body() async* {
      try {
        yield* response.transform(utf8.decoder);
      } finally {
        client.close(force: true);
      }
    }

    return PushResponse(response.statusCode, body());
  };
}

/// `HttpClient` 기반 [TelemetryPost] — 익명 집계 업로드(9.3).
/// **관리 플레인으로 가는 유일한 쓰기 경로**이고, 실패해도 화면의 번역은 영향을 받지 않는다.
TelemetryPost ioTelemetryPost({Duration timeout = const Duration(seconds: 15)}) {
  return (String url, String body) async {
    final client = HttpClient();
    try {
      final request = await client.postUrl(Uri.parse(url));
      request.headers.set(HttpHeaders.contentTypeHeader, 'application/json');
      request.write(body);
      final response = await request.close().timeout(timeout);
      await response.drain<void>();
      return response.statusCode;
    } finally {
      client.close(force: true);
    }
  };
}
