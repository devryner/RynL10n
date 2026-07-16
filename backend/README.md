# RynL10n 관리 백엔드 (M2 β)

대시보드 편집·릴리스·백포트, 배포 파이프라인(7.4), publish/롤백(8.3)을 제공하는 관리 플레인.
**M0 참조 빌더(`../src/builder`)를 그대로 재사용** — 골든 벡터로 검증된 결정적 산출물 생성을 공유한다.

## 실행

```bash
npm run backend            # 관리 API :8787 + 배포 플레인 :8788 (node:sqlite 내장, 외부 의존성 0)
npm run test:backend       # node --test — 파이프라인 + API 통합 (13 tests)
npm run typecheck:backend  # tsc --noEmit
docker compose up          # 단일 노드 셀프호스트 (9.1)
```

- Node ≥ 23.6 (네이티브 TS 타입 스트리핑). DB=`node:sqlite`, 스토리지=로컬 FS(MinIO/S3 대체 가능).

## 플레인 분리 (4.1)

- **관리 플레인** (`:8787`, 쓰기, 인증) — REST API. DB(SoT) + 산출물 빌더.
- **배포 플레인** (`:8788`, 읽기, 정적) — 스냅샷·델타·manifest만 서빙. 애플리케이션 서버 없음.
- SDK 런타임은 배포 플레인만 읽고 관리 API는 절대 호출하지 않음 → 관리 서버가 죽어도 기존 배포는 계속 서빙.

## 데이터 모델 (5 / 7.4)

`node:sqlite` 정규화 관계형 SoT — `projects` / `locales` / `keys` / `translations` / `releases` /
`release_keys`(다대다, 백포트 대상) / `jobs` / `published_manifests`(롤백 보존 창) / `audit_log`.

## 관리 API (7.1 / 11.2)

| 메서드·경로 | 권한 | 성공 | 실패 |
| --- | --- | --- | --- |
| `POST /projects` | Admin | 201 | 403 |
| `PUT /projects/{p}/keys/{key}` | Translator+ | 200 | — |
| `PUT /projects/{p}/translations/{key}/{locale}` | Translator+ | 200 | **422** 서명 불일치 · 404 |
| `POST /projects/{p}/releases` | Maintainer+ | 201 | 400 |
| `POST /projects/{p}/releases/{r}/keys` | Maintainer+ | 200 | 404 |
| `POST /projects/{p}/releases/{r}/publish` | Maintainer+ | **202** {jobId} | **409** 범위 충돌 |
| `PATCH /projects/{p}/releases/{r}` | Maintainer+ | 200 | 404 |
| `POST /projects/{p}/releases/{r}/rollback` | Maintainer+ | 200 | 404 |
| `POST /projects/{p}/translations/{key}/backport` | Maintainer+ | 200 · **207** 부분 | 404 |
| `GET /projects/{p}/jobs/{jobId}` | Viewer+ | 200 | 404 |
| `GET /projects/{p}/releases` · `GET /projects/{p}/manifest` | Viewer+ | 200 | 404 |

인증 없음 → **401**. 권한 부족 → **403**.

## 인증 & RBAC (7.3)

머신(CI 플러그인)=스코프 제한 Bearer 토큰. 사람=OIDC는 통합 지점만(β는 토큰 경로).
역할 4종: **Admin**(전체) / **Maintainer**(릴리스·publish·롤백·백포트) / **Translator**(번역 편집) / **Viewer**(읽기).

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
- `POST /projects/{p}/rebuild` — DB(SoT)만으로 산출물 재생성(결정적). 스토리지 유실 복구.
- 운영 절차 전체는 [`../OPERATIONS.md`](../OPERATIONS.md).

## 검증 (DoD)

- `pipeline.test.ts` — publish → **M0 SDK 클라이언트가 백엔드 산출물 소비**(M2→M1 연결) → 편집·델타 →
  롤백 → 버전 격리(자동 상한 닫힘+superseded) → 409 충돌 → 보존 창 → **백엔드 base 해시 = 참조 빌더 일치**.
- `api.test.ts` — 실제 HTTP 서버 기동 후 401/403/422/409/404/202/207 + 전체 워크플로.
- `m3.test.ts` — 메트릭 노출 · 텔레메트리 집계/PII 거부 · **export→import→rebuild 바이트 동일**(이식성+결정성).

## 프로덕션 경로 (M3)

DB=Postgres, 스토리지=MinIO/S3, 배포=CDN, 빌더=별도 워커, OIDC 연동, 대시보드 UI, Helm/K8s.
플레인 분리·API 계약·결정적 빌더는 그대로 유지된다.
