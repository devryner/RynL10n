/// 조회 로케일 축 — 기획서 6.1(configure options의 로케일) / 3.1(fallback 체인).
///
/// 회귀 방지가 목적이다. 이전 구현은 `t()`의 기본 조회 로케일을
/// `locale ?? context.releaseLabel ?? bundle.defaultLocale`로 계산했는데, `releaseLabel`은
/// 5.2의 `versionMatch.strategy = 'exact-label'` 판정값이지 로케일이 아니다.
/// **릴리스 매칭 축(4.3)과 로케일 축(3.1)이 서로 새면 안 된다** — 새면 exact-label을 쓰는 앱이
/// 조용히 기본 로케일로 떨어지고(크래시가 없어 드러나지 않는다) 로케일 설정 수단도 사라진다.
/// 4개 SDK가 같은 축을 본다(파리티).
import 'package:test/test.dart';
import 'package:rynl10n/rynl10n.dart';
import 'package:rynl10n/rynl10n_io.dart';

final bundle = Snapshot(1, 'R1', 'b0', 'en', {
  'en': {'cart.title': TextValue('Cart')},
  'ko': {'cart.title': TextValue('장바구니')},
  'ko-KR': {'cart.title': TextValue('장바구니(KR)')},
});

RynL10nClient client({String? locale, ClientContext? context}) => RynL10nClient(
      bundle: bundle,
      store: InMemoryDeliveryStore(),
      context: context ?? ClientContext(appVersion: '1.0.0'),
      locale: locale,
    );

void main() {
  test('locale 미지정이면 번들 기본 로케일 — 코어는 플랫폼 API를 모른다', () {
    expect(client().t('cart.title'), 'Cart');
  });

  test('config locale이 t()의 기본 조회 로케일이 된다(6.1)', () {
    final c = client(locale: 'ko');
    expect(c.t('cart.title'), '장바구니');
    expect(c.t('cart.title', locale: 'en'), 'Cart', reason: '호출 인자가 설정을 이긴다');
  });

  test('config locale도 fallback 체인을 탄다(3.1) — 구체→일반→기본', () {
    expect(client(locale: 'ko-KR').t('cart.title'), '장바구니(KR)');
    expect(client(locale: 'ko-Hang-KR').t('cart.title'), '장바구니', reason: '구체→일반 절단');
    expect(client(locale: 'fr-FR').t('cart.title'), 'Cart', reason: '어디에도 없으면 기본 로케일');
  });

  test('회귀: releaseLabel은 조회 로케일로 새지 않는다(매칭 축 ≠ 로케일 축)', () {
    // exact-label 전략을 쓰는 앱. 이전 구현은 조회 로케일을 '2024-spring'으로 삼아
    // 체인 ['2024-spring', 'en']을 타고 기본 로케일로 떨어졌다.
    final ctx = ClientContext(releaseLabel: '2024-spring');
    expect(client(locale: 'ko', context: ctx).t('cart.title'), '장바구니',
        reason: 'releaseLabel이 설정 로케일을 가리면 안 된다');
    expect(client(context: ctx).t('cart.title'), 'Cart',
        reason: '로케일 미지정이면 releaseLabel이 아니라 번들 기본 로케일');
  });

  test('ioDeviceLocale: BCP 47이거나 null — POSIX 형식을 그대로 넘기지 않는다', () {
    // 값 자체는 실행 환경에 달렸다. 계약은 fallback 체인(3.1)이 `-`로 절단할 수 있는 형태뿐.
    final tag = ioDeviceLocale();
    if (tag == null) return;
    expect(tag, isNotEmpty);
    expect(tag.contains('_'), isFalse, reason: 'ko_KR.UTF-8 → ko-KR로 정규화돼야 한다');
    expect(tag.contains('.'), isFalse, reason: '인코딩 접미사가 남으면 체인이 엉뚱하게 절단된다');
  });
}
