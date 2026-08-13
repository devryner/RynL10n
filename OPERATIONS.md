# 운영 가이드 (셀프호스트)

RynL10n 셀프호스트 운영: 설치·업그레이드·백업/복구·재해 복구·에어갭·관측성.
라이선스: **Apache-2.0** (SDK·서버·어드민 전체 단일, 기능 게이팅 없음).

> 본문의 `(9.4)` 같은 괄호 번호는 내부 설계 기획서의 절 번호입니다. 추적용 표기이니
> 운영 절차를 따라가는 데는 필요하지 않습니다.

## 설치 (9.1)

```bash
docker compose up          # 단일 노드: 관리 API :8787 + 배포 플레인 :8788
# 또는
npm run backend            # 로컬 실행 (Node >= 23.6)
```

- 최소 사양(평가·소규모): 2 vCPU / 4GB / 20GB. 중규모: 4 vCPU / 8GB / 50GB.
- **읽기 트래픽은 CDN/배포 플레인이 흡수** → 앱 수·조회량 급증에도 관리 서버 증설 불필요.
- 환경 변수: `RYNL10N_PORT` · `RYNL10N_DELIVERY_PORT` · `RYNL10N_DB` · `RYNL10N_STORAGE` ·
  `RYNL10N_ADMIN_TOKEN` · `RYNL10N_DELIVERY_ALLOW_ORIGIN`.
- **부트스트랩 admin 토큰은 반드시 교체**하고 시크릿으로 주입.

### 배포 플레인 앞에 CDN을 둘 때 (브라우저 SDK 필수 조건)

배포 플레인은 공개 읽기 전용 정적 파일이라 참조 서버가 기본으로 `Access-Control-Allow-Origin: *`를
보낸다(`RYNL10N_DELIVERY_ALLOW_ORIGIN`으로 좁힐 수 있다). **CDN·S3로 갈아탈 때 다음 세 헤더를 그대로
넘겨야** Web·Flutter Web SDK의 갱신 경로가 온전히 동작한다:

| 헤더 | 없으면 |
| --- | --- |
| `Access-Control-Allow-Origin` | 브라우저가 응답 자체를 차단 → 원격 갱신 불가(번들 fallback만) |
| `Access-Control-Expose-Headers: ETag` | JS가 ETag를 못 읽어 **조건부 요청이 영영 성립하지 않음** → 폴링마다 manifest 전량 재다운로드 |
| `Access-Control-Allow-Headers: If-None-Match` | preflight 실패 → 조건부 요청 실패 |

`ETag`는 CORS 안전목록 응답 헤더가 **아니다** — 명시 노출이 필요하다. 셋 다 없어도 앱은 죽지 않고
성능만 나빠진다(가장 눈에 안 띄는 실패 모드라 배포 후 한 번은 실제로 확인할 것).

## 업그레이드 (9.4)

- **관리 서버 무중단 롤링**: 배포 플레인은 정적 파일이라 관리 서버 재시작 중에도 앱은 영향 없음(플레인 분리).
- **산출물 하위호환**: 모든 산출물에 `schemaVersion` 태그. SDK는 미지의 필드를 무시(전방 호환) — 구 SDK가 신 산출물을 계속 읽는다. `schemaVersion` 증가 시 마이그레이션 규칙은 릴리스 노트에 명시.
- 순서: 새 이미지 배포 → 관리 서버 롤링 재시작 → (필요 시) `POST /projects/{p}/rebuild`로 산출물 재생성.

## 백업 / 복구 (9.4)

**SoT는 관리 DB뿐** — DB만 백업하면 충분하다(산출물은 DB에서 재생성 가능, 결정적 빌드).

- **파일 백업**: `RYNL10N_DB` 파일(또는 프로덕션 Postgres) 정기 백업.
- **논리 백업 / 이관(데이터 이식성 9.2)**:
  ```bash
  curl -H "authorization: Bearer $ADMIN" $API/projects/{p}/export > backup.json     # 전체 export(락인 없음)
  curl -X POST -H "authorization: Bearer $ADMIN" $API/projects/import -d @backup.json # 복원
  ```
- **재해 복구(스토리지 유실)**: DB만 있으면
  ```bash
  curl -X POST -H "authorization: Bearer $ADMIN" $API/projects/{p}/rebuild
  ```
  → 모든 스냅샷·델타·manifest를 DB로부터 재생성. 결정적이라 같은 DB → 같은 산출물.
  (base는 현재 상태로 재베이스라인 — 2계층 구조 덕분에 구버전 앱은 풀 스냅샷을 받아 번역 공백 0.)

## 롤백 (8.3)

```bash
curl -X POST -H "authorization: Bearer $ADMIN" $API/projects/{p}/releases/{r}/rollback -d '{"to":"<이전 overlay 해시>"}'
```
manifest overlay 포인터를 이전 target으로 되돌리고 재게시. 산출물 불변이라 즉시·무손실. 보존 창 = 최근 20개.

## 장애 격리 (9.4)

관리 서버 다운 → **편집·publish만 중단**, 기존 배포는 CDN/배포 플레인에서 계속 서빙. 앱은 영향 없음.

## 에어갭 운영 (9.4)

완전 폐쇄망: 빌드 플러그인 vendored 모드(커밋된 스냅샷으로 bake, 6.3) + 사내 스토리지/CDN.
```bash
swift run rynl10n-bake vendored-snapshot.json ./out     # 외부 접근 없이 bake
gradle rynl10nBake -Psource=vendored-snapshot.json -Pout=./out
```

## 관측성 (9.3)

- **Prometheus**: `GET /metrics` — publish 성공/충돌/실패 카운트·소요시간, API 요청·지연, 텔레메트리 이벤트.
- **구조화 로그**: stdout JSON 라인(5xx 등). 기존 로그 파이프라인에 그대로 물림.
- **텔레메트리(옵트인·익명·집계)**: SDK `telemetry: 'aggregate'` → 4개 이벤트(overlay_applied /
  format_guard_rejected / key_unresolved / delta_failed) 카운트만 리포트. 값·키명·기기 식별자 없음.
  ```bash
  POST /projects/{p}/telemetry   # 정의된 5개 필드 외 유입은 거부(프라이버시 가드)
  GET  /projects/{p}/releases/{r}/health   # 카나리 판정(8.4) 입력: 포맷 가드 거부율 등
  ```
- 셀프호스트는 텔레메트리를 **자기 인프라에만** 저장 → 규제 요건 부합.

## 프로덕션 토폴로지 (대규모)

DB=Postgres, 스토리지=MinIO/S3, 배포=CDN, 빌더=별도 워커, 인증=OIDC, Helm/K8s 수평 확장.
플레인 분리·API 계약·결정적 빌더·관측성 계약은 그대로 유지된다.
