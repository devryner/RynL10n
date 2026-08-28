/**
 * 전송 계층 왕복 — 실제로 프로세스를 띄워 stdin/stdout으로 말한다.
 *
 * 디스패처 단위 테스트만으로는 못 보는 것들이 여기 있다: 개행 프레이밍 · **로그가 stdout을
 * 오염시키지 않는가**(한 줄만 섞여도 클라이언트의 프레임 해석이 깨진다) · 청크가 줄 중간에서
 * 끊겨도 메시지가 살아남는가.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSnapshot } from "../../src/builder/builder.ts";

const ENTRY = resolve(import.meta.dirname, "..", "src", "main.ts");

/** 여러 메시지를 한 번에 밀어 넣고 응답 줄들을 모은다. `split`이면 청크를 줄 중간에서 자른다. */
function roundTrip(messages: unknown[], opts: { split?: boolean } = {}): Promise<{ out: string; err: string }> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [ENTRY], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => { out += c; });
    child.stderr.on("data", (c: string) => { err += c; });
    child.on("error", reject);
    child.on("close", () => done({ out, err }));

    const payload = messages.map((m) => `${JSON.stringify(m)}\n`).join("");
    if (opts.split === true) {
      const cut = Math.floor(payload.length / 2);
      child.stdin.write(payload.slice(0, cut));
      child.stdin.end(payload.slice(cut));
    } else {
      child.stdin.end(payload);
    }
  });
}

function parseLines(out: string): any[] {
  return out.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
}

test("initialize → tools/list 왕복이 stdio로 성립한다", async () => {
  const { out } = await roundTrip([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);
  const responses = parseLines(out);
  // 알림에는 응답이 없으므로 두 줄이어야 한다.
  assert.equal(responses.length, 2);
  assert.equal(responses[0].result.protocolVersion, "2025-06-18");
  assert.equal(responses[0].result.serverInfo.name, "rynl10n-stdio");
  assert.deepEqual(responses[1].result.tools.map((t: any) => t.name), ["bake_preview", "lockfile_status"]);
});

test("로그는 stderr로만 간다 — stdout은 JSON 줄만", async () => {
  const { out, err } = await roundTrip([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
  assert.doesNotThrow(() => parseLines(out));
  assert.equal(parseLines(out).length, 1);
  assert.match(err, /rynl10n-stdio/); // 시작 로그는 stderr에 있다
});

test("청크가 줄 중간에서 끊겨도 메시지가 살아남는다", async () => {
  const msgs = [
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", id: 2, method: "ping" },
    { jsonrpc: "2.0", id: 3, method: "ping" },
  ];
  const { out } = await roundTrip(msgs, { split: true });
  assert.deepEqual(parseLines(out).map((r) => r.id), [1, 2, 3]);
});

test("깨진 JSON 한 줄은 -32700으로 돌려주고 서버는 계속 산다", async () => {
  const child = await new Promise<{ out: string }>((done, reject) => {
    const c = spawn(process.execPath, [ENTRY], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    c.stdout.setEncoding("utf8");
    c.stdout.on("data", (chunk: string) => { out += chunk; });
    c.on("error", reject);
    c.on("close", () => done({ out }));
    c.stdin.write("{ 이건 JSON이 아니다\n");
    c.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" })}\n`);
  });
  const responses = parseLines(child.out);
  assert.equal(responses[0].error.code, -32700);
  assert.equal(responses[1].id, 9); // 다음 메시지가 정상 처리된다
});

test("bake_preview를 stdio로 호출하면 구조화 결과가 온다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rynl10n-stdio-"));
  const snap = buildSnapshot({ release: "R1", defaultLocale: "en", locales: { en: { a: "A" } } });
  const path = join(dir, "snapshot.json");
  writeFileSync(path, JSON.stringify(snap), "utf8");

  const { out } = await roundTrip([{
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "bake_preview", arguments: { snapshot: path, outDir: join(dir, "out") } },
  }]);
  const result = parseLines(out)[0].result;
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.release, "R1");
  assert.equal(result.structuredContent.bundle.status, "추가");
  assert.match(result.content[0].text, /release=R1/);
});
