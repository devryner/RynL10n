# SDK 가이드 검증

`sdks/README.md`와 네 SDK 가이드의 코드 블록을 직접 추출해 임시 소비자 프로젝트에서
컴파일·실행한다. UI·앱·함수 틀은 `templates/`가 제공하며 SDK 호출 코드는 README가 원본이다.
관리·배포 서버는 임시 SQLite DB·스토리지와 루프백 임의 포트를 사용하고 실행 후 종료한다.

저장소 루트에서 실행한다:

```bash
npm install
npm run check:sdk-guides                         # 네 SDK 전부
npm run check:sdk-guides -- --only=web            # 쉼표로 여러 SDK 선택 가능
npm run check:sdk-guides -- --only=ios --keep     # 생성한 프로젝트·로그 보관
./tools/ci-local.sh guides                       # 검증 도구 타입 검사·추출 가드 테스트도 포함
```

`./tools/ci-local.sh`의 기본 실행은 기존 5개 컴포넌트 다음에 `guides`도 실행한다.
선택한 SDK의 필수 도구가 없으면 실패한다(SKIP 없음). 성공 시 임시 파일을 삭제하고, 실패 시에는
생성한 소스·컴파일러 로그를 보관해 경로를 출력한다. 외부 명령은 각각 10분으로 제한하며,
중단·실패 때 서버와 자식 프로세스를 종료한다. 중단한 프로세스의 자손도 함께 종료한다.

| 대상 | 필요한 도구 | 검증 범위 |
| --- | --- | --- |
| 공통 | Node ≥ 23.6, 패키지 다운로드 네트워크 | 실제 백엔드로 초기 스냅샷·OTA 델타 생성. README 마커·언어·검증 연결 누락 검사. |
| Web | npm | TypeScript strict, jsdom 초기/원격 렌더, 번들 import/fetch, 캐시, SSE, 서버 텔레메트리 집계, React 서버 렌더. npm 설치 버전은 가이드에서 읽는다. |
| iOS | macOS, Swift 6, 전체 Xcode와 iOS SDK | iOS 15 시뮬레이터 대상 SwiftUI/UIKit 컴파일, macOS SDK 실행, 원격/로컬 SwiftPM 의존 빌드, 플러그인 bake·번들 로드. 시뮬레이터 기동은 필요 없다. |
| Android | Java, JDK 21·17 툴체인, Android SDK 35 | 가이드 Maven 의존·Manifest·AndroidX·Compose 컴파일, Robolectric 초기화·assets·원격 갱신·Compose 재구성. Gradle 래퍼와 JVM 고정 설정은 SDK 것을 복사한다. |
| Flutter | Flutter, Chrome | 가이드 pub.dev 버전으로 analyze, 위젯·IO 실행, Chrome HTTP·localStorage 검증. `path_provider` 캐시 경로는 테스트 플랫폼 구현으로 제공한다. |

Android SDK는 `sdks/android/local.properties`의 `sdk.dir`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`
순서로 찾는다. SDK 35와 build-tools 34.0.0·라이선스를 준비한다. JDK가 없으면 Gradle 툴체인
조달 설정에 따라 다운로드한다. Chrome은 `CHROME_EXECUTABLE`, macOS 기본 설치 경로,
PATH의 `google-chrome`·`chromium`·`chromium-browser` 순서로 찾는다.

`templates/web/package-lock.json`은 검사 도구 버전을 고정한다. Web SDK는 별도로 README의
설치 버전을 받으며, Android·Flutter·원격 SwiftPM도 가이드의 실제 설치 선언을 사용한다.
게시본 설치가 전제라 이 추가 게이트는 **로컬 CI 전용**이다. 미게시 버전을 만드는 태그 Actions의
컴포넌트 게이트와는 분리한다. 게시 후 `smoke:consumer`의 24개 계약 검사는 그대로 유지한다.

예제를 바꿀 때:

1. 기존 `<!-- sdk-guide:SDK.이름 -->` 마커를 유지하고 README 코드를 고친다.
2. 새 Swift·Kotlin·TS/TSX·Dart 예제에는 고유 마커를 붙이고 `run.ts`에 소비 위치와 실행 검증을 연결한다.
   인용문 안의 코드와 Android Manifest·리소스 등록 DSL도 같은 방법으로 추출한다.
3. 해당 SDK를 선택 실행한 뒤 전체 로컬 CI를 실행한다. 마커 없는 새 코드, 중복/오타 마커,
   연결하지 않은 예제, 코드 블록 언어 변경은 실패한다.

예제에서 바꾸는 것은 임시 서버 URL·로컬 패키지/캐시 경로와 문서에 안내된 텔레메트리 옵트인뿐이다.
SDK API를 가짜로 구현하거나 성공하도록 호출을 제거하지 않는다. 검증 범위는 컴파일과 테스트 호스트
실행이며 실기기·배포 앱의 전체 통합을 대신하지 않는다. 검증 도구 자체는
`npm run typecheck:sdk-guides`와 `npm run test:sdk-guides`로 검사한다.
