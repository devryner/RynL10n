// 플레이스홀더 서명 & 포맷 안전 가드 — 기획서 3.1 / 5.3.
import 'types.dart';

final _re = RegExp(
    r'\{\s*([A-Za-z0-9_]+)\s*(?:,\s*(plural|selectordinal|select|number|date|time|spellout|ordinal|duration))?');

String signature(TranslationValue value) {
  final args = <String, String>{};
  if (value is TextValue) {
    _collect(value.value, args);
  } else if (value is PluralValue) {
    for (final k in (value.map.keys.toList()..sort())) {
      _collect(value.map[k]!, args);
    }
  }
  final keys = args.keys.toList()..sort();
  return keys.map((k) => '$k:${args[k]}').join(',');
}

bool signaturesMatch(TranslationValue a, TranslationValue b) => signature(a) == signature(b);

void _collect(String icu, Map<String, String> args) {
  for (final m in _re.allMatches(icu)) {
    final name = m.group(1)!;
    final type = m.group(2) ?? 'simple';
    final prev = args[name];
    if (prev == null) {
      args[name] = type;
    } else if (prev != type) {
      args[name] = '$prev|$type';
    }
  }
}
