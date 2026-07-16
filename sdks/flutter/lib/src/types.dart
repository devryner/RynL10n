// 데이터 모델 & 산출물 스키마 — 기획서 5 / 11.

sealed class TranslationValue {
  static TranslationValue fromJson(dynamic j) =>
      j is String ? TextValue(j) : PluralValue(Map<String, String>.from(j as Map));
}

class TextValue extends TranslationValue {
  final String value;
  TextValue(this.value);
  @override
  bool operator ==(Object o) => o is TextValue && o.value == value;
  @override
  int get hashCode => value.hashCode;
}

class PluralValue extends TranslationValue {
  final Map<String, String> map;
  PluralValue(this.map);
  @override
  bool operator ==(Object o) {
    if (o is! PluralValue || o.map.length != map.length) return false;
    for (final e in map.entries) {
      if (o.map[e.key] != e.value) return false;
    }
    return true;
  }
  @override
  int get hashCode => Object.hashAllUnordered(map.entries.map((e) => Object.hash(e.key, e.value)));
}

class Snapshot {
  final int schemaVersion;
  final String release;
  final String base;
  final String defaultLocale;
  final Map<String, Map<String, TranslationValue>> locales;
  Snapshot(this.schemaVersion, this.release, this.base, this.defaultLocale, this.locales);

  factory Snapshot.fromJson(Map j) {
    final locales = <String, Map<String, TranslationValue>>{};
    (j['locales'] as Map).forEach((loc, keys) {
      locales[loc as String] = (keys as Map).map((k, v) => MapEntry(k as String, TranslationValue.fromJson(v)));
    });
    return Snapshot(j['schemaVersion'] as int, j['release'] as String, j['base'] as String,
        j['defaultLocale'] as String, locales);
  }
}

class DeltaOp {
  final String op; // set | delete
  final String key;
  final String locale;
  final TranslationValue? value;
  DeltaOp(this.op, this.key, this.locale, this.value);
  factory DeltaOp.fromJson(Map j) => DeltaOp(j['op'] as String, j['key'] as String, j['locale'] as String,
      j.containsKey('value') ? TranslationValue.fromJson(j['value']) : null);
}

class Delta {
  final String release;
  final String from;
  final String to;
  final List<DeltaOp> ops;
  Delta(this.release, this.from, this.to, this.ops);
  factory Delta.fromJson(Map j) =>
      Delta(j['release'] as String, j['from'] as String, j['to'] as String,
          (j['ops'] as List).map((o) => DeltaOp.fromJson(o as Map)).toList());
}

class VersionMatch {
  final String strategy; // semver-range | exact-label | integer-range
  final String value;
  VersionMatch(this.strategy, this.value);
  factory VersionMatch.fromJson(Map j) => VersionMatch(j['strategy'] as String, j['value'] as String);
}

class ManifestRelease {
  final String id;
  final String state; // draft | published | superseded | archived
  final VersionMatch versionMatch;
  final String base;
  final String overlay;
  final int rollout;
  final String snapshot;
  final String? delta;
  ManifestRelease(this.id, this.state, this.versionMatch, this.base, this.overlay, this.rollout, this.snapshot, this.delta);
  factory ManifestRelease.fromJson(Map j) => ManifestRelease(
      j['id'] as String, j['state'] as String, VersionMatch.fromJson(j['versionMatch'] as Map),
      j['base'] as String, j['overlay'] as String, j['rollout'] as int, j['snapshot'] as String,
      j['delta'] as String?);
}

class Manifest {
  final String project;
  final String defaultLocale;
  final List<ManifestRelease> releases;
  Manifest(this.project, this.defaultLocale, this.releases);
  factory Manifest.fromJson(Map j) => Manifest(j['project'] as String, j['defaultLocale'] as String,
      (j['releases'] as List).map((r) => ManifestRelease.fromJson(r as Map)).toList());
}

enum FallbackPolicy { nearestLower, bundleOnly }
