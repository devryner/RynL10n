# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 저장소 현재 상태 (중요)

**로드맵 M0~M4 전 마일스톤 완주 + 파리티 마감 상태다.** 기획서(SoT)의 모든 확정 설계가 구현·검증됐다.
테스트 137개 전부 통과(TS 참조 60 · 백엔드 17 · Web 5 · iOS 20 · Android 20 · Flutter 15).
남은 것은 실제 앱/외부 환경 의존 항목뿐(아래 "열려 있는 항목" 참조). 전체 지도는 `HANDOVER.md`.

- **코어 스택**: TypeScript/Node ≥ 23.6 (네이티브 타입 스트리핑, 빌드 스텝 없음). 참조 구현·백엔드 모두
  외부 런타임 의존성 0 (`node:crypto`·`node:sqlite`·`String.normalize`). devDep은 `typescript`·`@types/node`뿐.
- **명령 (컴포넌트별)**:
  - `npm test` / `npm run typecheck` / `npm run demo` — TS 참조 구현 (루트)
  - `npm run gen:golden` — 골든 벡터 재생성 → `fixtures/golden/*.json`
  - `npm run backend` / `npm run test:backend` / `npm run typecheck:backend` — 관리 백엔드
  - `swift test` (`sdks/ios`, Swift 6) · `gradle test` (`sdks/android`, Gradle 9/JDK 21) ·
    `node --test "test/*.test.ts"` (`sdks/web`) · `dart pub get && dart test` (`sdks/flutter`, Dart 3.5+)
  - `docker compose up` — 단일 노드 셀프호스트 (관리 API :8787 + 배포 플레인 :8788)
- **레이아웃**: `src/`(M0 TS 참조 구현 — serialize·core·builder·client, 결정적 코어의 단일 원천) ·
  `backend/`(M2 관리 백엔드, `../src/builder` 재사용) · `sdks/`(ios·android·web·flutter) ·
  `tools/gen-golden.ts` + `fixtures/golden/`(크로스언어 계약) · `examples/ios-consumer/`(SPM 플러그인 소비 예제) ·
  `OPERATIONS.md`(운영 가이드). 상세는 `HANDOVER.md`와 각 디렉토리 README.
- **골든 벡터 = 크로스언어 계약**: TS 참조 구현이 정규화·해시·resolve·매칭·카나리의 기대 출력을 언어 무관
  JSON으로 방출하고, 4개 언어 SDK가 이를 로드해 바이트·해시·동작 정합을 기계 검증한다.
  **스키마/알고리즘 변경 시 반드시 `npm run gen:golden` 재실행 후 각 SDK 테스트 재실행.**
- 설계 관련 판단이 필요하면 항상 기획서를 먼저 확인한다(아래 참조). 이 파일은 요약일 뿐, 상충 시 기획서가 우선한다.

### 기획서(SoT) 읽는 법

Craft MCP 문서다. rootBlockId = `0f5c1bb2-03c7-7787-654c-483c5061805f`.

```
craft_read: blocks get 0f5c1bb2-03c7-7787-654c-483c5061805f --format markdown
# 길어서 페이지네이션됨 → 응답의 nextCursor로 이어 읽기
```

주요 절: 3.1(2계층 resolve), 4.1(플레인 분리), 4.3(버전 격리), 5(데이터 모델), 6(SDK), 7(백엔드/API), 8(배포/롤백/카나리), 9(셀프호스팅/관측성/라이선스), 10(로드맵), 11(MVP 블로커 확정 스펙 — 직렬화/API/매칭).

## 제품 한 줄 정의

앱 업데이트·심사 없이 번역을 배포하는 오픈소스 원격 로컬라이제이션 인프라. **빌드타임에 자동으로 구운 번들(fallback) + 런타임 원격 오버레이의 2계층**으로, 항상 완전한 번역을 보장하면서 즉시 갱신한다.

핵심 차별점 두 가지(나머지는 경쟁사도 하는 패리티): ① **빌드타임 자동 번들링**(플러그인 한 줄, 커밋할 파일 없음 — iOS SPM build tool plugin으로 실증) ② **완전 오픈소스 셀프호스팅**(`docker compose up` 원커맨드, Apache-2.0 단일).

## 아키텍처 — 큰 그림

여러 파일에 흩어진 구조라 먼저 이해해야 할 핵심:

### 플레인 분리 (모든 것의 기반, 기획서 4.1)

- **관리 플레인 (Management Plane)** — 대시보드 + 관리 API + DB(SoT) + 산출물 빌더. **쓰기 경로 전담, 인증 필요.**
- **배포 플레인 (Delivery Plane)** — 오브젝트 스토리지 + CDN. **정적 파일만 서빙(읽기 경로에 애플리케이션 서버 없음).**
- **철칙: SDK 런타임은 배포 플레인의 정적 파일만 읽고, 관리 API는 절대 호출하지 않는다.** 관리 서버가 죽어도 기존 배포는 CDN에서 계속 서빙된다. 이 분리가 셀프호스팅 경량성과 롤백 무손실성의 근거다. (실시간 푸시 SSE는 데이터 없는 신호만 → 데이터 경로는 정적 유지.)

### 2계층 resolve (기획서 3.1)

조회 순서는 **원격 오버레이 → 번들 스냅샷**, 키 단위 override. 로케일 fallback은 BCP 47 태그를 구체→일반으로 절단(`ko-KR → ko → 기본 로케일`)하되 **각 로케일 단계 안에서 오버레이+번들을 모두 확인한 뒤 다음 로케일로**(로케일 우선 원칙). 오버레이는 sparse(변경분만), 적용은 원자적(체크섬 후 스왑). **포맷 안전 가드**: 오버레이 플레이스홀더 서명이 번들과 불일치하면 그 키만 번들로 fallback(런타임 크래시 차단). tombstone(삭제 마커) 지원.

### 버전 격리 (기획서 4.3)

- 프로젝트 → **릴리스(release)** → 앱 버전 범위 매핑. 릴리스 = 키 카탈로그 스냅샷 + 버전 매칭 규칙 + 상태.
- **정적 manifest 라우팅**: 버전→릴리스 매핑을 정적 manifest로 배포하고 **클라이언트가 자기 앱 버전에 맞는 릴리스를 스스로 선택**(서버 라우팅 없음 → 배포 플레인 정적 원칙 유지).
- 매칭 전략 3종: `semver-range` · `exact-label` · `integer-range`(빌드넘버). semver-range는 **node-semver 부분집합만**(비교자 + 공백 AND 결합; `||`·`^`·`~`·x-range·hyphen-range 파싱 거부 → 항상 명시적 하한·상한). publish 시 범위 충돌은 409로 차단(런타임엔 매칭 릴리스가 최대 1개 보장).
- **클라이언트 후보 필터**: `published`·`superseded` 모두 후보, `draft`·`archived`만 제외(8.1과의 정합 — 기획서 11.3에 반영 완료).

### 직렬화 (기획서 11.1 — 결정성이 전부)

- **RFC 8785 JSON Canonicalization Scheme(JCS)** + 문자열 NFC 정규화 → 같은 (릴리스, 콘텐츠)면 항상 같은 바이트열.
- **콘텐츠 해시 = SHA-256**, 파일 식별자는 앞 16 hex 절단. 해시 입력에서 `createdAt`·`base` 제외.
- **스냅샷**(전체 카탈로그) + **델타**(sparse, `set`/`delete` ops, `(locale,key,op)` 사전순 정렬). 복수형은 CLDR 카테고리 맵 **전체 원자 교체**(부분 델타 없음).
- 내부 표준 저장 포맷은 **ICU MessageFormat + CLDR 복수형**. bake 시점에 플랫폼 네이티브 포맷(.xcstrings/strings.xml/JSON/.arb)으로 변환. 변환 손실은 메타·플래그로 보존하거나 안전 축약 + 경고(조용한 손실 금지).
- 결정성이 불변 캐싱·무손실 롤백·CI 재현성·재해복구(DB에서 산출물 재생성)의 근거다.

### 배포·롤백·캐싱 (기획서 7.2 · 8)

- 산출물 파일은 **불변·내용해시 URL** → CDN·클라이언트 영구 캐싱. 무효화 대상은 짧은 TTL의 `manifest.json`뿐.
- 릴리스 라이프사이클: `draft → published → (superseded) → archived`.
- **롤백 = manifest의 overlay 포인터를 이전 target으로 되돌리고 재게시.** 산출물이 불변이라 즉시·무손실. 기본 보존 창 = 최근 20개 published manifest.
- 델타는 publish 시점에 사전 생성(클라이언트에서 diff 계산 없음).

### 배포 API 정적 파일 레이아웃 (기획서 11.2)

```
/{project}/manifest.json                              # 짧은 TTL + ETag
/{project}/releases/{r}/snapshot-{hash}.json          # immutable
/{project}/releases/{r}/delta-{base}-{target}.json    # immutable
```

관리 API는 REST + JSON, 리소스는 데이터 모델 엔티티에 1:1(`projects`/`keys`/`translations`/`releases`/`locales`). 에러 코드 규약: 422(플레이스홀더 서명 불일치), 409(버전 범위 충돌·동시 편집), 202(비동기 잡).

### 데이터 모델 (기획서 5)

엔티티 5종: **Project**(최상위 격리 단위) / **Key**(`namespace.key`, 값이 아닌 '의미' 단위, 플레이스홀더 서명·복수형 메타 보유) / **Translation**((Key,Locale)→값, 복수형은 CLDR 카테고리 맵) / **Release**(격리 단위) / **Locale**(BCP 47). Release↔Key는 다대다(백포트가 이 참조 테이블 대상, 참조 카운트로 키 삭제 가드).

### SDK 표면 (기획서 6)

- 최소 API: `RynL10n.configure(projectKey, endpoint, options)` / `t(key, args)`(동기 — 항상 번들 fallback이 있어 블로킹 네트워크 없음) / `onCatalogUpdated(listener)`. 반응형 바인딩: SwiftUI Combine / Android StateFlow / React 어댑터.
- **빌드타임 자동 번들링 플러그인**(차별점 ①): SPM build tool plugin(실증 완료, `examples/ios-consumer`) / Gradle task / Flutter build hook. 빌드마다 현재 릴리스 스냅샷을 fetch → 네이티브 포맷으로 bake → base 해시를 lockfile에 기록(결정성·CI 재현성). 서버 실패 시 마지막 캐시로 진행, 에어갭용 vendored 모드 지원.
- 공통 코어(resolve·캐시·폴링)는 골든 벡터로 정합성을 보증하며 이식하되, 표면은 각 플랫폼 관용구에 맞춘다.

## 확정된 스택 / 결정

- **플랫폼**: iOS(Swift 6/SPM) + Android(Kotlin/Gradle) + Web(TS, React 어댑터) + Flutter(순수 Dart) — 4종 모두 구현 완료.
- **백엔드**: TypeScript/Node(M0 참조 빌더 재사용). DB=`node:sqlite`(프로덕션은 Postgres), 스토리지=로컬 FS(프로덕션은 MinIO/S3).
- **라이선스**: 전체 **Apache-2.0 단일**(SDK·서버·어드민앱 구분 없이). 기능 게이팅·엔터프라이즈 전용 기능 없음.
- **사업 모델**: 오픈코어 아님. 오픈소스 코어 + **유료 매니지드 호스팅**(설치·운영 대행). 코어만으로 기능적으로 완전한 제품.
- **셀프호스팅**: 단일 노드 **Docker Compose**(`docker compose up` 원커맨드) / 대규모는 Helm·K8s(Postgres + S3 호환 스토리지 + CDN + 별도 빌더 워커).
- 관리 API 인증: 사람=OIDC(통합 지점만), 머신(CI 플러그인)=스코프 제한 Bearer 토큰. RBAC 4역할: Admin / Maintainer / Translator / Viewer.

## 로드맵 상태 (기획서 10.2 — 전 마일스톤 완료)

- **M0** 2계층 resolve + 버전 격리 PoC ✅ / **M1** iOS+Android SDK α ✅ / **M2** 관리 백엔드 β ✅ /
  **M3** 셀프호스트 GA ✅ / **M4** Web·Flutter·카나리·실시간 푸시 ✅ / **파리티 마감** ✅.
- 마일스톤별 커밋 지도는 `HANDOVER.md` 참조.
- **완료 정의(DoD)**: 각 핵심 기능은 ① 샘플 앱에서 시나리오 A/B/C 재현 ② 단위+통합 테스트 통과 ③ 문서화 — 셋을 충족해야 완료.
- 시나리오: A = 출시 직후 오타 OTA 긴급 수정 / B = 신규 프로젝트에 플러그인 한 줄로 자동 번들링 도입 / C = 규제 산업 완전 셀프호스트.

## 열려 있는 항목 (앱/외부 환경 의존 — 코드 아님)

- **카나리 실제 활성화(rollout<100)**: 8.4 프라이버시 법무 승인 대기. 코드 완비, **안전 기본값 rollout 100 고정**. 버킷 판정은 기기 로컬 익명 `installId`(UUID v4, 서버 미전송) 기반 `hash(installId + releaseId) mod 100 < rollout%`.
- **실제 앱 통합**: Xcode 앱 타깃·AGP 앱 모듈에서의 위젯 렌더·리소스 병합(SDK 계층은 완료·검증). Compose `stringResource` 얇은 래퍼는 앱 모듈.
- **프로덕션 토폴로지(M3+)**: Postgres·MinIO/S3·CDN·별도 빌더 워커·OIDC·대시보드 UI·Helm/K8s. 플레인 분리·API 계약·결정적 빌더는 그대로 유지.
