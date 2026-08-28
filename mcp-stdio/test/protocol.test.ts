/**
 * stdio 전송의 JSON-RPC 프레이밍 + **관리 플레인 표면과의 대조**.
 *
 * 두 서버는 구현을 공유하지 않는다(한쪽은 DB·인증에 묶여 있고 여기는 둘 다 없다). 대신
 * **갈리면 안 되는 결정**을 여기서 함께 읽어 맞춘다 — 프로토콜 리비전 협상 · 알 수 없는 도구는
 * JSON-RPC 에러 · 도구 실행 실패는 `isError` 결과. 구현을 합치는 대신 계약을 고정하는 쪽이다.
 *
 * `initialize`·`ping`·`tools/call`(알 수 없는 이름)은 deps·principal을 건드리지 않으므로
 * 관리 플레인 디스패처를 그대로 호출해 비교할 수 있다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMessage, toolResult, SUPPORTED_PROTOCOLS } from "../src/protocol.ts";
import type { StdioTool } from "../src/protocol.ts";
import { handleMcpMessage } from "../../backend/src/mcp/server.ts";
import { TOOLS, SERVER_INFO } from "../src/tools.ts";

const NO_DEPS = null as any; // initialize/ping/알 수 없는 도구 경로는 deps를 읽지 않는다

const throwing: StdioTool = {
  name: "boom", title: "던지는 도구", description: "테스트용",
  inputSchema: { type: "object" },
  run: () => { throw new Error("터졌다"); },
};

function call(msg: unknown, tools: readonly StdioTool[] = TOOLS) {
  return handleMessage(tools, SERVER_INFO, msg);
}

test("initialize: 아는 리비전을 물으면 그대로, 모르는 것을 물으면 최신으로", () => {
  const known = call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  assert.equal((known?.result as any).protocolVersion, "2025-03-26");
  const unknown = call({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal((unknown?.result as any).protocolVersion, SUPPORTED_PROTOCOLS[0]);
  assert.deepEqual((known?.result as any).serverInfo, SERVER_INFO);
});

test("관리 플레인과 프로토콜 협상이 같다 — 리비전 목록이 갈리면 여기서 걸린다", () => {
  for (const asked of [...SUPPORTED_PROTOCOLS, "1999-01-01", undefined]) {
    const msg = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: asked } };
    const mine = (call(msg)?.result as any).protocolVersion;
    const theirs = (handleMcpMessage(NO_DEPS, NO_DEPS, msg)?.result as any).protocolVersion;
    assert.equal(mine, theirs, `리비전 협상 불일치: asked=${String(asked)}`);
  }
});

test("알림(id 없음)에는 응답하지 않는다", () => {
  assert.equal(call({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

test("ping은 빈 결과", () => {
  assert.deepEqual(call({ jsonrpc: "2.0", id: 3, method: "ping" })?.result, {});
});

test("tools/list: 이름·설명·입력 스키마를 낸다(인증이 없으므로 필터도 없다)", () => {
  const tools = (call({ jsonrpc: "2.0", id: 4, method: "tools/list" })?.result as any).tools;
  assert.deepEqual(tools.map((t: any) => t.name), ["bake_preview"]);
  assert.equal(typeof tools[0].inputSchema, "object");
  assert.deepEqual(tools[0].inputSchema.required, ["snapshot", "outDir"]);
});

test("알 수 없는 도구·메서드는 JSON-RPC 에러 — 관리 플레인과 같은 코드", () => {
  const bad = { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "없는도구" } };
  assert.equal(call(bad)?.error?.code, -32602);
  assert.equal(handleMcpMessage(NO_DEPS, NO_DEPS, bad)?.error?.code, -32602);

  const nope = { jsonrpc: "2.0", id: 6, method: "없는메서드" };
  assert.equal(call(nope)?.error?.code, -32601);
  assert.equal(handleMcpMessage(NO_DEPS, NO_DEPS, nope)?.error?.code, -32601);
});

/**
 * **도구 실행 실패는 프로토콜 에러가 아니다.** 모델이 반응해야 하는 정보지 호출 자체의 실패가
 * 아니고, JSON-RPC 에러로 올리면 대화가 끊긴다. 관리 플레인도 같은 규칙이고 그쪽은
 * `backend/test/mcp-server.test.ts`가 고정한다.
 */
test("도구가 던지면 isError 결과로 나간다 — 대화가 끊기지 않는다", () => {
  const res = call({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "boom" } }, [throwing]);
  assert.equal(res?.error, undefined);
  const result = res?.result as any;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /터졌다/);
  assert.equal(result.structuredContent.error.message, "터졌다");
});

test("결과 봉투: 사람이 읽는 content + 기계가 읽는 structuredContent", () => {
  assert.deepEqual(toolResult("요약", { a: 1 }), {
    content: [{ type: "text", text: "요약" }], structuredContent: { a: 1 }, isError: false,
  });
});

test("필수 인자가 빠지면 무엇이 필요한지 말한다(isError 결과로)", () => {
  const res = call({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "bake_preview", arguments: {} } });
  const result = res?.result as any;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /snapshot이\(가\) 필요하다/);
});

test("method가 없으면 -32600", () => {
  assert.equal(call({ jsonrpc: "2.0", id: 9 })?.error?.code, -32600);
});
