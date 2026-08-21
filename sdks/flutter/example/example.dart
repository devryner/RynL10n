// RynL10n Flutter/Dart SDK 예제 — 네트워크·위젯 없이 코어 동작을 그대로 보여준다.
//   dart run example/example.dart
//
// 실제 앱 적용(배포 플레인 HTTP·폴링·푸시·텔레메트리)은 ../README.md 참조.
import 'package:rynl10n/rynl10n.dart';

/// 빌드타임에 구워진 번들(fallback). 실제로는 플러그인이 `assets/rynl10n/snapshot.json`에
/// 굽고 앱이 `parseBakedSnapshot`으로 읽는다 — 여기서는 같은 모양을 손으로 만든다.
Snapshot bakedBundle() => Snapshot(1, 'R42', 'base0', 'en', {
      'en': {
        'cart.title': TextValue('Cart'),
        'cart.greeting': TextValue('Hello, {name}!'),
      },
      'ko': {
        'cart.title': TextValue('장바구니'),
        'cart.greeting': TextValue('{name}님, 안녕하세요!'),
      },
      'ko-KR': {'cart.title': TextValue('장바구니(대한민국)')},
    });

void main() {
  final bundle = bakedBundle();
  final store = InMemoryDeliveryStore();

  // ── ① 2계층 resolve ────────────────────────────────────────────────────────
  // 오버레이는 sparse다 — 바뀐 (로케일, 키)만 담는다. 나머지는 번들이 그대로 받는다.
  // 마지막 op는 플레이스홀더 서명이 번들과 다르다(‹{name}› → ‹{user}›) → 포맷 가드가 잡는다.
  store.putDelta(
    'releases/R42/delta-base0-base1.json',
    Delta('R42', 'base0', 'base1', [
      DeltaOp('set', 'cart.title', 'ko', TextValue('카트')),
      DeltaOp('set', 'cart.greeting', 'ko', TextValue('{user}님 반갑습니다!')),
    ]),
  );

  final manifest = Manifest('shop', 'en', [
    ManifestRelease(
      'R42',
      'published',
      VersionMatch('semver-range', '>=3.2.0 <3.3.0'),
      'base0',
      'base1',
      100,
      'releases/R42/snapshot-base0.json',
      'releases/R42/delta-base0-base1.json',
    ),
  ]);

  final client = RynL10nClient(
    bundle: bundle,
    store: store,
    context: ClientContext(appVersion: '3.2.1'), // 어느 릴리스를 받을지(4.3)
    locale: 'ko', // 그 안에서 어느 언어를 읽을지(6.1)
  );

  print('── ① 2계층 resolve (오버레이 → 번들, 키 단위) ──');
  print('  갱신 전  cart.title = ${client.t('cart.title')}');
  client.refresh(manifest);
  print('  갱신 후  cart.title = ${client.t('cart.title')}   ← 오버레이가 덮었다');

  // ── ② 포맷 안전 가드 ──────────────────────────────────────────────────────
  // 오버레이 값의 플레이스홀더가 번들과 다르면 그 키만 번들로 물러난다.
  // 이 가드가 없으면 {name}을 기대한 화면이 원격 문자열 하나로 깨진다.
  print('\n── ② 포맷 안전 가드 (서명 불일치 키만 번들로) ──');
  print('  cart.greeting = ${client.t('cart.greeting', args: {'name': '지원'})}');
  print('  ↑ 오버레이는 {user}를 썼다 → 무시하고 번들({name})을 쓴다');

  // ── ③ 로케일 fallback 체인 ────────────────────────────────────────────────
  // 구체 → 일반 → 기본 로케일 순으로 절단한다. 각 단계에서 오버레이·번들을 모두 본 뒤 다음 로케일로.
  print('\n── ③ 로케일 fallback 체인 (ko-KR → ko → en) ──');
  for (final locale in ['ko-KR', 'ko', 'ja', 'en']) {
    print('  $locale'.padRight(10) + '→ ${client.t('cart.title', locale: locale)}');
  }
  print('  ja는 카탈로그에 없다 → 기본 로케일(en)로 내려간다');

  // ── ④ 버전 격리 ──────────────────────────────────────────────────────────
  // 앱 버전이 릴리스 범위 밖이면 아무 오버레이도 받지 않는다 — 구버전에 새 문구가 새지 않는다.
  print('\n── ④ 버전 격리 (4.3) ──');
  final oldApp = RynL10nClient(
    bundle: bundle,
    store: store,
    context: ClientContext(appVersion: '3.1.0'), // 릴리스 범위(>=3.2.0) 밖
    locale: 'ko',
  );
  oldApp.refresh(manifest);
  print('  앱 3.2.1 → ${client.selectionKind.padRight(12)} cart.title = ${client.t('cart.title')}');
  print('  앱 3.1.0 → ${oldApp.selectionKind.padRight(12)} cart.title = ${oldApp.t('cart.title')}');
  print('  ↑ 범위 밖이라 번들만 쓴다 — 네트워크가 없어도 번역 공백은 생기지 않는다');
}
