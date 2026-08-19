/**
 * 단일 노드 엔트리포인트 (9.1) — `docker compose up` / `node backend/src/main.ts`.
 * 관리 플레인(쓰기 API)과 배포 플레인(정적 산출물 서빙)을 한 프로세스로 기동.
 * 프로덕션은 DB=Postgres, 스토리지=MinIO/S3, 배포=CDN으로 대체(플레인 분리는 동일).
 */
import { openDatabase } from "./db/schema.ts";
import { Repo } from "./db/repo.ts";
import { FsArtifactStore } from "./storage/store.ts";
import { createDeliveryServer } from "./storage/delivery-server.ts";
import { TokenRegistry, DbTokenRegistry } from "./auth/rbac.ts";
import { createManagementServer } from "./api/server.ts";

const MGMT_PORT = Number(process.env.RYNL10N_PORT ?? 8787);
const DELIVERY_PORT = Number(process.env.RYNL10N_DELIVERY_PORT ?? 8788);
const DB_PATH = process.env.RYNL10N_DB ?? ":memory:";
const STORAGE_ROOT = process.env.RYNL10N_STORAGE ?? "./.rynl10n-storage";
const ADMIN_TOKEN = process.env.RYNL10N_ADMIN_TOKEN ?? "dev-admin-token";
// 브라우저 SDK(Web·Flutter Web)가 교차 오리진으로 읽는다. 공개 읽기 전용 정적 파일이라 기본은 `*`.
const DELIVERY_ALLOW_ORIGIN = process.env.RYNL10N_DELIVERY_ALLOW_ORIGIN ?? "*";

const repo = new Repo(openDatabase(DB_PATH));
const store = new FsArtifactStore(STORAGE_ROOT);
// 부트스트랩 env 토큰(첫 admin을 만들 수단) + DB 사용자 토큰(대시보드 '사용자' 패널에서 발급 —
// DB에 영속되므로 재시작해도 살아남는다). 프로덕션은 사용자 생성 후 env 토큰을 회전할 것.
const bootstrap = new TokenRegistry();
bootstrap.issue(ADMIN_TOKEN, { actor: "bootstrap-admin", role: "admin", projects: "*" });
const tokens = new DbTokenRegistry(repo, bootstrap);

// 배포 플레인 base URL — 대시보드가 산출물 링크를 만들 때 쓴다(프로덕션은 CDN 도메인).
const DELIVERY_BASE_URL = process.env.RYNL10N_DELIVERY_URL ?? `http://localhost:${DELIVERY_PORT}`;

// 관리 플레인 (쓰기, 인증 필요) + 대시보드(어드민 앱, 9.2 코어 ③).
createManagementServer({ repo, store, tokens, deliveryBaseUrl: DELIVERY_BASE_URL }).listen(MGMT_PORT, () => {
  console.log(`[rynl10n] 대시보드   → http://localhost:${MGMT_PORT}/          (토큰: ${ADMIN_TOKEN})`);
  console.log(`[rynl10n] 관리 API   → http://localhost:${MGMT_PORT}  (Bearer ${ADMIN_TOKEN})`);
});

// 배포 플레인 (읽기 전용 정적 파일 — CDN/오브젝트 스토리지 stand-in).
// ETag·CORS를 포함해 실제 CDN이 주는 동작을 그대로 준다(delivery-server.ts 참조).
createDeliveryServer({ root: STORAGE_ROOT, allowOrigin: DELIVERY_ALLOW_ORIGIN }).listen(DELIVERY_PORT, () => {
  console.log(`[rynl10n] 배포 플레인 → http://localhost:${DELIVERY_PORT}/{project}/manifest.json  (정적, 읽기 전용)`);
});
