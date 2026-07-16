// DoD ① — 시나리오 A/B/C를 public API(RynL10nClient)로 재현.
import 'package:test/test.dart';
import 'package:rynl10n/rynl10n.dart';

Snapshot snap(String release, String base, Map<String, Map<String, String>> locales) {
  final tv = locales.map((loc, keys) =>
      MapEntry(loc, keys.map((k, v) => MapEntry(k, TextValue(v) as TranslationValue))));
  return Snapshot(1, release, base, 'en', tv);
}

void main() {
  test('시나리오 A — OTA 오타 긴급 수정 + 롤백', () {
    final v0 = snap('R42', 'base0', {'en': {'pay.button': 'Pay'}, 'ja': {'pay.button': '支払―'}});
    final delta = Delta('R42', 'base0', 'base1', [DeltaOp('set', 'pay.button', 'ja', TextValue('支払い'))]);
    final store = InMemoryDeliveryStore();
    store.putSnapshot('releases/R42/snapshot-base0.json', v0);
    store.putDelta('releases/R42/delta-base0-base1.json', delta);

    final published = ManifestRelease('R42', 'published', VersionMatch('semver-range', '>=3.2.0 <3.3.0'),
        'base0', 'base1', 100, 'releases/R42/snapshot-base0.json', 'releases/R42/delta-base0-base1.json');
    final manifest = Manifest('shop', 'en', [published]);

    final client = RynL10nClient(bundle: v0, store: store, context: ClientContext(appVersion: '3.2.1'));
    var notified = 0;
    client.onCatalogUpdated((_) => notified++);

    expect(client.t('pay.button', locale: 'ja'), '支払―');
    expect(client.refresh(manifest), true);
    expect(client.t('pay.button', locale: 'ja'), '支払い');
    expect(notified, 1);

    final rolledBack = ManifestRelease('R42', 'published', VersionMatch('semver-range', '>=3.2.0 <3.3.0'),
        'base0', 'base0', 100, 'releases/R42/snapshot-base0.json', null);
    client.refresh(Manifest('shop', 'en', [rolledBack]));
    expect(client.t('pay.button', locale: 'ja'), '支払―');
  });

  test('시나리오 B — 결정적 bake(같은 카탈로그 → 같은 base, NFC 무관)', () {
    final a = {'en': {'greet': 'Hello'}, 'ko': {'greet': '안녕하세요'}};
    final b = {'ko': {'greet': '안녕하세요'}, 'en': {'greet': 'Hello'}};
    final ha = snapshotHash('R1', 'en', a);
    expect(snapshotHash('R1', 'en', b), ha); // 키 순서 무관
    expect(fileId(ha).length, 16);
  });

  test('시나리오 C — 앱 버전별 격리(신규 키가 구버전에 안 샘)', () {
    final r42 = snap('R42', 'r42', {'en': {'home.title': 'Home'}});
    final r50 = snap('R50', 'r50', {'en': {'home.title': 'Home', 'home.newBadge': 'NEW'}});
    final store = InMemoryDeliveryStore();
    store.putSnapshot('releases/R42/snapshot-r42.json', r42);
    store.putSnapshot('releases/R50/snapshot-r50.json', r50);

    final releases = [
      ManifestRelease('R42', 'superseded', VersionMatch('semver-range', '>=3.2.0 <3.3.0'), 'r42', 'r42', 100, 'releases/R42/snapshot-r42.json', null),
      ManifestRelease('R50', 'published', VersionMatch('semver-range', '>=3.3.0'), 'r50', 'r50', 100, 'releases/R50/snapshot-r50.json', null),
    ];
    final manifest = Manifest('app', 'en', releases);

    final oldApp = RynL10nClient(bundle: r42, store: store, context: ClientContext(appVersion: '3.2.5'));
    oldApp.refresh(manifest);
    expect(oldApp.releaseId, 'R42');
    expect(oldApp.t('home.newBadge'), '⟪home.newBadge⟫');

    final newApp = RynL10nClient(bundle: r50, store: store, context: ClientContext(appVersion: '3.3.1'));
    newApp.refresh(manifest);
    expect(newApp.releaseId, 'R50');
    expect(newApp.t('home.newBadge'), 'NEW');
  });

  test('카나리 게이트: rollout 0 → 오버레이 미수신', () {
    final v0 = snap('R1', 'b0', {'en': {'greet': 'old'}});
    final delta = Delta('R1', 'b0', 'b1', [DeltaOp('set', 'greet', 'en', TextValue('new'))]);
    final store = InMemoryDeliveryStore();
    store.putDelta('releases/R1/delta-b0-b1.json', delta);
    final rel = ManifestRelease('R1', 'published', VersionMatch('semver-range', '>=1.0.0'), 'b0', 'b1', 0, 'releases/R1/snapshot-b0.json', 'releases/R1/delta-b0-b1.json');
    final client = RynL10nClient(bundle: v0, store: store, context: ClientContext(appVersion: '1.0.0'), installId: 'device-1');
    client.refresh(Manifest('p', 'en', [rel]));
    expect(client.t('greet'), 'old'); // rollout 0 → 미수신
  });

  test('정수 빌드 넘버 매칭', () {
    final releases = [
      ManifestRelease('B1', 'published', VersionMatch('integer-range', '>=42 <50'), 'b1', 'b1', 100, 's1', null),
      ManifestRelease('B2', 'published', VersionMatch('integer-range', '>=50'), 'b2', 'b2', 100, 's2', null),
    ];
    expect(selectRelease(releases, ClientContext(buildNumber: 45)).releaseId, 'B1');
    expect(selectRelease(releases, ClientContext(buildNumber: 60)).releaseId, 'B2');
  });
}
