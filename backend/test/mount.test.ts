/**
 * createManagementHandler — 관리 플레인을 소비자 소유의 node:http 서버에 얹는 표면(7.1).
 *
 * 지키려는 계약 셋:
 *   ① 소비자 서버 안에서 코어 라우팅·인증이 그대로 동작한다
 *   ② 소비자가 핸들러보다 **먼저** 경로를 가로챌 수 있다(자체 UI·확장 API를 앞단에 두는 용도)
 *   ③ createManagementServer와 동작이 갈리지 않는다 — 후자는 전자를 감싼 것뿐이다
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openDatabase } from "../src/db/schema.ts";
import { Repo } from "../src/db/repo.ts";
import { MemoryArtifactStore } from "../src/storage/store.ts";
import { TokenRegistry } from "../src/auth/rbac.ts";
import { createManagementHandler, createManagementServer, type ServerDeps } from "../src/api/server.ts";

const TOKEN = "t-admin";

function deps(): ServerDeps {
  const repo = new Repo(openDatabase());
  const tokens = new TokenRegistry();
  tokens.issue(TOKEN, { actor: "admin", role: "admin", projects: "*" });
  return { repo, store: new MemoryArtifactStore(), tokens };
}

async function listen(server: Server): Promise<{ base: string; close: () => Promise<void> }> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const auth = { authorization: `Bearer ${TOKEN}` };

test("소비자 서버에 마운트해도 라우팅과 인증이 그대로 동작한다", async () => {
  const handler = createManagementHandler(deps());
  const { base, close } = await listen(createServer(handler));
  try {
    assert.equal((await fetch(`${base}/projects`)).status, 401);

    const me = await fetch(`${base}/me`, { headers: auth });
    assert.equal(me.status, 200);
    assert.equal(((await me.json()) as { role: string }).role, "admin");

    const created = await fetch(`${base}/projects`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ id: "shop", name: "Shop", defaultLocale: "en" }),
    });
    assert.equal(created.status, 201);
  } finally { await close(); }
});

test("소비자가 핸들러보다 먼저 경로를 가로챌 수 있다", async () => {
  const handler = createManagementHandler(deps());
  // 앞단에서 자체 UI를 서빙하고 나머지를 관리 API로 넘기는 전형적인 구성.
  const server = createServer((req, res) => {
    if (req.url === "/app") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html>consumer");
      return;
    }
    handler(req, res);
  });
  const { base, close } = await listen(server);
  try {
    assert.equal(await (await fetch(`${base}/app`)).text(), "<!doctype html>consumer");
    // 가로채지 않은 경로는 관리 API가 그대로 처리한다.
    assert.equal((await fetch(`${base}/me`, { headers: auth })).status, 200);
  } finally { await close(); }
});

test("createManagementServer와 응답이 동일하다", async () => {
  const viaHandler = await listen(createServer(createManagementHandler(deps())));
  const viaServer = await listen(createManagementServer(deps()));
  try {
    for (const path of ["/me", "/projects", "/metrics", "/nope"]) {
      const a = await fetch(viaHandler.base + path, { headers: auth });
      const b = await fetch(viaServer.base + path, { headers: auth });
      assert.equal(a.status, b.status, `${path} 상태 불일치`);
      assert.equal(
        a.headers.get("content-type"),
        b.headers.get("content-type"),
        `${path} content-type 불일치`,
      );
    }
  } finally { await viaHandler.close(); await viaServer.close(); }
});

test("serveDashboard:false면 대시보드 자산을 내주지 않는다", async () => {
  const handler = createManagementHandler({ ...deps(), serveDashboard: false });
  const { base, close } = await listen(createServer(handler));
  try {
    assert.equal((await fetch(`${base}/ui/app.js`)).status, 404);
    assert.equal((await fetch(`${base}/`)).status, 404);
  } finally { await close(); }
});
