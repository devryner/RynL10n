/**
 * MCP 전송 계층 — `POST /mcp` (JSON-RPC 2.0 / Streamable HTTP).
 *
 * 지키는 계약: ① 인증·RBAC가 관리 API와 **같은 축**이고 ② 권한 없는 도구는 목록에서 아예
 * 사라지며 ③ 도구 실행 실패는 프로토콜 에러가 아니라 `isError` 결과로 나가 대화가 안 끊긴다.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { openDatabase } from "../src/db/schema.ts";
import { Repo } from "../src/db/repo.ts";
import { MemoryArtifactStore } from "../src/storage/store.ts";
import { TokenRegistry } from "../src/auth/rbac.ts";
import { createManagementServer } from "../src/api/server.ts";
import { publishRelease } from "../src/pipeline/publish.ts";

let base = "";
let server: ReturnType<typeof createManagementServer>;
const TOK = { view: "t-view", other: "t-other" };

before(async () => {
  const repo = new Repo(openDatabase());
  const store = new MemoryArtifactStore();
  repo.createProject("shop", "Shop", "en", ["en", "ko"]);
  repo.createRelease("shop", "R42", "v3.2", { strategy: "semver-range", value: ">=3.2.0" }, "draft");
  const pay = repo.upsertKey("shop", "pay.button", "", false);
  const greet = repo.upsertKey("shop", "greet", "name:simple", false);
  repo.putTranslation("shop", pay, "en", "Pay", "reviewed");
  repo.putTranslation("shop", pay, "ko", "결제", "reviewed");
  repo.putTranslation("shop", greet, "en", "Hello {name}", "reviewed");
  repo.addReleaseKey("shop", "R42", pay);
  repo.addReleaseKey("shop", "R42", greet);
  publishRelease(repo, store, "shop", "R42", "pm");

  const tokens = new TokenRegistry();
  tokens.issue(TOK.view, { actor: "vw", role: "viewer", projects: new Set(["shop"]) });
  tokens.issue(TOK.other, { actor: "ot", role: "viewer", projects: new Set(["elsewhere"]) });
  server = createManagementServer({ repo, store, tokens });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

async function rpc(method: string, params?: unknown, opts: { token?: string; id?: unknown } = {}): Promise<{ status: number; body: any }> {
  const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params !== undefined) msg.params = params;
  if (opts.id !== null) msg.id = opts.id ?? 1;
  const res = await fetch(base + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: JSON.stringify(msg),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const call = (name: string, args: unknown, token = TOK.view) => rpc("tools/call", { name, arguments: args }, { token });

test("인증: 토큰 없으면 401 — 관리 API와 같은 축", async () => {
  const r = await rpc("initialize", { protocolVersion: "2025-06-18" });
  assert.equal(r.status, 401);
});

test("initialize: 아는 프로토콜이면 그대로 되돌려 준다", async () => {
  const r = await rpc("initialize", { protocolVersion: "2025-06-18" }, { token: TOK.view });
  assert.equal(r.status, 200);
  assert.equal(r.body.result.protocolVersion, "2025-06-18");
  assert.equal(r.body.result.serverInfo.name, "rynl10n");
  assert.ok(r.body.result.capabilities.tools);
});

test("알림(id 없음)은 본문 없는 202", async () => {
  const res = await fetch(base + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOK.view}` },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(res.status, 202);
  assert.equal(await res.text(), "");
});

test("tools/list: 두 도구가 스키마와 함께 나온다", async () => {
  const r = await rpc("tools/list", {}, { token: TOK.view });
  const names = r.body.result.tools.map((t: any) => t.name).sort();
  assert.deepEqual(names, ["resolve_preview", "validate_translation"]);
  const v = r.body.result.tools.find((t: any) => t.name === "validate_translation");
  assert.equal(v.inputSchema.type, "object");
  assert.deepEqual(v.inputSchema.required, ["project", "key", "entries"]);
});

test("validate_translation: 통과 — structuredContent로 온다", async () => {
  const r = await call("validate_translation", { project: "shop", key: "greet", entries: [{ locale: "ko", value: "안녕하세요 {name}님" }] });
  assert.equal(r.body.result.isError, false);
  assert.equal(r.body.result.structuredContent.ok, true);
  assert.equal(r.body.result.content[0].type, "text");
});

test("validate_translation: 서명 불일치는 오류가 아니라 결과다 — 빠진 인자까지", async () => {
  const r = await call("validate_translation", { project: "shop", key: "greet", entries: [{ locale: "ko", value: "안녕하세요" }] });
  assert.equal(r.body.result.isError, false); // 도구는 정상 실행됐다
  const out = r.body.result.structuredContent;
  assert.equal(out.ok, false);
  assert.deepEqual(out.problems[0].missingArgs, ["name"]);
});

test("resolve_preview: 값과 출처를 함께 돌려준다", async () => {
  const r = await call("resolve_preview", { project: "shop", key: "pay.button", locale: "ko", appVersion: "3.2.1" });
  const out = r.body.result.structuredContent;
  assert.equal(out.value, "결제");
  assert.equal(out.source, "bundle");
  assert.equal(out.release.id, "R42");
});

test("도구 실행 실패는 isError 결과 — 프로토콜 에러가 아니다(대화가 안 끊긴다)", async () => {
  const r = await call("resolve_preview", { project: "shop", key: "x", locale: "en" }); // 매칭 축 없음
  assert.equal(r.status, 200);
  assert.equal(r.body.error, undefined);
  assert.equal(r.body.result.isError, true);
  assert.equal(r.body.result.structuredContent.error.status, 400);
});

test("프로젝트 스코프 밖이면 403이 도구 결과로 온다", async () => {
  const r = await call("resolve_preview", { project: "shop", key: "pay.button", locale: "en", appVersion: "3.2.1" }, TOK.other);
  assert.equal(r.body.result.isError, true);
  assert.equal(r.body.result.structuredContent.error.status, 403);
});

test("알 수 없는 메서드는 -32601", async () => {
  const r = await rpc("resources/list", {}, { token: TOK.view });
  assert.equal(r.body.error.code, -32601);
});

/**
 * 대시보드는 `POST /mcp`를 부를 수 없다 — 브라우저 요청에는 Origin이 붙고 가드의 기본값이
 * 전부 거부이기 때문이다. 그래서 도구 목록을 관리 API로도 낸다. **같은 `MCP_TOOLS`에서 나와야**
 * 화면이 서버와 어긋나지 않는다.
 */
test("GET /mcp/tools: 관리 API로도 같은 목록이 나온다(대시보드용)", async () => {
  const viaMcp = await rpc("tools/list", {}, { token: TOK.view });
  const viaRest = await fetch(base + "/mcp/tools", { headers: { authorization: `Bearer ${TOK.view}` } });
  const rest: any = await viaRest.json();
  assert.equal(viaRest.status, 200);
  assert.deepEqual(
    rest.tools.map((t: any) => t.name).sort(),
    viaMcp.body.result.tools.map((t: any) => t.name).sort(),
  );
  assert.equal(rest.tools[0].capability, "read"); // 필요 권한도 함께 — UI가 배지로 그린다
});

test("GET /me: MCP 표면의 존재와 Origin 정책을 알려준다", async () => {
  const res = await fetch(base + "/me", { headers: { authorization: `Bearer ${TOK.view}` } });
  const me: any = await res.json();
  assert.equal(me.mcp.enabled, true);
  assert.deepEqual(me.mcp.allowedOrigins, []); // 안전 기본값 — 화면이 이 사실을 설명한다
});

test("GET /mcp는 405 — 서버→클라이언트 스트림을 제공하지 않는다", async () => {
  const res = await fetch(base + "/mcp", { headers: { authorization: `Bearer ${TOK.view}` } });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
});
