/**
 * 대시보드 프런트엔드 로직 스모크 테스트 (7.1 / 9.2 코어 ③).
 *
 * 브라우저 없이 검증하기 위해 app.js가 실제로 쓰는 만큼의 최소 DOM·fetch를 스텁으로 세운다.
 * 목적은 렌더 트리 확인이 아니라 **동작 계약** 검증이다:
 *   ① 토큰 유무에 따른 화면 분기 ② 목록·그리드가 API 응답을 그대로 반영하는가
 *   ③ 편집이 올바른 관리 API 호출로 이어지는가 ④ RBAC(7.3)이 UI에서도 반영되는가
 * app.js는 import 시 boot()이 돌기 때문에 시나리오마다 쿼리스트링으로 모듈 캐시를 분리한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// ── 최소 DOM 스텁 ────────────────────────────────────────────────────────────

class StubNode {
  tag: string;
  children: any[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, ((e?: any) => void)[]> = {};
  className = "";
  value = "";
  disabled = false;
  selectedOptions: any[] = [];
  own = "";

  constructor(tag: string) { this.tag = tag; }
  // 브라우저 동작 미러: value/disabled 속성은 대응 프로퍼티에도 반영된다.
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
    if (k === "value") this.value = v;
    if (k === "disabled") this.disabled = true;
  }
  getAttribute(k: string) { return this.attrs[k]; }
  addEventListener(t: string, f: (e?: any) => void) { (this.listeners[t] ??= []).push(f); }
  append(...ns: any[]) { this.children.push(...ns); }
  replaceChildren(...ns: any[]) { this.children = [...ns]; }
  remove() { }
  focus() { }
  scrollIntoView() { }
  get childNodes() { return this.children; }
  set textContent(v: string) { this.own = String(v); this.children = []; }
  get textContent(): string { return this.own + this.children.map((c) => c.textContent ?? "").join(""); }
  fire(type: string, e?: any) { for (const f of this.listeners[type] ?? []) f(e); }
  blur() { this.fire("blur"); }
}

function installDom() {
  const byId: Record<string, StubNode> = { app: new StubNode("div"), toasts: new StubNode("div") };
  const g = globalThis as any;
  g.Node = StubNode;
  g.document = {
    createElement: (t: string) => new StubNode(t),
    // 사이드바 아이콘은 인라인 SVG다 — SVG는 네임스페이스가 달라 createElement로는 만들 수 없고,
    // app.js가 createElementNS를 쓴다. 스텁에 없으면 셸을 그리는 순간 전부 터진다.
    createElementNS: (_ns: string, t: string) => new StubNode(t),
    createTextNode: (s: string) => Object.assign(new StubNode("#text"), { own: String(s) }),
    getElementById: (id: string) => byId[id],
    // main은 셸 안쪽(app > .app > .workspace > main)이라 직계 자식이 아니다 — 트리를 훑는다.
    querySelector: (_sel: string) => walk(byId.app!).find((c: any) => c.tag === "main"),
    body: new StubNode("body"),
  };
  const store: Record<string, string> = {};
  g.localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  };
  // app.js가 읽는 것들: 브랜드의 host, MCP 안내의 origin, 배포 플레인 기본 주소의 protocol·hostname.
  g.location = { protocol: "http:", hostname: "localhost", host: "l10n.test", origin: "https://l10n.test" };
  g.EventSource = class { addEventListener() { } close() { } };
  return { byId, store };
}

/** 트리 전체를 평탄화 — 특정 태그·텍스트 노드를 찾기 위한 헬퍼. */
function walk(n: any, out: any[] = []): any[] {
  out.push(n);
  for (const c of n.children ?? []) walk(c, out);
  return out;
}
const tags = (root: any, tag: string) => walk(root).filter((n) => n.tag === tag);

/** 경로별 응답 테이블을 받아 fetch를 스텁하고, 실제 호출을 기록한다. */
function installFetch(table: Record<string, any>) {
  const calls: { method: string; path: string; body: any; auth?: string }[] = [];
  (globalThis as any).fetch = async (path: string, init: any = {}) => {
    const method = init.method ?? "GET";
    calls.push({
      method, path,
      body: init.body ? JSON.parse(init.body) : undefined,
      auth: init.headers?.authorization,
    });
    const hit = table[`${method} ${path}`];
    if (hit === undefined) return { ok: false, status: 404, text: async () => JSON.stringify({ error: { code: "not_found", message: path } }) };
    if (hit instanceof Error) {
      const status = Number((hit as any).status ?? 500);
      return { ok: false, status, text: async () => JSON.stringify({ error: { code: (hit as any).code, message: hit.message } }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(hit) };
  };
  return calls;
}

/** 마이크로태스크 큐를 여러 번 비워 boot()의 연쇄 await를 소진시킨다. */
async function settle(times = 12) {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}

let scenario = 0;
async function loadApp() {
  await import(`../src/ui/app.js?s=${++scenario}`);
  await settle();
}

// ── 고정 응답(관리 API 실제 스키마와 동일) ────────────────────────────────────

const ME_ADMIN = {
  actor: "admin", role: "admin", projects: "*", deliveryBaseUrl: "https://cdn.test",
  mcp: { enabled: true, allowedOrigins: [] },
};
const MCP_TOOLS = {
  tools: [
    { name: "validate_translation", title: "번역 값 검증(쓰기 없음)", description: "…", capability: "read" },
    { name: "resolve_preview", title: "해석 경로 미리보기", description: "…", capability: "read" },
  ],
};
const PROJECTS = { projects: [{ id: "shop", name: "Shop", defaultLocale: "en" }] };
const PROJECT = { id: "shop", name: "Shop", defaultLocale: "en", locales: ["en", "ko"] };
const KEYS = {
  keys: [{
    name: "cart.title", signature: "", isPlural: false, refCount: 1,
    description: "장바구니 화면 상단 제목",
    translations: {
      en: { value: "Cart", state: "reviewed", updatedAt: "2026-07-27T00:00:00.000Z" },
      ko: { value: "장바구니", state: "draft", updatedAt: "2026-07-27T00:00:00.000Z" },
    },
  }],
};
const RELEASES = {
  releases: [{
    id: "R1", projectId: "shop", name: "1.x",
    versionMatch: { strategy: "semver-range", value: ">=1.0.0 <2.0.0" },
    state: "published", base: "aaaa1111bbbb2222", overlay: "cccc3333dddd4444", rollout: 100, seq: 1,
    createdAt: "2026-07-27T00:00:00.000Z",
  }],
};

interface Me {
  actor: string; role: string; projects: string | string[]; deliveryBaseUrl: string;
  mcp?: { enabled: boolean; allowedOrigins: string[] };
}

function projectTable(me: Me = ME_ADMIN) {
  return {
    "GET /me": me,
    "GET /projects": PROJECTS,
    "GET /projects/shop": PROJECT,
    "GET /projects/shop/keys": KEYS,
    "GET /projects/shop/releases": RELEASES,
    "GET /projects/shop/telemetry": { telemetry: [] },
    "GET /projects/shop/manifest": { schemaVersion: 1, project: "shop", releases: [] },
    "GET /projects/shop/manifests": { history: [] },
    "GET /users": { users: [] }, // 목록 화면은 admin이면 사용자도 함께 읽는다(7.3)
    "GET /mcp/tools": MCP_TOOLS,
  } as Record<string, any>;
}

// ── 테스트 ───────────────────────────────────────────────────────────────────

test("토큰이 없으면 로그인 화면을 렌더하고 API를 호출하지 않는다", async () => {
  const { byId } = installDom();
  const calls = installFetch({});
  await loadApp();

  assert.equal(calls.length, 0, "로그인 전에는 어떤 요청도 보내지 않아야 한다");
  assert.match(byId.app!.textContent, /RynL10n 대시보드/);
  assert.match(byId.app!.textContent, /dev-admin-token/, "기본 토큰 안내가 보여야 한다");
  assert.ok(tags(byId.app, "input").some((i) => i.attrs.type === "password"), "토큰 입력은 password 타입");
});

test("로그인: 토큰을 /me로 검증하고 통과하면 프로젝트 목록을 연다", async () => {
  const { byId, store } = installDom();
  const calls = installFetch(projectTable());
  await loadApp();

  const input = tags(byId.app, "input").find((i) => i.attrs.type === "password")!;
  input.value = "tok-admin";
  tags(byId.app, "button").find((b) => b.textContent === "로그인")!.fire("click");
  await settle();

  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["GET /me", "GET /projects", "GET /users"]);
  assert.equal(calls[0]!.auth, "Bearer tok-admin", "Bearer 헤더로 토큰을 보내야 한다");
  assert.equal(store["rynl10n.token"], "tok-admin", "검증에 성공해야만 토큰을 저장한다");
  assert.match(byId.app!.textContent, /Shop/);
  // 상단바는 아바타(머리글자) + 이름 + 역할로 나뉘어 있다 — 한 줄 문자열이 아니라 블록으로 본다.
  const who = walk(byId.app!).find((x: any) => x.className === "who");
  assert.ok(who, "상단바에 액터 블록이 있다");
  assert.match(who.textContent, /admin/, "헤더에 액터·역할 표시");
});

test("로그인 실패(401)면 토큰을 저장하지 않고 로그인 화면에 머문다", async () => {
  const { byId, store } = installDom();
  installFetch({ "GET /me": Object.assign(new Error("유효하지 않은 토큰"), { status: 401, code: "unauthorized" }) });
  await loadApp();

  const input = tags(byId.app, "input").find((i) => i.attrs.type === "password")!;
  input.value = "bad";
  tags(byId.app, "button").find((b) => b.textContent === "로그인")!.fire("click");
  await settle();

  assert.equal(store["rynl10n.token"], undefined, "실패한 토큰은 저장하지 않는다");
  assert.match(byId.app!.textContent, /유효하지 않은 토큰입니다/);
});

test("프로젝트를 열면 번역 그리드가 로케일·값·상태를 그대로 반영한다", async () => {
  const { byId, store } = installDom();
  store["rynl10n.token"] = "tok-admin";
  installFetch(projectTable());
  await loadApp();

  tags(byId.app, "button").find((b) => b.textContent === "shop")!.fire("click");
  await settle();

  const text = byId.app!.textContent;
  assert.match(text, /지원 로케일/);
  assert.match(text, /cart\.title/);
  const values = tags(byId.app, "input").map((i) => i.value);
  assert.ok(values.includes("Cart"), "en 값이 셀에 들어가야 한다");
  assert.ok(values.includes("장바구니"), "ko 값이 셀에 들어가야 한다");
  assert.match(text, /reviewed/, "번역 상태 배지 노출");
});

test("셀 편집 후 blur는 PUT /translations/{key}/{locale} 를 정확히 호출한다", async () => {
  const { byId, store } = installDom();
  store["rynl10n.token"] = "tok-admin";
  const table = projectTable();
  table["PUT /projects/shop/translations/cart.title/ko"] = { key: "cart.title", locale: "ko", value: "카트", state: "draft" };
  const calls = installFetch(table);
  await loadApp();

  tags(byId.app, "button").find((b) => b.textContent === "shop")!.fire("click");
  await settle();

  const cell = tags(byId.app, "input").find((i) => i.value === "장바구니")!;
  cell.value = "카트";
  cell.blur();
  await settle();

  const put = calls.find((c) => c.method === "PUT")!;
  assert.equal(put.path, "/projects/shop/translations/cart.title/ko");
  assert.deepEqual(put.body, { value: "카트", state: "draft" });
});

test("값을 바꾸지 않고 포커스만 빠져나가면 요청을 보내지 않는다", async () => {
  const { byId, store } = installDom();
  store["rynl10n.token"] = "tok-admin";
  const calls = installFetch(projectTable());
  await loadApp();

  tags(byId.app, "button").find((b) => b.textContent === "shop")!.fire("click");
  await settle();
  const before = calls.length;

  tags(byId.app, "input").find((i) => i.value === "Cart")!.blur();
  await settle();

  assert.equal(calls.length, before, "변경 없는 blur는 네트워크를 타면 안 된다");
});

test("번역 JSON 파일은 미리보기 후 현재 프로젝트 import API로 그대로 보낸다", async () => {
  const { byId, store } = installDom();
  store["rynl10n.token"] = "tok-admin";
  const table = projectTable();
  table["POST /projects/shop/translations/import"] = { createdKeys: 1, updatedKeys: 1, translations: 3 };
  const calls = installFetch(table);
  await loadApp();
  tags(byId.app, "button").find((b) => b.textContent === "shop")!.fire("click");
  await settle();

  const data = {
    keys: [
      { name: "cart.title", translations: [{ locale: "ko", value: "카트", state: "reviewed" }] },
      { name: "home.title", translations: [{ locale: "en", value: "Home" }, { locale: "ko", value: "홈" }] },
    ],
  };
  const picker = tags(byId.app, "input").find((i) => i.attrs.type === "file")!;
  picker.files = [{ name: "translations.json", text: async () => JSON.stringify(data) }];
  const before = calls.filter((c) => c.method === "POST").length;
  picker.fire("change");
  await settle();

  assert.match(byId.app!.textContent, /번역 가져오기 확인/);
  assert.match(byId.app!.textContent, /키 2 · 번역 3 · 로케일 2/);
  assert.equal(calls.filter((c) => c.method === "POST").length, before, "파일 선택만으로 쓰지 않는다");

  tags(byId.app, "button").find((b) => b.textContent === "가져오기")!.fire("click");
  await settle();
  const post = calls.find((c) => c.method === "POST" && c.path === "/projects/shop/translations/import")!;
  assert.deepEqual(post.body, data);
  assert.match((globalThis as any).document.getElementById("toasts").textContent, /새 키 1 · 기존 키 1 · 번역 3/);
});

test("깨진 번역 JSON은 로컬에서 막고 viewer에게는 파일 선택기를 보이지 않는다", async () => {
  const { byId, store } = installDom();
  store["rynl10n.token"] = "tok-admin";
  const calls = installFetch(projectTable());
  await loadApp();
  tags(byId.app, "button").find((b) => b.textContent === "shop")!.fire("click");
  await settle();
  const picker = tags(byId.app, "input").find((i) => i.attrs.type === "file")!;
  picker.files = [{ name: "broken.json", text: async () => "{ bad" }];
  picker.fire("change");
  await settle();
  assert.ok(!calls.some((c) => c.method === "POST"));
  assert.match((globalThis as any).document.getElementById("toasts").textContent, /JSON을 읽지 못했습니다/);

  const viewer = installDom();
  viewer.store["rynl10n.token"] = "tok-viewer";
  installFetch(projectTable({ actor: "viewer", role: "viewer", projects: ["shop"], deliveryBaseUrl: "https://cdn.test" }));
  await loadApp();
  tags(viewer.byId.app, "button").find((b) => b.textContent === "shop")!.fire("click");
  await settle();
  assert.equal(tags(viewer.byId.app, "input").some((i) => i.attrs.type === "file"), false);
  assert.equal(viewer.byId.app!.textContent.includes("번역 JSON 가져오기"), false);
});

test("422 서명 불일치는 입력값을 되돌리고 오류를 표면화한다", async () => {
  const { byId, store } = installDom();
  store["rynl10n.token"] = "tok-admin";
  const table = projectTable();
  table["PUT /projects/shop/translations/cart.title/ko"] =
    Object.assign(new Error('플레이스홀더 서명 불일치: 기대 "name:string" 실제 ""'), { status: 422, code: "signature_mismatch" });
  installFetch(table);
  await loadApp();

  tags(byId.app, "button").find((b) => b.textContent === "shop")!.fire("click");
  await settle();

  const cell = tags(byId.app, "input").find((i) => i.value === "장바구니")!;
  cell.value = "깨진 값";
  cell.blur();
  await settle();

  assert.equal(cell.value, "장바구니", "실패하면 마지막 저장값으로 되돌려야 한다");
  const toasts = (globalThis as any).document.getElementById("toasts").textContent;
  assert.match(toasts, /422 — 플레이스홀더 서명 불일치/);
  assert.match(toasts, /기대 "name:string"/, "서버 메시지를 그대로 보여준다");
});

test("키 설명: 기존 값을 셀에 채우고, 수정하면 PUT /keys/{key} 로 저장한다 (5.1)", async () => {
  const { byId, store } = installDom();
  store["rynl10n.token"] = "tok-admin";
  const table = projectTable();
  table["PUT /projects/shop/keys/cart.title"] = { id: 1, name: "cart.title", description: "결제 전 마지막 화면 제목. 짧게." };
  const calls = installFetch(table);
  await loadApp();

  tags(byId.app, "button").find((b) => b.textContent === "shop")!.fire("click");
  await settle();

  const box = tags(byId.app, "textarea").find((t) => t.value === "장바구니 화면 상단 제목");
  assert.ok(box, "기존 설명이 셀에 채워져야 한다");

  box!.value = "결제 전 마지막 화면 제목. 짧게.";
  box!.blur();
  await settle();

  const put = calls.find((c) => c.method === "PUT")!;
  assert.equal(put.path, "/projects/shop/keys/cart.title");
  assert.deepEqual(put.body, { description: "결제 전 마지막 화면 제목. 짧게." },
    "설명만 보내야 서명·복수형 메타가 덮어써지지 않는다");
});

test("키 추가 시 설명을 함께 보낼 수 있다 (차후 로케일 확장용 맥락)", async () => {
  const { byId, store } = installDom();
  store["rynl10n.token"] = "tok-admin";
  const table = projectTable();
  table["PUT /projects/shop/keys/cart.empty"] = { id: 2, name: "cart.empty", description: "빈 장바구니 안내" };
  const calls = installFetch(table);
  await loadApp();

  tags(byId.app, "button").find((b) => b.textContent === "shop")!.fire("click");
  await settle();

  const nameInput = tags(byId.app, "input").find((i) => i.attrs.placeholder === "namespace.key")!;
  const descBox = tags(byId.app, "textarea").find((t) => (t.attrs.placeholder ?? "").startsWith("설명(선택)"))!;
  nameInput.value = "cart.empty";
  descBox.value = "빈 장바구니 안내";
  tags(byId.app, "button").find((b) => b.textContent === "키 추가")!.fire("click");
  await settle();

  const put = calls.find((c) => c.method === "PUT")!;
  assert.equal(put.path, "/projects/shop/keys/cart.empty");
  assert.equal(put.body.description, "빈 장바구니 안내");
});

test("RBAC: viewer는 편집 입력이 잠기고 릴리스 작업 버튼이 없다 (7.3 UI 미러)", async () => {
  const { byId, store } = installDom();
  store["rynl10n.token"] = "tok-view";
  installFetch(projectTable({ actor: "vw", role: "viewer", projects: ["shop"], deliveryBaseUrl: "https://cdn.test" }));
  await loadApp();

  tags(byId.app, "button").find((b) => b.textContent === "shop")!.fire("click");
  await settle();

  const cells = tags(byId.app, "input").filter((i) => i.value === "Cart" || i.value === "장바구니");
  assert.ok(cells.length > 0);
  assert.ok(cells.every((c) => c.disabled), "viewer의 번역 셀은 비활성");
  assert.doesNotMatch(byId.app!.textContent, /키 추가/, "viewer에게 키 추가 폼을 보이지 않는다");

  // 릴리스 탭으로 이동 — publish 등 쓰기 작업이 노출되지 않아야 한다.
  tags(byId.app, "button").find((b) => b.textContent === "릴리스")!.fire("click");
  await settle();
  assert.match(byId.app!.textContent, /R1/, "릴리스 목록 자체는 읽을 수 있다");
  const labels = tags(byId.app, "button").map((b) => b.textContent);
  for (const forbidden of ["publish", "롤백", "키 추가", "보관"]) {
    assert.ok(!labels.includes(forbidden), `viewer에게 "${forbidden}" 버튼은 없어야 한다`);
  }
  assert.match(byId.app!.textContent, /읽기 전용/);
});

test("배포 탭은 배포 플레인 URL로 산출물 링크를 만든다 (플레인 분리 4.1)", async () => {
  const { byId, store } = installDom();
  store["rynl10n.token"] = "tok-admin";
  const table = projectTable();
  table["GET /projects/shop/manifest"] = {
    schemaVersion: 1, project: "shop", defaultLocale: "en",
    releases: [{ id: "R1", state: "published", base: "aaaa1111bbbb2222", overlay: "cccc3333dddd4444", rollout: 100, snapshot: "releases/R1/snapshot-aaaa1111bbbb2222.json", delta: "releases/R1/delta-aaaa1111bbbb2222-cccc3333dddd4444.json" }],
  };
  installFetch(table);
  await loadApp();

  tags(byId.app, "button").find((b) => b.textContent === "shop")!.fire("click");
  await settle();
  tags(byId.app, "button").find((b) => b.textContent === "배포")!.fire("click");
  await settle();

  const hrefs = tags(byId.app, "a").map((a) => a.attrs.href);
  assert.ok(hrefs.includes("https://cdn.test/shop/manifest.json"), "manifest는 배포 플레인 주소로");
  assert.ok(hrefs.some((h) => h === "https://cdn.test/shop/releases/R1/snapshot-aaaa1111bbbb2222.json"));
  assert.ok(hrefs.some((h) => h?.includes("delta-aaaa1111bbbb2222-cccc3333dddd4444.json")));
});

test("관측성 탭은 익명 집계를 요약하고 릴리스·앱 버전군별로 보여준다", async () => {
  const { byId, store } = installDom();
  store["rynl10n.token"] = "tok-view";
  const table = projectTable({ actor: "vw", role: "viewer", projects: ["shop"], deliveryBaseUrl: "https://cdn.test" });
  table["GET /projects/shop/telemetry"] = { telemetry: [
    { releaseId: "R1", appVersionBucket: "1.0", event: "overlay_applied", count: 100 },
    { releaseId: "R1", appVersionBucket: "1.0", event: "format_guard_rejected", count: 10 },
    { releaseId: "R1", appVersionBucket: "1.0", event: "key_unresolved", count: 5 },
    { releaseId: "R1", appVersionBucket: "1.0", event: "delta_failed", count: 2 },
    { releaseId: "R1", appVersionBucket: "1.1", event: "overlay_applied", count: 25 },
  ] };
  const calls = installFetch(table);
  await loadApp();

  tags(byId.app, "button").find((b) => b.textContent === "shop")!.fire("click");
  await settle();
  tags(byId.app, "button").find((b) => b.textContent === "관측성")!.fire("click");

  const text = byId.app!.textContent;
  assert.match(text, /익명 운영 신호/);
  assert.match(text, /번역 원문, 키 이름, 기기 식별자는 저장하지 않습니다/);
  assert.match(text, /125/, "전체 오버레이 적용 횟수를 합산한다");
  assert.match(text, /7\.41%/, "포맷 가드 거부율은 guard \/ \(applied \+ guard\)");
  assert.match(text, /1\.57%/, "델타 실패율은 failed \/ \(applied \+ failed\)");
  assert.match(text, /1\.0/);
  assert.match(text, /1\.1/);
  assert.match(text, /published/, "알려진 릴리스는 현재 상태도 함께 표시한다");

  const before = calls.filter((c) => c.path === "/projects/shop/telemetry").length;
  tags(byId.app, "button").find((b) => b.textContent === "새로고침")!.fire("click");
  await settle();
  assert.equal(calls.filter((c) => c.path === "/projects/shop/telemetry").length, before + 1);
});

// ── 검색·필터 ────────────────────────────────────────────────────────────────

const T = "2026-07-27T00:00:00.000Z";

/** 이름·설명·값·상태·미번역이 서로 다른 4개 키 — 필터 축을 하나씩 분리해 검증하기 위한 픽스처. */
const SEARCH_KEYS = {
  keys: [
    {
      name: "cart.title", signature: "", isPlural: false, refCount: 1,
      description: "장바구니 화면 상단 제목",
      translations: {
        en: { value: "Cart", state: "reviewed", updatedAt: T },
        ko: { value: "장바구니", state: "draft", updatedAt: T },
      },
    },
    {
      name: "cart.empty", signature: "", isPlural: false, refCount: 1,
      description: "비어 있을 때 안내 문구",
      translations: { en: { value: "Your cart is empty", state: "draft", updatedAt: T } }, // ko 없음
    },
    {
      name: "checkout.pay", signature: "", isPlural: false, refCount: 2,
      description: "결제 버튼 레이블",
      translations: {
        en: { value: "Pay now", state: "reviewed", updatedAt: T },
        ko: { value: "결제하기", state: "reviewed", updatedAt: T },
      },
    },
    {
      name: "order.count", signature: "", isPlural: true, refCount: 1,
      description: "주문 개수 안내",
      translations: {
        en: { value: { one: "1 order", other: "{n} orders" }, state: "draft", updatedAt: T },
        ko: { value: "", state: "draft", updatedAt: T }, // 빈 문자열도 미번역으로 본다
      },
    },
  ],
};

function searchTable() {
  const t = projectTable();
  t["GET /projects/shop/keys"] = SEARCH_KEYS;
  return t;
}

/** 그리드 본문에 실제로 그려진 키 이름 — td.key의 첫 텍스트 노드가 키 이름이다. */
function shownKeys(app: any): string[] {
  const tbody = tags(app, "tbody")[0];
  if (!tbody) return [];
  return tbody.children
    .filter((r: any) => r.tag === "tr")
    .map((r: any) => r.children[0]?.children?.[0]?.own)
    .filter((n: any) => typeof n === "string" && n.length > 0);
}

const searchBox = (app: any) => tags(app, "input").find((i: any) => i.attrs.type === "search")!;
const byLabel = (app: any, tag: string, label: string) =>
  tags(app, tag).find((n: any) => n.attrs["aria-label"] === label)!;

async function openSearchProject() {
  const { byId, store } = installDom();
  store["rynl10n.token"] = "tok-admin";
  const calls = installFetch(searchTable());
  await loadApp();
  tags(byId.app, "button").find((b) => b.textContent === "shop")!.fire("click");
  await settle();
  return { byId, calls };
}

test("검색: 키 이름·설명·번역 값을 함께 훑는다", async () => {
  const { byId } = await openSearchProject();
  assert.deepEqual(shownKeys(byId.app), ["cart.title", "cart.empty", "checkout.pay", "order.count"]);

  const q = searchBox(byId.app);
  q.value = "cart.";                       // ① 키 이름
  q.fire("input");
  assert.deepEqual(shownKeys(byId.app), ["cart.title", "cart.empty"]);

  q.value = "결제하기";                     // ② 번역 값으로 키를 되찾는 경로
  q.fire("input");
  assert.deepEqual(shownKeys(byId.app), ["checkout.pay"]);

  q.value = "안내";                        // ③ 설명
  q.fire("input");
  assert.deepEqual(shownKeys(byId.app), ["cart.empty", "order.count"]);

  q.value = "{n} orders";                  // ④ 복수형 값(CLDR 맵)도 검색 대상
  q.fire("input");
  assert.deepEqual(shownKeys(byId.app), ["order.count"]);
});

test("검색은 대소문자를 무시하고 한글은 NFC로 맞춰 비교한다 (11.1 정규화와 정합)", async () => {
  const { byId } = await openSearchProject();
  const q = searchBox(byId.app);

  q.value = "PAY NOW";
  q.fire("input");
  assert.deepEqual(shownKeys(byId.app), ["checkout.pay"], "대소문자 무시");

  // 조합형(NFD)으로 입력해도 NFC로 저장된 값을 찾아야 한다.
  q.value = "장바구니".normalize("NFD");
  q.fire("input");
  assert.deepEqual(shownKeys(byId.app), ["cart.title"], "NFD 입력도 NFC 값과 매칭");
});

test("검색은 네트워크를 타지 않고 그리드 본문만 교체한다 (입력 포커스 유지 계약)", async () => {
  const { byId, calls } = await openSearchProject();
  const before = calls.length;
  const tbodyBefore = tags(byId.app, "tbody")[0];
  const q = searchBox(byId.app);

  q.value = "cart";
  q.fire("input");

  assert.equal(calls.length, before, "클라이언트 측 필터 — 요청이 없어야 한다");
  assert.equal(tags(byId.app, "tbody")[0], tbodyBefore, "tbody 노드가 유지돼야 한다");
  assert.equal(searchBox(byId.app), q, "검색 입력이 교체되면 한 글자마다 포커스가 날아간다");
});

test("미번역만: 값이 없거나 빈 문자열인 키를 남긴다", async () => {
  const { byId } = await openSearchProject();
  const cb = byLabel(byId.app, "input", "미번역만 보기");

  cb.checked = true;
  cb.fire("change");
  assert.deepEqual(shownKeys(byId.app), ["cart.empty", "order.count"]);

  // 로케일을 좁히면 그 로케일 기준으로만 판정한다(열은 계속 전부 보인다).
  const locale = byLabel(byId.app, "select", "로케일");
  locale.value = "en";
  locale.fire("change");
  assert.deepEqual(shownKeys(byId.app), [], "en은 모두 번역돼 있다");
});

test("상태 필터와 검색은 AND로 결합된다", async () => {
  const { byId } = await openSearchProject();
  const st = byLabel(byId.app, "select", "상태");

  st.value = "reviewed";
  st.fire("change");
  assert.deepEqual(shownKeys(byId.app), ["cart.title", "checkout.pay"]);

  searchBox(byId.app).value = "checkout";
  searchBox(byId.app).fire("input");
  assert.deepEqual(shownKeys(byId.app), ["checkout.pay"], "상태 ∧ 검색");
});

test("결과가 없으면 빈 안내를 보여주고, 초기화가 모든 축을 되돌린다", async () => {
  const { byId } = await openSearchProject();
  const q = searchBox(byId.app);
  q.value = "존재하지-않는-키";
  q.fire("input");

  assert.deepEqual(shownKeys(byId.app), []);
  assert.match(byId.app!.textContent, /조건에 맞는 키가 없습니다/);

  byLabel(byId.app, "input", "미번역만 보기").checked = true;
  tags(byId.app, "button").find((b) => b.textContent === "초기화")!.fire("click");

  assert.deepEqual(shownKeys(byId.app), ["cart.title", "cart.empty", "checkout.pay", "order.count"]);
  assert.equal(searchBox(byId.app).value, "", "입력칸도 비워져야 한다");
});

test("필터는 편집 후 재렌더에도 유지된다", async () => {
  const { byId, store } = installDom();
  store["rynl10n.token"] = "tok-admin";
  const table = searchTable();
  table["PUT /projects/shop/translations/checkout.pay/ko"] = { key: "checkout.pay", locale: "ko", value: "결제", state: "reviewed" };
  installFetch(table);
  await loadApp();
  tags(byId.app, "button").find((b) => b.textContent === "shop")!.fire("click");
  await settle();

  const q = searchBox(byId.app);
  q.value = "checkout";
  q.fire("input");
  assert.deepEqual(shownKeys(byId.app), ["checkout.pay"]);

  // 셀 편집 → refresh()가 전체를 다시 그린다. 필터가 풀리면 사용자는 자리를 잃는다.
  const cell = tags(byId.app, "input").find((i) => i.value === "결제하기")!;
  cell.value = "결제";
  cell.blur();
  await settle();

  assert.equal(searchBox(byId.app).value, "checkout", "검색어가 유지돼야 한다");
  assert.deepEqual(shownKeys(byId.app), ["checkout.pay"], "필터 결과도 유지");
});

test("프로젝트를 다시 열면 필터는 초기화된다", async () => {
  const { byId } = await openSearchProject();
  const q = searchBox(byId.app);
  q.value = "checkout";
  q.fire("input");
  assert.deepEqual(shownKeys(byId.app), ["checkout.pay"]);

  btn(byId.app, "프로젝트")!.fire("click"); // 사이드바의 인스턴스 그룹 항목
  await settle();
  tags(byId.app, "button").find((b) => b.textContent === "shop")!.fire("click");
  await settle();

  assert.equal(searchBox(byId.app).value, "", "다른 프로젝트는 키·로케일이 달라 필터를 물고 가면 안 된다");
  assert.equal(shownKeys(byId.app).length, 4);
});

// ── 프로젝트 삭제 (DELETE /projects/{p}) ─────────────────────────────────────
// 되돌릴 수 없는 유일한 작업이라, 검증 대상은 "지워지는가"보다 **함부로 안 지워지는가**다.

const btn = (root: any, label: string) => tags(root, "button").find((b) => b.textContent === label);

/** admin으로 로그인해 프로젝트 목록까지 온 뒤, 삭제 확인 패널을 연다. */
async function openDeletePanel(table = projectTable()) {
  const { byId, store } = installDom();
  store["rynl10n.token"] = "tok-admin";
  const calls = installFetch(table);
  await loadApp();

  btn(byId.app, "삭제")!.fire("click");
  return { byId, calls, table };
}

test("삭제 확인 패널: 프로젝트 ID를 정확히 입력해야 영구 삭제 버튼이 열린다", async () => {
  const { byId, calls } = await openDeletePanel();

  const go = btn(byId.app, "영구 삭제")!;
  assert.equal(go.disabled, true, "패널이 열린 직후에는 잠겨 있어야 한다");
  assert.match(byId.app!.textContent, /되돌릴 수 없습니다/);
  assert.match(byId.app!.textContent, /archive/, "409로 막히는 조건을 미리 알려준다");

  const echo = tags(byId.app, "input").find((i) => i.attrs.placeholder === "shop")!;
  echo.value = "sho"; // 부분 일치로는 열리지 않는다
  echo.fire("input");
  assert.equal(go.disabled, true, "ID가 정확히 일치할 때만 열려야 한다");

  echo.value = "shop";
  echo.fire("input");
  assert.equal(go.disabled, false);

  assert.ok(!calls.some((c) => c.method === "DELETE"), "확인 전에는 아무것도 보내지 않는다");
});

test("확인 후 DELETE /projects/{p} 를 호출하고 목록을 다시 읽는다", async () => {
  const table = projectTable();
  table["DELETE /projects/shop"] = { id: "shop", deleted: true, removed: { keys: 3, releases: 2, locales: 2 } };
  const { byId, calls } = await openDeletePanel(table);

  const echo = tags(byId.app, "input").find((i) => i.attrs.placeholder === "shop")!;
  echo.value = "shop";
  echo.fire("input");
  table["GET /projects"] = { projects: [] }; // 삭제 후 서버가 보게 될 상태
  btn(byId.app, "영구 삭제")!.fire("click");
  await settle();

  const del = calls.find((c) => c.method === "DELETE")!;
  assert.equal(del.path, "/projects/shop");
  assert.equal(del.auth, "Bearer tok-admin");
  assert.equal(del.body, undefined, "본문 없는 DELETE");

  // 삭제 뒤에는 목록을 다시 읽어 화면과 서버 상태를 맞춘다.
  assert.ok(calls.slice(calls.indexOf(del)).some((c) => c.method === "GET" && c.path === "/projects"));
  assert.match(byId.app!.textContent, /아직 프로젝트가 없습니다/);

  const toasts = (globalThis as any).document.getElementById("toasts").textContent;
  assert.match(toasts, /shop 를 삭제했습니다/);
  assert.match(toasts, /키 3 · 릴리스 2 · 로케일 2/, "무엇이 사라졌는지 숫자로 남긴다");
});

test("published 릴리스가 있으면 409로 거절되고 패널이 남아 재시도할 수 있다", async () => {
  const table = projectTable();
  table["DELETE /projects/shop"] = Object.assign(
    new Error("published 릴리스가 있어 삭제할 수 없습니다: R1 — 먼저 archive 하세요"),
    { status: 409, code: "conflict" },
  );
  const { byId, calls } = await openDeletePanel(table);

  const echo = tags(byId.app, "input").find((i) => i.attrs.placeholder === "shop")!;
  echo.value = "shop";
  echo.fire("input");
  btn(byId.app, "영구 삭제")!.fire("click");
  await settle();

  const toasts = (globalThis as any).document.getElementById("toasts").textContent;
  assert.match(toasts, /409 — 현재 상태와 충돌/, "generic 409 코드에도 사람 말 설명이 붙어야 한다");
  assert.match(toasts, /먼저 archive 하세요/, "서버가 알려준 해결 방법을 그대로 보여준다");

  assert.ok(btn(byId.app, "영구 삭제"), "실패해도 패널을 닫지 않는다 — 고치고 되돌아올 수 있다");
  assert.ok(!calls.some((c) => c.method === "GET" && c.path === "/projects" && calls.indexOf(c) > calls.findIndex((x) => x.method === "DELETE")),
    "삭제되지 않았으므로 목록을 다시 읽지 않는다");
});

test("취소는 요청 없이 목록으로 돌아간다 (상세가 없는 화면이라 renderProject로 가면 안 된다)", async () => {
  const { byId, calls } = await openDeletePanel();
  const before = calls.length;

  btn(byId.app, "취소")!.fire("click");
  await settle();

  assert.ok(!calls.some((c) => c.method === "DELETE"));
  assert.match(byId.app!.textContent, /새 프로젝트/, "프로젝트 목록 화면으로 돌아와야 한다");
  assert.ok(calls.length > before, "목록을 다시 읽어 최신 상태로 되돌린다");
});

test("RBAC: admin이 아니면 삭제 버튼 자체가 없다 (7.3 UI 미러)", async () => {
  for (const role of ["viewer", "translator", "maintainer"]) {
    const { byId } = installDom();
    (globalThis as any).localStorage.setItem("rynl10n.token", `tok-${role}`);
    installFetch(projectTable({ actor: role, role, projects: ["shop"], deliveryBaseUrl: "https://cdn.test" }));
    await loadApp();

    assert.ok(!btn(byId.app, "삭제"), `${role}에게 삭제 버튼은 없어야 한다`);
    assert.match(byId.app!.textContent, /shop/, `${role}도 목록 자체는 읽는다`);
  }
});

// ── 프로젝트 가져오기 (POST /projects/import, 9.2) ───────────────────────────
// export의 반대편. 검증 축은 **파일을 고른 것과 복원을 실행한 것을 분리했는가**다 —
// 엉뚱한 파일은 네트워크를 타기 전에 걸러야 하고, 복원할 ID는 보내기 전에 바꿀 수 있어야 한다.

/** label 텍스트로 입력 칸을 집는다(같은 화면에 입력이 여럿이라 순서로 찾으면 깨진다). */
const fieldInput = (root: any, label: string) =>
  walk(root).find((n) => n.tag === "label" && n.textContent.includes(label))
    ?.children.find((c: any) => c.tag === "input");

const EXPORT = {
  project: { id: "shop", name: "Shop", defaultLocale: "en" },
  locales: [{ tag: "en", fallbackParent: null }, { tag: "ko", fallbackParent: null }],
  keys: [{
    name: "cart.title", signature: "", isPlural: false, description: "장바구니 화면 상단 제목",
    translations: [{ locale: "en", value: "Cart", state: "reviewed" }],
  }],
  releases: [{
    id: "R1", name: "1.x", versionMatch: { strategy: "semver-range", value: ">=1.0.0 <2.0.0" },
    state: "published", base: "aaaa1111bbbb2222", overlay: "cccc3333dddd4444", rollout: 100, keys: ["cart.title"],
  }],
};

/** admin으로 목록까지 온 뒤 파일 하나를 고른다. content는 파일에 담길 raw 문자열. */
async function pickImportFile(content: string, table = projectTable()) {
  const { byId, store } = installDom();
  store["rynl10n.token"] = "tok-admin";
  const calls = installFetch(table);
  await loadApp();

  const picker = tags(byId.app, "input").find((i) => i.attrs.type === "file")!;
  picker.files = [{ name: "shop-export.json", text: async () => content }];
  picker.fire("change");
  await settle();
  return { byId, calls, table };
}

test("파일을 고르면 요청 없이 미리보기부터 보여준다", async () => {
  const before = JSON.stringify(EXPORT);
  const { byId, calls } = await pickImportFile(before);
  const n = calls.length;

  assert.match(byId.app!.textContent, /가져오기 확인/);
  assert.match(byId.app!.textContent, /shop-export\.json/, "어떤 파일을 골랐는지 보여준다");
  assert.match(byId.app!.textContent, /로케일 2 · 키 1 · 릴리스 1/, "복원 규모를 미리 알려준다");
  assert.equal(fieldInput(byId.app, "복원할 프로젝트 ID")!.value, "shop", "파일의 ID로 채워 둔다");
  assert.ok(!calls.some((c) => c.method === "POST"), "고르기만 해서는 아무것도 보내지 않는다");
  assert.equal(calls.length, n, "미리보기는 순수 로컬 동작");
});

test("복원은 파일 내용을 그대로 POST /projects/import 로 보내고 목록을 다시 읽는다", async () => {
  const table = projectTable();
  table["POST /projects/import"] = { id: "shop-copy" };
  const { byId, calls } = await pickImportFile(JSON.stringify(EXPORT), table);

  fieldInput(byId.app, "복원할 프로젝트 ID")!.value = "shop-copy"; // 복사본으로 복원
  table["GET /projects"] = { projects: [{ id: "shop", name: "Shop", defaultLocale: "en" }, { id: "shop-copy", name: "Shop", defaultLocale: "en" }] };
  btn(byId.app, "복원")!.fire("click");
  await settle();

  const post = calls.find((c) => c.method === "POST" && c.path === "/projects/import")!;
  assert.ok(post, "복원 버튼을 눌러야 비로소 보낸다");
  assert.equal(post.auth, "Bearer tok-admin");
  assert.equal(post.body.project.id, "shop-copy", "화면에서 바꾼 ID로 보낸다");
  assert.deepEqual(post.body.keys, EXPORT.keys, "키·번역은 파일 그대로 — UI가 손대지 않는다");
  assert.deepEqual(post.body.releases, EXPORT.releases);
  assert.equal(post.body.project.name, "Shop", "ID 말고 다른 필드는 유지");

  assert.ok(calls.slice(calls.indexOf(post)).some((c) => c.method === "GET" && c.path === "/projects"));
  assert.match(byId.app!.textContent, /shop-copy/, "복원된 프로젝트가 목록에 보인다");
  assert.match((globalThis as any).document.getElementById("toasts").textContent, /shop-copy 를 복원했습니다/);
});

test("export가 아닌 JSON은 네트워크를 타지 않고 로컬에서 막는다", async () => {
  const { byId, calls } = await pickImportFile(JSON.stringify({ hello: "world" }));

  assert.ok(!calls.some((c) => c.method === "POST"), "서버까지 갈 필요가 없는 오류다");
  assert.match((globalThis as any).document.getElementById("toasts").textContent, /export 파일이 아닙니다/);
  assert.equal(byId.app!.textContent.includes("가져오기 확인"), false, "미리보기로 넘어가지 않는다");
});

test("깨진 JSON은 파싱 단계에서 걸러진다", async () => {
  const { byId, calls } = await pickImportFile("{ not json");

  assert.ok(!calls.some((c) => c.method === "POST"));
  assert.match((globalThis as any).document.getElementById("toasts").textContent, /JSON을 읽지 못했습니다/);
  assert.equal(byId.app!.textContent.includes("가져오기 확인"), false);
});

test("409(이미 있는 ID)면 패널이 남아 ID만 고쳐 다시 시도할 수 있다", async () => {
  const table = projectTable();
  table["POST /projects/import"] = Object.assign(
    new Error("이미 있는 프로젝트입니다: shop — 다른 ID로 복원하거나 기존 프로젝트를 먼저 삭제하세요"),
    { status: 409, code: "conflict" },
  );
  const { byId, calls } = await pickImportFile(JSON.stringify(EXPORT), table);

  btn(byId.app, "복원")!.fire("click"); // 파일의 ID(shop)가 이미 있는 상황
  await settle();

  const toasts = (globalThis as any).document.getElementById("toasts").textContent;
  assert.match(toasts, /409 — 현재 상태와 충돌/);
  assert.match(toasts, /다른 ID로 복원/, "서버가 알려준 해결 방법을 그대로 보여준다");

  const idInput = fieldInput(byId.app, "복원할 프로젝트 ID");
  assert.ok(idInput, "패널이 남아 있어야 ID를 고칠 수 있다");
  assert.equal(idInput!.value, "shop", "입력값도 그대로 — 처음부터 다시 고르게 하지 않는다");

  // 두 번째 시도는 실제로 새 ID로 나간다.
  table["POST /projects/import"] = { id: "shop-2" };
  idInput!.value = "shop-2";
  btn(byId.app, "복원")!.fire("click");
  await settle();
  const posts = calls.filter((c) => c.method === "POST" && c.path === "/projects/import");
  assert.equal(posts.length, 2);
  assert.equal(posts[1]!.body.project.id, "shop-2");
});

test("취소하면 고른 파일을 버리고 목록으로 돌아간다", async () => {
  const { byId, calls } = await pickImportFile(JSON.stringify(EXPORT));

  btn(byId.app, "취소")!.fire("click");
  await settle();

  assert.ok(!calls.some((c) => c.method === "POST"));
  assert.equal(byId.app!.textContent.includes("가져오기 확인"), false);
  assert.ok(tags(byId.app, "input").some((i) => i.attrs.type === "file"), "다시 고를 수 있는 상태로 돌아온다");
});

test("프로젝트를 열면 고르다 만 파일은 버려진다 (돌아왔을 때 유령이 남지 않는다)", async () => {
  const { byId } = await pickImportFile(JSON.stringify(EXPORT));

  btn(byId.app, "shop")!.fire("click"); // 목록에서 프로젝트 진입
  await settle();
  btn(byId.app, "프로젝트")!.fire("click"); // 사이드바의 인스턴스 그룹 항목
  await settle();

  assert.equal(byId.app!.textContent.includes("가져오기 확인"), false, "미리보기가 되살아나면 안 된다");
});

test("RBAC: admin이 아니면 가져오기 패널 자체가 없다 (7.3 UI 미러)", async () => {
  for (const role of ["viewer", "translator", "maintainer"]) {
    const { byId } = installDom();
    (globalThis as any).localStorage.setItem("rynl10n.token", `tok-${role}`);
    installFetch(projectTable({ actor: role, role, projects: ["shop"], deliveryBaseUrl: "https://cdn.test" }));
    await loadApp();

    assert.equal(byId.app!.textContent.includes("프로젝트 가져오기"), false, `${role}에게 import는 없어야 한다`);
    assert.ok(!tags(byId.app, "input").some((i) => i.attrs.type === "file"), `${role}에게 파일 선택기는 없어야 한다`);
  }
});

// ── 버전 매칭 전략 (4.3) ─────────────────────────────────────────────────────
// 코어·SDK 4종은 integer-range를 구현하는데 대시보드 드롭다운에 없어서 고를 수가 없었다.
// 전략마다 값 문법이 완전히 달라서(semver 비교자 / 정수 비교자 / 자유 라벨) 안내도 같이 바뀌어야 한다.

/** admin으로 프로젝트를 열고 릴리스 탭까지 이동한 뒤 새 릴리스 폼 요소를 집어 준다. */
async function openReleaseCreator(table = projectTable()) {
  const { byId, store } = installDom();
  store["rynl10n.token"] = "tok-admin";
  const calls = installFetch(table);
  await loadApp();
  btn(byId.app, "shop")!.fire("click");
  await settle();
  btn(byId.app, "릴리스")!.fire("click");
  await settle();

  const strategy = tags(byId.app, "select").find((s) => s.children.some((o: any) => o.attrs.value === "semver-range"))!;
  const inputs = tags(byId.app, "input");
  return { byId, calls, strategy, inputs };
}

test("릴리스 생성 폼은 전략 3종을 모두 제공한다", async () => {
  const { strategy } = await openReleaseCreator();
  assert.deepEqual(
    strategy.children.map((o: any) => o.attrs.value),
    ["semver-range", "integer-range", "exact-label"],
    "코어가 구현한 전략은 전부 고를 수 있어야 한다",
  );
});

test("전략을 바꾸면 매칭 값 예시와 안내가 그 전략의 것으로 바뀐다", async () => {
  const { byId, strategy } = await openReleaseCreator();
  const valueInput = () => tags(byId.app, "input").find((i) => (i.attrs.placeholder ?? "").startsWith(">=") || i.attrs.placeholder === "web-stable")!;

  assert.equal(valueInput().attrs.placeholder, ">=3.2.0 <3.3.0");
  assert.match(byId.app!.textContent, /\^, ~, \|\| 불가/, "semver 안내가 먼저 보인다");

  strategy.value = "integer-range";
  strategy.fire("change");
  assert.equal(valueInput().attrs.placeholder, ">=4200 <4300", "정수 예시로 바뀐다");
  assert.match(byId.app!.textContent, /buildNumber를 넘겨야/, "앱이 뭘 넘겨야 하는지 알려준다");
  assert.doesNotMatch(byId.app!.textContent, /\^, ~, \|\| 불가/, "semver 안내는 사라진다");

  strategy.value = "exact-label";
  strategy.fire("change");
  assert.equal(valueInput().attrs.placeholder, "web-stable");
  assert.match(byId.app!.textContent, /releaseLabel과 완전히 같아야/);
});

test("integer-range를 골라 만들면 그 전략 그대로 POST된다", async () => {
  const table = projectTable();
  table["POST /projects/shop/releases"] = { id: "R2", state: "draft" };
  const { byId, calls, strategy } = await openReleaseCreator(table);

  const inputs = tags(byId.app, "input");
  const nameInput = inputs.find((i) => i.attrs.placeholder === "3.2.x")!;
  const valueInput = inputs.find((i) => i.attrs.placeholder === ">=3.2.0 <3.3.0")!;
  // 스텁 select는 존재하지 않는 값도 받아들이므로, 실제로 고를 수 있는 항목인지 먼저 확인한다.
  assert.ok(strategy.children.some((o: any) => o.attrs.value === "integer-range"),
    "드롭다운에 없는 전략은 사용자가 고를 수 없다");
  strategy.value = "integer-range";
  strategy.fire("change");
  nameInput.value = "빌드 4200대";
  valueInput.value = ">=4200 <4300";

  btn(byId.app, "릴리스 생성")!.fire("click");
  await settle();

  const post = calls.find((c) => c.method === "POST" && c.path === "/projects/shop/releases")!;
  assert.ok(post, "생성 요청이 나가야 한다");
  assert.deepEqual(post.body.versionMatch, { strategy: "integer-range", value: ">=4200 <4300" });
  assert.equal(post.body.name, "빌드 4200대");
});

// ── 사용자 관리(7.3) — admin 전용 패널 ────────────────────────────────────────

const USERS = {
  users: [
    {
      id: "alice", name: "Alice", role: "translator", projects: ["shop"], disabled: false,
      createdAt: "2026-08-19T00:00:00.000Z",
      tokens: [{ id: "tok-1111aaaa", label: "ci", createdAt: "2026-08-19T00:00:00.000Z" }],
    },
    {
      id: "root", name: "Root", role: "admin", projects: "*", disabled: false,
      createdAt: "2026-08-19T00:00:00.000Z", tokens: [],
    },
  ],
};

async function openUsersList(table = projectTable()) {
  const { byId, store } = installDom();
  store["rynl10n.token"] = "tok-admin";
  const calls = installFetch(table);
  await loadApp();
  return { byId, calls };
}

test("사용자 패널: 목록·역할·스코프·토큰 라벨을 그대로 반영한다", async () => {
  const table = projectTable();
  table["GET /users"] = USERS;
  const { byId } = await openUsersList(table);

  const text = byId.app!.textContent;
  assert.match(text, /alice/);
  assert.match(text, /Alice/);
  assert.match(text, /전체/, "projects '*' 는 사람 말('전체')로 보여준다");
  assert.match(text, /shop/, "스코프 프로젝트 id 노출");
  assert.match(text, /ci/, "토큰 라벨 노출");
  const rowSel = tags(byId.app, "select").find((s) => s.attrs["aria-label"] === "alice 역할")!;
  assert.equal(rowSel.value, "translator", "행의 역할 셀렉트는 현재 역할로 시작한다");
});

test("RBAC: admin이 아니면 사용자 패널이 없고 GET /users 도 부르지 않는다 (7.3 UI 미러)", async () => {
  const { byId, calls } = await openUsersList(
    projectTable({ actor: "mnt", role: "maintainer", projects: ["shop"], deliveryBaseUrl: "https://cdn.test" }),
  );
  assert.ok(!calls.some((c) => c.path === "/users"), "admin 전용 라우트는 아예 부르지 않는다(403 소음 방지)");
  assert.equal(btn(byId.app, "사용자 추가"), undefined, "생성 폼이 없어야 한다");
  assert.doesNotMatch(byId.app!.textContent, /사용자 관리|아직 사용자가 없습니다/);
});

test("생성 폼: 역할을 고르면 안내 문구가 그 역할의 것으로 바뀐다 (ROLE_HINTS)", async () => {
  const { byId } = await openUsersList();
  const roleSel = tags(byId.app, "select").find((s) => s.attrs["aria-label"] === "역할")!;

  assert.equal(roleSel.value, "viewer", "최소 권한이 기본값");
  assert.match(byId.app!.textContent, /읽기 전용/, "viewer 안내가 먼저 보인다");

  roleSel.value = "maintainer";
  roleSel.fire("change");
  assert.match(byId.app!.textContent, /릴리스 생성·publish·롤백/, "maintainer 안내로 바뀐다");

  roleSel.value = "admin";
  roleSel.fire("change");
  assert.match(byId.app!.textContent, /프로젝트·사용자 관리/, "admin 안내로 바뀐다");
});

test("생성은 id·이름·역할·프로젝트 스코프를 그대로 POST /users 로 보낸다", async () => {
  const table = projectTable();
  table["POST /users"] = { id: "bob", name: "Bob", role: "maintainer", projects: ["shop"], disabled: false, tokens: [] };
  const { byId, calls } = await openUsersList(table);

  const inputs = tags(byId.app, "input");
  inputs.find((i) => i.attrs.placeholder === "user-id")!.value = "bob";
  inputs.find((i) => i.attrs.placeholder === "사용자 이름")!.value = "Bob";
  const roleSel = tags(byId.app, "select").find((s) => s.attrs["aria-label"] === "역할")!;
  roleSel.value = "maintainer";
  roleSel.fire("change");

  // '모든 프로젝트'를 끄고 shop만 고른다.
  const allBox = inputs.find((i) => i.attrs["aria-label"] === "모든 프로젝트")! as any;
  assert.equal(allBox.checked, true, "전체 스코프가 기본값");
  allBox.checked = false;
  allBox.fire("change");
  const scopeBox = tags(byId.app, "select").find((s) => s.attrs["aria-label"] === "접근 가능한 프로젝트")! as any;
  assert.equal(scopeBox.disabled, false, "체크를 끄면 프로젝트 선택이 열린다");
  scopeBox.selectedOptions = [{ value: "shop" }];

  btn(byId.app, "사용자 추가")!.fire("click");
  await settle();

  const post = calls.find((c) => c.method === "POST" && c.path === "/users")!;
  assert.ok(post, "생성 요청이 나가야 한다");
  assert.deepEqual(post.body, { id: "bob", name: "Bob", role: "maintainer", projects: ["shop"] });
});

test("토큰 발급: 평문은 1회 노출 패널에만 보이고 닫으면 사라진다", async () => {
  const table = projectTable();
  table["GET /users"] = USERS;
  table["POST /users/alice/tokens"] = { id: "tok-9999", token: "rl10n_only-shown-once", label: "" };
  const { byId } = await openUsersList(table);

  btn(byId.app, "토큰 발급")!.fire("click"); // 첫 행 = alice
  await settle();

  assert.match(byId.app!.textContent, /지금만 볼 수 있습니다/);
  const box = tags(byId.app, "input").find((i) => i.value === "rl10n_only-shown-once")!;
  assert.ok(box, "평문은 복사할 수 있게 입력 상자로 보여준다");
  assert.equal(box.attrs.readonly, "", "편집은 잠근다");

  btn(byId.app, "닫기")!.fire("click");
  await settle();
  assert.doesNotMatch(byId.app!.textContent, /rl10n_only-shown-once/, "닫으면 평문은 다시 볼 수 없다");
});

test("마지막 admin 강등 409는 역할 셀렉트를 되돌리고 오류를 표면화한다", async () => {
  const table = projectTable();
  table["GET /users"] = USERS;
  table["PATCH /users/root"] = Object.assign(
    new Error("마지막 admin은 강등·비활성화할 수 없습니다"), { status: 409, code: "conflict" });
  const { byId } = await openUsersList(table);

  const rowSel = tags(byId.app, "select").find((s) => s.attrs["aria-label"] === "root 역할")!;
  rowSel.value = "viewer";
  rowSel.fire("change");
  await settle();

  assert.equal(rowSel.value, "admin", "409면 셀렉트를 원래 역할로 되돌린다");
});

// ── 백포트: 키 축 (POST /projects/{p}/translations/{key}/backport) ────────────
// 릴리스 축(releases/{r}/keys)은 이미 UI에 있었고 키 축은 관리 API에만 있었다. 둘 다 같은 참조
// 테이블을 건드리지만 출발점이 다르다 — 출시된 앱의 오타 한 건을 아직 살아 있는 릴리스들에
// 태우는 일(시나리오 A)은 키에서 시작한다. 검증의 축은 **부분 실패(207)가 화면에 드러나는가**다.

const TWO_RELEASES = {
  releases: [
    RELEASES.releases[0],
    {
      id: "R2", projectId: "shop", name: "2.x",
      versionMatch: { strategy: "semver-range", value: ">=2.0.0 <3.0.0" },
      state: "draft", base: null, overlay: null, rollout: 100, seq: 2,
      createdAt: "2026-08-24T00:00:00.000Z",
    },
  ],
};

/** admin으로 프로젝트를 연 뒤(번역 탭이 기본) 키 행의 백포트 패널을 연다. */
async function openBackportPanel(table = projectTable()) {
  table["GET /projects/shop/releases"] = TWO_RELEASES;
  const { byId, store } = installDom();
  store["rynl10n.token"] = "tok-admin";
  const calls = installFetch(table);
  await loadApp();
  btn(byId.app, "shop")!.fire("click");
  await settle();
  btn(byId.app, "백포트")!.fire("click");
  await settle();
  const box = tags(byId.app, "select").find((s) => s.children.some((o: any) => o.attrs.value === "R2"))!;
  return { byId, calls, table, box };
}

test("백포트 패널은 요청 없이 릴리스 목록을 상태와 함께 보여준다", async () => {
  const { byId, calls, box } = await openBackportPanel();

  assert.match(byId.app!.textContent, /cart\.title 백포트/);
  assert.deepEqual(box.children.map((o: any) => o.attrs.value), ["R1", "R2"]);
  assert.match(box.textContent, /R1 · published/, "어느 릴리스가 살아 있는지 상태로 구분한다");
  assert.match(box.textContent, /R2 · draft/);
  assert.match(byId.app!.textContent, /publish 할 때/, "지금 배포되는 게 아님을 알린다");
  assert.ok(!calls.some((c) => c.method === "POST"), "확인 전에는 아무것도 보내지 않는다");
});

test("확인하면 고른 릴리스들로 키 축 백포트를 호출한다", async () => {
  const table = projectTable();
  table["POST /projects/shop/translations/cart.title/backport"] = { applied: ["R1", "R2"], failed: [] };
  const { byId, calls, box } = await openBackportPanel(table);

  box.selectedOptions = [{ value: "R1" }, { value: "R2" }];
  btn(byId.app, "확인")!.fire("click");
  await settle();

  const post = calls.find((c) => c.method === "POST" && c.path === "/projects/shop/translations/cart.title/backport")!;
  assert.ok(post, "키 축 라우트로 나가야 한다 — 릴리스 축으로 여러 번 나누면 안 된다");
  assert.deepEqual(post.body, { releaseIds: ["R1", "R2"] });
  assert.equal(post.auth, "Bearer tok-admin");

  const toasts = (globalThis as any).document.getElementById("toasts").textContent;
  assert.match(toasts, /cart\.title 백포트 완료/);
  assert.match(toasts, /릴리스 2개/);
  assert.ok(calls.slice(calls.indexOf(post)).some((c) => c.path === "/projects/shop/keys"),
    "참조 수(refCount)가 달라지므로 키를 다시 읽는다");
});

test("207 부분 성공은 실패한 릴리스를 이름까지 표면화한다", async () => {
  const table = projectTable();
  // 207 — 목록을 받은 뒤 R2가 사라진 상황(서버는 status 207 + applied/failed로 나눠 준다).
  table["POST /projects/shop/translations/cart.title/backport"] = { applied: ["R1"], failed: ["R2"] };
  const { byId, box } = await openBackportPanel(table);

  box.selectedOptions = [{ value: "R1" }, { value: "R2" }];
  btn(byId.app, "확인")!.fire("click");
  await settle();

  const toasts = (globalThis as any).document.getElementById("toasts").textContent;
  assert.match(toasts, /일부만 반영됐습니다 \(1\/2\)/, "성공 개수와 요청 개수를 같이 보여준다");
  assert.match(toasts, /실패: R2/, "어느 릴리스가 빠졌는지 알아야 다시 넣을 수 있다");
  assert.doesNotMatch(toasts, /백포트 완료/, "부분 실패를 성공으로 읽히게 두면 안 된다");
});

test("대상을 고르지 않고 확인하면 요청을 보내지 않는다", async () => {
  const { byId, calls } = await openBackportPanel();
  btn(byId.app, "확인")!.fire("click");
  await settle();
  assert.ok(!calls.some((c) => c.method === "POST"));
  assert.match((globalThis as any).document.getElementById("toasts").textContent, /하나 이상 고르세요/);
});

test("RBAC: manage_release가 없으면 백포트 진입점 자체가 없다 (7.3 UI 미러)", async () => {
  for (const role of ["viewer", "translator"]) {
    const { byId, store } = installDom();
    store["rynl10n.token"] = `tok-${role}`;
    installFetch(projectTable({ actor: role, role, projects: ["shop"], deliveryBaseUrl: "https://cdn.test" }));
    await loadApp();
    btn(byId.app, "shop")!.fire("click");
    await settle();

    assert.match(byId.app!.textContent, /cart\.title/, `${role}도 키 자체는 본다`);
    assert.ok(!btn(byId.app, "백포트"), `${role}에게 백포트 버튼은 없어야 한다`);
  }
});

// ── 릴리스 카탈로그·스냅샷 읽기 (GET releases/{r}/keys · /snapshot) ───────────
// 배포 탭은 **게시된 산출물**을 보여준다. 여기서 보는 것은 DB에서 지금 다시 빌드한 카탈로그라,
// publish 전 draft와 "다음 publish에 무엇이 바뀌는지"는 이 화면에서만 확인할 수 있다.

const SNAPSHOT = {
  schemaVersion: 1, release: "R1", defaultLocale: "en",
  locales: { en: { "cart.title": "Cart" }, ko: { "cart.title": "장바구니" } },
};
const RELEASE_CHANGES = {
  releaseId: "R1",
  baseline: { releaseId: "R1", hash: "cccc3333dddd4444", entries: 3 },
  target: { releaseId: "R1", hash: "eeee5555ffff6666", entries: 3 },
  summary: { added: 1, changed: 1, deleted: 1, total: 3 },
  changes: [
    { type: "added", key: "cart.empty", locale: "en", after: "Your cart is empty" },
    { type: "changed", key: "cart.title", locale: "ko", before: "카트", after: "장바구니" },
    { type: "deleted", key: "checkout.old", locale: "en", before: "Old checkout" },
  ],
};

function catalogTable(me: Me = ME_ADMIN) {
  const table = projectTable(me);
  table["GET /projects/shop/releases/R1/keys"] = { keys: ["cart.title", "cart.empty"] };
  table["GET /projects/shop/releases/R1/snapshot"] = SNAPSHOT;
  table["GET /projects/shop/releases/R1/changes"] = RELEASE_CHANGES;
  return table;
}

/** 릴리스 탭까지 이동해 카탈로그 패널을 연다. */
async function openCatalog(table = catalogTable()) {
  const { byId, store } = installDom();
  store["rynl10n.token"] = "tok-admin";
  const calls = installFetch(table);
  await loadApp();
  btn(byId.app, "shop")!.fire("click");
  await settle();
  btn(byId.app, "릴리스")!.fire("click");
  await settle();
  btn(byId.app, "변경사항")!.fire("click");
  await settle();
  return { byId, calls };
}

test("출시 전 변경사항은 마지막 게시본과 현재 카탈로그를 한 번에 보여준다", async () => {
  const { byId, calls } = await openCatalog();

  assert.ok(calls.some((c) => c.path === "/projects/shop/releases/R1/keys"));
  assert.ok(calls.some((c) => c.path === "/projects/shop/releases/R1/snapshot"));
  assert.ok(calls.some((c) => c.path === "/projects/shop/releases/R1/changes"));

  assert.match(byId.app!.textContent, /R1 변경사항/);
  assert.match(byId.app!.textContent, /추가1수정1삭제1전체 변경3/);
  assert.match(byId.app!.textContent, /cccc3333dddd4444→R1 · eeee5555ffff6666/, "비교 기준과 게시 후 해시가 이어져야 한다");
  assert.match(byId.app!.textContent, /카트→장바구니/, "이전 값과 게시 후 값을 같은 행에서 읽을 수 있어야 한다");
  assert.match(byId.app!.textContent, /Old checkout/, "삭제되는 값도 게시 전에 확인할 수 있어야 한다");
  assert.match(byId.app!.textContent, /cart\.empty/, "카탈로그의 키는 번역 그리드와 별개로 릴리스 소속을 보여준다");
  assert.match(byId.app!.textContent, /키 2개 · 로케일 2개 · 기본 en/);
  assert.match(byId.app!.textContent, /게시된 base aaaa1111bbbb2222/, "게시본과 지금 카탈로그를 나란히 볼 수 있어야 한다");

  const pre = tags(byId.app, "pre").find((n) => n.className === "json")!;
  assert.ok(pre, "스냅샷은 JSON 그대로 보여준다 — 빌드 플러그인이 받는 것과 같은 바이트다");
  assert.match(pre.textContent, /"schemaVersion": 1/);
  assert.match(pre.textContent, /장바구니/);
});

test("변경 유형과 키·로케일로 출시 전 목록을 좁힐 수 있다", async () => {
  const { byId } = await openCatalog();
  const filter = tags(byId.app, "select").find((n) => n.attrs["aria-label"] === "변경 유형 필터")!;
  const search = tags(byId.app, "input").find((n) => n.attrs["aria-label"] === "변경사항 검색")!;

  filter.value = "deleted";
  filter.fire("change");
  let rows = tags(byId.app, "tr").filter((n) => n.className.startsWith("diff-row"));
  assert.deepEqual(rows.map((n) => n.textContent), ["− 삭제checkout.oldenOld checkout→—"]);

  filter.value = "";
  filter.fire("change");
  search.value = "CART.TITLE";
  search.fire("input");
  rows = tags(byId.app, "tr").filter((n) => n.className.startsWith("diff-row"));
  assert.deepEqual(rows.map((n) => n.textContent), ["↗ 수정cart.titleko카트→장바구니"]);
});

test("닫으면 릴리스 탭으로 돌아가고 다시 읽지 않는다", async () => {
  const { byId, calls } = await openCatalog();
  const before = calls.length;

  btn(byId.app, "닫기")!.fire("click");
  await settle();

  assert.match(byId.app!.textContent, /새 릴리스/, "릴리스 탭 화면으로 돌아온다");
  assert.equal(calls.length, before, "이미 가진 상태로 되돌아갈 뿐 서버를 다시 부르지 않는다");
});

test("빈 카탈로그는 publish 하면 무엇이 나가는지 알려준다", async () => {
  const table = catalogTable();
  table["GET /projects/shop/releases/R1/keys"] = { keys: [] };
  table["GET /projects/shop/releases/R1/snapshot"] = { ...SNAPSHOT, locales: {} };
  const { byId } = await openCatalog(table);

  assert.match(byId.app!.textContent, /빈 카탈로그가 나갑니다/);
});

test("카탈로그 읽기는 viewer에게도 열려 있다 (read 권한 축)", async () => {
  const table = catalogTable({ actor: "vw", role: "viewer", projects: ["shop"], deliveryBaseUrl: "https://cdn.test" });
  const { byId, store } = installDom();
  store["rynl10n.token"] = "tok-view";
  installFetch(table);
  await loadApp();
  btn(byId.app, "shop")!.fire("click");
  await settle();
  btn(byId.app, "릴리스")!.fire("click");
  await settle();

  assert.ok(btn(byId.app, "변경사항"), "쓰기 게이트 앞에 있어야 viewer도 닿는다");
  assert.match(byId.app!.textContent, /읽기 전용/, "쓰기 작업이 없다는 표시는 그대로 남는다");

  btn(byId.app, "변경사항")!.fire("click");
  await settle();
  assert.match(byId.app!.textContent, /R1 변경사항/);
  assert.equal(btn(byId.app, "이 변경사항 게시"), undefined, "viewer에게 게시 동작은 열지 않는다");
});

/**
 * MCP 안내 화면은 **조작하는 자리가 아니라 알려주는 자리**다. 검증 축은 셋:
 *  ① 도구 목록이 서버가 준 것인가(하드코딩하면 서버와 조용히 어긋난다)
 *  ② 대시보드가 `POST /mcp`를 부르지 않는가 — 브라우저라서 Origin 가드에 걸린다
 *  ③ MCP가 꺼진 배포에서는 메뉴가 아예 없는가(죽은 메뉴를 그리지 않는다)
 */
test("MCP 화면: 도구 목록은 서버가 준 것이고, 엔드포인트·설정 스니펫을 보여준다", async () => {
  const { byId, store } = installDom();
  store["rynl10n.token"] = "t";
  const calls = installFetch(projectTable());
  await loadApp();

  tags(byId.app, "button").find((b) => b.textContent === "MCP")!.fire("click");
  await settle();

  const text = byId.app!.textContent;
  assert.match(text, /https:\/\/l10n\.test\/mcp/, "엔드포인트가 보여야 한다");
  assert.match(text, /validate_translation/);
  assert.match(text, /resolve_preview/);
  assert.match(text, /"type": "http"/, "붙이는 설정 스니펫이 있어야 한다");
  assert.ok(calls.some((c) => c.method === "GET" && c.path === "/mcp/tools"), "목록은 서버에서 받아온다");
  assert.ok(!calls.some((c) => c.path === "/mcp"), "대시보드는 MCP 전송 엔드포인트를 직접 부르지 않는다");
});

test("MCP 화면: 허용 Origin이 비어 있으면 그것이 안전 기본값임을 설명한다", async () => {
  const { byId, store } = installDom();
  store["rynl10n.token"] = "t";
  installFetch(projectTable());
  await loadApp();
  tags(byId.app, "button").find((b) => b.textContent === "MCP")!.fire("click");
  await settle();

  assert.match(byId.app!.textContent, /안전 기본값/);
  assert.match(byId.app!.textContent, /RYNL10N_MCP_ALLOWED_ORIGINS/, "바꾸는 방법을 알려줘야 한다");
});

/**
 * MCP 화면의 토큰 발급(7.3). 이 화면에 두는 이유는 여기가 그 토큰을 **쓰는** 자리여서다.
 * 검증 축은 넷:
 *  ① 폼 값이 그대로 하나뿐인 발급 라우트로 가는가(여기서 규칙을 다시 만들지 않는다)
 *  ② 기본 표면이 최소 권한('mcp')인가
 *  ③ 평문이 붙여넣을 설정 스니펫에 들어가는가 — 손으로 옮기는 단계가 사라져야 값이 덜 떠돈다
 *  ④ admin이 아니면 폼도, 그 폼이 필요로 하는 GET /users 도 없는가
 */
const MCP_USERS = {
  users: [
    {
      id: "ci-bot", name: "CI", role: "viewer", projects: ["shop"], disabled: false,
      createdAt: "2026-09-01T00:00:00.000Z",
      tokens: [
        { id: "tok-mcp-0001", label: "agent", surface: "mcp", maxRole: "viewer", createdAt: "2026-09-01T00:00:00.000Z" },
        { id: "tok-all-0002", label: "build", surface: "all", maxRole: null, createdAt: "2026-09-01T00:00:00.000Z" },
      ],
    },
    { id: "old", name: "Old", role: "viewer", projects: "*", disabled: true, createdAt: "2026-09-01T00:00:00.000Z", tokens: [] },
  ],
};

async function openMcpScreen(table = projectTable()) {
  const { byId, store } = installDom();
  store["rynl10n.token"] = "t";
  const calls = installFetch(table);
  await loadApp();
  btn(byId.app, "MCP")!.fire("click");
  await settle();
  return { byId, calls };
}

test("MCP 화면: 발급 폼의 값이 그대로 POST 되고 평문이 설정 스니펫에 들어간다", async () => {
  const table = projectTable();
  table["GET /users"] = MCP_USERS;
  table["POST /users/ci-bot/tokens"] =
    { id: "tok-9999", token: "rl10n_mcp-only-once", label: "github-actions", surface: "mcp", maxRole: "viewer" };
  const { byId, calls } = await openMcpScreen(table);

  const sel = (label: string) => tags(byId.app, "select").find((x) => x.attrs["aria-label"] === label)!;
  assert.equal(sel("토큰 표면").value, "mcp", "이 화면의 기본 표면은 최소 권한이다");
  assert.equal(sel("토큰을 발급할 사용자").value, "ci-bot", "첫 활성 사용자가 기본값");
  assert.equal(tags(sel("토큰을 발급할 사용자"), "option").length, 1,
    "비활성 사용자는 고를 수 없다 — 인증에서 막히는 토큰을 만들지 않는다");

  tags(byId.app, "input").find((i) => i.attrs.placeholder === "github-actions")!.value = "github-actions";
  sel("역할 상한").value = "viewer";
  btn(byId.app, "발급")!.fire("click");
  await settle();

  const post = calls.find((c) => c.method === "POST" && c.path === "/users/ci-bot/tokens")!;
  assert.ok(post, "발급 요청이 나가야 한다");
  assert.deepEqual(post.body, { label: "github-actions", surface: "mcp", maxRole: "viewer" });

  const text = byId.app!.textContent;
  assert.match(text, /지금만 볼 수 있습니다/, "평문은 1회 노출임을 말한다");
  assert.match(text, /Bearer rl10n_mcp-only-once/, "붙이는 설정 스니펫에 그대로 들어간다");
  assert.ok(calls.some((c) => c.method === "GET" && c.path === "/users" && calls.indexOf(c) > calls.indexOf(post)),
    "발급 뒤 목록을 다시 읽어야 새 토큰을 폐기할 수 있다");
});

test("MCP 화면: 표면을 '전체 API'로 바꾸면 CI 빌드 플러그인 쪽 안내로 바뀐다", async () => {
  const table = projectTable();
  table["GET /users"] = MCP_USERS;
  const { byId } = await openMcpScreen(table);

  assert.match(byId.app!.textContent, /POST \/mcp 로만 붙습니다/, "MCP 전용 안내가 먼저 보인다");
  const surfaceSel = tags(byId.app, "select").find((x) => x.attrs["aria-label"] === "토큰 표면")!;
  surfaceSel.value = "all";
  surfaceSel.fire("change");
  assert.match(byId.app!.textContent, /CI 빌드 플러그인/, "전체 API가 필요한 이유를 말해 준다");
});

test("MCP 화면: 발급된 MCP 전용 토큰만 목록에 두고 그 자리에서 폐기한다", async () => {
  const table = projectTable();
  table["GET /users"] = MCP_USERS;
  table["DELETE /users/ci-bot/tokens/tok-mcp-0001"] = { id: "tok-mcp-0001", revoked: true };
  const { byId, calls } = await openMcpScreen(table);

  const text = byId.app!.textContent;
  assert.match(text, /agent/, "MCP 전용 토큰은 보인다");
  assert.doesNotMatch(text, /build/, "전체 API 토큰은 이 화면의 축이 아니다");
  assert.match(text, /≤ viewer/, "역할 상한을 배지로 드러낸다");

  btn(byId.app, "폐기")!.fire("click");
  await settle();
  assert.ok(calls.some((c) => c.method === "DELETE" && c.path === "/users/ci-bot/tokens/tok-mcp-0001"),
    "평문을 잃었을 때 할 수 있는 일은 폐기 → 재발급뿐이라 이 화면에서 끝나야 한다");
});

test("MCP 화면: 발급 뒤에도 고른 사용자·표면은 남고 라벨만 비워진다", async () => {
  const table = projectTable();
  table["GET /users"] = MCP_USERS;
  table["POST /users/ci-bot/tokens"] =
    { id: "tok-1", token: "rl10n_first", label: "one", surface: "all", maxRole: null };
  const { byId } = await openMcpScreen(table);

  const sel = (label: string) => tags(byId.app, "select").find((x) => x.attrs["aria-label"] === label)!;
  sel("토큰 표면").value = "all";
  sel("토큰 표면").fire("change");
  tags(byId.app, "input").find((i) => i.attrs.placeholder === "github-actions")!.value = "one";
  btn(byId.app, "발급")!.fire("click");
  await settle();

  // 발급하면 목록에 새 토큰이 실려야 해서 화면을 다시 그린다 — 그 재렌더가 선택을 먹으면
  // 연달아 발급할 때 엉뚱한 사용자에게 토큰이 붙는다.
  assert.equal(sel("토큰을 발급할 사용자").value, "ci-bot", "고른 사용자가 남는다");
  assert.equal(sel("토큰 표면").value, "all", "고른 표면도 남는다");
  assert.match(byId.app!.textContent, /CI 빌드 플러그인/, "안내도 그 표면의 것으로 남는다");
  assert.equal(tags(byId.app, "input").find((i) => i.attrs.placeholder === "github-actions")!.value, "",
    "라벨만은 비운다 — 직전 토큰의 이름이 다음 토큰에 붙으면 안 된다");
});

test("MCP 화면은 상단바 제목도 MCP다 (인스턴스 화면이 둘이라는 사실이 제목에서도 보여야 한다)", async () => {
  const { byId } = await openMcpScreen();
  const titles = walk(byId.app!).find((x: any) => x.className === "titles")!;
  assert.match(titles.textContent, /MCP/);
  assert.doesNotMatch(titles.textContent, /토큰 스코프에 포함된 프로젝트/, "목록 화면의 부제가 남으면 안 된다");
});

test("MCP 화면: admin이 아니면 발급 폼도 GET /users 도 없다", async () => {
  const me = { ...ME_ADMIN, actor: "m", role: "maintainer" };
  const { byId, calls } = await openMcpScreen({ ...projectTable(me), "GET /me": me });

  assert.equal(btn(byId.app, "발급"), undefined, "쓰기 표면을 열지 않는다");
  assert.ok(!calls.some((c) => c.path === "/users"), "admin 전용 라우트를 부르지 않는다(403 소음 방지)");
  assert.match(byId.app!.textContent, /프로젝트 목록 → 사용자 관리/, "발급 자리는 여전히 알려준다");
});

test("MCP가 꺼진 배포에서는 메뉴가 없다", async () => {
  const { byId, store } = installDom();
  store["rynl10n.token"] = "t";
  const me = { ...ME_ADMIN, mcp: { enabled: false, allowedOrigins: [] } };
  installFetch({ ...projectTable(me), "GET /me": me });
  await loadApp();

  assert.ok(!tags(byId.app, "button").some((b) => b.textContent === "MCP"), "죽은 메뉴를 그리면 안 된다");
});
