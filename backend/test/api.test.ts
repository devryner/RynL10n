import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { openDatabase } from "../src/db/schema.ts";
import { Repo } from "../src/db/repo.ts";
import { MemoryArtifactStore } from "../src/storage/store.ts";
import { TokenRegistry } from "../src/auth/rbac.ts";
import { createManagementServer } from "../src/api/server.ts";

let base = "";
let server: ReturnType<typeof createManagementServer>;
const TOK = { admin: "t-admin", maint: "t-maint", trans: "t-trans", view: "t-view" };

before(async () => {
  const repo = new Repo(openDatabase());
  const store = new MemoryArtifactStore();
  const tokens = new TokenRegistry();
  tokens.issue(TOK.admin, { actor: "admin", role: "admin", projects: "*" });
  tokens.issue(TOK.maint, { actor: "mnt", role: "maintainer", projects: new Set(["shop"]) });
  tokens.issue(TOK.trans, { actor: "tr", role: "translator", projects: new Set(["shop"]) });
  tokens.issue(TOK.view, { actor: "vw", role: "viewer", projects: new Set(["shop"]) });
  server = createManagementServer({ repo, store, tokens });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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

test("인증: 토큰 없으면 401", async () => {
  const r = await api("POST", "/projects", { body: { id: "x", name: "X", defaultLocale: "en" } });
  assert.equal(r.status, 401);
});

test("RBAC: translator는 프로젝트 생성 불가(403), admin은 가능(201)", async () => {
  const denied = await api("POST", "/projects", { token: TOK.trans, body: { id: "shop", name: "Shop", defaultLocale: "en" } });
  assert.equal(denied.status, 403);
  const ok = await api("POST", "/projects", { token: TOK.admin, body: { id: "shop", name: "Shop", defaultLocale: "en", locales: ["en", "ja", "ko"] } });
  assert.equal(ok.status, 201);
});

test("키·번역 편집(translator) + 422 서명 불일치", async () => {
  await api("PUT", "/projects/shop/keys/pay.button", { token: TOK.trans });
  await api("PUT", "/projects/shop/keys/greet", { token: TOK.trans });

  const pay = await api("PUT", "/projects/shop/translations/pay.button/ja", { token: TOK.trans, body: { value: "支払―", state: "reviewed" } });
  assert.equal(pay.status, 200);
  await api("PUT", "/projects/shop/translations/pay.button/en", { token: TOK.trans, body: { value: "Pay" } });

  // greet: 첫 값이 서명 확정(name:string)
  const g1 = await api("PUT", "/projects/shop/translations/greet/en", { token: TOK.trans, body: { value: "Hello {name}" } });
  assert.equal(g1.status, 200);
  // 플레이스홀더 없는 값 → 422
  const g2 = await api("PUT", "/projects/shop/translations/greet/ja", { token: TOK.trans, body: { value: "안녕" } });
  assert.equal(g2.status, 422);
  assert.equal(g2.body.error.code, "signature_mismatch");
});

test("viewer는 편집 불가(403)", async () => {
  const r = await api("PUT", "/projects/shop/translations/pay.button/ko", { token: TOK.view, body: { value: "결제" } });
  assert.equal(r.status, 403);
});

test("릴리스 생성·publish(202 잡) → 잡 조회 → manifest", async () => {
  const rel = await api("POST", "/projects/shop/releases", { token: TOK.maint, body: { id: "R42", name: "v3.2", versionMatch: { strategy: "semver-range", value: ">=3.2.0" }, keys: ["pay.button", "greet"] } });
  assert.equal(rel.status, 201);
  assert.equal(rel.body.state, "draft");

  const pub = await api("POST", "/projects/shop/releases/R42/publish", { token: TOK.maint });
  assert.equal(pub.status, 202);
  assert.ok(pub.body.jobId);

  const job = await api("GET", `/projects/shop/jobs/${pub.body.jobId}`, { token: TOK.view });
  assert.equal(job.status, 200);
  assert.equal(job.body.state, "done");

  const man = await api("GET", "/projects/shop/manifest", { token: TOK.view });
  assert.equal(man.status, 200);
  assert.equal(man.body.releases[0].id, "R42");
});

test("백포트: 존재하는 릴리스만 적용(207 부분성공)", async () => {
  const r = await api("POST", "/projects/shop/translations/pay.button/backport", { token: TOK.maint, body: { releaseIds: ["R42", "R999"] } });
  assert.equal(r.status, 207);
  assert.deepEqual(r.body.applied, ["R42"]);
  assert.deepEqual(r.body.failed, ["R999"]);
});

test("겹치는 범위 publish는 409", async () => {
  await api("POST", "/projects/shop/releases", { token: TOK.maint, body: { id: "R70", name: "wide", versionMatch: { strategy: "semver-range", value: ">=3.1.0 <3.5.0" }, keys: ["pay.button"] } });
  const pub = await api("POST", "/projects/shop/releases/R70/publish", { token: TOK.maint });
  assert.equal(pub.status, 409);
  assert.equal(pub.body.error.code, "range_conflict");
});

test("없는 릴리스 PATCH는 404", async () => {
  const r = await api("PATCH", "/projects/shop/releases/NOPE", { token: TOK.maint, body: { state: "archived" } });
  assert.equal(r.status, 404);
});
