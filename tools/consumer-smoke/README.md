# 소비자 스모크 — 게시본을 실 좌표로 설치해 `t()`까지 굴린다

```bash
npm run smoke:consumer                          # 도구가 있는 채널 전부
npm run smoke:consumer -- --only=npm,pub        # 일부만
npm run smoke:consumer -- --version=0.2.0       # 매니페스트 대신 이 버전을 검증
npm run smoke:consumer -- --keep                # 생성한 소비자 프로젝트를 남긴다
```

## 왜 있는가

**게시가 끝났다는 것과 소비자가 실제로 받아 쓸 수 있다는 것은 다른 명제다.** 그 사이에는 게시본에만
있는 실패가 산다:

- 패키징에서 빠진 파일(`files`·`.pubignore`·`singleVariant`)
- `.d.ts` 경로가 어긋난 `exports` — 설치는 되는데 타입이 안 잡힌다
- POM이 못 끌고 오는 전이 의존성, 또는 스코프가 어긋난 의존성
- 태그가 매니페스트 없는 커밋을 가리키는 경우(SPM은 태그가 곧 버전이다)

저장소 안에서 도는 테스트는 전부 **소스**를 보므로 이 층을 통째로 통과시킨다. `release.yml`의 dry-run도
마찬가지다 — `npm pack`·`pub publish --dry-run`·`publishToMavenLocal`은 **만드는 쪽**만 본다.
받는 쪽을 보는 자리는 여기뿐이다.

되돌리는 롤백이 없다는 점이 이걸 사후 검증으로 만든다. npm·pub.dev·Maven Central은 게시 후 사실상
불변이고 SPM 태그는 삭제·재작성이 소비자의 `Package.resolved`를 조용히 깨뜨린다. 그러니 **게시 직후에
돌려서, 다음 버전을 올리기 전에 알아낸다.**

## 무엇을 하는가

빈 프로젝트 넷을 임시 디렉토리에 만들어 **레지스트리 좌표로만** 의존성을 걸고, 네 언어가 **같은
`checks.json`을 읽어** 같은 6가지를 실행한다:

| 검증 축 | 보는 것 |
| --- | --- |
| 기본 로케일 조회 | 설정 `locale`이 조회 로케일이 되는가 |
| 호출 인자 로케일 우선 | `t(key, args, locale)`이 설정을 이기는가 |
| 플레이스홀더 치환 | ICU 인자 바인딩 |
| 복수형 one / other | CLDR 카테고리 선택(인자가 정수로 전달되는가) |
| 로케일 fallback 체인 | `ko-KR → ko → 기본 로케일` 절단(3.1) |

케이스를 언어마다 따로 적으면 조용히 갈라지고, 갈라진 쪽이 통과해도 아무도 모른다. 그래서 케이스는
`run.ts`의 `CHECKS` 한 곳에 있고 네 프로젝트에 같은 JSON으로 떨어진다 — 골든 벡터와 같은 원리다.
번들 스냅샷도 `fixtures/golden/convert.json`의 것을 그대로 쓴다(스모크 전용 픽스처를 따로 두면 그쪽이
먼저 낡는다).

### 이 검증의 전제 — 소비자 쪽에 로컬 참조를 두지 않는다

`mavenLocal()`·`file:`·`path:`가 **하나라도** 남으면 로컬 산출물을 집어 레지스트리를 건드리지 않고
통과한다. 그러면 검증한 것이 게시본이 아니다. 템플릿의 저장소 선언에 그 셋이 없는 것이 이 도구의
전부이므로, 템플릿을 고칠 때 여기부터 본다.

## 무엇을 하지 않는가

- **원격 갱신 경로를 타지 않는다.** 배포 플레인 fetch·ETag·델타 적용·폴링·푸시·텔레메트리는 각 SDK의
  테스트 스위트가 본다. 여기는 "설치 → 번들 로드 → `t()`"까지다.
- **게시하지 않는다.** 읽기만 한다.
- **CI에 넣지 않았다.** 네 툴체인(Node·Dart·Swift·JDK+Android SDK)과 네 레지스트리 왕복이 필요해
  PR마다 돌릴 물건이 아니다. **태그를 민 직후 로컬에서 한 번** 돌리는 것을 전제로 만들었다.

## 요구 도구 (없는 채널은 SKIP)

| 채널 | 필요한 것 |
| --- | --- |
| npm | `npm` |
| pub.dev | `dart` |
| Maven Central | `java` + `ANDROID_HOME`/`ANDROID_SDK_ROOT`에 `platforms/android-35`. Gradle 래퍼는 `sdks/android` 것을 복사해 쓰므로 시스템 gradle은 필요 없다 |
| SwiftPM | `swift` (macOS) |

**SKIP은 통과가 아니다.** 요약 줄에 몇 개를 건너뛰었는지 적히고, 건너뛴 채널은 검증되지 않은 것이다.
종료 코드는 실행된 채널 중 하나라도 실패하면 1이다.

## 버전 결정

인자가 없으면 세 매니페스트(`sdks/web/package.json` · `sdks/flutter/pubspec.yaml` ·
`sdks/android/library/build.gradle.kts`)에서 읽어 **셋이 같은지 먼저 본다**(`release.yml`의 lockstep
검사와 같은 축). 다르면 즉시 멈춘다. iOS는 매니페스트에 버전이 없다 — SPM은 태그가 곧 버전이라
`--version`(또는 lockstep 값)이 그대로 태그 `v<version>`을 가리킨다.

이미 올라간 버전을 검증하는 도구이므로, 매니페스트를 다음 버전으로 올린 뒤에는 `--version`으로
직전 게시본을 가리켜야 한다.
