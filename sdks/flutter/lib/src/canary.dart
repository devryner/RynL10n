// 카나리 버킷팅 — 기획서 8.4. hash(installId+releaseId) mod 100 < rollout%.
// SHA-256 앞 32비트 → mod 100. 전 언어 결정적. installId=기기 로컬 익명 난수(서버 미전송).
import 'dart:convert';
import 'package:crypto/crypto.dart';

int bucketOf(String installId, String releaseId) {
  final bytes = sha256.convert(utf8.encode('$installId:$releaseId')).bytes;
  final u32 = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  return u32 % 100;
}

/// rollout>=100 → 전체. installId 없으면 rollout<100에서 보수적으로 미수신.
bool inRollout(int rollout, String? installId, String releaseId) {
  if (rollout >= 100) return true;
  if (rollout <= 0) return false;
  if (installId == null) return false;
  return bucketOf(installId, releaseId) < rollout;
}
