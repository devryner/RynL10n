/// RynL10n Flutter/Dart SDK (M4 α) 공개 표면.
/// 코어 알고리즘은 M0 TS 참조 구현과 골든 벡터(fixtures/golden)로 정합성 보장.
library rynl10n;

export 'src/types.dart';
export 'src/jcs.dart' show canonicalString, sha256Hex, fileId, snapshotHash;
export 'src/semver.dart' show versionInRange, parseVersion, parseRange, satisfies;
export 'src/intrange.dart' show intInRange, parseIntRange;
export 'src/canary.dart' show bucketOf, inRollout;
export 'src/matching.dart' show selectRelease, findRangeConflicts, ClientContext, ConflictInput, Selection, Matched, NearestLower, BundleOnly;
export 'src/resolve.dart' show OverlayLayer, resolveValue, format, fallbackChain, ResolveResult;
export 'src/placeholder.dart' show signature, signaturesMatch;
export 'src/client.dart';
// 앱 적용 경로(6.3/6.4) — 순수 Dart. `dart:io` 기본 어댑터는 `rynl10n_io.dart` 참조.
export 'src/baked.dart';
export 'src/delivery.dart';
// 앱 적용 경로 ③ 실시간 푸시 신호(4.1/M4)·익명 집계 텔레메트리 업로드(9.3) — 둘 다 옵트인.
// HTTP는 어댑터가 채운다(`rynl10n_io.dart` / `rynl10n_http.dart`).
export 'src/push.dart';
export 'src/telemetry.dart';
