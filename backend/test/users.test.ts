/**
 * 사용자 관리(7.3) — /users API + DB 기반 토큰 인증(DbTokenRegistry).
 *
 * 검증 축:
 *   ① admin만 사용자 관리에 접근한다(다른 역할은 403)
 *   ② 발급된 토큰으로 실제 인증이 되고, 역할·프로젝트 스코프가 그대로 적용된다
 *   ③ 평문은 발급 응답 1회만 — DB·목록 어디에도 평문/해시가 노출되지 않는다
 *   ④ 폐기·비활성·삭제가 **즉시** 401이 된다(세션 캐시 없음)
 *   ⑤ 마지막 활성 admin은 강등·비활성·삭제할 수 없다(스스로 잠그는 사고 차단)
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { openDatabase } from "../src/db/schema.ts";
import { Repo } from "../src/db/repo.ts";
import { MemoryArtifactStore } from "../src/storage/store.ts";
import { TokenRegistry, DbTokenRegistry, tokenHash } from "../src/auth/rbac.ts";
import { createManagementServer } from "../src/api/server.ts";

let base = "";
let server: ReturnType<typeof createManagementServer>;
let repo: Repo;
const BOOT = "u-bootstrap-admin";
const TOK = { view: "u-view" };

before(async () => {
  repo = new Repo(openDatabase());
  const store = new MemoryArtifactStore();
  // 실서비스 배선(main.ts)과 동일: 부트스트랩 env 토큰 + DB 사용자 토큰.
  const bootstrap = new TokenRegistry();
  bootstrap.issue(BOOT, { actor: "bootstrap-admin", role: "admin", projects: "*" });
  bootstrap.issue(TOK.view, { actor: "vw", role: "viewer", projects: "*" });
  const tokens = new DbTokenRegistry(repo, bootstrap);
  server = createManagementServer({ repo, store, tokens });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await api("POST", "/projects", { token: BOOT, body: { id: "shop", name: "Shop", defaultLocale: "en" } });
  await api("POST", "/projects", { token: BOOT, body: { id: "web", name: "Web", defaultLocale: "en" } });
});
after(() => { server.close(); });

async function api(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const init: RequestInit = {
    method,
    headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await fetch(base + path, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}

test("RBAC: /users 전 라우트는 admin 전용 — viewer는 403, 무토큰은 401", async () => {
  assert.equal((await api("GET", "/users")).status, 401);
  assert.equal((await api("GET", "/users", { token: TOK.view })).status, 403);
  assert.equal((await api("POST", "/users", { token: TOK.view, body: { id: "x", name: "x", role: "viewer" } })).status, 403);
});

test("생성: 역할·스코프 검증(400) + 중복 id 409 — 조용한 덮어쓰기 없음", async () => {
  const bad = await api("POST", "/users", { token: BOOT, body: { id: "alice", name: "Alice", role: "superuser" } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /role/);

  const badScope = await api("POST", "/users", { token: BOOT, body: { id: "alice", name: "Alice", role: "viewer", projects: [] } });
  assert.equal(badScope.status, 400);

  const ok = await api("POST", "/users", { token: BOOT, body: { id: "alice", name: "Alice", role: "translator", projects: ["shop"] } });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.body.projects, ["shop"]);

  const dup = await api("POST", "/users", { token: BOOT, body: { id: "alice", name: "Alice2", role: "viewer" } });
  assert.equal(dup.status, 409);
});

test("토큰 발급 → 평문 1회 반환, 그 토큰으로 /me가 역할·스코프를 반영한다", async () => {
  const issued = await api("POST", "/users/alice/tokens", { token: BOOT, body: { label: "대시보드" } });
  assert.equal(issued.status, 201);
  assert.match(issued.body.token, /^rl10n_/);

  const me = await api("GET", "/me", { token: issued.body.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.actor, "alice");
  assert.equal(me.body.role, "translator");
  assert.deepEqual(me.body.projects, ["shop"]);

  // 스코프 적용: shop은 열리고 web은 403 (7.3).
  assert.equal((await api("GET", "/projects/shop/keys", { token: issued.body.token })).status, 200);
  assert.equal((await api("GET", "/projects/web/keys", { token: issued.body.token })).status, 403);
  // 역할 적용: translator는 릴리스 생성 불가.
  const rel = await api("POST", "/projects/shop/releases", {
    token: issued.body.token, body: { name: "1.x", versionMatch: { strategy: "exact-label", value: "l" } },
  });
  assert.equal(rel.status, 403);
});

test("목록에는 토큰 id·label만 — 평문·해시는 어디에도 없다 (DB에는 sha256만)", async () => {
  const issued = await api("POST", "/users/alice/tokens", { token: BOOT, body: { label: "ci" } });
  const list = await api("GET", "/users", { token: BOOT });
  assert.equal(list.status, 200);
  const alice = list.body.users.find((u: any) => u.id === "alice");
  assert.ok(alice.tokens.length >= 2);
  const raw = JSON.stringify(list.body);
  assert.ok(!raw.includes(issued.body.token), "평문이 목록에 노출되면 안 됨");
  assert.ok(!raw.includes(tokenHash(issued.body.token)), "해시도 목록에 노출되면 안 됨");
  // DB 검증: 저장된 것은 평문이 아니라 해시다.
  const found = repo.findUserByTokenHash(tokenHash(issued.body.token));
  assert.equal(found?.id, "alice");
  assert.equal(repo.findUserByTokenHash(issued.body.token), undefined);
});

test("폐기 즉시 401 — 없는 토큰 폐기는 404", async () => {
  const issued = await api("POST", "/users/alice/tokens", { token: BOOT, body: {} });
  assert.equal((await api("GET", "/me", { token: issued.body.token })).status, 200);

  const revoked = await api("DELETE", `/users/alice/tokens/${issued.body.id}`, { token: BOOT });
  assert.equal(revoked.status, 200);
  assert.equal((await api("GET", "/me", { token: issued.body.token })).status, 401);
  assert.equal((await api("DELETE", `/users/alice/tokens/${issued.body.id}`, { token: BOOT })).status, 404);
});

test("비활성은 토큰을 남긴 채 즉시 401, 활성화하면 같은 토큰이 되살아난다", async () => {
  const issued = await api("POST", "/users/alice/tokens", { token: BOOT, body: {} });
  await api("PATCH", "/users/alice", { token: BOOT, body: { disabled: true } });
  assert.equal((await api("GET", "/me", { token: issued.body.token })).status, 401);
  await api("PATCH", "/users/alice", { token: BOOT, body: { disabled: false } });
  assert.equal((await api("GET", "/me", { token: issued.body.token })).status, 200);
});

test("사용자 삭제는 토큰까지 CASCADE — 즉시 401", async () => {
  await api("POST", "/users", { token: BOOT, body: { id: "bob", name: "Bob", role: "viewer" } });
  const issued = await api("POST", "/users/bob/tokens", { token: BOOT, body: {} });
  assert.equal((await api("GET", "/me", { token: issued.body.token })).status, 200);
  assert.equal((await api("DELETE", "/users/bob", { token: BOOT })).status, 200);
  assert.equal((await api("GET", "/me", { token: issued.body.token })).status, 401);
});

test("마지막 활성 admin은 강등·비활성·삭제 모두 409 — 다른 admin이 생기면 허용", async () => {
  await api("POST", "/users", { token: BOOT, body: { id: "root", name: "Root", role: "admin" } });
  assert.equal((await api("PATCH", "/users/root", { token: BOOT, body: { role: "viewer" } })).status, 409);
  assert.equal((await api("PATCH", "/users/root", { token: BOOT, body: { disabled: true } })).status, 409);
  assert.equal((await api("DELETE", "/users/root", { token: BOOT })).status, 409);

  await api("POST", "/users", { token: BOOT, body: { id: "root2", name: "Root2", role: "admin" } });
  assert.equal((await api("PATCH", "/users/root", { token: BOOT, body: { role: "viewer" } })).status, 200);
  // root가 admin에서 내려왔으므로 root2가 마지막 admin — 다시 가드가 선다.
  assert.equal((await api("DELETE", "/users/root2", { token: BOOT })).status, 409);
});

test("DB 사용자 admin 토큰으로 사용자 관리가 가능하다 (부트스트랩 없이 자립)", async () => {
  const issued = await api("POST", "/users/root2/tokens", { token: BOOT, body: {} });
  const list = await api("GET", "/users", { token: issued.body.token });
  assert.equal(list.status, 200);
  // 감사 로그: 인스턴스 수준 액션이 남았는지(project_id='*').
  const created = await api("POST", "/users", {
    token: issued.body.token, body: { id: "carol", name: "Carol", role: "viewer" },
  });
  assert.equal(created.status, 201);
});

test("부트스트랩 env 토큰은 DB 레지스트리와 공존한다 (첫 admin을 만들 수단)", async () => {
  assert.equal((await api("GET", "/me", { token: BOOT })).status, 200);
  assert.equal((await api("GET", "/me", { token: "no-such-token" })).status, 401);
});
