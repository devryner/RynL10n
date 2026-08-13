# RynL10n

**앱 업데이트·심사 없이 번역을 배포하는 오픈소스 원격 로컬라이제이션 인프라.**

빌드타임에 자동으로 구운 번들(fallback)과 런타임 원격 오버레이의 **2계층 구조**로,
항상 완전한 번역을 보장하면서 스토어 심사 없이 즉시 갱신합니다.

```
번들(빌드타임, 완전한 스냅샷)  ←  항상 존재하는 안전망
오버레이(런타임, 변경분만)     ←  키 단위로 즉시 덮어쓰기
```

- **오타 하나 고치려고 앱 심사를 다시 받지 않습니다** — 수정 → publish → 수 분 내 전 기기 반영.
- **네트워크가 끊겨도 빈 문자열이 없습니다** — 모든 키는 빌드에 포함된 번들이 fallback을 보장합니다.
- **완전한 셀프호스팅** — `docker compose up` 한 줄, Apache-2.0 단일 라이선스, 기능 게이팅 없음.

## 왜 RynL10n인가

| | 일반적인 OTA 번역 서비스 | RynL10n |
| --- | --- | --- |
| 번들링 | 번역 파일을 수동 다운로드·커밋 | **빌드 플러그인 한 줄** — 빌드마다 자동 bake, 커밋할 파일 없음 |
| 셀프호스팅 | 없거나 유료/제한 | **완전 오픈소스** (Apache-2.0 단일, 전 기능 포함) |
| 서버 장애 시 | 번역 조회 불가 위험 | 배포 플레인은 정적 파일 + CDN — **관리 서버가 죽어도 서빙 지속** |
| 런타임 안전성 | 잘못된 플레이스홀더로 크래시 가능 | **포맷 안전 가드** — 서명 불일치 키만 번들로 자동 fallback |
| 롤백 | 재배포 필요 | 불변 산출물 + 포인터 되돌리기 — **즉시·무손실** |

## 지원 플랫폼

| 플랫폼 | SDK | 빌드타임 자동 번들링 | 반응형 바인딩 |
| --- | --- | --- | --- |
| iOS | Swift 6 / SPM (`sdks/ios`) — [**앱 적용 가이드**](sdks/ios/README.md) | SPM build tool plugin | SwiftUI Combine |
| Android | Kotlin / AAR (`sdks/android`) — [**앱 적용 가이드**](sdks/android/README.md) | Gradle task | StateFlow · Compose |
| Web | TypeScript (`sdks/web`) | 번들러 연동 | React 어댑터 |
| Flutter | 순수 Dart (`sdks/flutter`) | build hook | ValueListenable |

SDK 표면은 세 가지가 전부입니다:

```
RynL10n.configure(projectKey, endpoint, options)
t(key, args)                 // 동기 — 번들 fallback이 항상 있어 블로킹 네트워크 없음
onCatalogUpdated(listener)   // 원격 갱신 알림
```

## 빠른 시작

### 1. 서버 실행 (셀프호스트)

```bash
docker compose up   # 대시보드 + 관리 API :8787 · 배포 플레인 :8788
```

브라우저로 <http://localhost:8787> 을 열면 대시보드가 뜹니다. 관리 API 토큰으로 로그인하고
(로컬 기본값 `dev-admin-token`, Docker는 `RYNL10N_ADMIN_TOKEN`) 번역 편집·릴리스·publish·롤백을
모두 화면에서 처리할 수 있습니다.

최소 사양 2 vCPU / 4GB면 충분합니다. 읽기 트래픽은 정적 파일 + CDN이 흡수하므로
앱 사용자가 늘어도 관리 서버 증설이 필요 없습니다.

### 2. 앱에 플러그인 한 줄 추가

빌드 플러그인이 빌드마다 현재 릴리스 스냅샷을 받아 플랫폼 네이티브 포맷
(`.xcstrings` / `strings.xml` / JSON / `.arb`)으로 자동 bake하고, base 해시를
lockfile에 기록해 CI 재현성을 보장합니다. 서버에 접근할 수 없으면 마지막 캐시로
빌드를 계속하며, 완전 폐쇄망을 위한 vendored 모드도 지원합니다.

대시보드에 적어둔 **키 설명은 네이티브 주석으로 함께 구워집니다** — `.xcstrings`의 `comment`,
`strings.xml`의 XML 주석, `.arb`의 `@key.description`. 설명은 스냅샷과 분리된 사이드카로
전달되므로(런타임 페이로드·콘텐츠 해시 불변) 없으면 주석 없이 빌드가 계속됩니다.
Web JSON은 주석을 담을 표준 자리가 없어 생략합니다.

```bash
rynl10n-bake --fetch "$API/projects/myapp/releases/R1/snapshot" --token "$TOKEN" \
  --descriptions "$API/projects/myapp/releases/R1/descriptions" \
  --emit-native ./Generated
```

### 3. 번역 수정 → publish

대시보드(또는 관리 API)에서 번역을 수정하고 publish하면 실행 중인 앱이 오버레이를 받아
즉시 반영합니다. 문제가 생기면 롤백 한 번으로 이전 상태로 무손실 복귀합니다.

## 대시보드

관리 플레인(`:8787`)이 함께 서빙하는 어드민 앱입니다. 별도 설치·빌드가 없고
(프레임워크·번들러 없는 바닐라 HTML/CSS/JS), 다른 코드와 동일한 Apache-2.0 범위입니다.

| 탭 | 할 수 있는 일 |
| --- | --- |
| 번역 | 키 추가, **키 설명(번역자용 맥락) 작성**, 로케일별 값 인라인 편집, `draft`↔`reviewed` 상태 전환, 지원 로케일 추가, **검색·필터**(키 이름·설명·번역 값 검색 + 로케일·미번역만·상태 3축) |
| 릴리스 | 릴리스 생성(매칭 전략 3종 — semver-range·integer-range·exact-label), 키 백포트, publish, 롤백, 보관 |
| 배포 | 현재 manifest·산출물 링크, 게시 이력, 배포 건전성, 산출물 재생성, 전체 export |

프로젝트 목록 화면에서는 프로젝트 생성·삭제와 **export 파일 가져오기(import)** 를 할 수 있습니다(Admin).

- **번역자용 설명** — 각 키에 "이 문구가 어디에 쓰이고 어떤 톤인지"를 남겨둘 수 있습니다. 키(=의미) 단위라 나중에 로케일을 늘려도 같은 설명이 그대로 쓰이며, 앱으로 내려가는 산출물에는 포함되지 않습니다. 빌드 시에는 네이티브 포맷의 주석으로 구워져 Xcode·ARB에서 작업하는 번역자에게도 전달됩니다(아래 참조).
- **RBAC 반영** — 토큰 역할(Admin/Maintainer/Translator/Viewer)에 따라 쓰기 UI가 잠깁니다. 최종 판정은 항상 서버입니다.
- **프로젝트 삭제** — Admin만 가능하며 되돌릴 수 없습니다. 확인하려면 프로젝트 ID를 직접 입력해야 하고, published 릴리스가 남아 있으면 서버가 막습니다(먼저 보관하세요).
- **가져오기(import)** — '전체 export'로 받은 JSON을 올려 프로젝트를 통째로 복원합니다(락인 없음). 파일을 고르면 먼저 미리보기(프로젝트 ID·로케일/키/릴리스 수)를 보여주고, 복원할 ID를 그 자리에서 바꿀 수 있습니다. **이미 있는 ID는 덮어쓰지 않고 거절합니다** — 복사본을 만들려면 ID를 바꾸고, 원본을 대체하려면 먼저 삭제하세요. 복원은 전부 되거나 전혀 안 되거나 둘 중 하나입니다(트랜잭션).
- **실시간 반영** — publish·롤백이 일어나면 SSE 신호를 받아 화면이 자동 갱신됩니다(데이터는 정적 경로로만 이동).
- **플레인 분리 유지** — 대시보드는 관리 플레인만 호출하고, 배포 플레인은 산출물 링크로만 노출합니다.
- 헤드리스로 돌리려면 `createManagementServer({ serveDashboard: false })`.

## 빠른 시작: API 워크플로

서버가 떠 있다면 curl만으로 번역 등록부터 OTA 배포까지 전 사이클을 돌릴 수 있습니다.
관리 API(`:8787`)는 Bearer 토큰 인증이 필요합니다 — `npm run backend` 기본값은
`dev-admin-token`, Docker는 `RYNL10N_ADMIN_TOKEN` 환경 변수로 주입합니다(운영 시 반드시 교체).

```bash
API=http://localhost:8787
CDN=http://localhost:8788
AUTH='Authorization: Bearer dev-admin-token'
JSON='content-type: application/json'

# 1. 프로젝트 생성 — 지원 로케일은 반드시 생성 시 locales 배열로 등록
#    (등록되지 않은 로케일의 번역은 산출물에서 제외됩니다)
curl -X POST $API/projects -H "$AUTH" -H "$JSON" \
  -d '{"id":"myapp","name":"My App","defaultLocale":"en","locales":["en","ko"]}'

# 2. 키 등록 — namespace.key 형식, 플레이스홀더 서명 포함
curl -X PUT $API/projects/myapp/keys/home.greeting -H "$AUTH" -H "$JSON" \
  -d '{"placeholders":["name"]}'

# 3. 번역 입력 (로케일별)
curl -X PUT $API/projects/myapp/translations/home.greeting/en -H "$AUTH" -H "$JSON" \
  -d '{"value":"Hello, {name}!"}'
curl -X PUT $API/projects/myapp/translations/home.greeting/ko -H "$AUTH" -H "$JSON" \
  -d '{"value":"안녕하세요, {name}님!"}'

# 4. 릴리스 생성 — 앱 버전 범위 매핑
#    전략 3종: semver-range(명시적 하한·상한 필수) · integer-range(빌드넘버) · exact-label
#    값이 그 전략의 문법이 아니면 이 시점에 400 — publish까지 갔다가 실패하지 않습니다.
curl -X POST $API/projects/myapp/releases -H "$AUTH" -H "$JSON" \
  -d '{"name":"1.x","versionMatch":{"strategy":"semver-range","value":">=1.0.0 <2.0.0"},"keys":["home.greeting"]}'
# → {"id":"R1","state":"draft"}

# 5. publish — 스냅샷·manifest 생성 + 배포 플레인 게시 (202 + jobId)
curl -X POST $API/projects/myapp/releases/R1/publish -H "$AUTH"

# 6. 배포 플레인에서 확인 — SDK가 읽는 경로 그대로 (정적 파일, 인증 없음)
curl $CDN/myapp/manifest.json
curl $CDN/myapp/releases/R1/snapshot-<manifest의 base 해시>.json

# 7. OTA 수정 — 번역을 고쳐 재게시하면 변경분만 담긴 델타가 생성되고
#    manifest의 overlay 포인터가 새 해시로 이동합니다 (앱 업데이트 불필요)
curl -X PUT $API/projects/myapp/translations/home.greeting/ko -H "$AUTH" -H "$JSON" \
  -d '{"value":"반갑습니다, {name}님!"}'
curl -X POST $API/projects/myapp/releases/R1/publish -H "$AUTH"
curl $CDN/myapp/manifest.json   # → "delta": "releases/R1/delta-<base>-<overlay>.json"
```

문제가 생기면 롤백 한 번으로 이전 overlay로 무손실 복귀합니다:

```bash
curl -X POST $API/projects/myapp/releases/R1/rollback -H "$AUTH" -H "$JSON" \
  -d '{"to":"<이전 overlay 해시>"}'
```

전체 엔드포인트 표(권한·상태 코드 포함)는 [`backend/README.md`](backend/README.md),
백업·복구·에어갭 등 운영 절차는 [`OPERATIONS.md`](OPERATIONS.md)를 참조하세요.

## 아키텍처 핵심

- **플레인 분리** — 쓰기 경로(관리 API + DB + 빌더)와 읽기 경로(오브젝트 스토리지 + CDN, 정적 파일만)를 완전히 분리. SDK는 관리 API를 절대 호출하지 않습니다.
- **버전 격리** — 릴리스를 앱 버전 범위에 매핑하고, 클라이언트가 정적 manifest만으로 자기 릴리스를 스스로 선택합니다(서버 라우팅 없음). 신규 키가 구버전 앱에 노출되지 않습니다.
- **결정적 직렬화** — RFC 8785(JCS) + NFC 정규화 + SHA-256 내용해시. 같은 콘텐츠는 항상 같은 바이트열이므로 불변 캐싱·무손실 롤백·DB만으로 전체 산출물 재생성(재해복구)이 성립합니다.
- **골든 벡터 계약** — TypeScript 참조 구현이 기대 출력을 언어 무관 JSON으로 방출하고, 4개 SDK가 이를 로드해 바이트·해시·동작 정합을 기계 검증합니다.

## 저장소 구성

```
src/                  결정적 코어 참조 구현 (TypeScript, 런타임 의존성 0)
backend/              관리 백엔드 (REST API + 산출물 빌더)
backend/src/ui/       대시보드 (어드민 앱 — 빌드 스텝 없는 바닐라 HTML/CSS/JS)
sdks/                 ios · android · web · flutter SDK
fixtures/golden/      크로스언어 계약 골든 벡터
examples/             SPM 플러그인 소비 예제 등
docker-compose.yml    단일 노드 셀프호스트
```

## 개발

Node ≥ 23.6 (네이티브 타입 스트리핑 — 빌드 스텝 없음). 코어·백엔드 모두 외부 런타임 의존성이 없습니다.

```bash
npm test                 # 코어 참조 구현 테스트
npm run test:backend     # 관리 백엔드 테스트
npm run gen:golden       # 골든 벡터 재생성 (스키마/알고리즘 변경 시)
swift test               # sdks/ios
gradle test              # sdks/android
node --test "test/*.test.ts"   # sdks/web
dart test                # sdks/flutter
```

## 라이선스

[Apache-2.0](LICENSE) — SDK·서버·어드민 전체 단일 라이선스. 기능 게이팅이나
엔터프라이즈 전용 기능 없이 코어만으로 기능적으로 완전한 제품입니다.
**대시보드 역시 오픈소스 범위**입니다 — 유료·클라우드 전용으로 분리하지 않습니다.
