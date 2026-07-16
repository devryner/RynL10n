// M0 TS 참조 구현과의 정합성 — fixtures/golden. 통과하면 Dart 코어가 바이트/해시/동작 단위로 일치.
import 'dart:convert';
import 'dart:io';
import 'package:test/test.dart';
import 'package:rynl10n/rynl10n.dart';

Directory _goldenDir() {
  var dir = Directory.current;
  for (var i = 0; i < 12; i++) {
    final c = Directory('${dir.path}/fixtures/golden');
    if (c.existsSync()) return c;
    dir = dir.parent;
  }
  throw StateError('fixtures/golden 없음');
}

Map _load(String f) => jsonDecode(File('${_goldenDir().path}/$f').readAsStringSync()) as Map;

TranslationValue? _tvOrNull(dynamic j) => j == null ? null : TranslationValue.fromJson(j);

void main() {
  test('serialize: canonical + sha256 + fileId', () {
    for (final c in _load('serialize.json')['cases'] as List) {
      expect(canonicalString(c['value']), c['canonical'], reason: c['name']);
      expect(sha256Hex(c['value']), c['sha256'], reason: c['name']);
      expect(fileId(c['sha256'] as String), c['fileId16'], reason: c['name']);
    }
  });

  test('nfc: 조합형/완성형 동일 해시', () {
    for (final c in _load('nfc.json')['cases'] as List) {
      expect(sha256Hex({'v': c['composed']}), c['sha256'], reason: c['name']);
      expect(sha256Hex({'v': c['decomposed']}), c['sha256'], reason: c['name']);
    }
  });

  test('snapshot-hash', () {
    for (final c in _load('snapshot-hash.json')['cases'] as List) {
      final input = c['input'] as Map;
      final obj = {'release': input['release'], 'defaultLocale': input['defaultLocale'], 'locales': input['locales']};
      expect(canonicalString(obj), c['canonical'], reason: c['name']);
      final full = snapshotHash(input['release'] as String, input['defaultLocale'] as String, input['locales']);
      expect(full, c['fullHash'], reason: c['name']);
      expect(fileId(full), c['base16'], reason: c['name']);
    }
  });

  test('delta application', () {
    final c = _load('delta.json')['case'] as Map;
    final from = Snapshot.fromJson(c['from'] as Map);
    final delta = Delta.fromJson(c['delta'] as Map);
    final overlay = OverlayLayer.fromDelta(delta);
    for (final op in delta.ops) {
      final r = resolveValue(from, overlay, op.key, op.locale);
      if (op.op == 'set') {
        expect(r.source, 'overlay');
        expect(r.value, op.value);
      } else {
        expect(r.matchedLocale == op.locale, false);
      }
    }
  });

  test('resolve', () {
    final f = _load('resolve.json');
    final bundle = Snapshot.fromJson(f['bundle'] as Map);
    for (final c in f['cases'] as List) {
      final overlay = OverlayLayer();
      for (final e in c['overlay'] as List) {
        if (e['tombstone'] == true) {
          overlay.tombstone(e['locale'] as String, e['key'] as String);
        } else if (e['value'] != null) {
          overlay.set(e['locale'] as String, e['key'] as String, TranslationValue.fromJson(e['value']));
        }
      }
      final r = resolveValue(bundle, overlay, c['key'] as String, c['locale'] as String);
      final exp = c['expected'] as Map;
      expect(r.source, exp['source'], reason: c['name']);
      expect(r.matchedLocale, exp['matchedLocale'], reason: c['name']);
      expect(r.guardFallback, exp['guardFallback'], reason: c['name']);
      expect(r.value, _tvOrNull(exp['value']), reason: c['name']);
    }
  });

  test('format', () {
    for (final c in _load('format.json')['cases'] as List) {
      final args = (c['args'] as Map).map((k, v) => MapEntry(k as String, v as Object?));
      expect(format(TranslationValue.fromJson(c['value']), c['locale'] as String, args), c['expected'], reason: c['name']);
    }
  });

  test('semver', () {
    final f = _load('semver.json');
    for (final c in f['satisfies'] as List) {
      expect(versionInRange(c['version'] as String, c['range'] as String, matchPrerelease: c['matchPrerelease'] == true),
          c['expected'], reason: '${c['version']} in ${c['range']}');
    }
    for (final c in f['reject'] as List) {
      if (c['expectedThrow'] == true) {
        expect(() => parseRange(c['range'] as String), throwsA(anything), reason: c['range'] as String);
      }
    }
  });

  test('routing', () {
    for (final c in _load('routing.json')['cases'] as List) {
      final releases = (c['releases'] as List).map((r) => ManifestRelease.fromJson(r as Map)).toList();
      final ctxJson = c['ctx'] as Map;
      final ctx = ClientContext(
        appVersion: ctxJson['appVersion'] as String?,
        releaseLabel: ctxJson['releaseLabel'] as String?,
        matchPrerelease: ctxJson['matchPrerelease'] == true,
        fallbackPolicy: ctxJson['fallbackPolicy'] == 'nearest-lower' ? FallbackPolicy.nearestLower : FallbackPolicy.bundleOnly,
      );
      final sel = selectRelease(releases, ctx);
      final exp = c['expected'] as Map;
      expect(sel.kind, exp['kind'], reason: c['name']);
      expect(sel.releaseId, exp['releaseId'], reason: c['name']);
    }
  });

  test('canary buckets + inRollout', () {
    final f = _load('canary.json');
    for (final c in f['buckets'] as List) {
      expect(bucketOf(c['installId'] as String, c['releaseId'] as String), c['bucket']);
    }
    for (final c in f['inRollout'] as List) {
      expect(inRollout(c['rollout'] as int, c['installId'] as String?, c['releaseId'] as String), c['expected']);
    }
  });

  test('intrange', () {
    final f = _load('intrange.json');
    for (final c in f['satisfies'] as List) {
      expect(intInRange(c['n'] as int, c['range'] as String), c['expected'], reason: '${c['n']} in ${c['range']}');
    }
    for (final c in f['reject'] as List) {
      if (c['expectedThrow'] == true) {
        expect(() => parseIntRange(c['range'] as String), throwsA(anything), reason: c['range'] as String);
      }
    }
  });
}
