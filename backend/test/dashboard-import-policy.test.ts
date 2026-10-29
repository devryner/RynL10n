import { test } from "node:test";
import assert from "node:assert/strict";

class DomNode {
  tag: string;
  children: any[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, ((event?: any) => void)[]> = {};
  className = "";
  value = "";
  disabled = false;
  checked = false;
  files: { name: string; text: () => Promise<string> }[] = [];
  selectedOptions: any[] = [];
  own = "";
  constructor(tag: string) { this.tag = tag; }
  setAttribute(key: string, value: string) {
    this.attrs[key] = value;
    if (key === "value") this.value = value;
    if (key === "disabled") this.disabled = true;
  }
  getAttribute(key: string) { return this.attrs[key]; }
  addEventListener(type: string, listener: (event?: any) => void) { (this.listeners[type] ??= []).push(listener); }
  append(...nodes: any[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: any[]) { this.children = nodes; }
  remove() { }
  focus() { }
  scrollIntoView() { }
  blur() { this.fire("blur"); }
  get childNodes() { return this.children; }
  set textContent(text: string) { this.own = String(text); this.children = []; }
  get textContent(): string { return this.own + this.children.map((node) => node.textContent ?? "").join(""); }
  fire(type: string, event?: any) { for (const listener of this.listeners[type] ?? []) listener(event); }
}
function walk(node: any): any[] { return [node, ...(node.children ?? []).flatMap(walk)]; }
const tag = (root: DomNode, name: string): DomNode[] => walk(root).filter((node) => node.tag === name);
const button = (root: DomNode, text: string) => tag(root, "button").find((node) => node.textContent === text);
const labelled = (root: DomNode, name: string) => walk(root).find((node) => node.attrs["aria-label"] === name) as DomNode;
async function settle() { for (let i = 0; i < 14; i++) await new Promise((resolve) => setImmediate(resolve)); }

function responseTable(role = "admin") {
  const project = { id: "shop", name: "Shop", defaultLocale: "en", locales: ["en", "ko"], publishPolicy: { requireReviewed: false, requireDefaultLocale: false } };
  return {
    "GET /me": { actor: "test", role, projects: "*", mcp: { enabled: false }, deliveryBaseUrl: "https://cdn.test" },
    "GET /projects": { projects: [project] },
    "GET /users": { users: [] },
    "GET /projects/shop": project,
    "GET /projects/shop/keys": { keys: [{ name: "hello", signature: "", isPlural: false, refCount: 1, description: "", translations: { en: { value: "Hello", state: "reviewed" } } }] },
    "GET /projects/shop/releases": { releases: [{ id: "R1", name: "First", versionMatch: { strategy: "exact-label", value: "stable" }, state: "published", base: "base", overlay: "base", rollout: 100 }] },
    "GET /projects/shop/telemetry": { telemetry: [] },
    "GET /projects/shop/manifest": { releases: [] },
    "GET /projects/shop/manifests": { history: [] },
    "GET /projects/shop/releases/R1/keys": { keys: ["hello"] },
    "GET /projects/shop/releases/R1/snapshot": { schemaVersion: 1, release: "R1", base: "base", defaultLocale: "en", locales: { en: { hello: "Hello" } } },
    "POST /projects/shop/translations/import": { createdKeys: 0, updatedKeys: 1, translations: 1 },
    "PATCH /projects/shop": project,
    "PUT /projects/shop/translations/hello/en": { value: "Edited", state: "draft" },
  } as Record<string, any>;
}
const previewResult = () => ({
  createdKeys: 0, updatedKeys: 1, translations: 1, locales: ["ko"], revision: "revision-1", warnings: [], metadataChanges: [],
  changes: [{ key: "hello", locale: "ko", type: "changed", before: "이전", after: "새 문구", beforeState: "reviewed", afterState: "draft" }],
  conflicts: [{ key: "hello", locale: "ko", before: "이전", after: "새 문구" }],
});
const releaseDiff = (ok = false) => ({
  releaseId: "R1", baseline: null, target: { hash: "new", entries: 1 }, summary: { added: 1, changed: 0, deleted: 0, total: 1 },
  changes: [{ type: "added", key: "hello", locale: "en", after: "Hello" }],
  publishCheck: { ok, policy: { requireReviewed: true, requireDefaultLocale: false }, issues: ok ? [] : [{ code: "unreviewed_translation", key: "hello", locale: "en" }] },
});

let scenario = 0;
async function open(table = responseTable()) {
  const app = new DomNode("div"), toasts = new DomNode("div");
  const store = new Map([["rynl10n.token", "token"]]);
  const globals = globalThis as any;
  globals.Node = DomNode;
  globals.document = {
    createElement: (name: string) => new DomNode(name), createElementNS: (_: string, name: string) => new DomNode(name),
    createTextNode: (text: string) => Object.assign(new DomNode("#text"), { own: text }),
    getElementById: (id: string) => id === "app" ? app : toasts,
    querySelector: () => tag(app, "main")[0], body: new DomNode("body"),
  };
  globals.localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) };
  globals.location = { protocol: "https:", hostname: "test", host: "test", origin: "https://test" };
  globals.EventSource = class { addEventListener() { } close() { } };
  const calls: { method: string; path: string; body: any }[] = [];
  globals.fetch = async (path: string, init: any = {}) => {
    const call = { method: init.method ?? "GET", path, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    let result = table[`${call.method} ${path}`];
    if (typeof result === "function") result = result(call);
    if (result === undefined) result = Object.assign(new Error(path), { status: 404, code: "not_found" });
    return result instanceof Error
      ? { ok: false, status: (result as any).status ?? 500, text: async () => JSON.stringify({ error: { code: (result as any).code, message: result.message } }) }
      : { ok: true, status: 200, text: async () => JSON.stringify(result) };
  };
  await import(`../src/ui/app.js?import-policy=${++scenario}`);
  await settle();
  button(app, "shop")!.fire("click"); await settle();
  return { app, toasts, calls, table };
}
async function chooseFile(app: DomNode, format = "arb", name = "ko.arb", content = '{"@@locale":"ko","hello":"새 문구"}') {
  const selector = labelled(app, "가져오기 형식");
  selector.value = format; selector.fire("change");
  const picker = labelled(app, "번역 파일");
  picker.files = [{ name, text: async () => content }]; picker.fire("change"); await settle();
}

test("파일 선택·취소는 요청하지 않고 명시적 미리보기 뒤에만 반영할 수 있다", async () => {
  const table = responseTable();
  table["POST /projects/shop/translations/import/preview"] = { ...previewResult(), conflicts: [] };
  const { app, calls } = await open(table);
  await chooseFile(app);
  assert.equal(calls.filter((call) => call.method === "POST").length, 0);
  assert.equal(button(app, "가져오기"), undefined);
  button(app, "미리보기")!.fire("click"); await settle();
  assert.match(app.textContent, /이전/);
  assert.match(app.textContent, /새 문구/);
  assert.match(app.textContent, /reviewed → draft/);
  const preview = calls.find((call) => call.path.endsWith("/import/preview"))!;
  assert.deepEqual(preview.body, { format: "arb", files: [{ name: "ko.arb", content: '{"@@locale":"ko","hello":"새 문구"}' }] });
  button(app, "가져오기")!.fire("click"); await settle();
  const applied = calls.find((call) => call.path.endsWith("/translations/import"))!;
  assert.equal(applied.body.revision, "revision-1");
  assert.equal(applied.body.overwrite, false);
  assert.equal(applied.body.format, "arb");
  await chooseFile(app);
  const before = calls.length;
  button(app, "취소")!.fire("click"); await settle();
  assert.equal(calls.length, before);
  assert.equal(button(app, "가져오기"), undefined);
});

test("값 충돌은 덮어쓰기 확인 전까지 반영하지 않고 409 뒤에는 새 미리보기를 요구한다", async () => {
  const table = responseTable();
  table["POST /projects/shop/translations/import/preview"] = previewResult();
  table["POST /projects/shop/translations/import"] = Object.assign(new Error("다른 사용자가 번역을 수정했습니다"), { status: 409, code: "stale_import" });
  const { app, calls, toasts } = await open(table);
  await chooseFile(app);
  button(app, "미리보기")!.fire("click"); await settle();
  assert.equal(button(app, "가져오기")!.disabled, true);
  button(app, "가져오기")!.fire("click"); await settle();
  assert.ok(!calls.some((call) => call.path.endsWith("/translations/import")));
  const acknowledge = labelled(app, "기존 번역 덮어쓰기 확인");
  acknowledge.checked = true; acknowledge.fire("change");
  button(app, "가져오기")!.fire("click"); await settle();
  assert.equal(calls.find((call) => call.path.endsWith("/translations/import"))!.body.overwrite, true);
  assert.match(toasts.textContent, /다시 미리보기 하세요/);
  assert.equal(button(app, "가져오기"), undefined);
  assert.ok(button(app, "미리보기"));
  table["POST /projects/shop/translations/import/preview"] = { ...previewResult(), revision: "revision-2" };
  button(app, "미리보기")!.fire("click"); await settle();
  assert.equal(labelled(app, "기존 번역 덮어쓰기 확인").checked, false);
});

test("기존 키 설명의 변경도 이전·이후를 보여 주고 덮어쓰기 확인을 받는다", async () => {
  const table = responseTable();
  table["POST /projects/shop/translations/import/preview"] = { ...previewResult(), conflicts: [], metadataChanges: [{ key: "hello", beforeDescription: "이전 설명", afterDescription: "새 설명" }] };
  const { app } = await open(table);
  await chooseFile(app);
  button(app, "미리보기")!.fire("click"); await settle();
  assert.match(app.textContent, /이전 설명 → 새 설명/);
  assert.equal(button(app, "가져오기")!.disabled, true);
  assert.match(app.textContent, /키 설명 1건/);
});

test("Android 파일은 파일별 로케일을 정해야 미리보기를 요청한다", async () => {
  const table = responseTable();
  table["POST /projects/shop/translations/import/preview"] = { ...previewResult(), conflicts: [] };
  const { app, calls } = await open(table);
  await chooseFile(app, "android-xml", "strings.xml", '<resources><string name="hello">안녕</string></resources>');
  assert.equal(button(app, "미리보기")!.disabled, true);
  const locale = labelled(app, "strings.xml 로케일 1");
  locale.value = "ko"; locale.fire("change");
  assert.equal(button(app, "미리보기")!.disabled, false);
  button(app, "미리보기")!.fire("click"); await settle();
  assert.equal(calls.find((call) => call.path.endsWith("/import/preview"))!.body.files[0].locale, "ko");
});

test("같은 이름의 언어별 파일을 함께 선택해 각 로케일로 미리본다", async () => {
  const table = responseTable();
  table["POST /projects/shop/translations/import/preview"] = { ...previewResult(), conflicts: [] };
  const { app, calls } = await open(table);
  const format = labelled(app, "가져오기 형식");
  format.value = "android-xml"; format.fire("change");
  const picker = labelled(app, "번역 파일");
  picker.files = [
    { name: "strings.xml", text: async () => '<resources><string name="hello">Hello</string></resources>' },
    { name: "strings.xml", text: async () => '<resources><string name="hello">안녕</string></resources>' },
  ];
  picker.fire("change"); await settle();
  for (const [index, locale] of ["en", "ko"].entries()) {
    const selector = labelled(app, `strings.xml 로케일 ${index + 1}`);
    selector.value = locale; selector.fire("change");
  }
  button(app, "미리보기")!.fire("click"); await settle();
  const files = calls.find((call) => call.path.endsWith("/import/preview"))!.body.files;
  assert.deepEqual(files.map((file: any) => [file.name, file.locale]), [["strings.xml", "en"], ["strings.xml", "ko"]]);
  assert.match(files[0].content, /Hello/);
  assert.match(files[1].content, /안녕/);
});

test("미리보기 뒤 로케일이나 형식을 바꾸면 이전 승인과 반영 단추를 버린다", async () => {
  const table = responseTable();
  table["POST /projects/shop/translations/import/preview"] = previewResult();
  const { app } = await open(table);
  await chooseFile(app);
  button(app, "미리보기")!.fire("click"); await settle();
  const acknowledge = labelled(app, "기존 번역 덮어쓰기 확인");
  acknowledge.checked = true; acknowledge.fire("change");
  const locale = labelled(app, "ko.arb 로케일 1");
  locale.value = "en"; locale.fire("change");
  assert.equal(button(app, "가져오기"), undefined);
  button(app, "미리보기")!.fire("click"); await settle();
  assert.equal(labelled(app, "기존 번역 덮어쓰기 확인").checked, false);
  const format = labelled(app, "가져오기 형식");
  format.value = "i18next"; format.fire("change");
  assert.equal(button(app, "가져오기"), undefined);
  assert.ok(button(app, "미리보기"));
});

test("xcstrings는 파일의 언어 구성을 따르고 이전 형식의 로케일 선택도 보내지 않는다", async () => {
  const table = responseTable();
  table["POST /projects/shop/translations/import/preview"] = previewResult();
  const { app, calls } = await open(table);
  const content = '{"sourceLanguage":"en","strings":{"Hello":{"localizations":{"ko":{"stringUnit":{"state":"translated","value":"안녕"}}}}},"version":"1.0"}';
  await chooseFile(app, "android-xml", "Localizable.xcstrings", content);
  const locale = labelled(app, "Localizable.xcstrings 로케일 1");
  locale.value = "ko"; locale.fire("change");
  const format = labelled(app, "가져오기 형식");
  format.value = "xcstrings"; format.fire("change");
  assert.equal(labelled(app, "Localizable.xcstrings 로케일 1"), undefined);
  button(app, "미리보기")!.fire("click"); await settle();
  const source = calls.find((call) => call.path.endsWith("/import/preview"))!.body;
  assert.deepEqual(source, { format: "xcstrings", files: [{ name: "Localizable.xcstrings", content }] });
});

test("대량 변환 안내는 20건씩 표시하고 마지막 안내까지 읽을 수 있다", async () => {
  const table = responseTable();
  table["POST /projects/shop/translations/import/preview"] = {
    ...previewResult(), warnings: Array.from({ length: 45 }, (_, index) => ({ file: "ko.arb", key: `entry-${index}`, message: `안내-${index}` })),
  };
  const { app } = await open(table);
  await chooseFile(app);
  button(app, "미리보기")!.fire("click"); await settle();
  const warningText = () => tag(app, "p").filter((node) => node.className === "small import-warning").map((node) => node.textContent);
  assert.match(app.textContent, /변환 안내 45건/);
  assert.equal(warningText().length, 20);
  assert.ok(warningText()[0]!.includes("안내-0"));
  button(app, "다음 안내")!.fire("click");
  assert.equal(warningText().length, 20);
  assert.ok(warningText()[0]!.includes("안내-20"));
  button(app, "다음 안내")!.fire("click");
  assert.equal(warningText().length, 5);
  assert.ok(warningText()[4]!.includes("안내-44"));
  assert.equal(button(app, "다음 안내")!.disabled, true);
  button(app, "이전 안내")!.fire("click");
  assert.ok(warningText()[0]!.includes("안내-20"));
});

test("프로젝트를 떠났다가 돌아오면 가져올 파일·승인·미리보기를 비운다", async () => {
  const table = responseTable();
  table["POST /projects/shop/translations/import/preview"] = previewResult();
  const { app } = await open(table);
  await chooseFile(app);
  button(app, "미리보기")!.fire("click"); await settle();
  button(app, "프로젝트")!.fire("click"); await settle();
  button(app, "shop")!.fire("click"); await settle();
  assert.equal(button(app, "가져오기"), undefined);
  assert.equal(button(app, "취소"), undefined);
  assert.equal(labelled(app, "가져오기 형식").value, "rynl10n");
  assert.equal(button(app, "미리보기")!.disabled, true);
  assert.doesNotMatch(app.textContent, /ko\.arb/);
});

test("게시 정책은 maintainer가 저장하고 viewer·translator는 읽기만 한다", async () => {
  const { app, calls } = await open(responseTable("maintainer"));
  button(app, "릴리스")!.fire("click");
  labelled(app, "미검수 번역 게시 차단").checked = true;
  labelled(app, "기본 로케일 누락 게시 차단").checked = true;
  button(app, "게시 정책 저장")!.fire("click"); await settle();
  assert.deepEqual(calls.find((call) => call.method === "PATCH")!.body, { publishPolicy: { requireReviewed: true, requireDefaultLocale: true } });
  for (const role of ["viewer", "translator"]) {
    const view = await open(responseTable(role));
    button(view.app, "릴리스")!.fire("click");
    assert.equal(button(view.app, "게시 정책 저장"), undefined);
    assert.equal(labelled(view.app, "미검수 번역 게시 차단").disabled, true);
    assert.equal(labelled(view.app, "기본 로케일 누락 게시 차단").disabled, true);
  }
});

test("출시 전 점검은 서버 정책 위반의 키·로케일을 보여 주고 게시 단추를 숨긴다", async () => {
  const table = responseTable();
  table["GET /projects/shop/releases/R1/changes"] = releaseDiff();
  const { app } = await open(table);
  button(app, "릴리스")!.fire("click");
  button(app, "변경사항")!.fire("click"); await settle();
  assert.match(app.textContent, /hello · en: 검수 필요/);
  assert.match(app.textContent, /프로젝트 게시 품질 정책/);
  assert.equal(button(app, "이 변경사항 게시"), undefined);
});

test("직접 publish도 켜진 정책의 서버 판정을 먼저 읽고 위반 시 요청하지 않는다", async () => {
  const table = responseTable();
  table["GET /projects/shop"].publishPolicy.requireReviewed = true;
  table["GET /projects/shop/releases/R1/changes"] = releaseDiff();
  const { app, calls, toasts } = await open(table);
  button(app, "릴리스")!.fire("click");
  button(app, "publish")!.fire("click"); await settle();
  assert.match(toasts.textContent, /hello · en: 검수 필요/);
  assert.ok(calls.some((call) => call.path.endsWith("/changes")));
  assert.ok(!calls.some((call) => call.method === "POST"));
});

test("검수된 번역의 값 수정은 초안으로 저장하고 명시적 승인과 구분한다", async () => {
  const { app, calls } = await open();
  const input = tag(app, "input").find((node) => node.value === "Hello")!;
  input.value = "Edited"; input.fire("blur"); await settle();
  assert.deepEqual(calls.find((call) => call.path === "/projects/shop/translations/hello/en")!.body, { value: "Edited", state: "draft" });
});
