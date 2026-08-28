/**
 * 앱 개발자용 로컬 stdio MCP 서버 — 진입점
 *
 * **이 저장소가 아니라 소비자 앱 저장소에서 도는 것을 전제로 한다.** 에이전트가 서브프로세스로
 * 띄우고, 인증이 없다(그 사용자로 그 디렉토리에서 돈다). stdio인 이유는 **파일** 때문이다 —
 * 관리 플레인 서버는 앱 저장소를 볼 수 없다.
 *
 * 프레이밍은 **개행 구분 JSON**이다. 한 줄이 메시지 하나이므로 청크가 줄 중간에서 끊길 수 있고,
 * 그래서 버퍼에 모아 개행에서만 자른다(SSE 줄 분해를 직접 하는 것과 같은 이유).
 * **로그는 전부 stderr로 간다** — stdout에 한 줄이라도 섞으면 클라이언트의 프레임 해석이 깨진다.
 */
import { handleMessage } from "./protocol.ts";
import { SERVER_INFO, TOOLS } from "./tools.ts";

function log(message: string): void {
  process.stderr.write(`[rynl10n-stdio] ${message}\n`);
}

function respond(res: unknown): void {
  process.stdout.write(`${JSON.stringify(res)}\n`);
}

/** 한 줄 = 메시지 하나. 파싱 실패는 프로토콜 에러로 돌려준다(id를 모르니 null). */
export function handleLine(line: string): void {
  const text = line.trim();
  if (text === "") return;
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    respond({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 파싱 실패" } });
    return;
  }
  const res = handleMessage(TOOLS, SERVER_INFO, msg);
  if (res !== null) respond(res);
}

export function main(): void {
  log(`시작 — 도구 ${TOOLS.length}종: ${TOOLS.map((t) => t.name).join(", ")}`);
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      handleLine(line);
      nl = buffer.indexOf("\n");
    }
  });
  // 개행 없이 끝난 마지막 줄도 버리지 않는다.
  process.stdin.on("end", () => {
    if (buffer.trim() !== "") handleLine(buffer);
  });
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) main();
