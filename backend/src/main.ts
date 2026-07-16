/**
 * 단일 노드 엔트리포인트 (9.1) — `docker compose up` / `node backend/src/main.ts`.
 * 관리 플레인(쓰기 API)과 배포 플레인(정적 산출물 서빙)을 한 프로세스로 기동.
 * 프로덕션은 DB=Postgres, 스토리지=MinIO/S3, 배포=CDN으로 대체(플레인 분리는 동일).
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { openDatabase } from "./db/schema.ts";
import { Repo } from "./db/repo.ts";
import { FsArtifactStore } from "./storage/store.ts";
import { TokenRegistry } from "./auth/rbac.ts";
import { createManagementServer } from "./api/server.ts";

const MGMT_PORT = Number(process.env.RYNL10N_PORT ?? 8787);
const DELIVERY_PORT = Number(process.env.RYNL10N_DELIVERY_PORT ?? 8788);
const DB_PATH = process.env.RYNL10N_DB ?? ":memory:";
const STORAGE_ROOT = process.env.RYNL10N_STORAGE ?? "./.rynl10n-storage";
const ADMIN_TOKEN = process.env.RYNL10N_ADMIN_TOKEN ?? "dev-admin-token";

const repo = new Repo(openDatabase(DB_PATH));
const store = new FsArtifactStore(STORAGE_ROOT);
const tokens = new TokenRegistry();
tokens.issue(ADMIN_TOKEN, { actor: "bootstrap-admin", role: "admin", projects: "*" });

// 관리 플레인 (쓰기, 인증 필요).
createManagementServer({ repo, store, tokens }).listen(MGMT_PORT, () => {
  console.log(`[rynl10n] 관리 API   → http://localhost:${MGMT_PORT}  (Bearer ${ADMIN_TOKEN})`);
});

// 배포 플레인 (읽기 전용 정적 파일 — CDN/오브젝트 스토리지 stand-in).
createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  try {
    const data = await readFile(join(STORAGE_ROOT, rel));
    const isManifest = rel.endsWith("manifest.json");
    res.writeHead(200, {
      "content-type": "application/json",
      // manifest는 짧은 TTL, 산출물은 내용해시라 영구 캐싱(4.4/7.2).
      "cache-control": isManifest ? "max-age=30, must-revalidate" : "public, max-age=31536000, immutable",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "not_found", message: rel } }));
  }
}).listen(DELIVERY_PORT, () => {
  console.log(`[rynl10n] 배포 플레인 → http://localhost:${DELIVERY_PORT}/{project}/manifest.json  (정적, 읽기 전용)`);
});
