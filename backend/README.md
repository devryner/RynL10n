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

## 배포 파이프라인 (7.4 / 8.1–8.3)

publish 시: ① 버전 범위 충돌·자동 상한 닫힘 검증(쓰기 전, 409) → ② 카탈로그 → 스냅샷/델타
산출물 생성(빌더 재사용, 결정적) → ③ 서빙 릴리스로 manifest 재게시 + 이력 기록.
**롤백** = overlay 포인터를 이전 target으로 되돌리고 재게시(산출물 불변, 즉시·무손실).
**보존 창** = 최근 20개 published manifest(8.3).

## 관측성 (9.3, M3)

- `GET /metrics` — Prometheus 노출: `rynl10n_publish_total{result}` · `rynl10n_publish_duration_seconds` ·
  `rynl10n_api_requests_total` · `rynl10n_telemetry_events_total{event}`. 구조화 JSON 로그(stdout).
- `POST /projects/{p}/telemetry` — 옵트인·익명·집계 수집(인증 없음). **정의된 5개 필드 외 유입은 거부**(프라이버시 가드).
  이벤트 ∈ {overlay_applied, format_guard_rejected, key_unresolved, delta_failed}.
- `GET /projects/{p}/releases/{r}/health` — 카나리 판정(8.4) 입력: 포맷 가드 거부율·미해결율·델타 실패율.

## 데이터 이식성 · 재해 복구 (9.2 / 9.4, M3)

- `GET /projects/{p}/export` / `POST /projects/import` — 전체 export/import(락인 없음).
- `POST /projects/{p}/translations/import` — 기존 프로젝트에 키·번역만 일괄 upsert. 전체 검증 후 단일 트랜잭션 적용.
- `POST /projects/{p}/rebuild` — DB(SoT)만으로 산출물 재생성(결정적). 스토리지 유실 복구.
- 운영 절차 전체는 [`../OPERATIONS.md`](../OPERATIONS.md).

## 검증 (DoD)

- `pipeline.test.ts` — publish → **M0 SDK 클라이언트가 백엔드 산출물 소비**(M2→M1 연결) → 편집·델타 →
  롤백 → 버전 격리(자동 상한 닫힘+superseded) → 409 충돌 → 보존 창 → **백엔드 base 해시 = 참조 빌더 일치**.
- `api.test.ts` — 실제 HTTP 서버 기동 후 401/403/422/409/404/202/207 + 전체 워크플로.
- `m3.test.ts` — 메트릭 노출 · 텔레메트리 집계/PII 거부 · **export→import→rebuild 바이트 동일**(이식성+결정성).
- `dashboard.test.ts` — 자산 서빙·허용 목록 밖 404 · `/me` · 스코프 필터 · **로케일 등록이 스냅샷 포함으로 이어짐**.
- `dashboard-ui.test.ts` — 최소 DOM 스텁으로 `src/ui/app.js` 동작 계약 검증(로그인 분기 · 그리드 반영 ·
  편집→PUT 매핑 · 422 롤백 · RBAC UI 미러 · 배포 플레인 링크 · 사용자 패널).
- `users.test.ts` — 사용자 관리 API + DB 토큰 인증(발급 토큰의 역할·스코프 적용 · 평문/해시 비노출 ·
  폐기/비활성/삭제 즉시 401 · 마지막 admin 409 · 부트스트랩 공존).

## 프로덕션 경로 (M3)

DB=Postgres, 스토리지=MinIO/S3, 배포=CDN, 빌더=별도 워커, OIDC 연동, 대시보드 UI, Helm/K8s.
플레인 분리·API 계약·결정적 빌더는 그대로 유지된다.
