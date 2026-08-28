/**
 * JSON-RPC 2.0 / MCP 프레이밍 — stdio 전송용
 *
 * **왜 관리 플레인의 `backend/src/mcp/server.ts`를 재사용하지 않는가.** 그쪽 디스패처는
 * `McpDeps{repo, store}`·`Principal`·`authorize`에 묶여 있다. 이 서버는 **DB도 인증도 없다**
 * (그 사용자로 그 디렉토리에서 도는 서브프로세스다). 재사용하려면 그 셋을 전부 제네릭으로
 * 열어야 하는데, 얻는 것은 프레이밍 50줄이고 잃는 것은 방금 착지한 코드의 안정성이다.
 *
 * 대신 **갈리면 안 되는 결정들**을 `test/protocol.test.ts`가 두 서버에서 함께 읽어 대조한다:
 * 지원 프로토콜 리비전 · 결과 봉투(`content`+`structuredContent`) · **도구 실행 실패는
 * JSON-RPC 에러가 아니라 `isError` 결과로 나간다**(프로토콜 에러로 올리면 대화가 끊긴다).
 * 구현을 합치는 대신 계약을 고정하는 쪽 — 골든 벡터와 같은 원리다.
 *
 * 전송은 **개행 구분 JSON**이다(MCP stdio). 응답은 stdout, 로그는 stderr로만 나간다 —
 * stdout에 로그를 한 줄이라도 섞으면 클라이언트의 프레임 해석이 깨진다.
 */

/** 우리가 말할 줄 아는 프로토콜 리비전. 클라이언트가 아는 것을 물으면 그대로 되돌려 준다. */
export const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26"] as const;

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

/** 도구 하나. `run`이 던지면 호출부가 `isError` 결과로 감싼다. */
export interface StdioTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly run: (args: any) => { summary: string; data: unknown };
}

export interface ServerInfo {
  readonly name: string;
  readonly version: string;
}

const ok = (id: unknown, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
const fail = (id: unknown, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: "2.0", id, error: { code, message },
});

/** 도구 결과 봉투 — 사람이 읽는 요약 + 기계가 읽는 구조. HTTP 표면과 같은 모양이다. */
export function toolResult(summary: string, data: unknown, isError = false): unknown {
  return { content: [{ type: "text", text: summary }], structuredContent: data, isError };
}

/**
 * 메시지 하나를 처리한다. 알림(id 없음)은 null — stdio에서는 아무것도 쓰지 않는다.
 */
export function handleMessage(
  tools: readonly StdioTool[],
  serverInfo: ServerInfo,
  msg: any,
): JsonRpcResponse | null {
  const id = msg?.id;
  const method = msg?.method;
  if (typeof method !== "string") return fail(id ?? null, -32600, "method 필요");
  if (id === undefined) return null; // 알림 — 응답하지 않는다

  switch (method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      const protocolVersion = (SUPPORTED_PROTOCOLS as readonly string[]).includes(asked)
        ? asked
        : SUPPORTED_PROTOCOLS[0];
      return ok(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: tools.map((t) => ({
          name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
        })),
      });
    case "tools/call": {
      const name = msg.params?.name;
      const tool = tools.find((t) => t.name === name);
      if (!tool) return fail(id, -32602, `알 수 없는 도구: ${name}`);
      try {
        const { summary, data } = tool.run(msg.params?.arguments ?? {});
        return ok(id, toolResult(summary, data));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return ok(id, toolResult(`오류: ${message}`, { error: { message } }, true));
      }
    }
    default:
      return fail(id, -32601, `지원하지 않는 메서드: ${method}`);
  }
}
