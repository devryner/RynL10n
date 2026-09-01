/**
 * 대시보드(어드민 앱) — 정적 자산 서빙 + 대시보드가 의존하는 조회/설정 엔드포인트 (7.1 / 9.2 코어 ③).
 * 대시보드는 관리 플레인만 호출한다(플레인 분리 4.1) — 여기 검증 대상도 전부 :8787 관리 API.
 */
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
const TOK = { admin: "d-admin", maint: "d-maint", trans: "d-trans", view: "d-view" };

before(async () => {
  const repo = new Repo(openDatabase());
  const store = new MemoryArtifactStore();
  const tokens = new TokenRegistry();
  tokens.issue(TOK.admin, { actor: "admin", role: "admin", projects: "*" });
  tokens.issue(TOK.maint, { actor: "mnt", role: "maintainer", projects: new Set(["shop"]) });
  tokens.issue(TOK.trans, { actor: "tr", role: "translator", projects: new Set(["shop"]) });
  tokens.issue(TOK.view, { actor: "vw", role: "viewer", projects: new Set(["shop"]) });
  server = createManagementServer({ repo, store, tokens, deliveryBaseUrl: "https://cdn.example.test" });
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

test("대시보드 자산: / 는 HTML, /ui/* 는 JS·CSS를 인증 없이 서빙", async () => {
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  const html = await page.text();
  assert.match(html, /RynL10n 대시보드/);
  assert.match(html, /\/ui\/app\.js/);

  const js = await fetch(base + "/ui/app.js");
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /javascript/);

  const css = await fetch(base + "/ui/style.css");
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type") ?? "", /text\/css/);
});

test("대시보드 자산은 허용 목록뿐 — 경로 순회·임의 파일 요청은 404", async () => {
  for (const p of ["/ui/../db/repo.ts", "/ui/serve.ts", "/ui/", "/index.html"]) {
    const res = await fetch(base + p);
    assert.equal(res.status, 404, `${p} 는 서빙되면 안 됨`);
  }
});

test("serveDashboard:false 면 / 는 일반 404 (헤드리스 배포)", async () => {
  const repo = new Repo(openDatabase());
  const headless = createManagementServer({
    repo, store: new MemoryArtifactStore(), tokens: new TokenRegistry(), serveDashboard: false,
  });
  await new Promise<void>((r) => headless.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(headless.address() as AddressInfo).port}/`;
  const res = await fetch(url);
  assert.equal(res.status, 404);
  headless.close();
});

test("GET /me: 토큰 검증 + 역할·스코프·배포 플레인 주소 반환", async () => {
  const anon = await api("GET", "/me");
  assert.equal(anon.status, 401);

  const me = await api("GET", "/me", { token: TOK.view });
  assert.equal(me.status, 200);
  assert.equal(me.body.actor, "vw");
  assert.equal(me.body.role, "viewer");
  assert.deepEqual(me.body.projects, ["shop"]);
  assert.equal(me.body.deliveryBaseUrl, "https://cdn.example.test");

  const admin = await api("GET", "/me", { token: TOK.admin });
  assert.equal(admin.body.projects, "*");
});

test("GET /projects: 토큰 스코프 밖 프로젝트는 목록에 없음 (7.3)", async () => {
  await api("POST", "/projects", { token: TOK.admin, body: { id: "shop", name: "Shop", defaultLocale: "en", locales: ["en", "ja"] } });
  await api("POST", "/projects", { token: TOK.admin, body: { id: "secret", name: "Secret", defaultLocale: "en" } });

  const all = await api("GET", "/projects", { token: TOK.admin });
  assert.deepEqual(all.body.projects.map((p: any) => p.id), ["secret", "shop"]);

  const scoped = await api("GET", "/projects", { token: TOK.view });
  assert.deepEqual(scoped.body.projects.map((p: any) => p.id), ["shop"]);
});

test("GET /projects/{p}: 지원 로케일 포함", async () => {
  const r = await api("GET", "/projects/shop", { token: TOK.view });
  assert.equal(r.status, 200);
  assert.equal(r.body.defaultLocale, "en");
  assert.deepEqual(r.body.locales, ["en", "ja"]);

  const missing = await api("GET", "/projects/nope", { token: TOK.admin });
  assert.equal(missing.status, 404);
});

test("GET /projects/{p}/keys: 키 + 로케일별 번역 + 릴리스 참조 수", async () => {
  await api("PUT", "/projects/shop/keys/cart.title", { token: TOK.trans });
  await api("PUT", "/projects/shop/translations/cart.title/en", { token: TOK.trans, body: { value: "Cart", state: "reviewed" } });
  await api("PUT", "/projects/shop/translations/cart.title/ja", { token: TOK.trans, body: { value: "カート" } });

  const r = await api("GET", "/projects/shop/keys", { token: TOK.view });
  assert.equal(r.status, 200);
  const key = r.body.keys.find((k: any) => k.name === "cart.title");
  assert.equal(key.translations.en.value, "Cart");
  assert.equal(key.translations.en.state, "reviewed");
  assert.equal(key.translations.ja.value, "カート");
  assert.equal(key.refCount, 0); // 아직 어떤 릴리스에도 속하지 않음
});

test("번역 JSON import: 기존 값 갱신 + 새 키·복수형 생성 + 기본 draft를 한 번에 처리", async () => {
  const r = await api("POST", "/projects/shop/translations/import", {
    token: TOK.trans,
    body: {
      keys: [
        {
          name: "cart.title",
          description: "가져오기로 갱신한 설명",
          translations: [
            { locale: "en", value: "Shopping cart", state: "reviewed" },
            { locale: "ja", value: "買い物かご" },
          ],
        },
        {
          name: "cart.items",
          translations: [
            { locale: "en", value: { one: "{n} item", other: "{n} items" }, state: "reviewed" },
            { locale: "ja", value: { other: "{n}個" }, state: "draft" },
          ],
        },
      ],
    },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { createdKeys: 1, updatedKeys: 1, translations: 4 });

  const keys = (await api("GET", "/projects/shop/keys", { token: TOK.view })).body.keys;
  const title = keys.find((k: any) => k.name === "cart.title");
  assert.equal(title.description, "가져오기로 갱신한 설명");
  assert.equal(title.translations.en.value, "Shopping cart");
  assert.equal(title.translations.ja.state, "draft", "state를 생략하면 draft");
  const items = keys.find((k: any) => k.name === "cart.items");
  assert.equal(items.isPlural, true);
  assert.equal(items.signature, "n:simple");
  assert.deepEqual(items.translations.en.value, { one: "{n} item", other: "{n} items" });
});

test("번역 JSON import는 잘못된 항목 하나가 있으면 앞의 정상 항목도 반영하지 않는다", async () => {
  const r = await api("POST", "/projects/shop/translations/import", {
    token: TOK.trans,
    body: {
      keys: [
        { name: "valid.before-error", translations: [{ locale: "en", value: "Valid" }] },
        { name: "bad.locale", translations: [{ locale: "ko", value: "미등록" }] },
      ],
    },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /지원 로케일/);
  const keys = (await api("GET", "/projects/shop/keys", { token: TOK.view })).body.keys;
  assert.equal(keys.some((k: any) => k.name === "valid.before-error"), false);
});

test("번역 JSON import는 중복·형식 오류와 기존 키의 서명 불일치를 구분해 거절한다", async () => {
  const duplicate = await api("POST", "/projects/shop/translations/import", {
    token: TOK.trans,
    body: { keys: [
      { name: "dup.key", translations: [{ locale: "en", value: "A" }] },
      { name: "dup.key", translations: [{ locale: "ja", value: "B" }] },
    ] },
  });
  assert.equal(duplicate.status, 400);
  assert.match(duplicate.body.error.message, /중복/);

  const badPlural = await api("POST", "/projects/shop/translations/import", {
    token: TOK.trans,
    body: { keys: [{ name: "bad.plural", translations: [{ locale: "en", value: { one: "one" } }] }] },
  });
  assert.equal(badPlural.status, 400);
  assert.match(badPlural.body.error.message, /other/);

  const mismatch = await api("POST", "/projects/shop/translations/import", {
    token: TOK.trans,
    body: { keys: [{ name: "cart.title", translations: [{ locale: "en", value: "Cart for {name}" }] }] },
  });
  assert.equal(mismatch.status, 422);
  assert.equal(mismatch.body.error.code, "signature_mismatch");
});

test("번역 JSON import는 Translator 이상만 가능", async () => {
  const body = { keys: [{ name: "rbac.key", translations: [{ locale: "en", value: "Allowed" }] }] };
  assert.equal((await api("POST", "/projects/shop/translations/import", { token: TOK.view, body })).status, 403);
  assert.equal((await api("POST", "/projects/shop/translations/import", { body })).status, 401);
});

test("키 설명(5.1): 생성·수정·조회 — 로케일이 아니라 '의미'에 붙는다", async () => {
  const created = await api("PUT", "/projects/shop/keys/cart.empty", {
    token: TOK.trans, body: { description: "장바구니가 비었을 때 본문. 안내 톤, 느낌표 금지." },
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.description, "장바구니가 비었을 때 본문. 안내 톤, 느낌표 금지.");

  const listed = (await api("GET", "/projects/shop/keys", { token: TOK.view })).body.keys
    .find((k: any) => k.name === "cart.empty");
  assert.equal(listed.description, "장바구니가 비었을 때 본문. 안내 톤, 느낌표 금지.");

  const edited = await api("PUT", "/projects/shop/keys/cart.empty", { token: TOK.trans, body: { description: "수정된 설명" } });
  assert.equal(edited.body.description, "수정된 설명");

  // 설명을 주지 않은 요청은 기존 설명을 지우지 않는다.
  await api("PUT", "/projects/shop/keys/cart.empty", { token: TOK.trans, body: { isPlural: false } });
  const kept = (await api("GET", "/projects/shop/keys", { token: TOK.view })).body.keys
    .find((k: any) => k.name === "cart.empty");
  assert.equal(kept.description, "수정된 설명");
});

test("설명만 수정해도 확정된 플레이스홀더 서명이 유지된다 (포맷 가드 3.1 회귀 방지)", async () => {
  await api("PUT", "/projects/shop/keys/greet.user", { token: TOK.trans });
  // 첫 값이 서명을 확정한다.
  await api("PUT", "/projects/shop/translations/greet.user/en", { token: TOK.trans, body: { value: "Hi {name}" } });
  const locked = (await api("GET", "/projects/shop/keys", { token: TOK.view })).body.keys
    .find((k: any) => k.name === "greet.user").signature;
  assert.ok(locked, "서명이 확정돼 있어야 한다");

  // 설명만 수정 — 서명이 초기화되면 안 된다.
  await api("PUT", "/projects/shop/keys/greet.user", { token: TOK.trans, body: { description: "인사말" } });
  const after = (await api("GET", "/projects/shop/keys", { token: TOK.view })).body.keys
    .find((k: any) => k.name === "greet.user");
  assert.equal(after.signature, locked, "설명 수정이 서명을 지우면 안 된다");

  // 서명이 살아 있으므로 불일치 값은 여전히 422로 막힌다.
  const mismatch = await api("PUT", "/projects/shop/translations/greet.user/ja", { token: TOK.trans, body: { value: "こんにちは" } });
  assert.equal(mismatch.status, 422);
});

test("로케일 추가 API: 미등록 로케일의 번역이 스냅샷에 포함되도록 만든다 (5.1 함정 해소)", async () => {
  // ko는 아직 지원 로케일이 아니다 → 번역을 넣어도 카탈로그에서 조용히 제외된다.
  await api("PUT", "/projects/shop/translations/cart.title/ko", { token: TOK.trans, body: { value: "장바구니" } });
  await api("POST", "/projects/shop/releases", {
    token: TOK.maint,
    body: { id: "RD1", name: "v1", versionMatch: { strategy: "semver-range", value: ">=1.0.0 <2.0.0" }, keys: ["cart.title"] },
  });

  const before = await api("GET", "/projects/shop/releases/RD1/snapshot", { token: TOK.view });
  assert.equal(before.body.locales.ko, undefined, "등록 전에는 ko가 제외돼야 한다");

  const translatorDenied = await api("POST", "/projects/shop/locales", { token: TOK.trans, body: { tag: "ko" } });
  assert.equal(translatorDenied.status, 403, "로케일 추가는 Maintainer+");

  const added = await api("POST", "/projects/shop/locales", { token: TOK.maint, body: { tag: "ko" } });
  assert.equal(added.status, 200);
  assert.deepEqual(added.body.locales, ["en", "ja", "ko"]);

  const after = await api("GET", "/projects/shop/releases/RD1/snapshot", { token: TOK.view });
  assert.equal(after.body.locales.ko["cart.title"], "장바구니", "등록 후에는 스냅샷에 포함돼야 한다");

  const bad = await api("POST", "/projects/shop/locales", { token: TOK.maint, body: { tag: "  " } });
  assert.equal(bad.status, 400);
});

test("GET /projects/{p}/releases/{r}/keys: 릴리스 카탈로그 구성 키", async () => {
  const r = await api("GET", "/projects/shop/releases/RD1/keys", { token: TOK.view });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.keys, ["cart.title"]);

  const missing = await api("GET", "/projects/shop/releases/NOPE/keys", { token: TOK.view });
  assert.equal(missing.status, 404);
});

test("GET /projects/{p}/manifests: 게시 이력 → 롤백 대상(overlay) 추적 (8.3)", async () => {
  const empty = await api("GET", "/projects/shop/manifests", { token: TOK.view });
  assert.deepEqual(empty.body.history, []);

  await api("POST", "/projects/shop/releases/RD1/publish", { token: TOK.maint });
  const first = await api("GET", "/projects/shop/manifests", { token: TOK.view });
  assert.equal(first.body.history.length, 1);
  const baseHash = first.body.history[0].manifest.releases[0].overlay;

  // 번역 수정 후 재게시 → overlay가 이동하고 이전 해시가 이력에 남는다(롤백 후보).
  await api("PUT", "/projects/shop/translations/cart.title/ko", { token: TOK.trans, body: { value: "카트" } });
  await api("POST", "/projects/shop/releases/RD1/publish", { token: TOK.maint });

  const history = (await api("GET", "/projects/shop/manifests", { token: TOK.view })).body.history;
  assert.equal(history.length, 2);
  assert.equal(history[0].seq, 2, "최신이 먼저");
  const current = history[0].manifest.releases[0].overlay;
  assert.notEqual(current, baseHash);
  const candidates = history.flatMap((h: any) => h.manifest.releases.map((r: any) => r.overlay));
  assert.ok(candidates.includes(baseHash), "이전 overlay가 롤백 후보로 남아야 한다");
});

test("GET /projects/{p}/releases/{r}/changes: 마지막 게시본과 publish 직전 카탈로그를 실제 delta 규칙으로 비교", async () => {
  const unchanged = await api("GET", "/projects/shop/releases/RD1/changes", { token: TOK.view });
  assert.equal(unchanged.status, 200);
  assert.equal(unchanged.body.baseline.releaseId, "RD1");
  assert.equal(unchanged.body.baseline.hash, unchanged.body.target.hash);
  assert.deepEqual(unchanged.body.summary, { added: 0, changed: 0, deleted: 0, total: 0 });

  // 게시하지 않은 DB 편집만 미리보기에 잡혀야 한다. 현재 overlay 포인터는 아직 이전 값을 가리킨다.
  await api("PUT", "/projects/shop/translations/cart.title/ko", {
    token: TOK.trans, body: { value: "새 장바구니", state: "reviewed" },
  });
  const changed = await api("GET", "/projects/shop/releases/RD1/changes", { token: TOK.view });
  assert.equal(changed.body.baseline.releaseId, "RD1");
  assert.equal(changed.body.summary.changed, 1);
  assert.deepEqual(changed.body.changes[0], {
    type: "changed", key: "cart.title", locale: "ko", before: "카트", after: "새 장바구니",
  });

  // 한 번도 게시하지 않은 다음 릴리스는 같은 매칭 전략의 직전 릴리스를 자동 기준으로 삼는다.
  await api("POST", "/projects/shop/releases", {
    token: TOK.maint,
    body: { id: "RD2", name: "v2", versionMatch: { strategy: "semver-range", value: ">=2.0.0 <3.0.0" }, keys: ["cart.title", "cart.items"] },
  });
  const next = await api("GET", "/projects/shop/releases/RD2/changes", { token: TOK.view });
  assert.equal(next.body.baseline.releaseId, "RD1");
  assert.equal(next.body.target.releaseId, "RD2");
  assert.ok(next.body.summary.total > 0, "직전 버전과 달라진 번역을 보여줘야 한다");

  // 프로젝트의 첫 릴리스는 비교 기준이 없음을 밝히고 현재 번역을 모두 '추가'로 분류한다.
  await api("PUT", "/projects/secret/keys/hello", { token: TOK.admin });
  await api("PUT", "/projects/secret/translations/hello/en", { token: TOK.admin, body: { value: "Hello" } });
  await api("POST", "/projects/secret/releases", {
    token: TOK.admin,
    body: { id: "FIRST", name: "first", versionMatch: { strategy: "exact-label", value: "first" }, keys: ["hello"] },
  });
  const first = await api("GET", "/projects/secret/releases/FIRST/changes", { token: TOK.admin });
  assert.equal(first.body.baseline, null);
  assert.deepEqual(first.body.summary, { added: 1, changed: 0, deleted: 0, total: 1 });
  assert.deepEqual(first.body.changes[0], { type: "added", key: "hello", locale: "en", after: "Hello" });

  assert.equal((await api("GET", "/projects/shop/releases/RD1/changes")).status, 401);
  assert.equal((await api("GET", "/projects/shop/releases/NOPE/changes", { token: TOK.view })).status, 404);
});

test("설명 사이드카: 빌드 플러그인이 네이티브 주석용으로 fetch (5.1 / 6.3)", async () => {
  const r = await api("GET", "/projects/shop/releases/RD1/descriptions", { token: TOK.view });
  assert.equal(r.status, 200);
  assert.equal(r.body.release, "RD1");
  // RD1에 속한 키만, 설명이 있는 것만 — 스냅샷과 분리된 사이드카다.
  assert.deepEqual(Object.keys(r.body.descriptions), ["cart.title"].filter((k) => r.body.descriptions[k]));
  assert.equal(r.body.descriptions["cart.empty"], undefined, "릴리스에 없는 키는 제외");

  await api("PUT", "/projects/shop/keys/cart.title", { token: TOK.trans, body: { description: "장바구니 화면 제목" } });
  const withDesc = await api("GET", "/projects/shop/releases/RD1/descriptions", { token: TOK.view });
  assert.equal(withDesc.body.descriptions["cart.title"], "장바구니 화면 제목");

  const missing = await api("GET", "/projects/shop/releases/NOPE/descriptions", { token: TOK.view });
  assert.equal(missing.status, 404);
  const noAuth = await api("GET", "/projects/shop/releases/RD1/descriptions");
  assert.equal(noAuth.status, 401);
});

test("설명은 export/import로 보존되지만 런타임 산출물에는 실리지 않는다 (9.2 / 11.1)", async () => {
  const exported = (await api("GET", "/projects/shop/export", { token: TOK.admin })).body;
  assert.equal(exported.keys.find((k: any) => k.name === "cart.empty").description, "수정된 설명");

  // 다른 id로 복원 → 설명까지 살아난다(락인 없음).
  exported.project.id = "shop-copy";
  const restored = await api("POST", "/projects/import", { token: TOK.admin, body: exported });
  assert.equal(restored.status, 201);
  const copied = (await api("GET", "/projects/shop-copy/keys", { token: TOK.admin })).body.keys
    .find((k: any) => k.name === "cart.empty");
  assert.equal(copied.description, "수정된 설명");

  // 배포 스냅샷에는 없어야 한다: 기기로 내려갈 데이터가 아니고,
  // 해시 입력(11.1 {release,defaultLocale,locales})이 바뀌면 골든 벡터 계약이 깨진다.
  const snap = (await api("GET", "/projects/shop/releases/RD1/snapshot", { token: TOK.view })).body;
  assert.equal(JSON.stringify(snap).includes("수정된 설명"), false, "설명이 산출물로 새면 안 된다");
  assert.deepEqual(Object.keys(snap).sort(), ["base", "defaultLocale", "locales", "release", "schemaVersion"]);
});

// ── import 실패 경로 (POST /projects/import, 9.2) ─────────────────────────────
// 성공 경로는 위 export/import 왕복 테스트가 덮는다. 여기서 못박는 건 **실패가 사용자에게
// 고칠 수 있는 형태로 돌아오는가**다 — 이 라우트는 원래 무엇이 잘못돼도 500 internal이었다.

test("이미 있는 id로 복원하면 409로 막고 기존 프로젝트를 건드리지 않는다", async () => {
  const exported = (await api("GET", "/projects/shop/export", { token: TOK.admin })).body;
  const before = (await api("GET", "/projects/shop/keys", { token: TOK.admin })).body.keys.length;

  const dup = await api("POST", "/projects/import", { token: TOK.admin, body: exported });
  assert.equal(dup.status, 409, "덮어쓰기가 아니라 거절 — import는 병합이 아니다");
  assert.equal(dup.body.error.code, "conflict");
  assert.match(dup.body.error.message, /다른 ID로 복원/, "해결 방법을 메시지에 담는다");
  assert.equal(dup.body.error.message.includes("UNIQUE constraint"), false, "SQLite 원문이 새면 안 된다");

  const after = (await api("GET", "/projects/shop/keys", { token: TOK.admin })).body.keys.length;
  assert.equal(after, before, "거절된 import가 원본을 건드리지 않았다");
});

test("export가 아닌 JSON은 400 — TypeError가 500으로 새지 않는다", async () => {
  const PROJ = { id: "x", name: "X", defaultLocale: "en" };
  /** 형식이 온전한 최소 export — 각 케이스는 여기서 한 군데씩만 망가뜨린다. */
  const ok = (over: Record<string, unknown> = {}) => ({ project: PROJ, locales: [], keys: [], releases: [], ...over });
  const key = (over: Record<string, unknown> = {}) => ({
    name: "a.b", signature: "", isPlural: false, translations: [{ locale: "en", value: "A", state: "draft" }], ...over,
  });
  const rel = (over: Record<string, unknown> = {}) => ({
    id: "R1", name: "R1", versionMatch: { strategy: "semver-range", value: ">=1.0.0 <2.0.0" },
    state: "draft", base: null, overlay: null, keys: [], ...over,
  });

  const cases: [string, unknown][] = [
    ["빈 본문", {}],
    ["project 없음", { locales: [], keys: [], releases: [] }],
    ["keys가 배열이 아님", ok({ keys: {} })],
    ["키 이름 없음", ok({ keys: [{ translations: [] }] })],
    ["릴리스 매칭 규칙 불량", ok({ releases: [rel({ versionMatch: { strategy: "nope", value: "1" } })] })],
    // 아래부터는 SQLite 바인딩까지 내려가면 TypeError·제약 위반으로 500이 되던 자리들이다.
    ["키 서명 없음", ok({ keys: [key({ signature: undefined })] })],
    ["번역 값 없음", ok({ keys: [key({ translations: [{ locale: "en", state: "draft" }] })] })],
    ["번역 값이 null", ok({ keys: [key({ translations: [{ locale: "en", value: null, state: "draft" }] })] })],
    ["번역 상태 없음", ok({ keys: [key({ translations: [{ locale: "en", value: "A" }] })] })],
    ["설명이 문자열이 아님", ok({ keys: [key({ description: { ko: "설명" } })] })],
    ["로케일 fallbackParent가 객체", ok({ locales: [{ tag: "ko", fallbackParent: {} }] })],
    ["릴리스 상태 불량", ok({ releases: [rel({ state: "shipped" })] })],
    ["릴리스 포인터가 문자열이 아님", ok({ releases: [rel({ base: 123, overlay: 456 })] })],
    ["rollout이 범위 밖", ok({ releases: [rel({ rollout: 140 })] })],
    ["rollout이 정수가 아님", ok({ releases: [rel({ rollout: 12.5 })] })],
    // 이름 참조가 깨진 export — importProject가 조용히 버리던 자리다(복원이 반쪽이 된다).
    ["릴리스가 없는 키를 참조", ok({ keys: [key()], releases: [rel({ keys: ["a.b", "ghost.key"] })] })],
  ];
  for (const [label, body] of cases) {
    const r = await api("POST", "/projects/import", { token: TOK.admin, body });
    assert.equal(r.status, 400, `${label} → 400이어야 한다 (받은 값: ${r.status})`);
    assert.equal(r.body.error.code, "bad_request");
    assert.match(r.body.error.message, /export 형식이 아닙니다|versionMatch/, `${label}: 어디가 문제인지 알려준다`);
  }
  assert.equal((await api("GET", "/projects/x", { token: TOK.admin })).status, 404, "실패한 import가 프로젝트를 남기지 않았다");
});

test("rollout(카나리 %)은 복원된다 — 백업을 되살렸더니 전량 배포가 되어 있으면 안 된다", async () => {
  // rollout을 쓰는 API는 아직 없다(8.4 법무 승인 대기, 안전 기본값 100 고정). 그래서 export가
  // 값을 담고 있어도 import가 버리면 아무도 눈치채지 못한다 — 카나리가 열리는 날 조용히 터진다.
  const exported = (await api("GET", "/projects/shop/export", { token: TOK.admin })).body;
  assert.ok(exported.releases.length > 0, "이 시나리오는 릴리스가 있어야 성립한다");
  assert.equal(exported.releases[0].rollout, 100, "export는 rollout을 담는다");

  const canary = {
    ...exported,
    project: { ...exported.project, id: "shop-canary" },
    releases: exported.releases.map((r: any, i: number) => ({ ...r, rollout: i === 0 ? 25 : r.rollout })),
  };
  assert.equal((await api("POST", "/projects/import", { token: TOK.admin, body: canary })).status, 201);

  const restored = (await api("GET", "/projects/shop-canary/releases", { token: TOK.admin })).body.releases;
  assert.equal(restored[0].rollout, 25, "백업에 담긴 카나리 비율이 그대로 살아난다");
  assert.equal(restored[0].state, exported.releases[0].state, "상태도 그대로");
});

test("rollout·포인터가 없는 구 export도 복원된다 (하위호환)", async () => {
  const exported = (await api("GET", "/projects/shop/export", { token: TOK.admin })).body;
  // rollout·base·overlay가 없던 시절의 백업. 필드를 지워서 그대로 재현한다.
  const legacy = {
    ...exported,
    project: { ...exported.project, id: "shop-legacy" },
    releases: exported.releases.map(({ rollout, base, overlay, ...rest }: any) => rest),
  };
  assert.equal((await api("POST", "/projects/import", { token: TOK.admin, body: legacy })).status, 201,
    "결측 필드는 거절 사유가 아니다");

  const restored = (await api("GET", "/projects/shop-legacy/releases", { token: TOK.admin })).body.releases;
  assert.equal(restored[0].rollout, 100, "없으면 안전 기본값 100");
  assert.equal(restored[0].base, null, "포인터는 미설정 — 산출물은 재생성으로 복구한다(9.4)");
  assert.equal(restored[0].overlay, null);
});

test("import 중간에 깨지면 통째로 롤백된다 — 반쪽 프로젝트가 남지 않는다", async () => {
  const exported = (await api("GET", "/projects/shop/export", { token: TOK.admin })).body;
  // 형식 검사는 통과하지만 DB에서 깨지는 본문: 같은 릴리스 id가 두 번(두 번째 INSERT가 PK 충돌).
  // 키를 다 넣은 뒤에 터지므로, 트랜잭션이 없으면 키만 있는 프로젝트가 남는다.
  const broken = {
    ...exported,
    project: { ...exported.project, id: "half" },
    releases: [...exported.releases, ...exported.releases],
  };
  assert.ok(broken.releases.length >= 2, "이 시나리오는 릴리스가 최소 1개 있어야 성립한다");

  const r = await api("POST", "/projects/import", { token: TOK.admin, body: broken });
  assert.equal(r.status, 500, "예상 못한 DB 오류는 500이 맞다 — 검증 대상은 상태가 깨끗한가다");

  assert.equal((await api("GET", "/projects/half", { token: TOK.admin })).status, 404,
    "프로젝트 자체가 없어야 한다");
  assert.equal((await api("GET", "/projects", { token: TOK.admin })).body.projects.some((p: any) => p.id === "half"), false);
});

test("import는 Admin 전용 (7.3)", async () => {
  const exported = (await api("GET", "/projects/shop/export", { token: TOK.admin })).body;
  exported.project.id = "nope";
  for (const t of [TOK.maint, TOK.trans, TOK.view]) {
    assert.equal((await api("POST", "/projects/import", { token: t, body: exported })).status, 403);
  }
  assert.equal((await api("POST", "/projects/import", { body: exported })).status, 401);
});

test("대시보드 조회 엔드포인트도 RBAC·스코프를 그대로 따른다", async () => {
  const outOfScope = await api("GET", "/projects/secret/keys", { token: TOK.view });
  assert.equal(outOfScope.status, 403);

  const noAuth = await api("GET", "/projects/shop/keys");
  assert.equal(noAuth.status, 401);
});
