// SDK 런타임 (배포 플레인 소비자) — 기획서 6.1 / 6.4. 카나리 게이트(8.4) 포함.
import 'types.dart';
import 'matching.dart';
import 'resolve.dart';
import 'canary.dart';

abstract class DeliveryStore {
  Snapshot? getSnapshot(String path);
  Delta? getDelta(String path);
}

class InMemoryDeliveryStore implements DeliveryStore {
  final Map<String, Snapshot> _snapshots = {};
  final Map<String, Delta> _deltas = {};
  void putSnapshot(String path, Snapshot s) => _snapshots[path] = s;
  void putDelta(String path, Delta d) => _deltas[path] = d;
  @override
  Snapshot? getSnapshot(String path) => _snapshots[path];
  @override
  Delta? getDelta(String path) => _deltas[path];
}

class TelemetryCounts {
  int overlayApplied = 0, formatGuardRejected = 0, keyUnresolved = 0, deltaFailed = 0;
}

class UpdateInfo { final String release; final String overlayTarget; UpdateInfo(this.release, this.overlayTarget); }

class RynL10nClient {
  final Snapshot bundle;
  final DeliveryStore store;
  final ClientContext context;

  /// 조회 로케일(6.1). [t]에 로케일을 넘기지 않았을 때 쓰인다. **[context]와는 다른 축이다** —
  /// [context]는 어느 릴리스를 받을지(4.3), 이 값은 그 릴리스 안에서 어느 언어를 읽을지를 정한다.
  ///
  /// null이면 번들의 기본 로케일(5.1). 코어는 플랫폼 API를 모르므로 기기 언어는 앱이 넘긴다 —
  /// Flutter는 `Localizations.localeOf(context).toLanguageTag()`,
  /// 위젯 밖이면 `PlatformDispatcher.instance.locale.toLanguageTag()`,
  /// 순수 Dart는 `rynl10n_io.dart`의 `ioDeviceLocale()`.
  final String? locale;

  final Map<String, String> localeOverrides;
  final String? installId;
  final String telemetry; // off | aggregate

  Snapshot _activeBundle;
  OverlayLayer _overlay = OverlayLayer();
  Selection _selection = BundleOnly();
  String? _overlayTarget;
  final List<void Function(UpdateInfo)> _listeners = [];
  final TelemetryCounts _tel = TelemetryCounts();

  RynL10nClient({
    required this.bundle,
    required this.store,
    required this.context,
    this.locale,
    this.localeOverrides = const {},
    this.installId,
    this.telemetry = 'off',
  }) : _activeBundle = bundle;

  void Function() onCatalogUpdated(void Function(UpdateInfo) listener) {
    _listeners.add(listener);
    return () => _listeners.remove(listener);
  }

  void _bump(String event) {
    if (telemetry != 'aggregate') return;
    switch (event) {
      case 'overlay_applied': _tel.overlayApplied++; break;
      case 'format_guard_rejected': _tel.formatGuardRejected++; break;
      case 'key_unresolved': _tel.keyUnresolved++; break;
      case 'delta_failed': _tel.deltaFailed++; break;
    }
  }

  TelemetryCounts drainTelemetry() {
    final s = TelemetryCounts()
      ..overlayApplied = _tel.overlayApplied
      ..formatGuardRejected = _tel.formatGuardRejected
      ..keyUnresolved = _tel.keyUnresolved
      ..deltaFailed = _tel.deltaFailed;
    _tel.overlayApplied = _tel.formatGuardRejected = _tel.keyUnresolved = _tel.deltaFailed = 0;
    return s;
  }

  /// 전송에 실패한 배치를 되돌린다(`TelemetryReporter` 전용, 9.3).
  /// 드레인 이후 새로 쌓인 카운트에 **더한다** — 실패 구간이 사라지면 카나리 판정(8.4)이
  /// 실제보다 건강해 보인다.
  void mergeTelemetry(TelemetryCounts counts) {
    _tel.overlayApplied += counts.overlayApplied;
    _tel.formatGuardRejected += counts.formatGuardRejected;
    _tel.keyUnresolved += counts.keyUnresolved;
    _tel.deltaFailed += counts.deltaFailed;
  }

  bool refresh(Manifest manifest) {
    final selection = selectRelease(manifest.releases, context);
    _selection = selection;
    if (selection is BundleOnly) {
      return _swap(bundle, OverlayLayer(), null, null);
    }
    final release = selection is Matched ? selection.release : (selection as NearestLower).release;

    var active = bundle;
    if (release.base != bundle.base) {
      final fetched = store.getSnapshot(release.snapshot);
      if (fetched == null) return false;
      active = fetched;
    }
    if (release.overlay == release.base || release.delta == null) {
      return _swap(active, OverlayLayer(), release.id, release.base);
    }
    // 카나리 게이트(8.4).
    if (!inRollout(release.rollout, installId, release.id)) {
      return _swap(active, OverlayLayer(), release.id, release.base);
    }
    final delta = store.getDelta(release.delta!);
    if (delta == null) { _bump('delta_failed'); return false; }
    if (delta.from != active.base) { _bump('delta_failed'); return false; }
    final changed = _swap(active, OverlayLayer.fromDelta(delta), release.id, release.overlay);
    if (changed) _bump('overlay_applied');
    return changed;
  }

  String t(String key, {Map<String, Object?> args = const {}, String? locale}) {
    final loc = locale ?? this.locale ?? _activeBundle.defaultLocale;
    final r = resolveValue(_activeBundle, _overlay, key, loc, localeOverrides);
    if (r.guardFallback) _bump('format_guard_rejected');
    if (r.value == null) { _bump('key_unresolved'); return '⟪$key⟫'; }
    return format(r.value!, r.matchedLocale ?? loc, args);
  }

  ResolveResult resolve(String key, String locale) =>
      resolveValue(_activeBundle, _overlay, key, locale, localeOverrides);

  String get selectionKind => _selection.kind;
  String? get releaseId => _selection.releaseId;
  String get activeBase => _activeBundle.base;

  bool _swap(Snapshot b, OverlayLayer o, String? releaseId, String? overlayTarget) {
    final changed = b.base != _activeBundle.base || overlayTarget != _overlayTarget;
    _activeBundle = b;
    _overlay = o;
    _overlayTarget = overlayTarget;
    if (changed && releaseId != null && overlayTarget != null) {
      for (final l in List.of(_listeners)) l(UpdateInfo(releaseId, overlayTarget));
    }
    return changed;
  }
}
