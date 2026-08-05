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
    createTextNode: (s: string) => Object.assign(new StubNode("#text"), { own: String(s) }),
    getElementById: (id: string) => byId[id],
    querySelector: (_sel: string) => byId.app!.children.find((c: any) => c.tag === "main"),
    body: new StubNode("body"),
  };
  const store: Record<string, string> = {};
  g.localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  };
  g.location = { protocol: "http:", hostname: "localhost" };
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

const ME_ADMIN = { actor: "admin", role: "admin", projects: "*", deliveryBaseUrl: "https://cdn.test" };
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

interface Me { actor: string; role: string; projects: string | string[]; deliveryBaseUrl: string }

function projectTable(me: Me = ME_ADMIN) {
  return {
    "GET /me": me,
    "GET /projects": PROJECTS,
    "GET /projects/shop": PROJECT,
    "GET /projects/shop/keys": KEYS,
    "GET /projects/shop/releases": RELEASES,
    "GET /projects/shop/manifest": { schemaVersion: 1, project: "shop", releases: [] },
    "GET /projects/shop/manifests": { history: [] },
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

  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["GET /me", "GET /projects"]);
  assert.equal(calls[0]!.auth, "Bearer tok-admin", "Bearer 헤더로 토큰을 보내야 한다");
  assert.equal(store["rynl10n.token"], "tok-admin", "검증에 성공해야만 토큰을 저장한다");
  assert.match(byId.app!.textContent, /Shop/);
  assert.match(byId.app!.textContent, /admin · admin/, "헤더에 액터·역할 표시");
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

  tags(byId.app, "button").find((b) => b.textContent === "← 프로젝트 목록")!.fire("click");
  await settle();
  tags(byId.app, "button").find((b) => b.textContent === "shop")!.fire("click");
  await settle();

  assert.equal(searchBox(byId.app).value, "", "다른 프로젝트는 키·로케일이 달라 필터를 물고 가면 안 된다");
  assert.equal(shownKeys(byId.app).length, 4);
});
