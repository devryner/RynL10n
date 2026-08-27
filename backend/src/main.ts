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
import { loadConfig } from "./config.ts";

// 환경 판정은 전부 config.ts에 있다 — 빈 문자열을 "설정 없음"으로 접는 자리가 한 곳이어야 한다.
const {
  managementPort: MGMT_PORT,
  deliveryPort: DELIVERY_PORT,
  dbPath: DB_PATH,
  storageRoot: STORAGE_ROOT,
  adminToken: ADMIN_TOKEN,
  deliveryAllowOrigin: DELIVERY_ALLOW_ORIGIN,
  deliveryBaseUrl: DELIVERY_BASE_URL,
  mcpAllowedOrigins: MCP_ALLOWED_ORIGINS,
} = loadConfig();

const repo = new Repo(openDatabase(DB_PATH));
const store = new FsArtifactStore(STORAGE_ROOT);
// 부트스트랩 env 토큰(첫 admin을 만들 수단) + DB 사용자 토큰(대시보드 '사용자' 패널에서 발급 —
// DB에 영속되므로 재시작해도 살아남는다). 프로덕션은 사용자 생성 후 env 토큰을 회전할 것.
const bootstrap = new TokenRegistry();
bootstrap.issue(ADMIN_TOKEN, { actor: "bootstrap-admin", role: "admin", projects: "*" });
const tokens = new DbTokenRegistry(repo, bootstrap);

// 관리 플레인 (쓰기, 인증 필요) + 대시보드(어드민 앱, 9.2 코어 ③).
createManagementServer({ repo, store, tokens, deliveryBaseUrl: DELIVERY_BASE_URL, mcpAllowedOrigins: MCP_ALLOWED_ORIGINS })
  .listen(MGMT_PORT, () => {
    console.log(`[rynl10n] 대시보드   → http://localhost:${MGMT_PORT}/          (토큰: ${ADMIN_TOKEN})`);
    console.log(`[rynl10n] 관리 API   → http://localhost:${MGMT_PORT}  (Bearer ${ADMIN_TOKEN})`);
    console.log(`[rynl10n] MCP        → http://localhost:${MGMT_PORT}/mcp  (JSON-RPC, Bearer)`);
  });

// 배포 플레인 (읽기 전용 정적 파일 — CDN/오브젝트 스토리지 stand-in).
// ETag·CORS를 포함해 실제 CDN이 주는 동작을 그대로 준다(delivery-server.ts 참조).
createDeliveryServer({ root: STORAGE_ROOT, allowOrigin: DELIVERY_ALLOW_ORIGIN }).listen(DELIVERY_PORT, () => {
  console.log(`[rynl10n] 배포 플레인 → http://localhost:${DELIVERY_PORT}/{project}/manifest.json  (정적, 읽기 전용)`);
});
