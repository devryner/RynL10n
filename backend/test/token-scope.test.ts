/**
 * 토큰 최소 권한(7.3) + MCP Origin 가드.
 *
 * 토큰 평문은 에이전트 설정 파일 같은 곳에 그대로 놓인다 — 관리 API 전체 권한을 담은 값이
 * 거기 있으면 유출 한 번의 피해가 사용자 권한 전부다. 그래서 발급 시점에 **표면**(어디에 닿는가)과
 * **역할 상한**(무엇을 할 수 있는가)을 좁힐 수 있어야 하고, 좁힌 것이 실제로 막혀야 한다.
 *
 * Origin 가드는 다른 축이다: MCP 클라이언트는 브라우저가 아니라 Origin을 보내지 않으므로,
 * Origin이 붙어 있다는 것 자체가 브라우저에서 왔다는 신호다(DNS rebinding 경로).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { openDatabase, applySchema } from "../src/db/schema.ts";
import { Repo } from "../src/db/repo.ts";
import { MemoryArtifactStore } from "../src/storage/store.ts";
import { DatabaseSync } from "node:sqlite";
import { TokenRegistry, DbTokenRegistry, narrowRole, tokenHash } from "../src/auth/rbac.ts";
import { createManagementServer } from "../src/api/server.ts";

let base = "";
let server: ReturnType<typeof createManagementServer>;
let repo: Repo;
const BOOT = "boot-admin";

before(async () => {
  repo = new Repo(openDatabase());
  repo.createProject("shop", "Shop", "en", ["en", "ko"]);
  repo.createUser("agent", "Agent", "maintainer", ["shop"]);
  const bootstrap = new TokenRegistry();
  bootstrap.issue(BOOT, { actor: "boot", role: "admin", projects: "*" });
  server = createManagementServer({
    repo, store: new MemoryArtifactStore(), tokens: new DbTokenRegistry(repo, bootstrap),
    mcpAllowedOrigins: ["https://studio.example.com"],
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

async function req(
  method: string, path: string, opts: { token?: string; body?: unknown; origin?: string } = {},
): Promise<{ status: number; body: any }> {
  const init: RequestInit = {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.origin ? { origin: opts.origin } : {}),
    },
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await fetch(base + path, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}

const issueToken = async (body: unknown): Promise<any> =>
  (await req("POST", "/users/agent/tokens", { token: BOOT, body })).body;
const mcpCall = (token: string, origin?: string) =>
  req("POST", "/mcp", { token, ...(origin ? { origin } : {}), body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });

test("narrowRole은 늘 약한 쪽으로 접힌다 — 상한이 더 높아도 권한이 오르지 않는다", () => {
  assert.equal(narrowRole("maintainer", "viewer"), "viewer");
  assert.equal(narrowRole("viewer", "admin"), "viewer");   // 상한이 위여도 올라가지 않는다
  assert.equal(narrowRole("translator", null), "translator");
  assert.equal(narrowRole("admin", "translator"), "translator");
});

test("기본 발급은 지금까지와 같다 — surface=all · 상한 없음", async () => {
  const t = await issueToken({ label: "ci" });
  assert.equal(t.surface, "all");
  assert.equal(t.maxRole, null);
  assert.equal((await req("GET", "/projects/shop/keys", { token: t.token })).status, 200);
  assert.equal((await mcpCall(t.token)).status, 200); // 전체 토큰은 MCP도 쓸 수 있다
});

test("MCP 전용 토큰은 관리 API가 403 — MCP는 통과", async () => {
  const t = await issueToken({ label: "agent", surface: "mcp" });
  assert.equal(t.surface, "mcp");

  const rest = await req("GET", "/projects/shop/keys", { token: t.token });
  assert.equal(rest.status, 403);
  assert.equal(rest.body.error.code, "forbidden");

  const mcp = await mcpCall(t.token);
  assert.equal(mcp.status, 200);
  assert.equal(mcp.body.result.tools.length, 2);
});

test("MCP 전용 토큰은 대시보드 데이터에도 닿지 못한다(/me 포함)", async () => {
  const t = await issueToken({ surface: "mcp" });
  assert.equal((await req("GET", "/me", { token: t.token })).status, 403);
});

test("역할 상한: maintainer 사용자의 토큰을 viewer로 묶으면 쓰기가 막힌다", async () => {
  const t = await issueToken({ surface: "all", maxRole: "viewer" });
  assert.equal(t.maxRole, "viewer");
  assert.equal((await req("GET", "/projects/shop/keys", { token: t.token })).status, 200);
  const write = await req("PUT", "/projects/shop/keys/pay.button", { token: t.token, body: {} });
  assert.equal(write.status, 403);
});

test("잘못된 surface·role은 400 — 오타가 조용히 넓은 쪽으로 접히면 안 된다", async () => {
  assert.equal((await req("POST", "/users/agent/tokens", { token: BOOT, body: { surface: "ALL" } })).status, 400);
  assert.equal((await req("POST", "/users/agent/tokens", { token: BOOT, body: { maxRole: "superuser" } })).status, 400);
});

test("발급된 토큰의 제한이 사용자 목록에 보인다 — UI가 배지를 그릴 수 있어야 한다", async () => {
  const t = await issueToken({ label: "scoped", surface: "mcp", maxRole: "viewer" });
  const users = await req("GET", "/users", { token: BOOT });
  const row = users.body.users.find((u: any) => u.id === "agent");
  const token = row.tokens.find((x: any) => x.id === t.id);
  assert.equal(token.surface, "mcp");
  assert.equal(token.maxRole, "viewer");
  assert.equal(token.token, undefined); // 평문은 목록에 절대 없다
});

test("Origin 가드: 목록 밖 Origin은 403 — 토큰이 유효해도", async () => {
  const t = await issueToken({ surface: "mcp" });
  const bad = await mcpCall(t.token, "https://evil.example.com");
  assert.equal(bad.status, 403);
  assert.equal(bad.body.error.code, "forbidden");
});

test("Origin 가드: 허용 목록의 Origin과 Origin 없는 요청은 통과", async () => {
  const t = await issueToken({ surface: "mcp" });
  assert.equal((await mcpCall(t.token, "https://studio.example.com")).status, 200);
  assert.equal((await mcpCall(t.token)).status, 200); // MCP 클라이언트는 Origin을 보내지 않는다
});

/**
 * 기존 배포에는 `surface`·`max_role` 없는 `user_tokens`가 이미 있다. 마이그레이션이 그 위에
 * 걸렸을 때 **이미 발급된 토큰이 계속 살아 있어야** 한다 — 기본값이 곧 기존 동작이기 때문이다.
 * (여기서 죽으면 업그레이드하는 순간 모든 CI 토큰이 401이 된다.)
 */
test("마이그레이션: 구 스키마의 토큰은 surface=all·상한 없음으로 그대로 산다", () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
                        projects TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE user_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                              token_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    INSERT INTO users VALUES ('old','Old','maintainer','["shop"]',0,'T0');
    INSERT INTO user_tokens VALUES ('tk1','old','${tokenHash("legacy-token")}','ci','T0');
  `);
  // 같은 연결 위에 스키마+마이그레이션을 적용하는 것이 곧 업그레이드다.
  applySchema(raw);

  const cols = (raw.prepare("PRAGMA table_info(user_tokens)").all() as any[]).map((c) => c.name);
  assert.ok(cols.includes("surface") && cols.includes("max_role"));

  const upgraded = new Repo(raw);
  const found = upgraded.findUserByTokenHash(tokenHash("legacy-token"))!;
  assert.equal(found.id, "old");
  assert.equal(found.tokenSurface, "all");   // 기존 토큰은 좁혀지지 않는다
  assert.equal(found.tokenMaxRole, null);

  const principal = new DbTokenRegistry(upgraded).resolve("legacy-token")!;
  assert.equal(principal.role, "maintainer"); // 권한도 그대로
  assert.equal(principal.surface, "all");
});

test("Origin 가드는 인증보다 먼저다 — 토큰 없이도 Origin이 틀리면 403", async () => {
  const r = await req("POST", "/mcp", { origin: "https://evil.example.com", body: { jsonrpc: "2.0", id: 1, method: "ping" } });
  assert.equal(r.status, 403);
});
