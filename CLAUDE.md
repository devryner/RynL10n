# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 저장소 현재 상태 (중요)

**M0 스파이크 구현 완료 단계다.** 기획서(SoT)의 가장 어려운 핵심(4.3 버전 격리 + 3.1 2계층 resolve)을
검증하는 TypeScript 참조 구현이 `src/`에 있다. 플랫폼 SDK(iOS/Android)는 M1이다. 아직 git 저장소는 아니다.

- **M0 스파이크 스택**: TypeScript/Node ≥ 23.6 (네이티브 타입 스트리핑, 빌드 스텝 없음). 런타임 의존성 0
  (`node:crypto` + `String.normalize`). devDep은 `typescript`·`@types/node`(타입체크용)뿐.
- **명령**:
  - `npm test` — `node --test "test/*.test.ts"` (유닛 + 시나리오 A/B/C 통합, 39 tests)
  - `npm run typecheck` — `tsc --noEmit` (strict + erasableSyntaxOnly)
  - `npm run demo` — 시나리오 A/C 콘솔 재현
- **레이아웃**: `src/serialize`(JCS·해시) · `src/core`(types·semver·matching·resolve·placeholder) ·
  `src/builder`(산출물 빌더) · `src/client`(SDK 런타임 시뮬) · `test/` · `examples/demo.ts`. 상세·기획서 매핑은 `README.md`.
- **스파이크가 드러낸 스펙 조정 1건**: 11.3의 클라이언트 후보 필터 "published만"은 8.1(superseded 산출물이
  구버전 앱에 계속 서빙)과 충돌 → 스파이크는 `published`·`superseded`를 후보로 두고 `draft`·`archived`만 제외.
  README "스펙 조정 지점" 참조. 기획서 11.3 문구 정정 제안 대기.
- 설계 관련 판단이 필요하면 항상 기획서를 먼저 확인한다(아래 참조). 이 파일은 요약일 뿐, 상충 시 기획서가 우선한다.

### 기획서(SoT) 읽는 법

Craft MCP 문서다. rootBlockId = `0f5c1bb2-03c7-7787-654c-483c5061805f`.

```
craft_read: blocks get 0f5c1bb2-03c7-7787-654c-483c5061805f --format markdown
# 길어서 페이지네이션됨 → 응답의 nextCursor로 이어 읽기
```

주요 절: 3.1(2계층 resolve), 4.1(플레인 분리), 4.3(버전 격리), 5(데이터 모델), 6(SDK), 7(백엔드/API), 8(배포/롤백), 9(셀프호스팅/사업모델), 10(로드맵), 11(MVP 블로커 확정 스펙 — 직렬화/API/매칭).

## 제품 한 줄 정의

앱 업데이트·심사 없이 번역을 배포하는 오픈소스 원격 로컬라이제이션 인프라. **빌드타임에 자동으로 구운 번들(fallback) + 런타임 원격 오버레이의 2계층**으로, 항상 완전한 번역을 보장하면서 즉시 갱신한다.

핵심 차별점 두 가지(나머지는 경쟁사도 하는 패리티): ① **빌드타임 자동 번들링**(플러그인 한 줄, 커밋할 파일 없음) ② **완전 오픈소스 셀프호스팅**.

## 아키텍처 — 큰 그림

여러 파일에 흩어질 구조라 먼저 이해해야 할 핵심:

### 플레인 분리 (모든 것의 기반, 기획서 4.1)

- **관리 플레인 (Management Plane)** — 대시보드 + 관리 API + DB(SoT) + 산출물 빌더. **쓰기 경로 전담, 인증 필요.**
- **배포 플레인 (Delivery Plane)** — 오브젝트 스토리지 + CDN. **정적 파일만 서빙(읽기 경로에 애플리케이션 서버 없음).**
- **철칙: SDK 런타임은 배포 플레인의 정적 파일만 읽고, 관리 API는 절대 호출하지 않는다.** 관리 서버가 죽어도 기존 배포는 CDN에서 계속 서빙된다. 이 분리가 셀프호스팅 경량성과 롤백 무손실성의 근거다.

### 2계층 resolve (기획서 3.1)

조회 순서는 **원격 오버레이 → 번들 스냅샷**, 키 단위 override. 로케일 fallback은 BCP 47 태그를 구체→일반으로 절단(`ko-KR → ko → 기본 로케일`)하되 **각 로케일 단계 안에서 오버레이+번들을 모두 확인한 뒤 다음 로케일로**(로케일 우선 원칙). 오버레이는 sparse(변경분만), 적용은 원자적(체크섬 후 스왑). **포맷 안전 가드**: 오버레이 플레이스홀더 서명이 번들과 불일치하면 그 키만 번들로 fallback(런타임 크래시 차단).

### 버전 격리 (가장 어려운 핵심, 기획서 4.3 · M0의 목표)

- 프로젝트 → **릴리스(release)** → 앱 버전 범위 매핑. 릴리스 = 키 카탈로그 스냅샷 + 버전 매칭 규칙 + 상태.
- **정적 manifest 라우팅**: 버전→릴리스 매핑을 정적 manifest로 배포하고 **클라이언트가 자기 앱 버전에 맞는 릴리스를 스스로 선택**(서버 라우팅 없음 → 배포 플레인 정적 원칙 유지).
- `versionMatch = { strategy: 'semver-range' | 'exact-label', value }`. semver-range는 **node-semver 부분집합만**(비교자 + 공백 AND 결합; `||`·`^`·`~`·x-range·hyphen-range 파싱 거부 → 항상 명시적 하한·상한). publish 시 범위 충돌은 409로 차단(런타임엔 매칭 릴리스가 최대 1개 보장).

### 직렬화 (기획서 11.1 — 결정성이 전부)

- **RFC 8785 JSON Canonicalization Scheme(JCS)** + 문자열 NFC 정규화 → 같은 (릴리스, 콘텐츠)면 항상 같은 바이트열.
- **콘텐츠 해시 = SHA-256**, 파일 식별자는 앞 16 hex 절단. 해시 입력에서 `createdAt`·`base` 제외.
- **스냅샷**(전체 카탈로그) + **델타**(sparse, `set`/`delete` ops, `(locale,key,op)` 사전순 정렬). 복수형은 CLDR 카테고리 맵 **전체 원자 교체**(부분 델타 없음).
- 내부 표준 저장 포맷은 **ICU MessageFormat + CLDR 복수형**. bake 시점에 플랫폼 네이티브 포맷(.xcstrings/strings.xml/JSON/.arb)으로 변환. 변환 손실은 메타·플래그로 보존하거나 안전 축약 + 경고(조용한 손실 금지).

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

- 최소 API: `RynL10n.configure(projectKey, endpoint, options)` / `t(key, args)`(동기 — 항상 번들 fallback이 있어 블로킹 네트워크 없음) / `onCatalogUpdated(listener)`.
- **빌드타임 자동 번들링 플러그인**(차별점 ①): Gradle task / SPM build tool plugin / 번들러 플러그인 / Flutter build hook. 빌드마다 현재 릴리스 스냅샷을 fetch → 네이티브 포맷으로 bake → base 해시를 lockfile에 기록(결정성·CI 재현성). 서버 실패 시 마지막 캐시로 진행, 에어갭용 vendored 모드 지원.
- 공통 코어(resolve·캐시·폴링)는 공유하되 표면은 각 플랫폼 관용구에 맞춘다.

## 확정된 스택 / 결정 (스캐폴딩 시 이대로)

- **플랫폼**: MVP는 **iOS(Swift/SPM) + Android(Kotlin/Gradle)** 먼저. Web(JS/TS) · Flutter(Dart)는 M4.
- **라이선스**: 전체 **Apache-2.0 단일**(SDK·서버·어드민앱 구분 없이). 기능 게이팅·엔터프라이즈 전용 기능 없음.
- **사업 모델**: 오픈코어 아님. 오픈소스 코어 + **유료 매니지드 호스팅**(설치·운영 대행). 코어만으로 기능적으로 완전한 제품.
- **셀프호스팅**: 단일 노드 **Docker Compose**(관리 API + DB + 빌더 워커 + MinIO + 대시보드, `docker compose up` 원커맨드) / 대규모는 Helm·K8s(S3 호환 스토리지).
- 관리 API 인증: 사람=OIDC, 머신(CI 플러그인)=스코프 제한 토큰. RBAC 4역할: Admin / Maintainer / Translator / Viewer.

## 로드맵 — 지금 무엇을 만드는가 (기획서 10.2)

- **M0 — 스파이크 (현재)**: **2계층 resolve + 버전 격리 정적 manifest 라우팅 PoC.** 가장 어려운 4.3을 먼저 검증하는 것이 목표.
- M1 — iOS+Android SDK α: 조회 API + 런타임 로딩 + 빌드 플러그인, 백엔드는 단일 노드.
- M2 — 관리 백엔드 β: 대시보드 편집·릴리스·백포트, 배포 파이프라인, publish/롤백.
- M3 — 셀프호스트 GA / M4 — Web·Flutter·카나리.

**완료 정의(DoD)**: 각 핵심 기능은 ① 샘플 앱에서 시나리오 A/B/C 재현 ② 단위+통합 테스트 통과 ③ 문서화 — 셋을 충족해야 완료.

시나리오: A = 출시 직후 오타 OTA 긴급 수정 / B = 신규 프로젝트에 플러그인 한 줄로 자동 번들링 도입 / C = 규제 산업 완전 셀프호스트.

## 미해결 (구현 중 마주치면)

문서상 설계는 모두 확정됐다. 유일한 잔여는 **8.4 카나리 버킷팅의 프라이버시 법무 확인**(외부 인풋 대기) — 확인 전 안전 기본값은 **카나리 비활성(rollout 100% 고정)**. 버킷팅 코드는 작성하되 실제 활성화는 법무 승인 후. 버킷 판정은 기기 로컬 익명 `installId`(UUID v4, 서버 미전송) 기반 `hash(installId + releaseId) mod 100 < rollout%`.
