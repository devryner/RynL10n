# RynL10n 관리 백엔드 (M2 β)

대시보드 편집·릴리스·백포트, 배포 파이프라인(7.4), publish/롤백(8.3)을 제공하는 관리 플레인.
**M0 참조 빌더(`../src/builder`)를 그대로 재사용** — 골든 벡터로 검증된 결정적 산출물 생성을 공유한다.

## 실행

```bash
npm run backend            # 대시보드 + 관리 API :8787 · 배포 플레인 :8788 (node:sqlite 내장, 외부 의존성 0)
                           # → 브라우저로 http://localhost:8787 접속, 토큰으로 로그인
npm run test:backend       # node --test — 파이프라인 + API 통합 + 대시보드 + 사용자 관리 (118 tests)
npm run typecheck:backend  # tsc --noEmit
docker compose up          # 단일 노드 셀프호스트 (9.1)
```

- Node ≥ 23.6 (네이티브 TS 타입 스트리핑). DB=`node:sqlite`, 스토리지=로컬 FS(MinIO/S3 대체 가능).

## 대시보드 (어드민 앱, 9.2 코어 ③)

관리 플레인이 `/`(HTML)와 `/ui/*`(JS·CSS)로 함께 서빙한다. 소스는 [`src/ui/`](src/ui/) —
프레임워크·번들러 없는 바닐라 ES 모듈이라 빌드 스텝이 없고 에어갭에서도 그대로 동작한다.

- 자산 경로는 **고정 허용 목록**(`src/ui/serve.ts`)이라 임의 파일 요청·경로 순회가 불가능하다.
- 정적 자산은 인증 없이 내려가지만 **모든 데이터 접근은 Bearer 토큰**을 거친다(로그인 = `GET /me` 검증).
- 역할별로 쓰기 UI가 잠긴다(7.3의 UI 미러). 최종 판정은 언제나 서버.
- publish·롤백 시 SSE(`/projects/{p}/events`)로 화면이 자동 갱신된다 — 신호만 오고 데이터는 정적 경로 유지.
- 끄려면 `createManagementServer({ serveDashboard: false })`.

## 플레인 분리 (4.1)

- **관리 플레인** (`:8787`, 쓰기, 인증) — REST API. DB(SoT) + 산출물 빌더.
- **배포 플레인** (`:8788`, 읽기, 정적) — 스냅샷·델타·manifest만 서빙. 애플리케이션 서버 없음.
  구현은 `src/storage/delivery-server.ts`(관리 API와 코드 경로 완전 분리).
- SDK 런타임은 배포 플레인만 읽고 관리 API는 절대 호출하지 않음 → 관리 서버가 죽어도 기존 배포는 계속 서빙.

### 배포 플레인이 CDN처럼 굴기 위한 두 가지

참조 서버는 실제 CDN/S3가 공짜로 주는 동작을 그대로 낸다. 둘 중 하나만 빠져도 SDK는 죽지 않지만
갱신 경로가 **조용히** 반쪽이 된다 — 그래서 계약 테스트(`test/delivery-plane.test.ts`)로 못박아 뒀다.

- **ETag + 조건부 요청(304)**: manifest는 짧은 TTL이라 폴링마다 재검증된다. validator가 없으면
  `If-None-Match`가 성립할 수 없어 매번 전량 재다운로드가 된다. ETag는 산출물 바이트의 내용해시라
  같은 내용 → 같은 검증자(결정성). `*`·목록·약한 검증자(`W/`)를 모두 이해한다(RFC 9110 §13.1.2).
- **CORS**: 브라우저 SDK(Web·Flutter Web)는 보통 다른 오리진에 있다. `Access-Control-Allow-Origin`
  (기본 `*`, `RYNL10N_DELIVERY_ALLOW_ORIGIN`으로 조정) + **`Access-Control-Expose-Headers: ETag`**
  (안전목록 헤더가 아니라 노출하지 않으면 JS가 못 읽는다) + `Access-Control-Allow-Headers:
  If-None-Match`(preflight 유발 헤더). 자세한 운영 지침은 [`OPERATIONS.md`](../OPERATIONS.md).

읽기 전용이라 `GET`·`HEAD`·`OPTIONS` 외 메서드는 405다.

## 데이터 모델 (5 / 7.4)

`node:sqlite` 정규화 관계형 SoT — `projects` / `locales` / `keys` / `translations` / `releases` /
`release_keys`(다대다, 백포트 대상) / `jobs` / `published_manifests`(롤백 보존 창) / `audit_log` /
`users` · `user_tokens`(사용자 관리 7.3 — 인스턴스 수준, export/import 비포함).

**키 설명(`keys.description`, 5.1)** — 번역자가 읽는 맥락(화면·톤·제약). 값이 아니라 '의미'에 붙으므로
로케일별이 아닌 **키 단위**이며, 로케일을 늘려도 같은 설명이 그대로 쓰인다.
저작 메타데이터라 **런타임 스냅샷·델타에는 싣지 않는다** — 기기로 내려갈 이유가 없고,
해시 입력(11.1 `{release,defaultLocale,locales}`)이 바뀌면 골든 벡터 계약이 깨지기 때문이다.
export/import에는 포함된다(9.2 락인 없음). 구 export에 필드가 없으면 빈 문자열로 취급.

대신 빌드타임에는 **사이드카**로 전달한다: `GET /projects/{p}/releases/{r}/descriptions`를
빌드 플러그인이 스냅샷과 별도로 fetch해 네이티브 주석으로 굽는다(5.3/6.3) —
`.xcstrings`의 `comment` · `strings.xml`의 XML 주석 · `.arb`의 `@key.description`.
사이드카가 없거나 읽기에 실패하면 주석 없이 bake가 계속된다(빌드가 설명 가용성에 종속되지 않음).

스키마 변경은 `schema.ts`의 `MIGRATIONS`에 idempotent ALTER로 추가한다(9.4 업그레이드) —
신규 DB는 `CREATE TABLE`이, 기존 DB는 ALTER가 처리하고 중복 적용은 무시된다.

## 관리 API (7.1 / 11.2)

| 메서드·경로 | 권한 | 성공 | 실패 |
| --- | --- | --- | --- |
| `GET /me` | Viewer+ | 200 `{actor,role,projects,deliveryBaseUrl}` | 401 |
| `POST /projects` | Admin | 201 | 403 |
| `GET /projects` | Viewer+ | 200 (토큰 스코프 내 프로젝트만) | 401 |
| `GET /projects/{p}` | Viewer+ | 200 `{…,locales}` | 404 |
| `POST /projects/{p}/locales` | Maintainer+ | 200 `{locales}` | 400 · 404 |
| `GET /projects/{p}/keys` | Viewer+ | 200 (키 + 로케일별 번역 + refCount) | 404 |
| `GET /projects/{p}/releases/{r}/keys` | Viewer+ | 200 `{keys}` | 404 |
| `GET /projects/{p}/releases/{r}/descriptions` | Viewer+ | 200 `{release,descriptions}` (bake 사이드카) | 404 |
| `GET /projects/{p}/manifests` | Viewer+ | 200 (게시 이력 — 롤백 대상) | — |
| `GET /projects/{p}/telemetry` | Viewer+ | 200 (릴리스·앱 버전군·이벤트별 익명 집계) | 404 |
| `PUT /projects/{p}/keys/{key}` | Translator+ | 200 `{id,name,signature,isPlural,description}` | — |
| `PUT /projects/{p}/translations/{key}/{locale}` | Translator+ | 200 | **422** 서명 불일치 · 404 |
| `POST /projects/{p}/translations/import` | Translator+ | 200 `{createdKeys,updatedKeys,translations}` | 400 형식·로케일 · **422** 서명/복수형 불일치 |
| `POST /projects/{p}/releases` | Maintainer+ | 201 | 400 |
| `POST /projects/{p}/releases/{r}/keys` | Maintainer+ | 200 | 404 |
| `POST /projects/{p}/releases/{r}/publish` | Maintainer+ | **202** {jobId} | **409** 범위 충돌 |
| `PATCH /projects/{p}/releases/{r}` | Maintainer+ | 200 | 404 |
| `POST /projects/{p}/releases/{r}/rollback` | Maintainer+ | 200 | 404 |
| `POST /projects/{p}/translations/{key}/backport` | Maintainer+ | 200 · **207** 부분 | 404 |
| `GET /projects/{p}/jobs/{jobId}` | Viewer+ | 200 | 404 |
| `GET /projects/{p}/releases` · `GET /projects/{p}/manifest` | Viewer+ | 200 | 404 |
| `GET /users` · `POST /users` | Admin | 200 · 201 | 400 · **409** 중복 id |
| `PATCH /users/{id}` · `DELETE /users/{id}` | Admin | 200 | **409** 마지막 admin · 404 |
| `POST /users/{id}/tokens` | Admin | 201 `{id,token,label}` — **평문 1회 노출** | 404 |
| `DELETE /users/{id}/tokens/{tid}` | Admin | 200 (즉시 무효) | 404 |

인증 없음 → **401**. 권한 부족 → **403**.

## 인증 & RBAC (7.3)

머신(CI 플러그인)=스코프 제한 Bearer 토큰. 사람=OIDC는 통합 지점만(β는 토큰 경로).
역할 4종: **Admin**(전체) / **Maintainer**(릴리스·publish·롤백·백포트) / **Translator**(번역 편집) / **Viewer**(읽기).

**사용자 관리** — `users`·`user_tokens` 테이블 + `DbTokenRegistry`(main.ts 배선). 부트스트랩 env 토큰
(`RYNL10N_ADMIN_TOKEN`)으로 첫 admin 사용자를 만든 뒤 발급 토큰으로 갈아탄다(env 토큰은 회전 권장).
토큰은 **sha256 해시만 저장**되고 평문은 발급 응답에 한 번만 담긴다 — 잃어버리면 폐기 후 재발급.
폐기·비활성·삭제는 DB 조회 기반이라 **즉시** 401이 되며(세션 캐시 없음), 마지막 활성 admin의
강등·비활성·삭제는 409로 막는다(스스로 잠그는 사고 차단). 모든 변경은 `audit_log`(project_id=`*`)에 남는다.
사용자는 인스턴스 수준이라 프로젝트 export/import(9.2)에 포함되지 않는다 — 복원에 권한이 딸려오지 않는다.
`users.oidc_subject`는 OIDC 통합 지점(β 미사용).

**토큰 최소 권한** — 발급 시점에 두 축으로 좁힐 수 있다(발급 후 불변, 바꾸려면 재발급):

| 축 | 값 | 효과 |
| --- | --- | --- |
| `surface` | `all`(기본) · `mcp` | `mcp`면 `POST /mcp` **외의 모든 관리 API가 403** |
| `maxRole` | 없음(기본) · 역할 4종 | 사용자 역할과 상한 중 **약한 쪽**으로 접힌다(`narrowRole`) |

토큰 평문은 에이전트 설정 파일·CI 시크릿처럼 서버 밖에 놓이는 값이라, 새어도 피해가 사용자 권한
전체로 번지지 않게 하는 것이 목적이다. 기본값이 곧 기존 동작이라 **이미 발급된 토큰은 그대로
살아 있다**(마이그레이션 회귀 테스트가 이걸 본다). 손상된 값은 넓은 쪽이 아니라 **좁은 쪽으로**
접는다 — 알 수 없는 surface는 `mcp`, 알 수 없는 상한은 `viewer`. 반대로 접으면 DB가 오염됐을 때
권한이 열린다. 대시보드 사용자 패널의 발급 컨트롤에서 둘 다 고를 수 있고, 발급된 토큰에는
제한이 배지로 보인다.

## 배포 파이프라인 (7.4 / 8.1–8.3)

publish 시: ① 버전 범위 충돌·자동 상한 닫힘 검증(쓰기 전, 409) → ② 카탈로그 → 스냅샷/델타
산출물 생성(빌더 재사용, 결정적) → ③ 서빙 릴리스로 manifest 재게시 + 이력 기록.
**롤백** = overlay 포인터를 이전 target으로 되돌리고 재게시(산출물 불변, 즉시·무손실).
**보존 창** = 최근 20개 published manifest(8.3).

## 관측성 (9.3, M3)

- `GET /metrics` — Prometheus 노출: `rynl10n_publish_total{result}` · `rynl10n_publish_duration_seconds` ·
  `rynl10n_api_requests_total` · `rynl10n_telemetry_events_total{event}`. 구조화 JSON 로그(stdout).
- `POST /projects/{p}/telemetry` — 옵트인·익명·집계 수집(인증 없음). **정의된 5개 필드 외 유입은 거부**(프라이버시 가드).
- `GET /projects/{p}/telemetry` — Viewer+ 익명 집계 열람. 릴리스·앱 버전군·이벤트별 누적 카운트만 반환.
  이벤트 ∈ {overlay_applied, format_guard_rejected, key_unresolved, delta_failed}.
- `GET /projects/{p}/releases/{r}/health` — 카나리 판정(8.4) 입력: 포맷 가드 거부율·미해결율·델타 실패율.

## 데이터 이식성 · 재해 복구 (9.2 / 9.4, M3)

- `GET /projects/{p}/export` / `POST /projects/import` — 전체 export/import(락인 없음).
- `POST /projects/{p}/translations/import` — 기존 프로젝트에 키·번역만 일괄 upsert. 전체 검증 후 단일 트랜잭션 적용.
- `POST /projects/{p}/rebuild` — DB(SoT)만으로 산출물 재생성(결정적). 스토리지 유실 복구.
- 운영 절차 전체는 [`../OPERATIONS.md`](../OPERATIONS.md).

## MCP 도구 표면 (`POST /mcp`)

관리 플레인에 JSON-RPC 2.0(Streamable HTTP)로 마운트된 **에이전트용 표면**. 끄려면
`createManagementServer({ serveMcp: false })`. 인증·RBAC는 **관리 API와 같은 축**이다 —
같은 Bearer 토큰, 같은 4역할, 같은 프로젝트 스코프. 도구마다 라우트와 같은 capability를 달고
`tools/list`는 **호출자가 쓸 수 없는 도구를 아예 빼서** 내려준다(모델에게 보이지 않는 편이
호출 후 거부당하는 것보다 낫다).

전송 계층은 직접 구현했다 — 필요한 것은 JSON-RPC 프레임 몇 개와 POST 하나뿐이고,
`@modelcontextprotocol/sdk`를 넣으면 이 저장소 최초의 런타임 의존성이 된다(의존성 0 원칙).
대가로 표면을 최소로 둔다: **stateless**(세션 없음) · 서버→클라이언트 스트림 없음(`GET /mcp`는 405) ·
알림은 본문 없는 202. 셋 다 스펙이 허용하는 선택지다.

도구 실행 실패는 JSON-RPC 에러가 아니라 `isError: true` 결과로 나간다 — 모델이 반응해야 하는
정보지 호출 자체의 실패가 아니고, 프로토콜 에러로 올리면 대화가 끊긴다.

**Origin 가드.** MCP 클라이언트는 브라우저가 아니라 `Origin`을 보내지 않는다 — 그래서 Origin이
**붙어 있다는 것 자체가** 브라우저에서 왔다는 신호이고, `RYNL10N_MCP_ALLOWED_ORIGINS`에 없으면
403이다. 기본값은 **빈 목록**(= Origin이 붙은 요청 전부 거부)이라 정상 사용을 막지 않으면서
로컬에 띄운 서버를 악성 페이지가 부르는 경로(DNS rebinding)를 끊는다. Host 비교로는 안 된다 —
rebinding에서는 Host도 공격자 도메인이라 Origin과 일치한다. 가드는 **인증보다 먼저** 건다.
지금도 Bearer가 필수라 실제 악용 경로는 이미 막혀 있지만, 방어선이 하나뿐인 상태를 없앤다.

**토큰은 `surface: "mcp"`로 발급하는 것을 권한다** — 그 토큰이 에이전트 설정 파일에 놓이므로,
새더라도 관리 API 전체가 딸려가지 않는다(위 "인증 & RBAC"의 토큰 최소 권한).

### `validate_translation` — 쓰기 전 검증 (read)

번역 값이 키의 플레이스홀더 서명·복수형 형태·지원 로케일을 만족하는지 **저장하지 않고** 검사한다.
`{project, key, entries:[{locale, value, state?}]}`.

- **판정은 단일 원천이다**: `ok`는 실제 쓰기 경로가 쓰는 `requireTranslationImport`가 정한다.
  여기서 규칙을 다시 구현하면 "미리보기는 통과, 실제 쓰기는 422"라는 최악의 조합이 생긴다.
  로케일별로 문제를 쪼개는 것도 규칙 복제가 아니라 **같은 검증기를 슬라이스마다 다시 부르는 것**이다.
- **엔트리가 배열인 이유**: 서버가 잡는 422 중 하나가 "같은 키의 번역끼리 서명이 다르다"인데
  단건 검증으로는 영영 못 잡는다. 쓰기 도구를 붙일 때도 **입력 스키마를 그대로 공유**해야 한다 —
  스키마가 갈리면 그 사이에서 변형이 일어나 검증이 무의미해진다.
- 서명 불일치는 문자열 두 개가 아니라 `missingArgs`·`extraArgs`·`changedArgs`로 온다.
  코드: `signature_mismatch` · `signature_inconsistent_across_locales` · `plural_shape_mismatch` ·
  `plural_missing_other` · `plural_unknown_category` · `locale_not_supported` · `duplicate_locale` ·
  `invalid_state`, 그리고 경고 `signature_will_be_established`(빈 서명은 값이 아니라 미확정
  센티널이므로, 이 쓰기가 서명을 **확정**시킨다는 사실을 알린다).
- 응답에 `key.description`을 함께 싣는다 — 검증하러 온 호출자가 "그럼 뭐라고 쓰나"의 맥락을
  같은 호출에서 얻어 왕복이 준다.

### `resolve_preview` — 해석 경로 미리보기 (read)

"이 앱 버전에서 이 키가 실제로 무엇으로 보이는가, 그리고 **왜** 그런가."
`{project, key, locale, appVersion?|releaseLabel?|buildNumber?, bundleBase?, args?, installId?, ...}`.

- **SDK와 같은 코드를 돌린다**: 판정은 `RynL10nClient`(`../../src/client`)가 그대로 하고
  `preview.ts`에는 resolve 규칙이 한 줄도 없다. 시뮬레이터를 따로 구현하면 실물과 갈라지는 순간
  도구가 거짓말을 시작한다.
- **매칭 축 3종 중 최소 하나 필수**(400). 셋 다 없으면 `selectRelease`가 무조건 bundle-only로
  떨어져 늘 같은 무의미한 답이 나온다. `buildNumber`를 빠뜨리면 정수 범위 릴리스가 매칭에서
  통째로 빠지므로 스키마 description에 그 경고를 박아 두었다(4.3의 상시 함정).
- **`bundleBase`가 핵심 인자다.** 서버는 앱이 무엇을 구웠는지 모른다. 생략하면 "방금 빌드한 앱"을
  가정하고 `bundle.assumed: true`로 **가정했음을 밝힌다** — 밝히지 않으면 "정상입니다"라고 답하는데
  사용자 앱은 스테일 번들 때문에 여전히 깨져 있는 조합이 생긴다.
- `diagnosis` 코드는 `refresh()`·`resolveValue()`의 **조기 반환 지점과 1:1**이다:
  `manifest_missing` · `no_release_matched` · `release_not_published`(manifest에는 published·
  superseded만 실리므로 DB를 봐야 "있는데 아직 draft"를 말할 수 있다) · `stale_bundle` ·
  `bundle_unavailable` · `snapshot_missing` · `overlay_absent` · `canary_excluded` · `delta_missing` ·
  `delta_base_mismatch` · `format_guard_fallback` · `tombstoned` · `locale_fallback` · `key_unresolved`.
  **분기가 늘면 진단 코드도 늘어야 한다** — 그래서 테스트가 코드마다 하나씩 있다.

### 열지 않은 것

배포 플레인은 도구 대상이 아니다(정적 읽기 경로 — 도구가 붙으면 플레인 분리가 흐려진다).
`DELETE /projects` · `POST /projects/import` · 사용자 관리/토큰 발급도 넣지 않았다: admin·비가역이고
확인 UI가 본질인 조작이라 대시보드 자리다. 관리 플레인이 배포 산출물을 **읽는** 것은 분리를 깨지
않는다 — `GET /projects/{p}/manifest`가 이미 하는 진단용 read-through와 같은 성격이다.

## 검증 (DoD)

- `pipeline.test.ts` — publish → **M0 SDK 클라이언트가 백엔드 산출물 소비**(M2→M1 연결) → 편집·델타 →
  롤백 → 버전 격리(자동 상한 닫힘+superseded) → 409 충돌 → 보존 창 → **백엔드 base 해시 = 참조 빌더 일치**.
- `api.test.ts` — 실제 HTTP 서버 기동 후 401/403/422/409/404/202/207 + 전체 워크플로.
- `m3.test.ts` — 메트릭 노출 · 텔레메트리 집계/PII 거부 · **export→import→rebuild 바이트 동일**(이식성+결정성).
- `dashboard.test.ts` — 자산 서빙·허용 목록 밖 404 · `/me` · 스코프 필터 · **로케일 등록이 스냅샷 포함으로 이어짐**.
- `dashboard-ui.test.ts` — 최소 DOM 스텁으로 `src/ui/app.js` 동작 계약 검증(로그인 분기 · 그리드 반영 ·
  편집→PUT 매핑 · 422 롤백 · RBAC UI 미러 · 배포 플레인 링크 · 사용자 패널).
- `mcp-validate.test.ts` — **도구 판정 = 실제 쓰기 경로 판정**(모든 케이스에서 직접 대조) ·
  서명 diff 정확도 · 검증이 DB를 건드리지 않음 · 비ASCII 인자 이름의 현재 동작 고정.
- `mcp-preview.test.ts` — diagnosis 코드마다 그 원인을 실제로 만들어 대조(오버레이·스테일 번들·
  카나리·델타 결측·포맷 가드·tombstone·draft 릴리스·빌드넘버 축 분리).
- `mcp-server.test.ts` — JSON-RPC 표면: 401 · initialize · 알림 202 · tools/list 스키마 ·
  권한 밖 도구 은닉 · 도구 실패가 `isError` 결과로 나감(대화 유지) · `GET /mcp` 405.
- `storage.test.ts` — `readDelta`·`deliveryReader`(SDK와 같은 경로 규약) + **릴리스 id·상대 경로의
  순회 가드**(프로젝트 id에만 있던 가드를 같은 부류의 나머지 세그먼트로 확장).
- `token-scope.test.ts` — 토큰 최소 권한(표면 제한·역할 상한이 실제로 막는가 · 잘못된 값은 400 ·
  목록에 제한 노출) + **구 스키마 업그레이드 회귀**(이미 발급된 토큰이 계속 산다) + MCP Origin 가드.
- `users.test.ts` — 사용자 관리 API + DB 토큰 인증(발급 토큰의 역할·스코프 적용 · 평문/해시 비노출 ·
  폐기/비활성/삭제 즉시 401 · 마지막 admin 409 · 부트스트랩 공존).

## 프로덕션 경로 (M3)

DB=Postgres, 스토리지=MinIO/S3, 배포=CDN, 빌더=별도 워커, OIDC 연동, 대시보드 UI, Helm/K8s.
플레인 분리·API 계약·결정적 빌더는 그대로 유지된다.
