/// 빌드타임에 구운 번들 스냅샷을 런타임에 로드한다 — 기획서 3.2 / 6.3 (차별점 ①의 마지막 구간).
///
/// `rynl10n-bake`가 빌드마다 `snapshot.json` + `rynl10n.lock`을 앱 자산에 넣는다. 이 파일은 그
/// 산출물을 [Snapshot]으로 되돌리는 표준 관문이다 — iOS `Snapshot.baked(in:)`,
/// Android `BakedBundle.snapshot(...)`, Web `BakedBundle.parse(...)`와 같은 자리.
///
/// **여기에는 `dart:io`가 들어 있지 않다.** Flutter 자산은 문자열로 오고(`rootBundle.loadString`),
/// 파일 시스템에서 찾아 읽는 경로는 `rynl10n_io.dart`의 어댑터가 담당한다 — 덕분에 이 로직은
/// Flutter Web을 포함한 모든 타깃에서 그대로 쓰인다.
///
/// ```dart
/// // Flutter 앱(모든 타깃)
/// final text = await rootBundle.loadString('assets/rynl10n/snapshot.json');
/// final bundle = parseBakedSnapshot(text, source: 'assets/rynl10n/snapshot.json');
/// ```
import 'dart:convert';

import 'types.dart';

/// 자산 루트 기준 탐색 순서 — iOS·Android·Web의 후보 순서와 동일하게 유지한다.
const List<String> bakedCandidates = ['rynl10n/snapshot.json', 'snapshot.json'];

/// lockfile(진단용) 탐색 순서.
const List<String> bakedLockfileCandidates = ['rynl10n/rynl10n.lock', 'rynl10n.lock'];

/// bake 산출물을 찾지 못했거나 디코딩하지 못함.
class BakedException implements Exception {
  final String message;
  const BakedException(this.message);
  @override
  String toString() => message;
}

/// bake lockfile(`rynl10n.lock`) — 어느 릴리스·base가 이 빌드에 구워졌는지 진단용.
/// 런타임 동작에는 쓰이지 않는다(스냅샷 자신이 `release`·`base`를 들고 있다).
class BakedLockfile {
  final int schemaVersion;
  final String release;
  final String base;
  final int keyCount;
  final List<String> locales;

  const BakedLockfile(this.schemaVersion, this.release, this.base, this.keyCount, this.locales);

  factory BakedLockfile.fromJson(Map j) => BakedLockfile(
        (j['schemaVersion'] as num?)?.toInt() ?? 1,
        j['release'] as String,
        j['base'] as String,
        (j['keyCount'] as num?)?.toInt() ?? 0,
        (j['locales'] as List? ?? const []).map((e) => e as String).toList(),
      );
}

/// bake 산출물 텍스트를 스냅샷으로 읽는다. 형태가 아니면 안내 메시지와 함께 던진다.
Snapshot parseBakedSnapshot(String text, {String source = 'bundle'}) {
  Object? decoded;
  try {
    decoded = jsonDecode(text);
  } catch (_) {
    decoded = null;
  }
  if (decoded is! Map || !_looksLikeSnapshot(decoded)) {
    throw BakedException(
      '[rynl10n] $source 를 번들 스냅샷으로 읽지 못했습니다.\n'
      '확인: ① 빌드가 rynl10n-bake를 돌리는지 ② 자산 경로가 bake 출력과 일치하는지'
      '(${bakedCandidates.join(', ')}) ③ 에어갭이면 vendored 스냅샷이 그 자리에 있는지.',
    );
  }
  try {
    return Snapshot.fromJson(decoded);
  } catch (_) {
    throw BakedException('[rynl10n] 번들 스냅샷을 디코딩하지 못했습니다: $source');
  }
}

/// lockfile 판독. 형태가 아니면 null(진단 정보라 실패해도 런타임은 계속된다).
BakedLockfile? parseBakedLockfile(String text) {
  try {
    final decoded = jsonDecode(text);
    if (decoded is! Map) return null;
    return BakedLockfile.fromJson(decoded);
  } catch (_) {
    return null;
  }
}

bool _looksLikeSnapshot(Map j) =>
    j['release'] is String &&
    j['base'] is String &&
    j['defaultLocale'] is String &&
    j['locales'] is Map;
