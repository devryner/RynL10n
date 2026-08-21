# rynl10n 예제

`example.dart` 하나로 SDK의 핵심 경로를 전부 보여준다 — 네트워크도 Flutter 위젯도 없이 `dart run
example/example.dart`로 그대로 돌아간다. 실제 앱에 붙이는 절차는 [`../README.md`](../README.md)를 본다.

```bash
cd sdks/flutter && dart pub get && dart run example/example.dart
```

보여주는 것은 넷이다.

1. **2계층 resolve**(3.1) — 원격 오버레이가 번들 위를 키 단위로 덮고, 없는 키는 번들이 받는다.
2. **로케일 fallback 체인**(3.1) — `ko-KR → ko → 기본 로케일`. 조회 로케일은 릴리스 매칭 축과
   별개라 `locale` 인자로 정한다(6.1).
3. **포맷 안전 가드**(3.1) — 오버레이의 플레이스홀더 서명이 번들과 다르면 그 키만 번들로 물러난다.
   런타임 크래시를 막는 자리다.
4. **버전 격리**(4.3) — 앱 버전이 어느 릴리스 범위에 드는지에 따라 받는 카탈로그가 달라진다.

예제는 `InMemoryDeliveryStore`를 쓴다. 실제 배포 플레인(CDN)에 붙일 때는
`RemoteDeliveryStore` + `rynl10n_io.dart`(모바일·데스크톱) 또는 `rynl10n_http.dart`(웹 포함)를
쓴다 — 두 진입점의 차이는 [`../README.md`](../README.md)에 있다.
