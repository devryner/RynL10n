# RynL10n — 핸드오버

> 앱 업데이트·심사 없이 번역을 배포하는 오픈소스 원격 로컬라이제이션 인프라.
> **빌드타임 자동 번들(fallback) + 런타임 원격 오버레이의 2계층**으로 항상 완전한 번역을 보장하며 즉시 갱신.

이 문서는 저장소를 처음 여는 사람(또는 나중에 돌아온 나)을 위한 전체 지도다. **설계의 단일 원천(SoT)은
Craft 기획서**이고(아래 참조), 이 저장소는 그 기획서를 구현·검증한 코드다. 상충 시 기획서가 우선한다.

## 현재 상태 (한눈에)

- **로드맵 M0~M4 전 마일스톤 완주 + 파리티 마감.** 커밋 15개(`1c0e225`~`8baec5f`).
- **테스트 137개 전부 통과** — TS 참조 60 · 백엔드 17 · Web 5 · iOS 20 · Android 20 · Flutter 15.
- 기획서의 모든 확정 설계가 구현·검증됨. 남은 것은 실제 앱/외부 환경 의존 항목뿐(맨 아래 참조).
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
  src/db/             스키마 + Repo (정규화 관계형 SoT)
  src/pipeline/       publish/롤백 파이프라인(7.4/8.x)
  src/storage/        배포 플레인 산출물 스토리지(FS, MinIO/S3 대체 가능)
  src/api/            REST 관리 API(7.1) + SSE 실시간 푸시
  src/auth/           스코프 토큰 + RBAC 4역할(7.3)
  src/observability/  Prometheus 메트릭 · 텔레메트리 · Notifier
  src/admin/          데이터 이식성 + 재해복구 rebuild(9.4)
  src/main.ts         단일 노드 엔트리(관리 API + 배포 정적 서버)

sdks/ios/             Swift/SPM SDK + rynl10n-bake CLI + SPM build tool plugin
sdks/android/         Kotlin/JVM SDK + bake CLI(Gradle task)
sdks/web/             @rynl10n/web — 코어 재사용 + fetch/ETag 폴링 + SSE 푸시 + React 어댑터
sdks/flutter/         순수 Dart SDK(dart test 검증)
examples/ios-consumer/  SPM 플러그인 소비 예제(플러그인 한 줄 → 자동 bake)

docker-compose.yml · backend/Dockerfile   단일 노드 셀프호스트(9.1)
OPERATIONS.md         운영 가이드(설치·업그레이드·백업·에어갭·관측성, 9.4)
CLAUDE.md             에이전트용 저장소 요약 + 확정 스택
LICENSE · NOTICE      Apache-2.0
```

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

## 확정된 스택 / 결정

- 라이선스: **Apache-2.0 단일**(기능 게이팅 없음). 사업모델: 오픈소스 + 유료 매니지드 호스팅.
- 백엔드 언어: TypeScript/Node(참조 빌더 재사용). DB: `node:sqlite`(프로덕션은 Postgres). 스토리지: FS(프로덕션 MinIO/S3).
- 인증: 머신=스코프 Bearer 토큰, 사람=OIDC(통합 지점만). RBAC: Admin/Maintainer/Translator/Viewer.
- 직렬화: JCS+NFC+SHA-256, 파일ID=앞 16 hex. 해시 입력에서 base·createdAt 제외.
- 매칭: node-semver **부분집합**(`||`·`^`·`~`·x-range·hyphen 거부, 명시적 하한·상한 강제). publish 시 범위 충돌 409.

## 스펙 조정 (기억할 것)

- **11.3 클라이언트 후보 필터**: 기획서 원문은 "published만"이었으나 8.1(superseded 산출물이 구버전 앱에 계속
  서빙)과 충돌 → **published·superseded 모두 후보, draft·archived만 제외**로 정정. 코드·Craft 기획서 모두 반영됨.

## 열려 있는 항목 (앱/외부 환경 의존)

- **카나리 실제 활성화(rollout<100)**: 8.4 프라이버시 법무 승인 대기. 코드 완비, **안전 기본값 rollout 100 고정**.
  버킷 판정 = `hash(installId + releaseId) mod 100 < rollout%`, installId=기기 로컬 익명 난수(서버 미전송).
- **실제 앱 통합**: Xcode 앱 타깃·AGP 앱 모듈에서의 위젯 렌더·리소스 병합(SDK 계층은 완료·검증). Compose
  `stringResource` 얇은 래퍼는 앱 모듈.
- **프로덕션 토폴로지(M3+)**: Postgres·MinIO/S3·CDN·별도 빌더 워커·OIDC·대시보드 UI·Helm/K8s. 플레인 분리·API
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

각 컴포넌트의 상세는 해당 디렉토리의 README(`sdks/README.md`, `sdks/*/README.md`, `backend/README.md`)와
`OPERATIONS.md` 참조.
