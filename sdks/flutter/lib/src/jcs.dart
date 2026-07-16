// RFC 8785 JCS + 콘텐츠 해시 — 기획서 11.1. M0 TS 참조와 바이트 동일(fixtures/golden 검증).
import 'dart:convert';
import 'package:crypto/crypto.dart';
import 'package:unorm_dart/unorm_dart.dart' as unorm;

String canonicalString(dynamic value) {
  final sb = StringBuffer();
  _emit(value, sb);
  return sb.toString();
}

List<int> canonicalBytes(dynamic value) => utf8.encode(canonicalString(value));

void _emit(dynamic value, StringBuffer sb) {
  if (value == null) {
    sb.write('null');
  } else if (value is bool) {
    sb.write(value ? 'true' : 'false');
  } else if (value is int) {
    sb.write(value.toString());
  } else if (value is double) {
    if (value.isFinite && value == value.roundToDouble()) {
      sb.write(value.toInt().toString());
    } else {
      throw ArgumentError('JCS: 비정수 number는 범위 밖 ($value)');
    }
  } else if (value is String) {
    _emitString(value, sb);
  } else if (value is List) {
    sb.write('[');
    for (var i = 0; i < value.length; i++) {
      if (i > 0) sb.write(',');
      _emit(value[i], sb);
    }
    sb.write(']');
  } else if (value is Map) {
    final keys = value.keys.map((k) => k as String).toList()..sort(); // UTF-16 코드유닛 순
    sb.write('{');
    for (var i = 0; i < keys.length; i++) {
      if (i > 0) sb.write(',');
      _emitString(keys[i], sb);
      sb.write(':');
      _emit(value[keys[i]], sb);
    }
    sb.write('}');
  } else {
    throw ArgumentError('JCS: 직렬화할 수 없는 타입 ${value.runtimeType}');
  }
}

void _emitString(String raw, StringBuffer sb) {
  final s = unorm.nfc(raw);
  sb.write('"');
  for (final cu in s.codeUnits) {
    switch (cu) {
      case 0x22: sb.write('\\"'); break;
      case 0x5C: sb.write('\\\\'); break;
      case 0x08: sb.write('\\b'); break;
      case 0x09: sb.write('\\t'); break;
      case 0x0A: sb.write('\\n'); break;
      case 0x0C: sb.write('\\f'); break;
      case 0x0D: sb.write('\\r'); break;
      default:
        if (cu < 0x20) {
          sb.write('\\u');
          sb.write(cu.toRadixString(16).padLeft(4, '0'));
        } else {
          sb.writeCharCode(cu);
        }
    }
  }
  sb.write('"');
}

const int fileIdHex = 16;
const int fileIdHexExtended = 20;

String sha256Hex(dynamic value) => sha256.convert(canonicalBytes(value)).toString();

String fileId(String fullHash, [Set<String> taken = const {}]) {
  final short = fullHash.substring(0, fileIdHex);
  return taken.contains(short) ? fullHash.substring(0, fileIdHexExtended) : short;
}

String snapshotHash(String release, String defaultLocale, dynamic locales) =>
    sha256Hex({'release': release, 'defaultLocale': defaultLocale, 'locales': locales});
