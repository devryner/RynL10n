# AGENTS.md

This file provides guidance to coding agents when working with code in this repository. 저장소에 추적되는 유일한 에이전트 가이드다 — 로컬의 `CLAUDE.md`는 같은 내용의 사본이지만 `.gitignore` 대상이라 공유되지 않는다. 한쪽을 고치면 다른 쪽도 같이 고친다.

## 저장소 현재 상태 (중요)

**로드맵 M0~M4 전 마일스톤 완주 + 파리티 마감 + 대시보드 구현 상태다.** 기획서(SoT)의 모든 확정 설계가 구현·검증됐다.
테스트 474개 전부 통과(TS 참조 75 · 백엔드 208 · Web 33 · iOS 50 · Android 54 · Flutter 54 —
2026-08-13 전 컴포넌트 재실행, 2026-08-20 번역 import·관측성 탭 추가 후 TS·백엔드 재실행,
같은 날 **4개 SDK 전부에 폴링·푸시·텔레메트리 전송**을 맞추고 전 컴포넌트 재실행 +
iOS는 실제 백엔드 대상 왕복 확인. 2026-08-25 빈 문자열 처리 3건 수정 + 회귀 10개 추가 후
GitHub Actions에서 5개 컴포넌트 전부 재실행.
2026-08-27 **MCP 도구 표면** + 토큰 최소 권한·Origin 가드로 백엔드 145 → 206 — `src/`·`fixtures/`·`sdks/`가 무변경이라
골든 벡터 계약이 걸린 자리를 안 건드렸고, 재실행은 TS 참조·백엔드·Web으로 한정했다.
2026-08-28 **ICU 인자 이름 경계 수정** — 골든 벡터가 바뀌므로 5개 컴포넌트 전부 재실행).
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
  - `npm run smoke:consumer` — **소비자 스모크**(`tools/consumer-smoke/`). 네 채널의 **게시본**을
    저장소 밖 빈 프로젝트에서 실 좌표로 설치해 `t()`까지 굴린다. 저장소 테스트 466개는 전부 소스를
    보므로 게시본에만 있는 실패(패키징 누락·`exports` 경로·POM 스코프·태그가 가리키는 커밋)를 볼
    자리가 여기뿐이다. CI 아님 — **태그를 민 직후 로컬 1회**. 케이스는 `run.ts`의 `CHECKS` 한 곳에
    있고 네 언어가 같은 `checks.json`을 읽는다(골든 벡터와 같은 원리). 전제는 하나 — 소비자 쪽에
    `mavenLocal()`·`file:`·`path:`를 두지 않는 것.
- **레이아웃**: `src/`(M0 TS 참조 구현 — serialize·core·builder·client, 결정적 코어의 단일 원천) ·
  `backend/`(M2 관리 백엔드, `../src/builder` 재사용; `src/ui/`=대시보드 · `src/config.ts`=환경 판정 ·
  `src/mcp/`=MCP 도구 표면) ·
  `sdks/`(ios·android·web·flutter) ·
  `tools/gen-golden.ts` + `fixtures/golden/`(크로스언어 계약) · `tools/consumer-smoke/`(게시본 소비 검증) · `examples/ios-consumer/`(SPM 플러그인 소비 예제) ·
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

**ICU 인자 이름의 정의는 언어마다 한 곳에만 둔다**(2026-08-28, `src/core/icu.ts` · `Icu.swift` ·
`Icu.kt` · `icu.dart`). argName은 **Pattern_Syntax도 Pattern_White_Space도 아닌 문자 1개 이상**이라
비ASCII를 허용한다 — `[A-Za-z0-9_]+`로 좁히면 `{이름}`이 리터럴이 되고, **원래 플레이스홀더가 없던
키**(서명 "")에 그걸 새로 넣을 때 가드가 그냥 열린다. 이 지식은 서명(`placeholder`) · 런타임 치환
(`resolve`) · bake 변환(`convert`) 세 곳이 쓰는데, 서명만 고치면 "서명에는 잡히는데 화면에는 여전히
리터럴"이 된다. 클래스는 유니코드 범위 표에서 생성했고(두 속성 모두 불변으로 선언돼 안전), 4개 언어가
**바이트 동일**해야 한다. 골든 벡터 `signature.json`이 그 경계를 계약으로 잡는다. 다시 좁히지 말 것 —
상세는 `HANDOVER.md`.

### 버전 격리 (기획서 4.3)

- 프로젝트 → **릴리스(release)** → 앱 버전 범위 매핑. 릴리스 = 키 카탈로그 스냅샷 + 버전 매칭 규칙 + 상태.
- **정적 manifest 라우팅**: 버전→릴리스 매핑을 정적 manifest로 배포하고 **클라이언트가 자기 앱 버전에 맞는 릴리스를 스스로 선택**(서버 라우팅 없음 → 배포 플레인 정적 원칙 유지).
- 매칭 전략 3종: `semver-range` · `exact-label` · `integer-range`(빌드넘버). semver-range는 **node-semver 부분집합만**(비교자 + 공백 AND 결합; `||`·`^`·`~`·x-range·hyphen-range 파싱 거부 → 항상 명시적 하한·상한). publish 시 범위 충돌은 409로 차단(런타임엔 매칭 릴리스가 최대 1개 보장).
관리 API(`requireVersionMatch`)는 3종을 모두 받고 **값이 그 전략의 문법으로 파싱되는지까지 생성 시점에 검증**한다(400).
전략만 보고 통과시키면 파싱 불가한 범위식이 draft로 저장됐다가 publish에서 파서가 던져 500이 되고, 그 릴리스는
영영 게시할 수 없다. `exact-label`은 파싱할 문법이 없어 자유 문자열. 대시보드 드롭다운도 3종을 모두 제공한다.
골든 벡터 `routing.json`이 integer-range 라우팅을 6케이스로 덮는다(파싱은 `intrange.json`).
검증 축은 **전략별 평가가 서로 분리돼 있는가** — 빌드넘버만 준 컨텍스트에서 semver 릴리스가
딸려오거나 `buildNumber`가 없는데 정수 릴리스가 매칭되면 앱이 엉뚱한 카탈로그를 받는다.
언어마다 옵셔널 처리가 달라 어긋나기 쉬운 자리다. SDK 골든 테스트의 ctx 디코더는 `buildNumber`를
반드시 읽어야 한다 — 빠뜨리면 이 케이스들이 바로 실패한다(3종 모두에서 확인).
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
서버를 직접 띄우지 않고 소비자 서버에 붙이려면 `createManagementHandler`를 export해 마운트한다.
`DELETE /projects/{p}`는 admin 전용이고, 프로젝트 산출물을 지울 때 **스토리지 경로 순회 가드**를 통과해야 한다.
`POST /projects/import`(admin)는 **덮어쓰지 않는다** — 이미 있는 id는 409, export 형식이 아니면 400,
복원 자체는 `Repo.importProject`의 트랜잭션으로 전부-또는-전무. (전에는 무엇이 잘못돼도 500이었다.)
`requireProjectExport`의 검사 범위 = `importProject`가 역참조하는 필드 **전부 + 타입**(node:sqlite가
문자열·숫자·null 외를 바인딩하면 TypeError → 500). `keys[]`에 없는 키를 릴리스가 참조해도 400 —
이름 기반 참조라 조용히 버려지면 복원이 반쪽이 된다. `rollout`·`base`·`overlay` 결측은 구 백업 하위호환으로
허용(각각 100·미설정). 복원은 `rollout`을 **되살린다** — 무손실이어야 하므로.

`POST /projects/{p}/translations/import`(Translator+)는 **기존 프로젝트에 키·번역만 병합**한다 —
프로젝트를 통째로 세우는 `POST /projects/import`와 다른 축이다. 본문은 export의 `keys[].translations[]`
부분집합이라 export에서 키 배열만 떼어 재사용할 수 있고, 같은 (키, 로케일)은 갱신·나머지는 유지한다.
검증은 **쓰기 전에 전부**(미등록 로케일·키/로케일 중복·CLDR 카테고리와 `other`·state ∈ {draft, reviewed}는 400,
파일 내부 서명 불일치와 **기존 키의 서명·복수형 불일치는 422**), 적용은 `Repo.importTranslations`의
단일 트랜잭션. 서명 검사를 건너뛰면 포맷 가드(3.1)가 무력화된 카탈로그가 대량으로 들어와 런타임이 깨지고,
트랜잭션이 없으면 대량 입력 도중 실패했을 때 무엇을 다시 올려야 하는지 알 수 없다.

### 데이터 모델 (기획서 5)

엔티티 5종: **Project**(최상위 격리 단위) / **Key**(`namespace.key`, 값이 아닌 '의미' 단위, 플레이스홀더 서명·복수형 메타·**번역자용 설명** 보유) / **Translation**((Key,Locale)→값, 복수형은 CLDR 카테고리 맵) / **Release**(격리 단위) / **Locale**(BCP 47). Release↔Key는 다대다(백포트가 이 참조 테이블 대상, 참조 카운트로 키 삭제 가드).

**키 설명(`keys.description`)**: 번역자가 읽는 맥락(화면·톤·제약). '의미'에 붙으므로 로케일별이 아닌 **키 단위** —
로케일을 늘려도 같은 설명을 재사용한다. **런타임 스냅샷·델타에는 넣지 않는다**(해시 입력 불변 → 골든 벡터 계약 유지,
기기 페이로드 절약). export/import에는 포함(9.2). 편집 경로는 `PUT /projects/{p}/keys/{key}`의 `description`.
**네이티브 주석 bake**: 빌드 플러그인이 `GET /projects/{p}/releases/{r}/descriptions`(스냅샷과 분리된 사이드카)를
fetch해 `.xcstrings` `comment` · `strings.xml` XML 주석 · `.arb` `@key.description`으로 굽는다(5.3/6.3).
Web JSON은 표준 주석 자리가 없어 생략. 변환기(TS·Swift·Kotlin)는 descriptions를 **선택 인자**로 받아
생략 시 기존 산출물과 바이트 동일하며, 주입 시 출력은 골든 벡터(`convert.json`)로 3개 언어가 정합 검증된다.
XML 주석은 `--`를 지우지 않고 하이픈 사이 공백으로 보존(XML 1.0 §2.5, 조용한 손실 금지).
CLI: `rynl10n-bake --descriptions <path|url> --emit-native` (읽기 실패 시 주석 없이 계속).
이 라우트는 `signature`·`isPlural`을 **명시한 경우에만** 갱신한다 — 설명만 고칠 때 서명이 지워져 포맷 가드(3.1)가
무력화되면 안 되기 때문. DB 스키마 변경은 `backend/src/db/schema.ts`의 `MIGRATIONS`에 idempotent ALTER로 추가.

### SDK 표면 (기획서 6)

- 최소 API: `RynL10n.configure(projectKey, endpoint, options)` / `t(key, args)`(동기 — 항상 번들 fallback이 있어 블로킹 네트워크 없음) / `onCatalogUpdated(listener)`. 반응형 바인딩: SwiftUI Combine / Android StateFlow / React 어댑터.
- **로케일 축 ≠ 릴리스 매칭 축** (2026-08-21 분리, 다시 붙이지 말 것): `t()`의 조회 로케일은
  **호출 인자 → 설정 `locale` → `bundle.defaultLocale`** 순이다. 전에는 그 가운데가
  `context.releaseLabel`이었는데 그건 `exact-label` 릴리스 판정값(5.2)이지 로케일이 아니라,
  exact-label 앱이 조용히 기본 로케일로 떨어지고 기기 언어를 반영할 방법도 없었다.
  **코어는 기기 언어를 직접 읽지 않는다** — 읽으면 같은 입력이 기계마다 다른 결과를 내 골든 벡터
  계약이 깨진다. 주입은 플랫폼 진입점 몫: Web `HttpRynL10n`(`browserLocale()`, `window`를 먼저 봄) ·
  Android `RynL10n.configure`(`deviceLocale(context)`, 리소스 설정 로케일이라 앱별 언어 반영) ·
  iOS `RynL10nClient.deviceLocale()`·Flutter `Localizations.localeOf`/`ioDeviceLocale()`은 앱이 한 줄로.
  4개 SDK 모두 회귀 테스트가 있다.
- **빌드타임 자동 번들링 플러그인**(차별점 ①): SPM build tool plugin(실증 완료, `examples/ios-consumer`) / Gradle task / Flutter build hook. 빌드마다 현재 릴리스 스냅샷을 fetch → 네이티브 포맷으로 bake → base 해시를 lockfile에 기록(결정성·CI 재현성). 서버 실패 시 마지막 캐시로 진행, 에어갭용 vendored 모드 지원.
- 공통 코어(resolve·캐시·폴링)는 골든 벡터로 정합성을 보증하며 이식하되, 표면은 각 플랫폼 관용구에 맞춘다.
- **iOS 앱 적용 경로(`sdks/ios/README.md`)**: 빌드 산출물 로드 `Snapshot.baked(in:)`(Xcode 앱=`.main`,
  SwiftPM=`.module`) + 배포 플레인 HTTP 참조 구현 `RemoteDeliveryStore(baseURL:project:)`.
  `DeliveryStore`가 **동기 프로토콜**이라(화면이 네트워크를 기다리지 않음) 비동기 다운로드와 동기 조회를
  분리한다 — `update(_:)`가 manifest(ETag)→릴리스 선택→필요한 산출물만 다운로드→메인 액터 스왑까지 처리하고,
  프로토콜 메서드는 캐시만 읽는다. 산출물은 내용해시 URL이라 영구 캐싱, 오프라인이면 마지막 캐시로 진행.
  Xcode 앱 타깃은 플러그인이 `XcodeBuildToolPlugin`을 구현해야 붙는다(Build Phases → Run Build Tool Plug-ins).
  갱신 시점은 셋 다 제공한다: 수동 `update(_:)`(앱 시작·포그라운드 복귀) · `startPolling(_:interval:)`
  (기본 60초, 보장선) · `ServerPushChannel`(SSE 신호 → 즉시 `update`, 지연 단축용. 끊기면 3→60초 백오프
  재연결이고 그 사이는 폴링이 덮는다). **푸시 엔드포인트는 알림(관리) 플레인이지만 프레임은 신호뿐이고
  데이터는 여전히 배포 플레인에서 받는다** — 플레인 분리는 유지된다(4.1). SSE 줄 분해는 직접 한다:
  `AsyncLineSequence`가 빈 줄을 내보내지 않아 프레임 경계가 사라진다.
  익명 집계 전송은 `TelemetryReporter`(옵트인 — 객체를 만들어야 전송, 수집 자체도 `telemetry: "aggregate"`
  일 때만). `POST /projects/{p}/telemetry`로 서버 스키마의 5개 필드만 올리고(9.3 프라이버시 가드가
  그 외 필드를 거부), 전송 실패면 카운트를 **되돌린다** — 실패 구간이 사라지면 카나리 판정(8.4)이
  실제보다 건강해 보인다. `appVersionBucket`은 앱 버전군(`3.2.1` → `3.2`), `installId`는 보내지 않는다.
  **4개 SDK가 같은 3종을 가진다**(2026-08-20 파리티): 폴링 · SSE 푸시 · 텔레메트리 업로드.
  표면 이름과 실패 정책(폴링이 보장선 · 푸시는 지연 단축 · 전송 실패 시 카운트 되돌리기 ·
  릴리스 미정이면 드레인 보류 · 버전군 라벨)은 언어를 넘어 동일하고, 각 SDK 테스트가 같은 축을 본다.
- **Android 앱 적용 경로(`sdks/android/README.md`)**: 배포 아티팩트는 `:library` AAR 모듈(코어 소스를
  재컴파일해 넣고 Android 바인딩만 더함, 루트는 bake CLI·골든 벡터 검증용 JVM 모듈로 남음).
  `BakedBundle`(assets 로더, Android API 의존 0 → JVM에서 그대로 테스트) + `RemoteDeliveryStore`
  (`HttpURLConnection` + 디스크 캐시, iOS와 동작 대칭이나 스왑은 호출 코루틴 컨텍스트에서).
  폴링·푸시·텔레메트리는 코루틴 기반(`startPolling(scope=…)` · `ServerPushChannel` · `TelemetryReporter`)이고
  파사드 단축키도 있다(`RynL10n.startPolling/connectServerPush/startTelemetry`).
  SSE 구독 중단은 코루틴 취소만으로는 안 된다 — 블로킹 `readLine`을 깨우려면 **연결을 직접 끊어야** 한다.
- **Web 앱 적용 경로(`sdks/web/README.md`)**: `BakedBundle.parse/load`(번들러 import 검증 + 정적 자산
  fetch) + `PersistentCache`(기본 `localStorage`, 없으면 메모리) 기반 영속 캐시. `refresh()`는 폴링 루프
  자리라 던지지 않고 오프라인이면 마지막 캐시 manifest로 진행하며, 진단용 `loadManifest()`만 `DeliveryError`
  (`bad-status`·`unavailable`·`malformed`)를 던진다. `defaultCache`는 `globalThis.localStorage`가 아니라
  **`window`를 먼저 본다** — Node의 실험적 전역을 집으면 SSR·테스트에서 엉뚱한 백엔드를 쓰게 된다.
  텔레메트리 업로드는 `telemetryEndpoint`를 주면 `start()`가 함께 켠다(`sdks/web/src/telemetry.ts`).
- **Flutter 앱 적용 경로(`sdks/flutter/README.md`)**: `parseBakedSnapshot`(자산 문자열 검증) +
  `RemoteDeliveryStore`. **HTTP·저장소 의존은 어댑터에만** — 코어(`rynl10n.dart`)는 `DeliveryFetch`·
  `ArtifactCache`를 주입받는 순수 Dart이고, 진입점은 둘 중 택일:
  `rynl10n_io.dart`(`dart:io`, 추가 의존성 0, **웹 컴파일 불가**) · `rynl10n_http.dart`(`package:http`,
  **Flutter Web 포함 전 플랫폼**). 웹은 파일 시스템이 없으므로 `FileArtifactCache` 대신
  `CallbackArtifactCache`(코어, 의존성 0)에 `localStorage`·`shared_preferences`를 클로저로 꽂는다 —
  SDK가 저장소 패키지를 고르지 않기 위한 이음새다. 푸시·텔레메트리도 같은 방식으로 구멍만 뚫어 뒀다
  (`PushConnect`·`TelemetryPost`, 어댑터는 `io*`/`http*`). **Flutter Web의 `httpPushConnect`는 SSE가
  스트리밍되지 않는다**(BrowserClient=XHR) — 웹은 `EventSource`를 `PushConnect`로 감싸 넣고,
  그대로 둬도 폴링이 보장선이라 기능은 안 깨지고 지연만 남는다.

### 배포 플레인은 CDN처럼 굴어야 한다 (`backend/src/storage/delivery-server.ts`)

정적 서버지만 **ETag + 조건부 304**와 **CORS** 둘 다 필요하다. 없어도 SDK는 죽지 않고 성능만 나빠지는
**조용한 실패**라 계약 테스트(`backend/test/delivery-plane.test.ts`)로 못박아 뒀다.
`ETag`는 CORS 안전목록 응답 헤더가 아니라 `Access-Control-Expose-Headers`로 노출하지 않으면 브라우저
SDK가 읽지 못해 조건부 요청이 영영 성립하지 않는다. `If-None-Match`는 preflight를 유발하므로
`Access-Control-Allow-Headers`에도 들어간다. 오리진은 `RYNL10N_DELIVERY_ALLOW_ORIGIN`(기본 `*` —
공개 읽기 전용 정적 파일이라 자격 증명을 쓰지 않는다).

### MCP 도구 표면 (`POST /mcp`, `backend/src/mcp/`)

관리 플레인에 JSON-RPC 2.0(Streamable HTTP)로 붙은 **에이전트용 표면**. 읽기 전용 도구 2종.
끄려면 `createManagementServer({ serveMcp: false })`. 상세는 `backend/README.md`.

**인증은 새 축을 만들지 않는다** — 기존 Bearer + RBAC 4역할 + 프로젝트 스코프 그대로다. 도구마다
라우트와 같은 capability를 달고, `tools/list`는 **호출자가 쓸 수 없는 도구를 아예 뺀다**(모델에게
보이지 않는 편이 호출 후 거부당하는 것보다 낫다). 도구 실행 실패는 JSON-RPC 에러가 아니라
`isError` **결과**로 나간다 — 프로토콜 에러로 올리면 대화가 끊긴다.

**전송 계층은 직접 구현했다.** `@modelcontextprotocol/sdk`는 이 저장소 최초의 런타임 의존성이
되므로 쓰지 않는다. 대가로 표면이 최소다: stateless · 서버→클라이언트 스트림 없음(`GET /mcp`=405) ·
알림은 본문 없는 202. 셋 다 스펙이 허용한다.

- **`validate_translation`** — 번역 값을 **저장하지 않고** 검사. **판정은 단일 원천이다**: `ok`를
  실제 쓰기 경로가 쓰는 `requireTranslationImport`가 정한다(그래서 그 함수를 `api/server.ts` 밖으로
  뺐다 — `api/translation-import.ts`, 에러 타입은 `api/errors.ts`). 여기서 규칙을 다시 구현하면
  "미리보기는 통과, 실제 쓰기는 422"라는 최악의 조합이 생긴다. 로케일별로 문제를 쪼개는 것도 규칙
  복제가 아니라 **같은 검증기를 슬라이스마다 다시 부르는 것**이고, 그 불변식을 테스트가 케이스마다
  대조한다. 엔트리가 **배열**인 이유 = "같은 키의 번역끼리 서명이 다르다"(422)는 단건으로 못 잡는다.
  **쓰기 도구를 붙일 때 입력 스키마를 그대로 공유할 것** — 갈리면 그 사이에서 변형이 일어난다.
- **`resolve_preview`** — "이 앱 버전에서 이 키가 무엇으로 보이고 **왜** 그런가."
  `preview.ts`에는 resolve 규칙이 한 줄도 없다: `RynL10nClient`를 그대로 인스턴스화해 `refresh()`를
  돌린다(시뮬레이터를 따로 짜면 실물과 갈라지는 순간 도구가 거짓말한다). `diagnosis` 14종은
  `refresh()`·`resolveValue()`의 **조기 반환 지점과 1:1** — 분기가 늘면 진단도 늘어야 한다.
  매칭 축 3종 중 최소 하나 필수(없으면 늘 bundle-only라 400), `bundleBase` 생략 시 "방금 빌드한 앱"을
  가정하되 `bundle.assumed`로 **밝힌다**(안 밝히면 "정상"이라 답하는데 앱은 스테일 번들로 깨져 있다).

**토큰은 `surface: "mcp"`로 발급하는 것을 권한다.** 그 평문이 에이전트 설정 파일에 놓이므로,
새더라도 `POST /mcp` 외의 관리 API로는 못 간다(403). 역할 상한(`maxRole`)까지 걸면 표면 안에서도
할 수 있는 일이 줄어든다. 둘 다 **발급 시점에만** 정해지고 이후 불변이라 바꾸려면 재발급한다.
기본값이 곧 기존 동작이라 이미 발급된 토큰은 업그레이드해도 그대로 산다.

**Origin 가드**: MCP 클라이언트는 Origin을 보내지 않으므로, Origin이 붙어 있다는 것 자체가
브라우저에서 왔다는 신호다 — `RYNL10N_MCP_ALLOWED_ORIGINS`(기본 빈 목록 = 전부 거부)에 없으면
403이고, 인증보다 먼저 건다. Host 비교로는 안 된다(DNS rebinding에서는 Host도 공격자 도메인이라
Origin과 일치한다).

**대시보드 진입점**: 사이드바 **인스턴스 › MCP**(켜져 있을 때만). 엔드포인트·설정 스니펫·도구 목록·
Origin 정책을 보여주는 **안내 화면**이지 조작 화면이 아니다. 도구 목록은 `GET /mcp/tools`에서 오는데,
이건 관리 API 라우트지 전송이 아니다 — 대시보드도 브라우저라 `POST /mcp`를 부르면 자기 Origin이
붙어 가드에 걸린다. 하드코딩하면 서버와 어긋나므로 같은 `MCP_TOOLS`를 관리 API로 한 번 더 낸다.

배포 플레인과 비가역 admin 조작(프로젝트 삭제·import·사용자 관리)은 **일부러 열지 않았다**.
관리 플레인이 배포 산출물을 *읽는* 것은 분리를 깨지 않는다(`GET /projects/{p}/manifest`와 같은 성격).

## 확정된 스택 / 결정

- **플랫폼**: iOS(Swift 6/SPM) + Android(Kotlin/Gradle) + Web(TS, React 어댑터) + Flutter(순수 Dart) — 4종 모두 구현 완료.
- **백엔드**: TypeScript/Node(M0 참조 빌더 재사용). DB=`node:sqlite`(프로덕션은 Postgres), 스토리지=로컬 FS(프로덕션은 MinIO/S3).
- **라이선스**: 전체 **Apache-2.0 단일**(SDK·서버·어드민앱 구분 없이). 기능 게이팅·엔터프라이즈 전용 기능 없음.
  **대시보드도 오픈소스 범위에 포함**(유료/클라우드 전용 분리 없음 — 2026-07 확정, 구현 완료).
- **대시보드**: `backend/src/ui/`(index.html·app.js·style.css) — 관리 플레인이 `/`·`/ui/*`로 서빙.
  프레임워크·번들러 없는 바닐라 ES 모듈(빌드 스텝 0, 의존성 0 원칙 유지). 자산 경로는 `serve.ts`의 고정 허용 목록.
  토큰 로그인(`GET /me`) · 역할별 쓰기 UI 잠금 · SSE 자동 갱신 · 배포 플레인은 링크로만 노출(플레인 분리 유지).
  끄려면 `createManagementServer({ serveDashboard: false })`.
  **셸은 좌측 고정 내비 + 상단 바**(2026-08-26, `RynL10n-Dashboard`에서 백포트). 탭 줄은 없다 —
  프로젝트 상세의 탭 4종이 사이드바에 있고, 화면 계층이 둘(인스턴스 / 프로젝트)이라는 사실이 상단
  탭으로는 드러나지 않기 때문이다. `shell()` 하나가 전체 셸을 만들고 호출부는 둘뿐.
  팔레트는 **역할 짝**(채움색 + 그 위 글자색을 늘 함께)이라 다크에서 컴포넌트 규칙을 덮어쓰지 않는다.
  아이콘은 인라인 SVG — `el()`이 `createElement`라 SVG를 못 만들어 `icon()`이 `createElementNS`를 쓰고,
  **테스트 DOM 스텁에도 그게 있어야 한다**(없으면 셸을 그리는 순간 전부 터진다). 상세는 `HANDOVER.md`.
  탭 4종: 번역(인라인 편집·키 설명·검색 1축 +
  필터 3축 AND · **번역 JSON 가져오기** — 파일 선택 → 키/번역/로케일 수 미리보기 → 확인 후 반영,
  고르기만 해서는 쓰지 않는다 · **키 축 백포트** — 키 한 건을 여러 릴리스에 한 번에, 207 부분 실패는
  실패한 릴리스 id까지 표면화) · 릴리스(생성·상태 전이·publish·롤백·릴리스 축 백포트 ·
  **카탈로그/스냅샷 읽기** — 게시본이 아니라 DB에서 지금 다시 빌드한 상태라 다음 publish에 무엇이
  바뀌는지 보는 자리, viewer도 열람 가능) ·
  배포(manifest·이력·health·export·rebuild) · **관측성**(`GET /projects/{p}/telemetry` 익명 집계 —
  4종 이벤트 요약 + 릴리스 × 앱 버전군 표. 거부율의 분모는 **적용 + 거부**라야 카나리 판정(8.4)의
  `releases/{r}/health`와 같은 것을 본다).
  프로젝트 목록에는 admin 전용 **삭제**(ID 타이핑 확인 + 409 표면화)와 **가져오기**(export JSON →
  미리보기 → 복원, 중복 ID는 409로 덮어쓰기 차단), **사용자 관리**(7.3 — 생성·역할 4종·프로젝트 스코프·
  비활성·삭제·토큰 발급/폐기. 평문은 발급 1회만 노출, 서버는 sha256 해시만 저장. **토큰은 발급 시점에 표면(`all`/`mcp`)과 역할 상한으로 좁힐 수 있다** — 평문이 서버 밖에 놓이는 값이라. `DbTokenRegistry`가
  부트스트랩 env 토큰 → DB 사용자 토큰 순서로 해석하고, 마지막 활성 admin 강등·비활성·삭제는 409.
  사용자는 인스턴스 수준이라 export/import 비포함). `serve.ts`가 자산을 모듈 캐시에
  담으므로 `app.js`를 고쳤으면 **서버 재시작**해야 반영된다.
  **관리 API에 있는데 UI 진입점이 없는 것은 이제 없다**(2026-08-25, 키 축 백포트·카탈로그 읽기로 마감).
  (`descriptions` 사이드카와 `/metrics`는 UI 대상이 아니다 — 격차가 아니라 성격이 다른 것.)
  상세는 `HANDOVER.md`의 대시보드 절.
- **사업 모델**: 오픈코어 아님. 오픈소스 코어 + **유료 매니지드 호스팅**(설치·운영 대행). 코어만으로 기능적으로 완전한 제품.
- **셀프호스팅**: 단일 노드 **Docker Compose**(`docker compose up` 원커맨드) / 대규모는 Helm·K8s(Postgres + S3 호환 스토리지 + CDN + 별도 빌더 워커).
- 관리 API 인증: 사람=OIDC(통합 지점만), 머신(CI 플러그인)=스코프 제한 Bearer 토큰. RBAC 4역할: Admin / Maintainer / Translator / Viewer.
- **빈 문자열은 "값 없음"이다**(2026-08-25 확정). 설정·센티널 자리에서 `?? 기본값`·`!= null`·`typeof === "string"`은
  빈 값을 값으로 받아들인다. 값 없는 변수를 빈 문자열로 주입하는 경로가 흔하기 때문에(오케스트레이터의 미해석
  Secret, CI가 `env:`로 넘긴 미설정 시크릿, `.env`의 `X=`) 이건 이론이 아니라 실제로 세 번 물린 자리다 —
  Android 릴리스 서명(빈 GPG 키로 서명이 켜져 게시가 죽음) · 백엔드 env 7종(포트 0·익명 임시 DB·빈 CORS 오리진) ·
  `keys.signature`(""는 "미확정" 센티널인데 값으로 받아 포맷 가드가 풀림). 환경 판정은 `backend/src/config.ts`
  **한 곳**에 모아 두었고(통과한 값은 "있으면 유효하다"), 새 설정을 읽을 때도 거기에 붙인다.

## 로드맵 상태 (기획서 10.2 — 전 마일스톤 완료)

- **M0** 2계층 resolve + 버전 격리 PoC ✅ / **M1** iOS+Android SDK α ✅ / **M2** 관리 백엔드 β ✅ /
  **M3** 셀프호스트 GA ✅ / **M4** Web·Flutter·카나리·실시간 푸시 ✅ / **파리티 마감** ✅.
- 마일스톤별 커밋 지도는 `HANDOVER.md` 참조.
- **완료 정의(DoD)**: 각 핵심 기능은 ① 샘플 앱에서 시나리오 A/B/C 재현 ② 단위+통합 테스트 통과 ③ 문서화 — 셋을 충족해야 완료.
- 시나리오: A = 출시 직후 오타 OTA 긴급 수정 / B = 신규 프로젝트에 플러그인 한 줄로 자동 번들링 도입 / C = 규제 산업 완전 셀프호스트.

## 열려 있는 항목 (앱/외부 환경 의존 — 코드 아님)

- **카나리 실제 활성화(rollout<100)**: 8.4 프라이버시 법무 승인 대기. 코드 완비, **안전 기본값 rollout 100 고정**
  (rollout을 쓰는 API 라우트는 없다 — 값을 담을 수 있는 유일한 경로가 import의 백업 복원이고, 거기서 0~100 정수로 검증한다). 버킷 판정은 기기 로컬 익명 `installId`(UUID v4, 서버 미전송) 기반 `hash(installId + releaseId) mod 100 < rollout%`.
- **실제 앱 통합**: Xcode 앱 타깃·AGP 앱 모듈에서의 위젯 렌더·리소스 병합(SDK 계층은 완료·검증). Compose `stringResource` 얇은 래퍼는 앱 모듈.
- **SDK 패키지 게시(6.5)**: 채널·좌표(Android=`com.devryner.rynl10n:android` · Web=`@rynl10n/web` · Flutter=`rynl10n` · iOS=SwiftPM, 버전 lockstep `0.1.0`)도 매니페스트도 확정이고 **릴리스 CI**도 들어왔으나(`.github/workflows/` — `ci.yml`이 곧 릴리스 게이트, `release.yml`이 태그 `v*`에서 4채널 동시 퍼블리시 + lockstep 검사) **4채널 전부 게시 완료**(`v0.1.0`, 2026-08-26 — npm `@rynl10n/web` · pub.dev `rynl10n` · Maven `com.devryner.rynl10n:android` · SwiftPM 태그). lockstep `0.1.0`이 네 레지스트리에서 실물로 성립한다.
  **npm·pub.dev는 첫 버전을 CI로 못 올린다** — 자동 게시(Trusted Publisher / Automated publishing) 등록이
  패키지 존재를 전제하는데 같은 버전 재게시는 거부되기 때문. 그래서 `v0.1.0` 태그 하나로 4채널이 끝나지 않는다.
  npm 잡은 **OIDC로 전환**했다(`NPM_TOKEN` 제거 — 2027-01부터 2FA 우회 토큰의 직접 게시가 폐지된다).
  **Maven은 업로드 후 Portal 승격이 필요하다** — `release.yml`에 그 단계가 없어 태그를 밀어도 Central에
  안 나타나는 상태였고, 2026-08-26에 승격 스텝(`publishing_type=automatic`)을 넣어 막았다. **iOS는 루트 `Package.swift`로 전환했다**(2026-08-26) — SPM이 루트 매니페스트만 인식하므로 매니페스트만
  올리고 소스는 `sdks/ios/`를 `path:`로 가리킨다. 미러 저장소 안은 폐기(클론 전송량 205 KiB 실측 —
  채택 근거가 무너졌다). **태그가 곧 SPM 배포**라 게시 잡도 시크릿도 없다.
  npm·pub 잡에는 **멱등 가드**를 넣었다 — 첫 버전이 워크플로 밖에서 올라갔으므로, 이미 게시된 버전이면
  건너뛴다. 덕분에 `v0.1.0` 태그로 4채널을 정렬할 수 있다. Web 게시본은 소스가 아니라 `prepack`의 **`tsc` 게시 빌드 산출물**(`.js`+`.d.ts`)로 나간다 — 소스 배포는 코어 상대경로 import·`node_modules` 타입 스트리핑 거부·`node:crypto` 때문에 성립하지 않는다. 붙이는 길은 이제 **실 좌표**다(`@rynl10n/web` · `rynl10n` · `com.devryner.rynl10n:android` · SPM 태그). 상세는 `HANDOVER.md`의 "SDK 배포 채널" 절.
  **2026-08-25 `workflow_dispatch`로 `dry_run=true`를 실제로 돌려 4채널 전부 통과**(run 32825252411):
  게이트 5종 + lockstep `0.1.0` · npm dry-run · pub.dev 경고 0건(35KB) · Maven `publishToMavenLocal` ·
  subtree split 루트에 `Package.swift` 확인. 첫 실행은 Maven 잡이 죽었고(빈 시크릿이 서명을 켰다 — `dc4416f`),
  **파이프라인은 태그를 받을 준비가 됐다 — 단 위 Maven 승격 갭은 예외다.** 그 밖에 남은 건 계정·소유 검증·키뿐이다.
  **2026-08-27 받는 쪽까지 확인했다** — 네 채널 게시본을 저장소 밖 빈 프로젝트에서 실 좌표로 설치해
  `t()`까지 6/6 통과(`npm run smoke:consumer`로 재현). 그 결과로 SDK README 4종의 "아직 게시되지
  않았다 / 경로 의존으로 참조한다" 안내를 실 좌표로 교체했고, 루트 README에 4채널 좌표를 넣었다.
  `v0.2.0`에서 처음 실행되는 것은 여전히 둘이다: npm OIDC 인증 · pub.dev 자동 게시(0.1.0에서는
  멱등 가드가 건너뛰었다).
- **프로덕션 토폴로지(M3+)**: Postgres·MinIO/S3·CDN·별도 빌더 워커·OIDC·Helm/K8s. 플레인 분리·API 계약·결정적 빌더는 그대로 유지.
