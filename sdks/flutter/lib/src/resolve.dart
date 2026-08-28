// 2계층 resolve + ICU/CLDR 포맷팅 — 기획서 3.1.
import 'icu.dart';
import 'types.dart';
import 'placeholder.dart';

sealed class OverlayEntry {}
class OverlayValue extends OverlayEntry { final TranslationValue value; OverlayValue(this.value); }
class OverlayTombstone extends OverlayEntry {}

class OverlayLayer {
  final Map<String, Map<String, OverlayEntry>> _map = {};
  void set(String locale, String key, TranslationValue value) =>
      _map.putIfAbsent(locale, () => {})[key] = OverlayValue(value);
  void tombstone(String locale, String key) =>
      _map.putIfAbsent(locale, () => {})[key] = OverlayTombstone();
  OverlayEntry? get(String locale, String key) => _map[locale]?[key];

  static OverlayLayer fromDelta(Delta delta) {
    final o = OverlayLayer();
    for (final op in delta.ops) {
      if (op.op == 'set' && op.value != null) {
        o.set(op.locale, op.key, op.value!);
      } else if (op.op == 'delete') {
        o.tombstone(op.locale, op.key);
      }
    }
    return o;
  }
}

class ResolveResult {
  final TranslationValue? value;
  final String source; // overlay | bundle | unresolved
  final String? matchedLocale;
  final bool guardFallback;
  ResolveResult(this.value, this.source, this.matchedLocale, this.guardFallback);
}

List<String> fallbackChain(String locale, String defaultLocale, [Map<String, String> overrides = const {}]) {
  final chain = <String>[];
  final seen = <String>{};
  String? cur = locale;
  while (cur != null && !seen.contains(cur)) {
    seen.add(cur);
    chain.add(cur);
    final parent = overrides[cur];
    if (parent != null) { cur = parent; continue; }
    final dash = cur.lastIndexOf('-');
    cur = dash > 0 ? cur.substring(0, dash) : null;
  }
  if (!seen.contains(defaultLocale)) chain.add(defaultLocale);
  return chain;
}

ResolveResult resolveValue(Snapshot bundle, OverlayLayer overlay, String key, String locale,
    [Map<String, String> localeOverrides = const {}]) {
  for (final loc in fallbackChain(locale, bundle.defaultLocale, localeOverrides)) {
    final bundleVal = bundle.locales[loc]?[key];
    final entry = overlay.get(loc, key);
    if (entry is OverlayTombstone) continue;
    if (entry is OverlayValue) {
      if (bundleVal != null && !signaturesMatch(entry.value, bundleVal)) {
        return ResolveResult(bundleVal, 'bundle', loc, true); // 포맷 가드
      }
      return ResolveResult(entry.value, 'overlay', loc, false);
    }
    if (bundleVal != null) return ResolveResult(bundleVal, 'bundle', loc, false);
  }
  return ResolveResult(null, 'unresolved', null, false);
}

// ── ICU named 치환 + CLDR 복수형(최소 규칙) ──────────────────────────────────
String format(TranslationValue value, String locale, [Map<String, Object?> args = const {}]) {
  if (value is TextValue) return _substitute(value.value, args, null);
  final map = (value as PluralValue).map;
  final count = _pickCount(args);
  final cat = _pluralCategory(locale, count);
  return _substitute(map[cat] ?? map['other'] ?? '', args, count);
}

String _pluralCategory(String locale, int n) {
  final lang = locale.toLowerCase().split('-').first;
  if (['ko', 'ja', 'zh', 'vi', 'th', 'id', 'ms'].contains(lang)) return 'other';
  if (['en', 'de', 'nl', 'sv', 'da', 'no', 'es', 'it', 'pt'].contains(lang)) return n == 1 ? 'one' : 'other';
  return 'other';
}

final _sub = icuSimpleArg;

String _substitute(String template, Map<String, Object?> args, int? count) {
  var out = template.replaceAllMapped(_sub, (m) {
    final name = m.group(1)!;
    return args.containsKey(name) ? _stringOf(args[name]) : '{$name}';
  });
  if (count != null) out = out.replaceAll('#', count.toString());
  return out;
}

int _pickCount(Map<String, Object?> args) {
  for (final name in ['count', 'n']) {
    final v = _intOf(args[name]);
    if (v != null) return v;
  }
  for (final v in args.values) {
    final i = _intOf(v);
    if (i != null) return i;
  }
  return 0;
}

int? _intOf(Object? v) {
  if (v is int) return v;
  if (v is double && v == v.roundToDouble()) return v.toInt();
  return null;
}

String _stringOf(Object? v) {
  if (v == null) return '';
  if (v is double && v == v.roundToDouble()) return v.toInt().toString();
  return v.toString();
}
