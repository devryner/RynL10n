# RynL10n — 핸드오버

> 앱 업데이트·심사 없이 번역을 배포하는 오픈소스 원격 로컬라이제이션 인프라.
> **빌드타임 자동 번들(fallback) + 런타임 원격 오버레이의 2계층**으로 항상 완전한 번역을 보장하며 즉시 갱신.

이 문서는 저장소를 처음 여는 사람(또는 나중에 돌아온 나)을 위한 전체 지도다. **설계의 단일 원천(SoT)은
Craft 기획서**이고(아래 참조), 이 저장소는 그 기획서를 구현·검증한 코드다. 상충 시 기획서가 우선한다.

## 현재 상태 (한눈에)

- **로드맵 M0~M4 전 마일스톤 완주 + 파리티 마감 + 대시보드 + 4개 플랫폼 앱 적용 경로.**
  커밋 56개(`1c0e225`~`fb3ee70` — 이 줄을 갱신하는 문서 커밋 자신은 세지 않으므로 항상 한 칸 뒤처진다.
  정확한 값은 `git rev-list --count HEAD`). **전부 `origin/main` 머지 완료(PR #1~#12, rebase —
  머지 커밋 없는 선형 이력)**.
- **테스트 405개 전부 통과** — TS 참조 72 · 백엔드 145 · Web 33 · iOS 49 · Android 53 · Flutter 53.
  (2026-08-25 빈 문자열 처리 3건 수정 + 회귀 10개 추가 후 **GitHub Actions CI에서 5개 컴포넌트 전부 재실행**
  — run 32833302282. 같은 날 릴리스 dry-run 4채널 통과 — 아래 "SDK 배포 채널" 절.)
  (2026-08-21 로케일 축 분리 후 전 컴포넌트 재실행 + `gen:golden` diff 없음 + `examples/ios-consumer` 빌드 확인.)
  (2026-08-13 전 컴포넌트 재실행, 2026-08-19 사용자 관리 · 2026-08-20 번역 import·관측성 탭 추가 후
  TS 참조·백엔드 재실행 — 골든 벡터·산출물은 무변경이라 SDK 코어는 영향 없음.
  2026-08-20 **4개 SDK 전부에 폴링·SSE 푸시·텔레메트리 업로드**를 맞추고 전 컴포넌트 재실행 +
  iOS는 실제 백엔드 대상 왕복 확인.)
  `npm run typecheck` · `npm run typecheck:backend` · `tsc -p sdks/web` · `dart analyze` 클린.
- 기획서의 모든 확정 설계가 구현·검증됨. 남은 것은 실제 앱/외부 환경 의존 항목뿐이다
  (아래 "열려 있는 항목" 참조 — 관리 API의 UI 격차는 2026-08-25에 마감했다).
- 스파이크에서 발견한 스펙 조정 1건(11.3 superseded 라우팅)은 **Craft 기획서에 이미 반영**됨.

## 두 가지 차별점 (나머지는 경쟁사도 하는 패리티)

1. **빌드타임 자동 번들링** — 플러그인 한 줄, 커밋할 파일 없음. iOS SPM build tool plugin으로 실증
   (`swift build` → 스냅샷을 앱 리소스 번들에 자동 bake).
2. **완전 오픈소스 셀프호스팅** — 백엔드까지 오픈소스, `docker compose up` 원커맨드, Apache-2.0 단일 라이선스.

## 저장소 구조

```
src/                  M0 참조 구현(TypeScript) — 결정적 코어의 단일 원천. 백엔드가 이걸 재사용한다.
  serialize/          RFC 8785 JCS + NFC + SHA-256 (11.1)
  core/               types · semver · intrange · canary · matching · placeholder · resolve
  builder/            snapshot/델타/manifest 생성 · bake · 네이티브 포맷 변환(convert)
  client/             SDK 런타임 참조 구현(2계층 resolve + 카나리 + 텔레메트리)
test/                 참조 구현 유닛 + 시나리오 A/B/C 테스트
tools/gen-golden.ts   골든 벡터 생성기 → fixtures/golden/*.json (크로스언어 계약)
fixtures/golden/      12종 골든 벡터. 4개 언어 SDK가 이걸로 정합성 검증.

backend/              M2 관리 백엔드(TypeScript, node:sqlite). ../src/builder 재사용.
  src/db/             스키마 + Repo (정규화 관계형 SoT) — 마이그레이션은 schema.ts의 MIGRATIONS
  src/pipeline/       publish/롤백 파이프라인(7.4/8.x)
  src/storage/        store.ts=산출물 스토리지(FS, MinIO/S3 대체 가능) ·
                      delivery-server.ts=배포 플레인 정적 서버(ETag·조건부 304·CORS)
  src/api/            REST 관리 API(7.1) + SSE 실시간 푸시 + 키 설명 사이드카(descriptions).
                      `createManagementHandler` export로 소비자 서버에 마운트 가능(서버를 직접 띄우지 않는 경로).
                      `DELETE /projects/{p}`는 admin 전용 + 스토리지 경로 순회 가드.
  src/auth/           스코프 토큰 + RBAC 4역할(7.3) + DbTokenRegistry(사용자 토큰 영속 인증)
  src/observability/  Prometheus 메트릭 · 텔레메트리 · Notifier
  src/admin/          데이터 이식성 + 재해복구 rebuild(9.4)
  src/ui/             대시보드(어드민 앱) — 바닐라 ES 모듈, 빌드 스텝 0. `/`·`/ui/*`로 서빙
  src/main.ts         단일 노드 엔트리(관리 API + 배포 정적 서버)

sdks/ios/             Swift/SPM SDK + rynl10n-bake CLI + SPM build tool plugin
                      앱 적용 경로: RemoteDelivery.swift(배포 플레인 HTTP) · BakedBundle.swift(번들 로더)
sdks/android/         Kotlin/JVM 코어 + bake CLI(Gradle task)
  library/            배포 아티팩트(AAR) — 코어 소스 재컴파일 + Android 바인딩(Context·Compose)
                      앱 적용 경로: RemoteDelivery.kt(배포 플레인 HTTP) · BakedBundle.kt(assets 로더)
sdks/web/             @rynl10n/web — 코어 재사용 + fetch/ETag 폴링 + SSE 푸시 + React 어댑터
                      앱 적용 경로: baked.ts(번들 로더) · cache.ts(영속 캐시=localStorage) · http.ts
sdks/flutter/         순수 Dart SDK(dart test 검증)
                      앱 적용 경로: baked.dart · delivery.dart(순수, DI)
                      어댑터 진입점: rynl10n_io.dart(dart:io, 웹 불가) / rynl10n_http.dart(package:http, 웹 O)
examples/ios-consumer/  SPM 플러그인 소비 예제(플러그인 한 줄 → 자동 bake)

docker-compose.yml · backend/Dockerfile   단일 노드 셀프호스트(9.1)
OPERATIONS.md         운영 가이드(설치·업그레이드·백업·에어갭·관측성, 9.4)  ← git 미추적(로컬 전용)
AGENTS.md             에이전트용 저장소 요약 + 확정 스택(추적본)
CLAUDE.md             AGENTS.md의 사본                                     ← git 미추적(로컬 전용)
HANDOVER.md           이 문서
LICENSE · NOTICE      Apache-2.0
```

> **로컬 전용 문서는 `CLAUDE.md` 하나뿐이다** — `AGENTS.md`와 같은 내용의 사본이라 클론에 둘 다
> 있을 이유가 없다(한쪽을 고치면 다른 쪽도 같이 고친다). `OPERATIONS.md`는 `74563f7`에서,
> 이 문서는 그 뒤에 추적으로 되돌렸다 — 셋 다 `54ec5fe`에서 SoT를 Craft로 옮기며 한꺼번에 빠졌지만,
> **추적 파일들이 링크로 가리키는 문서가 클론에 없으면 그 링크는 GitHub에서 404**다.
> 비공개 사유였던 Craft rootBlockId는 이미 `AGENTS.md`가 공개하고 있어(그 자체로는 자격 증명이
> 아니고 열람에 인증이 필요하다) 이 문서를 감춰서 얻는 것이 없었다.

## 빌드 & 테스트 (컴포넌트별)

| 컴포넌트 | 위치 | 명령 | 툴체인 |
| --- | --- | --- | --- |
| 참조 구현(TS) | 루트 | `npm test` · `npm run typecheck` · `npm run demo` | Node ≥ 23.6 |
| 골든 벡터 재생성 | 루트 | `npm run gen:golden` | Node |
| 백엔드 | 루트 | `npm run test:backend` · `npm run typecheck:backend` · `npm run backend` | Node ≥ 23.6 |
| iOS SDK | `sdks/ios` | `swift test` · `swift run rynl10n-bake …` | Swift 6 |
| Android SDK | `sdks/android` | `gradle test` · `gradle rynl10nBake …` | Gradle 9 / JDK 21 |
| Web SDK | `sdks/web` | `node --test "test/*.test.ts"` | Node ≥ 23.6 |
| Flutter SDK | `sdks/flutter` | `dart pub get && dart test` | Dart 3.5+ |
| 셀프호스트 | 루트 | `docker compose up` | Docker |

> **런타임 의존성 0 원칙**: 참조·백엔드·iOS는 외부 런타임 의존성 없음(Node 내장 sqlite/crypto, CryptoKit).
> Android=kotlinx(serialization·coroutines), Flutter=crypto·unorm_dart(NFC), 백엔드 devDep=typescript.

## SDK 배포 채널 (기획서 6.5) — **npm·pub.dev 게시됨(2026-08-26), 나머지 2채널 대기**

버전은 **4개 SDK lockstep**(현재 `0.1.0`). 채널·좌표는 확정돼 각 매니페스트에 박혀 있고
게시 자동화도 `.github/workflows/`에 들어와 있다(`ci.yml`·`release.yml` — 아래 "릴리스 CI").
**2026-08-26 npm `@rynl10n/web@0.1.0`과 pub.dev `rynl10n@0.1.0`이 실제로 게시됐다** —
이 저장소 최초의 레지스트리 게시다. 릴리스 태그는 여전히 0개이고(태그 경로가 아니라 둘 다 로컬 수동
게시였다 — 아래 "두 레지스트리의 부트스트랩"), 남은 2채널을 막는 것은 **저장소 밖 항목뿐이다** —
Sonatype 계정·서명키·시크릿 등록. (iOS 미러 저장소는 2026-08-26에 없앴다 — 아래 절.)

| SDK | 채널 | 좌표 | 매니페스트 | 게시 상태 | 지금 붙이는 법 |
| --- | --- | --- | --- | --- | --- |
| iOS | SwiftPM (git 태그) | **이 저장소** + 태그 `v*` | 루트 `Package.swift` — products 3종(library·`rynl10n-bake` CLI·build tool plugin), 소스는 `sdks/ios/`를 path로 | 태그 0개 — **태그가 곧 배포**라 게시 잡이 없다 | `.package(path: "../..")` (`examples/ios-consumer`가 이 경로) |
| Android | Maven Central (AAR) | `com.devryner.rynl10n:android:0.1.0` | `sdks/android/library/build.gradle.kts` — `maven-publish` + release variant + sources/javadoc jar + POM(라이선스·SCM·developer) 완비 | **Central 미게시** — 저장소 측 준비 끝, 서명키·계정만 남음 | `./gradlew :library:publishToMavenLocal` + 앱에 `mavenLocal()` |
| Web | npm (**`tsc` 게시 빌드** — `.js`+`.d.ts`) | `@rynl10n/web` | `sdks/web/package.json` — version `0.1.0`, `files`·`exports`·`prepack`(게시 빌드) 완비, `private` 제거 | ✅ **게시됨** `0.1.0` (2026-08-26, 로컬 수동 — provenance 미첨부) | `npm i @rynl10n/web` |
| Flutter | pub.dev | `rynl10n` | `sdks/flutter/pubspec.yaml` — version `0.1.0`, `publish_to` 해제, `.pubignore` | ✅ **게시됨** `0.1.0` (2026-08-26, 로컬 수동) | `dart pub add rynl10n` |

### iOS는 매니페스트가 루트에 있어야 한다 (6.5) — **미러 저장소를 없앴다(2026-08-26)**

**SwiftPM은 저장소 루트의 `Package.swift`만 패키지로 인식한다.** `.package(url:)`에 하위 경로를 줄 수
없다 — swift-package-manager#5768("Allow Package.swift not at the root")은 2022년에 닫혔고 Swift 6.3에도
`subdir` 문법이 없다(로컬 6.3.3에서 확인). 그러나 **제약은 매니페스트 위치에만 걸리고 소스 위치는
자유롭다.** 그래서 루트에 `Package.swift`를 두고 타깃이 `path:`로 `sdks/ios/`를 가리킨다 —
4개 언어 SDK가 `sdks/` 밑에 대칭으로 놓이는 레이아웃은 그대로다.

**소비자**: `.package(url: "https://github.com/devryner/RynL10n", from: "0.1.0")`.
**태그가 곧 배포**이므로 릴리스 워크플로에 iOS 게시 잡이 없다.

기각안: `sdks/ios/`를 subtree push하는 **미러 저장소 `rynl10n-swift`**(기획서의 원래 확정안).
채택 근거였던 "소비자가 모노레포 전체를 받는다"가 실측에서 무너졌다 — **클론 전송량 205 KiB**
(객체 1084개; `sdks/ios`의 145M은 빌드 산출물이라 git에 없다). 반면 유지 비용은 실재했다:
별도 저장소 · `MIRROR_DEPLOY_KEY` 시크릿 · 전용 CI 잡 · 태그가 두 곳에 생김 ·
**미러에서는 `swift test`가 돌지 않음**(골든 픽스처가 모노레포에만 있다). 전환으로 이 다섯이 한꺼번에
사라졌고, 검증 대신 "루트에 `Package.swift`가 있는지" 확인하던 dry-run 검사도 불필요해졌다.

전환 후 실측: 루트에서 **`swift test` 49개 전부 통과**, `examples/ios-consumer` 빌드 정상.
비용은 하나 — **루트에 `Package.swift`가 보인다.** 타 언어 소비자가 저장소 성격을 오해할 수 있어
매니페스트 첫머리에 왜 여기 있는지를 적어 두었다.

> **태그 삭제·재작성 금지**(6.5). SPM은 레지스트리 심사가 없고 git 태그가 곧 버전이라,
> 소비자의 `Package.resolved`가 커밋 해시를 고정하고 있어 조용히 깨진다.

### 릴리스 CI (`.github/workflows/`)

- **`ci.yml`** — push·PR에서 도는 일상 CI이자 **릴리스 게이트 그 자체**다(`workflow_call`).
  릴리스가 이 워크플로를 그대로 호출하므로 둘이 갈라질 수 없다 — 갈라지면 "테스트는 통과했는데
  릴리스가 깨진다"가 생긴다. 잡 5개: TS 참조·백엔드 + **골든 벡터 결정성**(`gen:golden` 후
  `git diff --exit-code`) · Web(게시 빌드 스모크 포함) · iOS(macOS 러너 + SPM 소비 예제 빌드) ·
  Android(`./gradlew test`는 Android SDK 없이 돌고 AAR 빌드까지) · Flutter(테스트 + 예제 실행 +
  `dart analyze --fatal-infos`).
- **`release.yml`** — 태그 `v*`에서 4개 채널 동시 퍼블리시. 구조는 하나뿐이다: **검증은 전부 앞에,
  게시는 전부 뒤에.** `gate`(=ci.yml) → `lockstep` → npm·pub·maven·swift-mirror.
  되돌리는 롤백이 없으므로(게시 후 사실상 불변) 이 순서가 유일한 안전장치다.
- **`lockstep` 잡**이 태그 버전과 web·flutter·android 매니페스트 값이 모두 같은지 본다.
  여기서 걸러야 "npm은 0.1.0인데 pub.dev는 0.0.9"가 영구히 남는 사고를 막는다. iOS는 매니페스트에
  버전이 없다 — SPM은 git 태그가 곧 버전이다.
- **`workflow_dispatch`의 `dry_run`**(기본 true)으로 각 채널의 dry-run까지만 돌려볼 수 있다.
  계정·키가 준비되기 전에 워크플로 자체를 검증하는 용도다.
- **iOS 게시 잡은 없다** — SwiftPM에는 레지스트리 업로드가 없고 태그가 곧 버전이라, 워크플로를 띄운
  `v*` 태그 자체가 이미 SPM 배포다. 2026-08-26 이전에는 미러 저장소로 subtree push하는 잡이 있었다.
- **Gradle 서명·업로드는 환경변수가 있을 때만 켜진다**(`library/build.gradle.kts`). 무조건 켜면
  키 없는 개발 환경에서 `publishToMavenLocal`·`assembleRelease`까지 같이 죽는다. Central URL도
  환경에서만 온다 — 계정 종류(레거시 OSSRH / Central Portal)에 따라 달라서 저장소에 박으면
  조용히 틀린 곳으로 올라간다.
- **필요한 시크릿 5종**: `MAVEN_CENTRAL_URL`·`_USERNAME`·`_PASSWORD` ·
  `SIGNING_KEY`(ASCII armored, 메모리로 전달)·`SIGNING_PASSWORD`. (iOS는 시크릿이 없다 — 태그가 곧 배포.)
  **npm과 pub.dev는 시크릿이 없다** — 둘 다 GitHub OIDC로 인증한다(npm=Trusted Publisher,
  pub.dev=Automated publishing). `NPM_TOKEN`은 2026-08-26에 제거했다 — 아래 "두 레지스트리의
  부트스트랩" 참조.

### 릴리스 dry-run 실전 검증 (2026-08-25) — **파이프라인은 태그를 받을 준비가 됐다**

`gh workflow run Release --ref main -f dry_run=true`로 두 번 돌렸다. 게시는 일어나지 않는다
(npm·pub은 `--dry-run`, Maven은 `publishToMavenLocal`, 미러는 subtree split 검사까지만).

| 잡 | 1차 (32824378038) | 2차 (32825252411) |
| --- | --- | --- |
| 게이트 5종 + lockstep | ✅ `0.1.0` 일치 | ✅ |
| npm `@rynl10n/web` | ✅ | ✅ (`dist/**` `.js`+`.d.ts` 63파일 55.9kB — 소스 `.ts` 미포함) |
| pub.dev `rynl10n` | ✅ 경고 0건 35KB | ✅ |
| SPM 미러 | ✅ 루트에 `Package.swift` | ✅ |
| Maven Central | ❌ `Could not read PGP secret key` | ✅ |

1차 실패는 **미설정 시크릿이 null이 아니라 빈 문자열로 주입**돼 빈 GPG 키로 서명이 켜진 것이다
(`dc4416f`에서 `!= null` → `!isNullOrBlank()`). `build.gradle.kts`의 바로 위 주석이 막으려던 사고
그대로였다 — 키 없는 환경의 `publishToMavenLocal`이 항상 죽는 상태였다.
**dry-run을 건너뛰고 태그를 달았다면 4채널 중 3개만 성공해 lockstep이 깨졌을 것이다.**

> npm 잡 로그를 받지 못해 "GitHub 로그 스토리지가 503"이라고 적었으나 **오진이었다(2026-08-26 정정)**.
> 실제 원인은 **개발 네트워크의 웹 필터가 `*.blob.core.windows.net`을 차단**하는 것이다 — Actions
> 로그 본문이 그 스토리지에 있어서 `gh run view --log`가 차단 페이지를 받는다. GitHub 쪽 장애가
> 아니므로 재시도해도 낫지 않는다. 잡 상태(success/failure)는 API로 정상 조회되니, 로그 본문이
> 필요하면 다른 네트워크나 브라우저를 쓴다.

### 첫 게시 실전 (2026-08-26) — npm·pub.dev

```
@rynl10n/web@0.1.0 · Apache-2.0 · 63 files · unpacked 192.5 kB
tarball: registry.npmjs.org/@rynl10n/web/-/web-0.1.0.tgz · attestations 없음
```

`sdks/web`에서 `npm publish --access public`. **CI가 아니라 로컬 수동 게시다** — 이유는 아래 절.
`--access public`은 생략 불가다(스코프 패키지 기본값이 private이라 402로 막힌다).
**게시 직후 `npm view`가 404를 낸다** — 레지스트리 문서 전파 지연이고, 그 시점에도
`npm access list packages rynl10n`은 `@rynl10n/web: read-write`를 반환한다. 이 둘이 어긋나면
"게시가 실패했다"가 아니라 "아직 전파 중"으로 읽어야 한다(수 분 뒤 200).

provenance는 붙지 않았다 — GitHub Actions 안에서만 발급되므로 **로컬 게시본인 `0.1.0`은 영구히
서명 없이 남는다.** 0.2.0부터 OIDC 게시라 자동으로 붙는다.

```
rynl10n 0.1.0 → pub.dev · 35 KB compressed · 경고 0건
```

`sdks/flutter`에서 `dart pub publish`. 확인 프롬프트(`y/N`) + Google OAuth를 거친다. 서버 응답이
**"it may take up-to 10 minutes"**라고 알려주듯 여기도 전파 지연이 있다(실측 수 분).
pub.dev는 npm보다 엄격하다 — **"Publishing is forever; packages cannot be unpublished."**
게시 전 `--dry-run`으로 경고 0건을 확인하는 습관이 여기서는 선택이 아니다.

### 두 레지스트리의 부트스트랩 — **첫 버전은 CI로 못 올린다**

npm과 pub.dev는 **자동 게시 설정을 패키지가 이미 존재할 때만 받는다**
(npm=Trusted Publisher, pub.dev=Automated publishing). 그런데 둘 다 같은 버전 재게시를 거부한다.
따라서 두 채널의 **첫 버전은 반드시 손으로 올리고, 그다음 자동 게시를 등록**하는 순서다.
릴리스 CI를 아무리 잘 만들어도 이 한 칸은 건너뛸 수 없다 — **`v0.1.0` 태그 하나로 4채널이
끝난다는 그림은 성립하지 않는다.** 진짜 원커맨드 릴리스는 `v0.2.0`부터다.

**npm은 OIDC로 전환했다(2026-08-26).** `release.yml`의 npm 잡에서 `NODE_AUTH_TOKEN`/`NPM_TOKEN`을
제거하고 Trusted Publishing으로 붙인다:

- 등록값: `devryner` / `RynL10n` / 워크플로 파일명 `release.yml` / environment 없음
- `registry-url`은 **남긴다** — `.npmrc`의 레지스트리 지정은 OIDC 경로에서도 필요하다
- `npm install -g npm@latest`를 넣었다. OIDC 교환은 **npm 11.5.1+ 전용**이라 Node 24 번들 버전에
  맡기면 러너 이미지가 바뀔 때 조용히 미달하고, 미달하면 토큰 경로로 떨어지는데 그 토큰이 없어 죽는다
- `--provenance`는 **빼야 한다** — OIDC 게시에 자동 첨부된다

토큰을 없앤 건 편의가 아니라 시한 때문이다: **npm은 2027-01부터 2FA 우회 토큰의 직접 게시를 폐지**한다
(2026-08 시점엔 계정·거버넌스 작업이 이미 막혔다). 토큰 방식으로 세팅했다면 반년 뒤 다시 뜯어야 했다.

**pub.dev의 Automated publishing도 등록했다(2026-08-26)**: `devryner/RynL10n` · 태그 패턴
`v{{version}}` · **push 이벤트만 활성**(`workflow_dispatch`는 끈 채로 둔다 — 실게시 경로가 태그
push 하나뿐이어야 수동 트리거로 실수 게시가 나지 않는다. `dry_run` 실행은 `dart pub publish --dry-run`
이라 인증을 타지 않으므로 영향 없다). pub 잡은 원래부터 OIDC라 `release.yml` 수정이 없었다.

> **두 채널의 검증 수준이 다르다.** pub.dev는 설정이 서버에 저장된 것을 페이지 재로드로 확인했다.
> npm의 Trusted Publisher는 그런 확인을 못 했다 — `npm publish --dry-run`은 인증을 타지 않아
> 로그아웃 상태에서도 통과하므로 `dry_run`으로 검증할 수 없고, `npm trust` CLI도 11.8.0에 없다.
> **npm은 첫 OIDC 게시가 곧 첫 검증**이므로, `v0.2.0` 태그를 밀 때 npm 잡의 인증 실패 가능성을
> 열어두고 봐야 한다.

> **pub.dev의 Manual publishing은 켜 둔 채로 남겼다.** 자동 게시를 켜면 끄는 것이 pub.dev 권고지만,
> 파이프라인이 아직 한 번도 실게시를 해보지 않았다 — 첫 태그 릴리스가 성공하기 전에 수동 경로를
> 끊으면 실패했을 때 대안이 없다. **`v0.2.0`이 자동 게시로 성사된 뒤에 끈다.**

### 멱등 가드 — **첫 게시가 워크플로 밖에서 일어났기 때문에 필요하다** (2026-08-26)

시크릿 5종을 모두 채우고 돌린 dry-run(run 32929226769)에서 **npm 잡만 실패**했다. 원인은 인증이 아니라
버전 충돌이다:

```
npm error You cannot publish over the previously published versions: 0.1.0.
```

`npm publish --dry-run`은 레지스트리에 **사전 확인을 하므로** 이미 게시된 버전에서는 dry-run부터 죽는다.
부트스트랩 때문에 0.1.0이 이 워크플로 밖에서 손으로 올라갔으니, 가드가 없으면 `v0.1.0` 태그는 npm 잡을
영구히 빨갛게 만들고 **"4채널 중 일부만 성공한 실행"과 구분되지 않는다.**

**pub.dev에는 같은 문제가 더 나쁜 형태로 잠복해 있었다.** `dart pub publish --dry-run`은 로컬 검증만
하므로 dry-run은 초록으로 통과하고 **실제 태그 릴리스에서만 죽는다** — 되돌릴 수 없는 지점에서 처음
드러나는 실패다.

두 잡 모두 게시 전에 레지스트리를 조회해 이미 있으면 건너뛴다(`npm view` / pub.dev
`/api/packages/rynl10n/versions/{v}` 200 여부). 실제 레지스트리에 대고 0.1.0(건너뜀)·0.2.0(진행)
양방향을 확인했다. 덤으로 **워크플로 재실행 안전성**도 같이 얻는다.

이 가드 덕분에 **`v0.1.0` 태그로 4채널을 정렬할 수 있다** — npm·pub은 건너뛰고 maven·SPM은 게시되어
0.1.0이 네 채널 모두에 존재하게 된다. 가드가 없었다면 0.2.0까지 기다려야 lockstep이 성립했다.

### Maven Central은 업로드가 끝이 아니다 — **승격 단계를 넣었다(2026-08-26)**

`publishReleasePublicationToMavenCentralRepository`는 OSSRH Staging API에 **올리기만 한다.**
승격 호출이 없으면 배포는 스테이징에 머물러 Portal에도, Maven Central에도 나타나지 않는다 —
**태그를 밀어도 Maven만 조용히 빠지는** 형태의 실패다. dry-run은 `publishToMavenLocal`까지만
가기 때문에 2026-08-25 4채널 검증이 이 갭을 통과시켰다. `release.yml`의 maven 잡에 승격 스텝을
추가해 막았다:

```
POST https://ossrh-staging-api.central.sonatype.com/manual/upload/defaultRepository/com.devryner
     ?publishing_type=automatic
Authorization: Bearer <base64(tokenUser:tokenPass)>
```

세 가지가 이 스텝의 함정이고 전부 주석으로 남겼다:

- **Basic이 아니라 Bearer**다. 값은 `base64(user:pass)` — 형식만 Basic을 닮았다.
- **base64 변환값은 Actions의 시크릿 마스킹을 타지 않는다.** 원본 시크릿은 마스킹되지만 파생값은
  아니므로 절대 출력하지 않는다.
- **GNU `base64`는 76자마다 줄을 바꾼다.** `-w0`가 없으면 헤더가 깨져 401이 난다.

`publishing_type=automatic`을 택했다(기본값은 `user_managed`=Portal 수동 승인). 나머지 3채널은
태그 하나로 즉시 영구 게시되는데 Maven만 사람 승인을 남기면, 그 한 번을 잊는 순간 **"버전 번호가 곧
정합 조합"이라는 lockstep 계약이 조용히 거짓**이 된다. 검증 게이트는 이미 전부 앞에 있다.
실패하면 산출물이 스테이징에 남으므로 `DELETE /manual/drop/repository/{key}`로 정리한 뒤 재시도한다.

`MAVEN_CENTRAL_URL`에 넣을 값도 이 Staging API 엔드포인트다:
`https://ossrh-staging-api.central.sonatype.com/service/local/staging/deploy/maven2/`

> 이 경로는 **계정이 생기기 전까지 실행 검증이 불가능하다.** YAML 파싱과 `bash -n`까지는 통과했다.

**POM의 `developerConnection`이 빠져 있었다(2026-08-26 수정).** Central은 `scm`의
`connection`·`developerConnection`·`url`을 **셋 다** 요구한다. 하나가 없으면 **업로드는 성공하고
Portal 검증에서 거부**되는데, 실패 지점이 업로드에서 멀어 원인을 짚기 어렵다. 게다가 dry-run
(`publishToMavenLocal`)은 POM 내용을 검사하지 않아 이 결함을 영영 통과시킨다.
`./gradlew :library:generatePomFileForReleasePublication`으로 실제 POM을 뽑아 Central 필수 필드
9종(groupId·artifactId·version·name·description·url·licenses·developers·scm)을 전부 대조했다 —
**계정 없이 저장소 쪽을 검증할 수 있는 유일한 지점이므로 POM을 고쳤으면 이걸 다시 돌린다.**
sources/javadoc jar는 `singleVariant("release")`의 `withSourcesJar()`·`withJavadocJar()`가 담당하고,
체크섬(MD5·SHA1)과 `.asc` 서명은 Gradle이 업로드 시 생성한다.

**GPG 공개키를 keyserver에 올리는 것을 잊으면** 서명은 붙는데 Portal 검증에서 거부된다
(`gpg --keyserver keyserver.ubuntu.com --send-keys <KEYID>`). 이것도 실패가 멀리서 나타나는 자리다.

네임스페이스 검증은 **`devryner.com` apex에 TXT 레코드**다 — `com.devryner` 네임스페이스의 검증
대상은 정확히 그 도메인이고 `com.devryner.com` 같은 변형은 동작하지 않는다. 도메인은 Cloudflare NS로
관리 중이라 대시보드에서 바로 추가할 수 있다. 막히면 **GitHub 가입 시 자동 검증되는
`io.github.devryner`가 탈출구**이지만, 좌표가 바뀌므로 문서·매니페스트를 함께 고쳐야 한다.

### 게시 준비 현황 (2026-08-21)

| SDK | 매니페스트 | 게시 가능? |
| --- | --- | --- |
| Flutter | `0.1.0` · `publish_to` 해제 · LICENSE·CHANGELOG·`example/` 추가 · `.pubignore`로 `test/` 제외 | **✅ `dart pub publish --dry-run` 통과**(경고는 uncommitted git 상태 하나뿐, 35KB) |
| Android | `0.1.0` · `maven-publish` · sources·javadoc jar · POM(name·description·url·license·scm·developer) | **✅ 저장소 측 준비 끝** — 남은 건 GPG 서명 + Sonatype 계정(외부) |
| iOS | 태그가 곧 버전이라 매니페스트에 버전 없음 | **✅ 루트 `Package.swift`로 즉시 가능**(2026-08-26) |
| Web | `0.1.0` · `files`·`exports`·메타데이터 + `prepack`의 **`tsc` 게시 빌드**. `private` 제거 | **✅ 블로커 3건 해소**(아래) — `npm publish` 열림 |

**Flutter `.pubignore`로 `test/`를 뺀 이유**: 테스트가 저장소 루트 `fixtures/golden/`을 읽는데 그 경로는
패키지 밖이라 tarball에 담기지 않는다. 그대로 실으면 소비자가 받은 패키지에서 `dart test`가 픽스처를
못 찾아 실패한다 — 실제로 깨진 게 아닌데 깨진 것처럼 보이는 상태다. 골든 정합 검증은 릴리스 CI 게이트에서 돈다.

### Web 게시 형식 — 6.5 정정 (2026-08-21, 실측 근거)

6.5는 *"소비자 측에 번들러가 있으므로 트랜스파일 산출물 대신 소스(ES 모듈)를 그대로 배포한다"*로
확정돼 있었으나 **성립하지 않는다.** 실물로 확인한 블로커 셋과 처리:

**① `sdks/web/`는 자족적이지 않았다.** 웹 소스 7곳이 `../../../src/...`(코어)를 import하는데 npm
`files`는 패키지 디렉토리 밖(`../`)을 담을 수 없다 — 그대로 게시하면 소비자의 모든 import가 실패한다.

**② Node는 `node_modules` 안의 `.ts`를 실행하지 않는다.** 타입 스트리핑을 정책적으로 거부한다
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). 같은 파일을 `node_modules` 밖에 두면 그대로
돌아가므로 코드가 아니라 **배포 형식**의 문제다. 즉 소스 배포는 번들러 소비자에게만 성립하고
SSR·스크립트·테스트에는 하드 에러다.

**③ 브라우저에서도 못 돌았다.** 웹 진입점이 닿는 `src/core/canary.ts`가 최상위에서 `node:crypto`를
import했다(카나리 버킷 SHA-256). 브라우저에 없는 모듈이라 **rollout 100이라 버킷 판정을 한 번도
호출하지 않아도 모듈 로드 시점에 깨진다.** Web 테스트가 Node에서 돌아 드러나지 않았다.

**처리** — ①②는 `tsc` 게시 빌드로 한 번에 풀었다(`sdks/web/tsconfig.publish.json`, `prepack`에서
자동 실행). tsc가 도달 가능한 모든 모듈을 함께 컴파일하므로 코어가 산출물에 들어가 ①이 해소되고,
소비자가 받는 것은 `.js`+`.d.ts`라 ②도 사라진다. **저장소 개발은 여전히 빌드 스텝 0이다** — 게시할
때만 tsc가 한 번 돈다. 진입점 경로가 `dist/sdks/web/src/index.js`로 깊은 것은 입력이 저장소 루트
`src/`와 `sdks/web/src/` 두 트리에 걸쳐 공통 조상이 루트이기 때문이고, 소비자는 `exports`로만
접근하므로 드러나지 않는다.

③은 **의존성 0 순수 TS SHA-256**(`src/core/sha256.ts`)으로 교체했다. `src/serialize/hash.ts`
(콘텐츠 해시)는 빌더·백엔드 전용이라 `node:crypto`를 그대로 쓴다 — SDK 런타임은 콘텐츠 해시를
계산하지 않고 읽기만 한다. **런타임 경로에서 해시가 필요해지면 `node:crypto`가 아니라 `sha256.ts`를
쓴다.** 검증은 세 겹이다: FIPS 180-4 알려진 벡터 · 길이 0~130바이트 전수를 `node:crypto`와 대조
(패딩·블록 경계가 손수 짠 SHA-256이 깨지는 자리) · 교체 전 `bucketOf`와 값 동일. 골든 벡터
(`canary.json`)는 재생성해도 diff가 없어 **4개 언어 정합이 그대로 유지된다.**

**검증**: `npm pack` → 소비자 프로젝트에 설치 → 평범한 Node에서 `import`·`t()` 실행 성공,
`tsc --noEmit`로 타입 해석까지 확인. 산출물에 `node:` import는 남아 있지 않다(주석뿐).

### 게시하려면 남은 일 (전부 저장소 밖)

저장소 안쪽은 끝났다 — 4개 매니페스트 version `0.1.0` 일치 · Web `private` 해제 + `tsc` 게시 빌드 ·
Flutter `publish_to` 해제 + `example/`·CHANGELOG · Android POM·sources·javadoc · 릴리스 CI.
남은 것은 **계정·소유 검증·키**뿐이다:

1. ~~**iOS**~~ — **완료(2026-08-26)**. 루트 `Package.swift`로 전환해 미러 저장소가 불필요해졌다.
   태그 `v0.1.0`을 미는 순간 SPM 배포가 끝난다.
   Linux CI를 켜려면 CryptoKit → swift-crypto 대체가 선행(`Package.swift` 주석).
2. **Android** — `com.devryner` 네임스페이스 **DNS TXT 소유 검증** + Sonatype 계정 + GPG 키
   (`SIGNING_KEY`·`SIGNING_PASSWORD`·`MAVEN_CENTRAL_URL`·`_USERNAME`·`_PASSWORD`).
3. ~~**Web**~~ — **완료(2026-08-26)**. npm org `rynl10n` 확보 → `0.1.0` 로컬 수동 게시 →
   Trusted Publisher 등록(`devryner`/`RynL10n`/`release.yml`). 시크릿은 쓰지 않는다.
4. ~~**Flutter**~~ — **완료(2026-08-26)**. `0.1.0` 로컬 수동 게시 → pub.dev admin에서
   Automated publishing 등록(`devryner/RynL10n` · 태그 패턴 `v{{version}}`). 시크릿은 쓰지 않는다.
5. **공통** — 태그 `v0.1.0`. (`dry_run=true` 확인은 **2026-08-25에 끝냈다** — 위 절.
   시크릿이 채워지면 한 번 더 돌려 실제 자격으로 붙는지 보는 게 안전하다.)
   태그 하나가 4채널을 동시에 민다 — lockstep이 깨지면 골든 벡터 계약이 어느 조합에서 성립하는지
   말할 수 없게 된다.

**릴리스 게이트는 `ci.yml` 그 자체다**(`release.yml`이 `workflow_call`로 호출): 5개 컴포넌트 테스트 +
`npm run gen:golden` 재실행 후 diff 없음(골든 벡터가 커밋 상태와 일치). 게이트는 퍼블리시 **이전에**
전부 걸린다 — npm·pub.dev·Maven Central 모두 게시 후 사실상 불변이라 **되돌리는 롤백이 없고**,
부분 성공은 lockstep 계약을 깬다.

## 아키텍처 핵심 (반드시 이해할 것)

1. **플레인 분리 (4.1)** — 관리 플레인(쓰기, 인증, DB=SoT)과 배포 플레인(읽기, 정적 파일, 앱 서버 없음)이
   완전히 분리. **SDK 런타임은 배포 플레인의 정적 파일만 읽고 관리 API는 절대 호출하지 않는다.** 관리 서버가
   죽어도 기존 배포는 CDN에서 계속 서빙된다. (실시간 푸시 SSE는 데이터 없는 신호만 → 데이터 경로는 정적 유지.)
2. **2계층 resolve (3.1)** — 오버레이 → 번들, 키 단위 override. 로케일 fallback은 BCP47 절단(ko-KR→ko→기본),
   **로케일 우선**(각 로케일에서 오버레이+번들 확인 후 다음 로케일로). 포맷 안전 가드(플레이스홀더 서명 불일치 시
   번들로 fallback) + tombstone(삭제 마커).
3. **버전 격리 (4.3)** — 정적 manifest 라우팅. 클라이언트가 자기 앱 버전/빌드넘버/라벨로 릴리스를 **스스로 선택**
   (서버 라우팅 없음). semver 부분집합 · exact-label · integer-range 3전략.
4. **결정성 (11.1)** — RFC 8785 JCS + NFC + SHA-256. 같은 (릴리스,콘텐츠) → 같은 바이트열 → 같은 해시.
   이게 불변 캐싱·무손실 롤백·CI 재현성·재해복구(DB에서 산출물 재생성)의 근거.
5. **골든 벡터 = 크로스언어 계약** — `src`(TS 참조)가 정규화·해시·resolve·매칭·카나리·정수매칭의 기대 출력을
   언어 무관 JSON으로 방출(`fixtures/golden`). 4개 언어 SDK가 이 벡터로 **바이트·해시·동작 정합**을 기계 검증한다.
   **스키마/알고리즘 변경 시 반드시 `npm run gen:golden` 재실행 후 각 SDK 테스트 재실행.**
   `routing.json`은 14케이스이고 그중 6개가 integer-range다(`72dbeaf`) — 검증 축은 **전략별 평가가 서로
   분리돼 있는가**(빌드넘버만 준 컨텍스트에 semver 릴리스가 딸려오는가 / `buildNumber` 없이 정수 릴리스가
   매칭되는가). 앱이 엉뚱한 카탈로그를 받는 실패는 크래시가 아니라 "그냥 다른 번역"이라 조용하다.
   SDK 골든 테스트의 ctx 디코더는 `buildNumber`를 반드시 읽어야 한다(빠뜨리면 3종 모두 즉시 실패).
6. **키 설명 (5.1)** — 번역자용 맥락은 **키 단위**(로케일 불변). **런타임 스냅샷·델타에는 넣지 않는다**
   (해시 입력 불변 → 골든 벡터 계약 유지, 기기 페이로드 절약). 대신 `GET /projects/{p}/releases/{r}/descriptions`
   사이드카를 빌드 플러그인이 fetch해 `.xcstrings` comment · `strings.xml` XML 주석 · `.arb` `@key.description`으로
   굽는다. 변환기는 descriptions를 **선택 인자**로 받아 생략 시 기존 산출물과 바이트 동일.
7. **앱 적용 경로 (6.3/6.4)** — SDK 코어와 별개로 "앱이 실제로 쓰는 두 조각"이 필요하다: **번들 로더**
   (빌드타임 bake 산출물 → `Snapshot`)와 **배포 플레인 HTTP 구현**(manifest ETag → 릴리스 자가 선택 →
   필요한 산출물만 다운로드 → 원자적 스왑). `DeliveryStore`가 **동기 인터페이스**라 비동기 다운로드와
   동기 조회를 분리한다 — 화면이 네트워크를 기다리지 않는다. **4개 플랫폼 모두 구현 완료**이고
   시나리오 테스트도 1:1로 맞춰 두었다(오프라인 fallback·불변 산출물 재요청 금지·404 내성 등).

## 확정된 스택 / 결정

- 라이선스: **Apache-2.0 단일**(기능 게이팅 없음). **대시보드도 오픈소스 범위**(유료/클라우드 전용 분리 없음).
  사업모델: 오픈소스 + 유료 매니지드 호스팅.
- 백엔드 언어: TypeScript/Node(참조 빌더 재사용). DB: `node:sqlite`(프로덕션은 Postgres). 스토리지: FS(프로덕션 MinIO/S3).
- 인증: 머신=스코프 Bearer 토큰, 사람=OIDC(통합 지점만). RBAC: Admin/Maintainer/Translator/Viewer.
- 직렬화: JCS+NFC+SHA-256, 파일ID=앞 16 hex. 해시 입력에서 base·createdAt 제외.
- 매칭: node-semver **부분집합**(`||`·`^`·`~`·x-range·hyphen 거부, 명시적 하한·상한 강제). publish 시 범위 충돌 409.
  관리 API는 전략 3종을 모두 받고 **값이 그 전략의 문법으로 파싱되는지까지 생성 시점에 검증**한다(400) —
  통과시키면 publish에서 파서가 던져 500이 되고 그 릴리스는 영영 게시할 수 없다(`6e957ca`).

## 스펙 조정 (기억할 것)

- **11.3 클라이언트 후보 필터**: 기획서 원문은 "published만"이었으나 8.1(superseded 산출물이 구버전 앱에 계속
  서빙)과 충돌 → **published·superseded 모두 후보, draft·archived만 제외**로 정정. 코드·Craft 기획서 모두 반영됨.

## 대시보드 (`backend/src/ui/`) — 구현 범위와 남은 확장

바닐라 ES 모듈(`app.js`·`style.css`·`index.html`·`serve.ts`). 빌드 스텝 0 · 의존성 0.
관리 플레인이 `/`·`/ui/app.js`·`/ui/style.css` **고정 허용 목록**으로만 서빙(경로 순회 불가).
`createManagementServer({ serveDashboard: false })`로 헤드리스 배포. 전용 테스트 72개
(`dashboard.test.ts` 21 = API 계층 · `dashboard-ui.test.ts` 41 = DOM 동작 · `users.test.ts` 10 = 사용자 관리).

> `serve.ts`가 자산 본문을 **모듈 캐시에 담아 두므로**, 개발 중 `app.js`를 고쳤으면 서버를 재시작해야
> 바뀐 화면이 나온다.

- **인증·RBAC** — 토큰 로그인 → `GET /me` 검증. `ROLE_CAPS` 4역할이 서버 RBAC(7.3)를 UI에서 미러하되
  **최종 판정은 항상 서버**(viewer는 입력 잠금·릴리스 버튼 없음).
- **번역 탭** — 그리드 인라인 편집(blur 저장, 값 불변이면 요청 없음, 422 서명 불일치는 입력 되돌림) ·
  키 설명(5.1) · 키/로케일 추가 · 복수형 CLDR 맵 JSON 검증 · 검색 1축 + 필터 3축 AND(`63b91a0`) ·
  **번역 JSON 일괄 import**(`POST .../translations/import`, Translator+)를 지원한다. import는 전체 export의
  `keys[].translations[]` 부분집합을 받아 같은 키·로케일은 갱신하고 파일에 없는 값은 유지한다. 미지원 로케일,
  중복 키·로케일, 잘못된 CLDR 맵, 서명/복수형 불일치를 쓰기 전에 막고 단일 트랜잭션으로 전부 반영하거나 전부 롤백한다.
- **릴리스 탭** — 목록·생성·상태 전이(PATCH)·publish(202 잡 폴링)·**롤백**(이전 target 선택)·
  **백포트**(`POST .../releases/{r}/keys` — 한 릴리스 카탈로그에 여러 키를 넣는 릴리스 축).
  생성 폼의 매칭 전략은 **3종 전부**이고, 전략을 고르면 매칭 값 예시(placeholder)와 안내가 그 전략의
  것으로 바뀐다(`6e957ca`) — 값 문법이 셋 다 달라(semver 비교자 / 정수 비교자 / 자유 라벨) 안내 하나로는
  어느 쪽에도 맞지 않는다. 전략 목록의 단일 원천은 `app.js`의 `MATCH_HINTS`.
- **배포 탭** — manifest·게시 이력·릴리스 health·export·rebuild(재해복구). 산출물 링크는 **배포 플레인
  URL로만** 생성해 플레인 분리(4.1)를 UI에서도 지킨다.
- **관측성 탭** — Viewer+ `GET /projects/{p}/telemetry`로 익명 집계를 읽어 전체 건수·실패율과
  릴리스/앱 버전군별 이벤트 카운트를 표시한다. 번역 원문·키 이름·기기 식별자를 저장하지 않는 프라이버시
  경계를 화면에도 명시하며, 새로고침으로 최신 누적값을 다시 읽는다.
- **프로젝트 삭제**(`13d6073`) — admin 전용. 되돌릴 수 없어 두 겹으로 막는다: 서버가
  published 릴리스를 409로 거절하고(archive 우선), UI는 **프로젝트 ID를 그대로 타이핑해야** 확인 버튼이
  열린다. 409는 패널을 닫지 않는다(고치고 되돌아올 여지가 있는 오류).
  `confirmPanel`은 이때 `onCancel`·`arm` 옵션을 얻었다 — 기존 기본값은 그대로라 릴리스 탭 호출부는 무변경.
- **프로젝트 가져오기**(`3d04edc`) — admin 전용. export의 반대편이지만 **목록 화면**에 있다(새 프로젝트를
  만드는 작업이고 라우트도 프로젝트 스코프가 아니다). 파일 선택 → **미리보기**(ID·로케일/키/릴리스 수) →
  복원의 2단계로, 엉뚱한/깨진 JSON은 네트워크 전에 로컬에서 막고 복원할 ID는 그 자리에서 바꾼다.
  409면 패널·입력값을 남겨 ID만 고쳐 재시도(삭제 UI와 같은 규칙). 목록을 떠나면 고르다 만 파일은 버린다.
  이때 서버 쪽도 함께 정리했다(`ade0001`) — 중복 id 409 · 형식 오류 400 · `importProject` 트랜잭션.
  **그전까지 이 라우트는 무엇이 잘못돼도 500 internal이었고 SQLite 원문이 그대로 노출됐다.**
  이어서 복원 경로를 마감했다(`c816a17`): 검증이 **존재만 보고 타입을 안 봐서** `translations[].value`
  누락 같은 입력이 여전히 500이었고(`node:sqlite`는 문자열·숫자·null 외를 바인딩하면 던진다),
  `keys[]`에 없는 키를 릴리스가 참조하면 **조용히 버려져 반쪽 복원**이 됐으며, 구 export의 포인터 결측은
  `!== null`이 undefined를 통과시켜 또 500이었다. `rollout`도 버려져 복원 시 전량 배포(100)로 리셋됐다.
- **사용자 관리**(7.3) — admin 전용, **목록 화면**에 있다(사용자는 인스턴스 수준 — 프로젝트 스코프도,
  export/import 대상도 아니다). 생성(역할 4종 드롭다운 — 고르면 안내가 바뀌는 `ROLE_HINTS`, MATCH_HINTS와
  같은 패턴) · 역할 인라인 변경 · 프로젝트 스코프(`*` 또는 다중 선택) · 비활성/활성 · 삭제(ID 타이핑 확인 +
  마지막 admin 409 표면화) · **토큰 발급/폐기**. 토큰 평문은 발급 직후 패널에서 **한 번만** 보이고
  (서버는 sha256 해시만 저장, `user_tokens`), 화면을 떠나면 노출이 끝난다(pendingImport와 같은 규칙).
  서버 쪽은 `/users` 라우트 6종(전부 admin) + `DbTokenRegistry`(부트스트랩 env 토큰 → DB 사용자 토큰 순서로
  해석, 폐기·비활성 즉시 401) + 마지막 활성 admin 강등·비활성·삭제 409 가드. `ServerDeps.tokens`는
  `PrincipalResolver` 인터페이스가 됐지만 `TokenRegistry`가 이를 구현하므로 기존 소비자는 무변경.
- **실시간** — SSE `/projects/{p}/events` 구독 → 자동 갱신.
- **키 축 백포트**(2026-08-25) — 번역 탭 키 행의 "백포트". 릴리스 탭의 "키 추가"와 **같은 참조 테이블을
  건드리는 반대 축**이고(한 키 → 여러 릴리스), 자리를 나눈 이유는 출발점이 다르기 때문이다: 출시된 앱의
  오타 한 건을 살아 있는 릴리스들에 태우는 일(시나리오 A)은 키에서 시작하지 릴리스를 하나씩 열지 않는다.
  이 라우트만 **207 부분 성공**을 돌려주는데, 성공/실패를 갈라 실패한 릴리스 id를 토스트에 남긴다 —
  삼키면 화면은 "다 됐다"로 읽히지만 그 릴리스는 키가 빠진 카탈로그를 그대로 publish 한다.
- **릴리스 카탈로그·스냅샷 읽기**(2026-08-25) — 릴리스 탭의 "카탈로그". 배포 탭이 보여주는 것은 **게시된
  불변 산출물**이고 여기는 **DB에서 지금 다시 빌드한 카탈로그**다(11.1 결정성). 그래서 draft도 보이고,
  게시 후 키가 더 붙은 릴리스면 둘을 나란히 놓아 "다음 publish에 무엇이 바뀌는지"가 드러난다.
  빌드 플러그인(6.3)이 fetch 하는 것과 같은 JSON이라 앱에 구워질 내용을 미리 보는 자리이기도 하다.
  읽기 라우트라 **쓰기 게이트 앞에 두어 viewer도 닿는다**(다른 릴리스 작업 버튼은 여전히 manage 전용).

**관리 API에는 있으나 UI 진입점이 없는 것: 이제 없다.**
(`GET .../descriptions`(빌드 플러그인용 사이드카)와 `/metrics`(Prometheus)는 UI 대상이 아니다 — 격차 아님.)

> `GET .../descriptions`(빌드 플러그인용 사이드카)와 `/metrics`(Prometheus)는 **UI 대상이 아니다** — 격차 아님.

## 로케일 축 분리 (2026-08-21 수정) — 다시 붙이지 말 것

`t()`의 기본 조회 로케일이 `locale ?? context.releaseLabel ?? bundle.defaultLocale`이었다.
`releaseLabel`은 `ClientContext`가 **"exact-label 후보 평가용"**으로 정의한 릴리스 매칭
값(`src/core/matching.ts:128`, 기획서 5.2)이지 로케일이 아니다 — **매칭 축(4.3)과 로케일 축(3.1)이
코드에서 붙어 있었고**, 기획서 6.1이 로케일을 configure options 소관으로 두는데 설정 필드 자체가
없었다. exact-label 앱은 조회 로케일이 릴리스 라벨(`"2024-spring"`)이 되어 체인에서 아무 것도 맞지
않아 조용히 기본 로케일로 떨어졌고, 나머지 전략도 기기 언어를 반영할 방법이 없었다.
크래시가 없어 359개 테스트가 다 통과하면서 남아 있던 결함이다(골든 벡터는 `resolveValue`에 로케일을
명시적으로 주고 체인만 검증한다 — `t()` 안의 기본값 결정은 계약 밖이었다).

**지금 구조**(4개 SDK 동일):

```
t()의 조회 로케일 = 호출 인자 → 설정 locale → bundle.defaultLocale
```

- **코어는 환경을 읽지 않는다.** 기기 언어를 코어가 직접 집으면 같은 입력이 기계마다 다른 결과를 내
  골든 벡터 계약과 CI 재현성이 무너진다. 그래서 주입은 **플랫폼 진입점**의 일이다:
  Web `HttpRynL10n`(`browserLocale()` = `window.navigator.language`) · Android
  `RynL10n.configure`(`deviceLocale(context)` — 리소스 설정 로케일이라 Android 13+ 앱별 언어 반영) ·
  iOS는 `RynL10nClient.deviceLocale()`을 앱이 한 줄로, Flutter는 `Localizations.localeOf` 또는
  `ioDeviceLocale()`(POSIX `ko_KR.UTF-8` → BCP 47 `ko-KR` 정규화)을 앱이 넘긴다.
- `browserLocale()`은 `defaultCache`와 같은 이유로 **`window`를 먼저 본다** — Node에도 `navigator`
  전역이 있어 그걸 집으면 SSR·테스트가 실행 기계 로케일에 따라 다른 문자열을 내놓는다.
- 회귀 테스트가 4개 SDK 모두에 있다(`test/locale.test.ts` · `sdks/*/…/Locale*`): 설정 로케일이 기본
  조회 로케일이 되는가 · 호출 인자가 그것을 이기는가 · 체인을 타는가 · **releaseLabel이 새지 않는가**.

## 열려 있는 항목 (앱/외부 환경 의존)

- **카나리 실제 활성화(rollout<100)**: 8.4 프라이버시 법무 승인 대기. 코드 완비, **안전 기본값 rollout 100 고정**.
  버킷 판정 = `hash(installId + releaseId) mod 100 < rollout%`, installId=기기 로컬 익명 난수(서버 미전송).
  rollout을 쓰는 API 라우트는 없다 — 값을 담을 수 있는 **유일한 경로가 import의 백업 복원**이고(`c816a17`,
  0~100 정수 검증), 이건 무손실 복원이 우선이라는 판단이다. 100 고정으로 되돌리려면 `importProject`의
  `r.rollout ?? 100`을 `100`으로 바꾸면 된다.
- **브라우저 실기 검증**: Web·Flutter Web 경로는 어댑터 계약(요청 헤더·응답 매핑·갱신 사이클)과 배포
  플레인 CORS까지 기계 검증했으나, 실제 브라우저에서의 end-to-end는 앱 프로젝트 몫이다.
  (Flutter Web 웹 테스트는 `dart test -p chrome`이 필요해 기본 스위트에 넣지 않았다.)
- **실제 앱 통합**: Xcode 앱 타깃·AGP 앱 모듈에서의 위젯 렌더·리소스 병합(SDK 계층은 완료·검증). Compose
  `stringResource` 얇은 래퍼는 앱 모듈.
- **SDK 패키지 게시**: **npm·pub.dev는 게시됐다**(`@rynl10n/web@0.1.0` · `rynl10n@0.1.0`, 2026-08-26). 나머지 2채널은
  코드·매니페스트·**릴리스 CI**까지 준비됐으나 아직 올라가 있지 않다(태그 0개). 남은 것은 저장소
  밖이다 — 레지스트리 계정·서명키·시크릿 등록, 그다음
  `dry_run` 검증 → 태그 `v0.1.0`. **단 태그 하나로 4채널이 끝나지 않는다** — npm·pub.dev의 첫 버전이
  수동이었던 이유와, Maven의 Portal 승격 갭은 아래 두 절.
  채널·좌표·남은 절차는 위 "SDK 배포 채널" 절.
- **프로덕션 토폴로지(M3+)**: Postgres·MinIO/S3·CDN·별도 빌더 워커·OIDC·Helm/K8s. 플레인 분리·API
  계약·결정적 빌더는 그대로 유지.

## 기획서(SoT) 읽는 법

Craft MCP 문서. rootBlockId = `0f5c1bb2-03c7-7787-654c-483c5061805f`.

```
craft_read: blocks get 0f5c1bb2-03c7-7787-654c-483c5061805f --format markdown
# 길어서 페이지네이션 → 응답의 nextCursor로 이어 읽기
```

주요 절: 3.1(2계층 resolve) · 4.1(플레인 분리) · 4.3(버전 격리) · 5(데이터 모델) · 6(SDK) · 7(백엔드/API) ·
8(배포/롤백/카나리) · 9(셀프호스팅/관측성/라이선스) · 10(로드맵) · 11(직렬화/API/매칭 확정 스펙).

## 마일스톤별 커밋 지도

- **M0** `1c0e225` — 2계층 resolve + 버전 격리 PoC
- **M1** `e74a223`·`048030f`·`69c6ceb`·`3069164`·`7937c1a` — iOS+Android SDK 코어·bake·네이티브 변환
- **M2** `31f535d` — 관리 백엔드 β(파이프라인·API·RBAC)
- **M3** `04bdf94` — 셀프호스트 GA(관측성·이식성·재해복구·라이선스)
- **M4** `0104423`·`1ee3b4c`·`8bda41e` — Web·Flutter SDK·카나리·정수매칭·실시간 푸시
- **파리티** `8aec9e4`·`93534dc`·`bd240f1`·`8baec5f` — iOS/Android M4 정합·fetch/캐시·SPM 플러그인·반응형 바인딩
- **대시보드** `482725f` — 어드민 앱(`backend/src/ui/`) + 키 설명(5.1) + 네이티브 주석 bake(3개 언어 변환기 정합)
- **앱 적용 경로** `2fff8bb`(iOS)·`c24b342`(Android)·`98fbae8`(Web·Flutter)·`87604e3`(Flutter Web
  `package:http` 어댑터 + 배포 플레인 ETag·CORS) — 배포 플레인 HTTP + 번들 로더 + Xcode 타깃/AAR 모듈/영속 캐시
- **관리 API 보강** `f21f76a`(`createManagementHandler` export)·`4302dd4`(`DELETE /projects/{p}` + 경로 순회 가드)
- **대시보드 확장** `63b91a0`·`d2f1a40`(PR #4) — 번역 그리드 검색·필터(4축 AND, NFC 정규화,
  tbody만 교체해 포커스 유지) + README 탭 표 반영 ·
  `13d6073`·`692b554`(PR #5) — 프로젝트 삭제 UI(ID 타이핑 확인 + 409 표면화 + `confirmPanel` 범용화) ·
  `ade0001`·`3d04edc`(PR #6) — import 실패 경로 정리(409·400·트랜잭션) + 프로젝트 가져오기 UI(미리보기 → 복원)
- **관리 플레인 정합 마감** `c816a17`·`6e957ca`·`72dbeaf`(PR #7) — 셋 다 **"코어와 SDK는 이미 하는 일을
  관리 플레인·계약이 못 따라간"** 계열이다. PR #6 리뷰의 후속 과제 2건에서 출발해 결함 3건이 더 나왔다:
  import 검증의 타입 미확인·조용한 키 참조 손실·구 export 포인터 결측(`c816a17`) · `integer-range`가
  코어와 SDK 4종에 다 있는데 관리 API가 막고 있던 것 + 매칭 값 파싱 미검증(`6e957ca`) ·
  골든 벡터에 integer-range 라우팅 케이스가 없던 것(`72dbeaf`).
- **UI 격차 마감** `b3cdb72` — 키 축 백포트(키 한 건을 여러 릴리스에, 207 부분 실패는 실패한 릴리스 id까지
  표면화) + 릴리스 카탈로그·스냅샷 읽기(게시본이 아니라 DB에서 지금 다시 빌드한 상태 — 다음 publish에
  무엇이 바뀌는지 보는 자리). 이로써 관리 API에 있는데 UI 진입점이 없는 것은 없다.
- **빈 문자열 클래스 마감** `dc4416f`·`dad8cc2` — 릴리스 dry-run이 드러낸 결함에서 출발해 같은 클래스를
  저장소 전체에서 훑었다. 공통 뿌리는 **"값이 없다"는 뜻의 빈 문자열을 값으로 받는 자리**다:
  Android 서명·업로드 URL(`!= null`) · 백엔드 env 7종(`?? 기본값`) · `FsArtifactStore` 루트(빈 루트면
  `deleteProject("src")`가 cwd의 `./src`를 재귀 삭제) · `keys.signature`(""는 "미확정" 센티널인데 값으로
  받아 `{"signature":""}` 한 번에 포맷 가드가 풀렸다). 환경 판정은 `backend/src/config.ts`로 모았다.
  훑는 과정에서 **SDK 로케일 주입 4종은 이미 이 클래스를 처리하고 있음**을 확인했다(Web `lang !== ""` ·
  Android `isNotEmpty() && != "und"` · Flutter `isEmpty→null`) — 새로 맞출 필요 없다.
  미해결로 남긴 것: `POST /projects {"id":" "}`가 201(truthy 검사라 공백은 안 걸린다).

각 컴포넌트의 상세는 해당 디렉토리의 README(`sdks/README.md`, `sdks/*/README.md`, `backend/README.md`)와
`OPERATIONS.md` 참조.
