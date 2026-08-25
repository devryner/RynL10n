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

test('PUT /keys의 signature:""는 확정된 서명을 풀지 못한다', async () => {
  // "" 는 값이 아니라 "아직 확정 안 됨" 센티널이다 — 번역 PUT이 `signature === ""`를 그렇게 읽고
  // 첫 값으로 서명을 확정한다. 값으로 받아주면 이 한 번의 요청이 포맷 안전 가드(3.1)를 풀어,
  // 422로 막혔던 값이 그대로 통과하며 새 서명으로 굳는다.
  await api("PUT", "/projects/shop/keys/guard.reset", { token: TOK.trans, body: { signature: "name:simple" } });
  const ok = await api("PUT", "/projects/shop/translations/guard.reset/en", { token: TOK.trans, body: { value: "Hello {name}" } });
  assert.equal(ok.status, 200);

  const mismatch = { value: "Hi {count} {extra}" };
  assert.equal((await api("PUT", "/projects/shop/translations/guard.reset/ja", { token: TOK.trans, body: mismatch })).status, 422);

  // 리셋 시도 — 200이되 서명은 그대로여야 한다.
  const reset = await api("PUT", "/projects/shop/keys/guard.reset", { token: TOK.trans, body: { signature: "" } });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.signature, "name:simple", "빈 문자열이 확정된 서명을 지웠다");

  // 가드가 살아 있으므로 아까 막힌 값은 여전히 422다.
  assert.equal((await api("PUT", "/projects/shop/translations/guard.reset/ja", { token: TOK.trans, body: mismatch })).status, 422);
});

test("설명만 고치는 요청은 서명·복수형을 건드리지 않는다", async () => {
  const before = await api("PUT", "/projects/shop/keys/guard.reset", { token: TOK.trans, body: { description: "홈 화면 인사말" } });
  assert.equal(before.status, 200);
  assert.equal(before.body.signature, "name:simple");
  assert.equal(before.body.description, "홈 화면 인사말");
});

test("서명이 아직 없는 키는 명시적으로 서명을 붙일 수 있다", async () => {
  // 빈 문자열을 거부한다고 해서 "미확정 → 확정" 경로까지 막으면 안 된다.
  await api("PUT", "/projects/shop/keys/guard.fresh", { token: TOK.trans });
  const set = await api("PUT", "/projects/shop/keys/guard.fresh", { token: TOK.trans, body: { signature: "n:number" } });
  assert.equal(set.body.signature, "n:number");
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

// ── 버전 매칭 규칙 검증 (4.3 / 11.3) ─────────────────────────────────────────

test("파싱 불가한 범위식은 생성 시점에 400 — publish 때 500으로 터지지 않는다", async () => {
  // 전략만 보고 통과시키면 draft로 저장됐다가 publish에서 파서가 던져 500이 된다.
  // 그 릴리스는 영영 게시할 수 없는데 사용자는 자기 입력이 원인인 줄 모른다.
  const cases: [string, string][] = [
    ["semver-range", "쓰레기값"],
    ["semver-range", "^3.2.0"],   // 부분집합 밖 문법(11.3) — 명시적 하한·상한만 받는다
    ["semver-range", "3.2.x"],
    ["semver-range", ""],
    ["integer-range", "1.2"],     // 정수만
    ["integer-range", ">=42 || >=100"],
  ];
  for (const [strategy, value] of cases) {
    const r = await api("POST", "/projects/shop/releases", {
      token: TOK.maint, body: { name: "bad", versionMatch: { strategy, value }, keys: [] },
    });
    assert.equal(r.status, 400, `${strategy} "${value}" → 400이어야 한다 (받은 값: ${r.status})`);
    assert.equal(r.body.error.code, "bad_request");
    assert.match(r.body.error.message, /문법이 아닙니다/, "무엇이 문제인지 파서 메시지를 그대로 전달한다");
  }

  // exact-label은 파싱할 문법이 없으므로 자유 문자열 그대로 통과한다.
  const label = await api("POST", "/projects/shop/releases", {
    token: TOK.maint, body: { id: "L1", name: "label", versionMatch: { strategy: "exact-label", value: "쓰레기값" }, keys: [] },
  });
  assert.equal(label.status, 201);
});

test("integer-range 릴리스: 생성 → publish → manifest (빌드넘버 매칭, 4.3)", async () => {
  const create = await api("POST", "/projects/shop/releases", {
    token: TOK.maint,
    body: { id: "B1", name: "빌드 4200대", versionMatch: { strategy: "integer-range", value: ">=4200 <4300" }, keys: ["pay.button"] },
  });
  assert.equal(create.status, 201, "코어·SDK 4종이 구현한 전략인데 API가 막고 있었다");

  const pub = await api("POST", "/projects/shop/releases/B1/publish", { token: TOK.maint });
  assert.equal(pub.status, 202);

  const man = await api("GET", "/projects/shop/manifest", { token: TOK.view });
  const rec = man.body.releases.find((r: any) => r.id === "B1");
  assert.ok(rec, "manifest에 실려야 클라이언트가 스스로 고를 수 있다(정적 라우팅)");
  assert.deepEqual(rec.versionMatch, { strategy: "integer-range", value: ">=4200 <4300" });
});

test("겹치는 integer-range publish는 409 — semver와 섞이면 충돌이 아니다", async () => {
  await api("POST", "/projects/shop/releases", {
    token: TOK.maint,
    body: { id: "B2", name: "겹침", versionMatch: { strategy: "integer-range", value: ">=4250 <4400" }, keys: ["pay.button"] },
  });
  const overlap = await api("POST", "/projects/shop/releases/B2/publish", { token: TOK.maint });
  assert.equal(overlap.status, 409, "4250~4299가 B1과 겹친다");
  assert.equal(overlap.body.error.code, "range_conflict");

  // 전략이 다르면 대상 앱군이 분리되므로 상호 배제 — 이미 게시된 semver 릴리스와는 충돌하지 않는다.
  await api("POST", "/projects/shop/releases", {
    token: TOK.maint,
    body: { id: "B3", name: "안 겹침", versionMatch: { strategy: "integer-range", value: ">=5000" }, keys: ["pay.button"] },
  });
  const apart = await api("POST", "/projects/shop/releases/B3/publish", { token: TOK.maint });
  assert.equal(apart.status, 202, "integer-range는 semver-range 릴리스와 겹치지 않는다");
});

test("알 수 없는 전략은 400이고 메시지가 지원 목록을 알려준다", async () => {
  const r = await api("POST", "/projects/shop/releases", {
    token: TOK.maint, body: { name: "x", versionMatch: { strategy: "date-range", value: "2026" }, keys: [] },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /semver-range · integer-range · exact-label/);
});
