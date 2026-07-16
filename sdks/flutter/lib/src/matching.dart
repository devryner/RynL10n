// 버전 매칭 · 충돌 검사 · 클라이언트 릴리스 판정 — 기획서 4.3 / 8.2 / 11.3 (+정수 M4).
import 'types.dart';
import 'semver.dart';
import 'intrange.dart';

class _Bound { final SemVer version; final bool inclusive; _Bound(this.version, this.inclusive); }
class _Interval { final _Bound? lower; final _Bound? upper; _Interval(this.lower, this.upper); }

_Interval _toInterval(List<Comparator> comparators) {
  _Bound? lower, upper;
  void tightenLower(_Bound b) {
    if (lower == null) { lower = b; return; }
    final c = compareSemVer(b.version, lower!.version);
    if (c > 0 || (c == 0 && !b.inclusive && lower!.inclusive)) lower = b;
  }
  void tightenUpper(_Bound b) {
    if (upper == null) { upper = b; return; }
    final c = compareSemVer(b.version, upper!.version);
    if (c < 0 || (c == 0 && !b.inclusive && upper!.inclusive)) upper = b;
  }
  for (final c in comparators) {
    switch (c.op) {
      case '>=': tightenLower(_Bound(c.version, true)); break;
      case '>': tightenLower(_Bound(c.version, false)); break;
      case '<=': tightenUpper(_Bound(c.version, true)); break;
      case '<': tightenUpper(_Bound(c.version, false)); break;
      default: tightenLower(_Bound(c.version, true)); tightenUpper(_Bound(c.version, true));
    }
  }
  return _Interval(lower, upper);
}

bool _overlaps(_Interval a, _Interval b) {
  final lo = _maxLower(a.lower, b.lower);
  final hi = _minUpper(a.upper, b.upper);
  if (lo == null || hi == null) return true;
  final c = compareSemVer(lo.version, hi.version);
  if (c < 0) return true;
  if (c > 0) return false;
  return lo.inclusive && hi.inclusive;
}

_Bound? _maxLower(_Bound? a, _Bound? b) {
  if (a == null) return b;
  if (b == null) return a;
  final c = compareSemVer(a.version, b.version);
  if (c != 0) return c > 0 ? a : b;
  return a.inclusive ? b : a;
}
_Bound? _minUpper(_Bound? a, _Bound? b) {
  if (a == null) return b;
  if (b == null) return a;
  final c = compareSemVer(a.version, b.version);
  if (c != 0) return c < 0 ? a : b;
  return a.inclusive ? b : a;
}

class ConflictInput { final String id; final VersionMatch versionMatch; ConflictInput(this.id, this.versionMatch); }

List<List<String>> findRangeConflicts(List<ConflictInput> releases) {
  final conflicts = <List<String>>[];
  final semver = releases.where((r) => r.versionMatch.strategy == 'semver-range').toList();
  final ivs = semver.map((r) => _toInterval(parseRange(r.versionMatch.value))).toList();
  for (var i = 0; i < semver.length; i++) {
    for (var j = i + 1; j < semver.length; j++) {
      if (_overlaps(ivs[i], ivs[j])) conflicts.add([semver[i].id, semver[j].id]);
    }
  }
  final byLabel = <String, List<String>>{};
  for (final r in releases) {
    if (r.versionMatch.strategy != 'exact-label') continue;
    byLabel.putIfAbsent(r.versionMatch.value, () => []).add(r.id);
  }
  for (final ids in byLabel.values) {
    for (var i = 1; i < ids.length; i++) conflicts.add([ids[0], ids[i]]);
  }
  final ints = releases.where((r) => r.versionMatch.strategy == 'integer-range').toList();
  final intIvs = ints.map((r) => intInterval(parseIntRange(r.versionMatch.value))).toList();
  for (var i = 0; i < ints.length; i++) {
    for (var j = i + 1; j < ints.length; j++) {
      if (intIntervalsOverlap(intIvs[i], intIvs[j])) conflicts.add([ints[i].id, ints[j].id]);
    }
  }
  return conflicts;
}

class ClientContext {
  final String? appVersion;
  final String? releaseLabel;
  final int? buildNumber;
  final bool matchPrerelease;
  final FallbackPolicy fallbackPolicy;
  ClientContext({this.appVersion, this.releaseLabel, this.buildNumber, this.matchPrerelease = false,
      this.fallbackPolicy = FallbackPolicy.bundleOnly});
}

sealed class Selection {
  String get kind;
  String? get releaseId;
}
class Matched extends Selection { final ManifestRelease release; Matched(this.release);
  @override String get kind => 'matched'; @override String? get releaseId => release.id; }
class NearestLower extends Selection { final ManifestRelease release; NearestLower(this.release);
  @override String get kind => 'nearest-lower'; @override String? get releaseId => release.id; }
class BundleOnly extends Selection {
  @override String get kind => 'bundle-only'; @override String? get releaseId => null; }

Selection selectRelease(List<ManifestRelease> releases, ClientContext ctx) {
  final serving = releases.where((r) => r.state == 'published' || r.state == 'superseded').toList();
  final matched = <ManifestRelease>[];
  for (final r in serving) {
    if (r.versionMatch.strategy == 'exact-label') {
      if (ctx.releaseLabel != null && ctx.releaseLabel == r.versionMatch.value) matched.add(r);
    } else if (r.versionMatch.strategy == 'integer-range') {
      if (ctx.buildNumber != null && intInRange(ctx.buildNumber!, r.versionMatch.value)) matched.add(r);
    } else {
      if (ctx.appVersion == null) continue;
      if (satisfies(parseVersion(ctx.appVersion!), parseRange(r.versionMatch.value), matchPrerelease: ctx.matchPrerelease)) {
        matched.add(r);
      }
    }
  }
  if (matched.length == 1) return Matched(matched[0]);
  if (matched.length > 1) return Matched(_tiebreak(matched));
  if (ctx.fallbackPolicy == FallbackPolicy.nearestLower && ctx.appVersion != null) {
    final nl = _nearestLower(serving, ctx.appVersion!);
    if (nl != null) return NearestLower(nl);
  }
  return BundleOnly();
}

ManifestRelease _tiebreak(List<ManifestRelease> candidates) {
  _Interval? iv(ManifestRelease r) => r.versionMatch.strategy == 'semver-range'
      ? _toInterval(parseRange(r.versionMatch.value)) : null;
  final sorted = [...candidates]..sort((x, y) {
    final lo = _cmpBound(iv(x)?.lower, iv(y)?.lower, true);
    if (lo != 0) return -lo;
    final hi = _cmpBound(iv(x)?.upper, iv(y)?.upper, false);
    if (hi != 0) return hi;
    return y.id.compareTo(x.id);
  });
  return sorted.first;
}

int _cmpBound(_Bound? a, _Bound? b, bool lower) {
  if (a == null && b == null) return 0;
  if (a == null) return lower ? -1 : 1;
  if (b == null) return lower ? 1 : -1;
  return compareSemVer(a.version, b.version);
}

ManifestRelease? _nearestLower(List<ManifestRelease> serving, String appVersion) {
  final v = parseVersion(appVersion);
  ManifestRelease? bestR;
  SemVer? bestU;
  for (final r in serving) {
    if (r.versionMatch.strategy != 'semver-range') continue;
    final upper = _toInterval(parseRange(r.versionMatch.value)).upper;
    if (upper == null) continue;
    if (compareSemVer(upper.version, v) <= 0) {
      if (bestU == null || compareSemVer(upper.version, bestU) > 0) { bestR = r; bestU = upper.version; }
    }
  }
  return bestR;
}
