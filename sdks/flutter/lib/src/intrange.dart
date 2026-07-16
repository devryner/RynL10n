// 정수(빌드 넘버) 범위 매칭 — M4. 포함 정수 하한/상한으로 정규화.
class IntComparator {
  final String op;
  final int n;
  IntComparator(this.op, this.n);
}

class IntInterval {
  final int? lower;
  final int? upper;
  IntInterval(this.lower, this.upper);
}

class IntRangeException implements Exception {
  final String message;
  IntRangeException(this.message);
  @override
  String toString() => 'IntRangeException: $message';
}

final _intComparator = RegExp(r'^(>=|<=|>|<|=)?(-?\d+)$');

List<IntComparator> parseIntRange(String input) {
  final raw = input.trim();
  if (raw.isEmpty) throw IntRangeException('빈 정수 범위식');
  for (final pat in ['||', '^', '~', ' - ']) {
    if (raw.contains(pat)) throw IntRangeException('미지원 정수 범위 문법 "$pat"');
  }
  return raw.split(RegExp(r'\s+')).map((tok) {
    final m = _intComparator.firstMatch(tok);
    if (m == null) throw IntRangeException('유효하지 않은 정수 비교자 "$tok"');
    return IntComparator(m.group(1) ?? '=', int.parse(m.group(2)!));
  }).toList();
}

IntInterval intInterval(List<IntComparator> comparators) {
  int? lower, upper;
  void raiseLower(int v) { if (lower == null || v > lower!) lower = v; }
  void lowerUpper(int v) { if (upper == null || v < upper!) upper = v; }
  for (final c in comparators) {
    switch (c.op) {
      case '>=': raiseLower(c.n); break;
      case '>': raiseLower(c.n + 1); break;
      case '<=': lowerUpper(c.n); break;
      case '<': lowerUpper(c.n - 1); break;
      default: raiseLower(c.n); lowerUpper(c.n);
    }
  }
  return IntInterval(lower, upper);
}

bool intSatisfies(int n, List<IntComparator> comparators) {
  final iv = intInterval(comparators);
  if (iv.lower != null && n < iv.lower!) return false;
  if (iv.upper != null && n > iv.upper!) return false;
  return true;
}

bool intInRange(int n, String range) => intSatisfies(n, parseIntRange(range));

bool intIntervalsOverlap(IntInterval a, IntInterval b) {
  final lo = a.lower == null ? b.lower : (b.lower == null ? a.lower : (a.lower! > b.lower! ? a.lower : b.lower));
  final hi = a.upper == null ? b.upper : (b.upper == null ? a.upper : (a.upper! < b.upper! ? a.upper : b.upper));
  if (lo == null || hi == null) return true;
  return lo <= hi;
}
