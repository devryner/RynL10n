// node-semver 부분집합 — 기획서 11.3.
class SemVer {
  final int major, minor, patch;
  final List<Object> prerelease; // int 또는 String
  SemVer(this.major, this.minor, this.patch, this.prerelease);
  bool get isPrerelease => prerelease.isNotEmpty;
}

class SemVerException implements Exception {
  final String message;
  SemVerException(this.message);
  @override
  String toString() => 'SemVerException: $message';
}

final _core = RegExp(r'^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$');
final _comparator = RegExp(r'^(>=|<=|>|<|=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$');

SemVer parseVersion(String input) {
  final m = _core.firstMatch(input.trim());
  if (m == null) throw SemVerException('유효하지 않은 버전: "$input"');
  final pre = <Object>[];
  final p = m.group(4);
  if (p != null && p.isNotEmpty) {
    for (final id in p.split('.')) {
      final n = int.tryParse(id);
      pre.add(n != null && n.toString() == id ? n : id);
    }
  }
  return SemVer(int.parse(m.group(1)!), int.parse(m.group(2)!), int.parse(m.group(3)!), pre);
}

int compareSemVer(SemVer a, SemVer b) {
  if (a.major != b.major) return a.major < b.major ? -1 : 1;
  if (a.minor != b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch != b.patch) return a.patch < b.patch ? -1 : 1;
  final ap = a.prerelease, bp = b.prerelease;
  if (ap.isEmpty && bp.isEmpty) return 0;
  if (ap.isEmpty) return 1;
  if (bp.isEmpty) return -1;
  for (var i = 0; i < ap.length && i < bp.length; i++) {
    final x = ap[i], y = bp[i];
    if (x is int && y is int) { if (x != y) return x < y ? -1 : 1; }
    else if (x is int) return -1;
    else if (y is int) return 1;
    else { final xs = x as String, ys = y as String; if (xs != ys) return xs.compareTo(ys) < 0 ? -1 : 1; }
  }
  if (ap.length != bp.length) return ap.length < bp.length ? -1 : 1;
  return 0;
}

class Comparator {
  final String op;
  final SemVer version;
  Comparator(this.op, this.version);
}

List<Comparator> parseRange(String input) {
  final raw = input.trim();
  if (raw.isEmpty) throw SemVerException('빈 범위식');
  for (final pat in ['||', '^', '~', ' - ']) {
    if (raw.contains(pat)) throw SemVerException('미지원 범위 문법 "$pat"');
  }
  return raw.split(RegExp(r'\s+')).map((tok) {
    final m = _comparator.firstMatch(tok);
    if (m == null) throw SemVerException('미지원/유효하지 않은 비교자 "$tok"');
    return Comparator(m.group(1) ?? '=', parseVersion(m.group(2)!));
  }).toList();
}

bool satisfies(SemVer version, List<Comparator> comparators, {bool matchPrerelease = false}) {
  if (version.isPrerelease) {
    if (!matchPrerelease) return false;
    final tuple = comparators.any((c) =>
        c.version.isPrerelease && c.version.major == version.major &&
        c.version.minor == version.minor && c.version.patch == version.patch);
    if (!tuple) return false;
  }
  return comparators.every((c) {
    final cmp = compareSemVer(version, c.version);
    switch (c.op) {
      case '>=': return cmp >= 0;
      case '<=': return cmp <= 0;
      case '>': return cmp > 0;
      case '<': return cmp < 0;
      default: return cmp == 0;
    }
  });
}

bool versionInRange(String version, String range, {bool matchPrerelease = false}) =>
    satisfies(parseVersion(version), parseRange(range), matchPrerelease: matchPrerelease);
