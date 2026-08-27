/**
 * MCP 서버 (JSON-RPC 2.0 / Streamable HTTP) — 관리 플레인에 `/mcp`로 마운트된다.
 *
 * **전송 계층을 직접 구현한 이유**: 이 저장소는 참조 구현·백엔드 모두 외부 런타임 의존성 0이
 * 원칙이고(devDep은 typescript·@types/node뿐), 필요한 것은 JSON-RPC 2.0 프레임 몇 개와
 * POST 하나뿐이다. `@modelcontextprotocol/sdk`를 넣으면 이 저장소 최초의 런타임 의존성이 된다.
 * 대가는 스펙 추종 비용을 스스로 진다는 것 — 그래서 표면을 최소로 두었다(stateless, 세션 없음,
 * 서버→클라이언트 스트림 없음). 셋 다 스펙이 허용하는 선택지다.
 *
 * **인증은 새 축을 만들지 않는다.** 기존 Bearer 토큰 + RBAC 4역할(7.3)을 그대로 쓴다.
 * 도구마다 관리 API 라우트와 같은 capability를 달고, `tools/list`는 **호출자가 쓸 수 없는 도구를
 * 아예 빼서** 내려준다 — 모델에게 보이지 않는 편이 호출 후 거부당하는 것보다 낫다.
 */
import type { Repo } from "../db/repo.ts";
import type { ArtifactStore } from "../storage/store.ts";
import { authorize, AuthError, type Capability, type Principal } from "../auth/rbac.ts";
import { HttpError } from "../api/errors.ts";
import { validateTranslation } from "./validate.ts";
import { resolvePreview } from "./preview.ts";

/** 우리가 말할 줄 아는 프로토콜 리비전. 클라이언트가 아는 것을 물으면 그대로 되돌려 준다. */
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26"] as const;
const SERVER_INFO = { name: "rynl10n", version: "0.1.0" };

export interface McpDeps {
  readonly repo: Repo;
  readonly store: ArtifactStore;
}

interface McpTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly capability: Capability;
  readonly inputSchema: Record<string, unknown>;
  readonly run: (deps: McpDeps, args: any) => { summary: string; data: unknown };
}

const VERSION_AXES = {
  appVersion: { type: "string", description: "semver-range 릴리스 평가용. 예: \"3.2.1\"" },
  releaseLabel: { type: "string", description: "exact-label 릴리스 평가용." },
  buildNumber: {
    type: "integer",
    description: "integer-range 릴리스 평가용(빌드 넘버). 앱이 SDK에 넘긴다면 반드시 함께 적을 것 — 빠뜨리면 정수 범위 릴리스가 매칭에서 통째로 빠져 엉뚱한 카탈로그를 본 것처럼 보인다.",
  },
} as const;

export const MCP_TOOLS: readonly McpTool[] = [
  {
    name: "validate_translation",
    title: "번역 값 검증(쓰기 없음)",
    description:
      "번역 값이 키의 플레이스홀더 서명·복수형 형태·프로젝트 지원 로케일 규칙을 만족하는지 검사한다. **저장하지 않는다.** " +
      "쓰기가 422로 거부될 값을 미리 잡고, 서명이 어긋나면 어느 인자가 빠졌는지(missingArgs)·남았는지(extraArgs)까지 돌려준다. " +
      "한 키의 여러 로케일을 한 번에 넣어야 로케일끼리 서명이 갈리는 경우까지 잡힌다. " +
      "응답의 key.description은 번역자용 맥락이니 문구를 지을 때 함께 읽을 것.",
    capability: "read",
    inputSchema: {
      type: "object",
      required: ["project", "key", "entries"],
      properties: {
        project: { type: "string", description: "프로젝트 id" },
        key: { type: "string", description: "키 이름(namespace.key)" },
        entries: {
          type: "array", minItems: 1,
          description: "검사할 (로케일, 값) 목록. 한 키에 대해 한 번에 넣는다.",
          items: {
            type: "object",
            required: ["locale", "value"],
            properties: {
              locale: { type: "string", description: "BCP 47. 프로젝트에 등록된 로케일이어야 한다." },
              value: {
                description: "ICU MessageFormat 문자열, 또는 CLDR 복수형 카테고리 맵(other 필수).",
                anyOf: [{ type: "string" }, { type: "object", additionalProperties: { type: "string" } }],
              },
              state: { type: "string", enum: ["draft", "reviewed"], default: "draft" },
            },
          },
        },
      },
    },
    run: (deps, args) => {
      const r = validateTranslation(deps.repo, args);
      const errors = r.problems.filter((p) => p.severity === "error");
      return {
        summary: r.ok
          ? `통과 — ${args.entries.length}개 로케일이 서명 "${r.signature.actual ?? ""}"로 일치합니다`
          : `거부 — ${errors.length}건: ${errors.map((p) => p.code).join(", ")}`,
        data: r,
      };
    },
  },
  {
    name: "resolve_preview",
    title: "해석 경로 미리보기",
    description:
      "특정 앱 버전·로케일에서 키가 실제로 어떤 값으로 보이는지, 그리고 그 값이 원격 오버레이·번들 스냅샷 중 어디서 왔는지를 돌려준다. " +
      "\"왜 아직 옛 문구가 보이는가\"의 원인(릴리스 미매칭·draft·카나리 제외·델타 불일치·포맷 가드 되돌림·로케일 fallback 등)을 diagnosis 코드로 짚어 준다. 읽기 전용. " +
      "appVersion·releaseLabel·buildNumber는 앱이 SDK에 넘기는 컨텍스트 그대로 적어야 하며 최소 하나가 필요하다.",
    capability: "read",
    inputSchema: {
      type: "object",
      required: ["project", "key", "locale"],
      properties: {
        project: { type: "string" },
        key: { type: "string" },
        locale: { type: "string", description: "조회 로케일(BCP 47). 릴리스 매칭 축과는 다른 축이다 — 앱이 t()에 넘기거나 configure에 설정한 값." },
        ...VERSION_AXES,
        bundleBase: {
          type: "string",
          description: "앱이 빌드 시점에 구워 넣은 번들의 base 해시(lockfile 값). 생략하면 '방금 빌드한 앱'을 가정하며 응답의 bundle.assumed가 true가 된다 — 스테일 번들이 원인인 경우를 보려면 반드시 줄 것.",
        },
        args: { type: "object", description: "ICU 포맷 인자. 복수형은 count." },
        fallbackPolicy: { type: "string", enum: ["bundle-only", "nearest-lower"], default: "bundle-only" },
        matchPrerelease: { type: "boolean" },
        installId: { type: "string", description: "카나리 버킷 판정용 기기 로컬 익명 id(8.4). rollout<100일 때만 의미가 있다." },
      },
    },
    run: (deps, args) => {
      const r = resolvePreview(deps.repo, deps.store, args);
      const where = r.source === "unresolved" ? "해석 실패" : `${r.source === "overlay" ? "원격 오버레이" : "번들"}/${r.matchedLocale}`;
      return {
        summary: `${JSON.stringify(r.value)} (${where}${r.diagnosis.length ? ` · ${r.diagnosis.map((d) => d.code).join(", ")}` : ""})`,
        data: r,
      };
    },
  },
];

// ── JSON-RPC 2.0 ────────────────────────────────────────────────────────────

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const ok = (id: unknown, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
const fail = (id: unknown, code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

/**
 * 도구 목록을 대시보드가 읽을 수 있는 형태로. `tools/list`와 **같은 필터**를 쓰므로
 * 화면에 보이는 것이 곧 그 토큰으로 쓸 수 있는 것이다(하드코딩하면 서버와 어긋난다).
 */
export function listMcpTools(principal: Principal): Array<{ name: string; title: string; description: string; capability: Capability }> {
  return visibleTools(principal).map((t) => ({
    name: t.name, title: t.title, description: t.description, capability: t.capability,
  }));
}

/** 호출자가 실제로 쓸 수 있는 도구만. 권한 없는 도구는 목록에서 사라진다. */
function visibleTools(principal: Principal): readonly McpTool[] {
  return MCP_TOOLS.filter((t) => {
    try { authorize(principal, t.capability, undefined); return true; } catch { return false; }
  });
}

function toolResult(summary: string, data: unknown, isError = false): unknown {
  return { content: [{ type: "text", text: summary }], structuredContent: data, isError };
}

/**
 * 메시지 하나를 처리한다. 알림(id 없음)은 null을 돌려주고 호출부가 202로 응답한다.
 * 도구 실행 실패는 JSON-RPC 에러가 아니라 `isError` 결과로 나간다 — 모델이 반응해야 하는
 * 정보지 호출 자체의 실패가 아니고, 프로토콜 에러로 올리면 대화가 끊긴다.
 */
export function handleMcpMessage(deps: McpDeps, principal: Principal, msg: any): JsonRpcResponse | null {
  const id = msg?.id;
  const method = msg?.method;
  if (typeof method !== "string") return fail(id ?? null, -32600, "method 필요");
  if (id === undefined) return null; // 알림 — 응답하지 않는다

  switch (method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0];
      return ok(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: visibleTools(principal).map((t) => ({
          name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
        })),
      });
    case "tools/call": {
      const name = msg.params?.name;
      const tool = visibleTools(principal).find((t) => t.name === name);
      if (!tool) return fail(id, -32602, `알 수 없는 도구: ${name}`);
      const args = msg.params?.arguments ?? {};
      try {
        // 프로젝트 스코프는 도구 인자에서 온다 — 관리 API 라우트의 :p와 같은 축이다.
        authorize(principal, tool.capability, typeof args.project === "string" ? args.project : undefined);
        const { summary, data } = tool.run(deps, args);
        return ok(id, toolResult(summary, data));
      } catch (e) {
        const err = e as HttpError & AuthError;
        const status = typeof err.status === "number" ? err.status : 500;
        return ok(id, toolResult(`오류(${status}): ${err.message}`, { error: { status, message: err.message } }, true));
      }
    }
    default:
      return fail(id, -32601, `지원하지 않는 메서드: ${method}`);
  }
}
