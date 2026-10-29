import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { openDatabase } from "../src/db/schema.ts";
import { Repo } from "../src/db/repo.ts";
import { MemoryArtifactStore } from "../src/storage/store.ts";
import { TokenRegistry } from "../src/auth/rbac.ts";
import { createManagementServer } from "../src/api/server.ts";

async function fixture(t: TestContext) {
  const db = openDatabase();
  const repo = new Repo(db);
  const store = new MemoryArtifactStore();
  repo.createProject("shop", "Shop", "en", ["en", "ko"]);
  const tokens = new TokenRegistry();
  for (const role of ["admin", "maintainer", "translator", "viewer"] as const) {
    tokens.issue(role, { actor: role, role, projects: role === "admin" ? "*" : new Set(["shop"]) });
  }
  tokens.issue("elsewhere", { actor: "elsewhere", role: "maintainer", projects: new Set(["other"]) });
  const server = createManagementServer({ repo, store, tokens, log: () => {} });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); });
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function api(method: string, path: string, body?: unknown, token = "translator") {
    const response = await fetch(endpoint + path, { method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  }
  function existing(name = "hello", value = "Original", description = "") {
    const key = repo.upsertKey("shop", name, "", false);
    repo.setKeyDescription("shop", name, description);
    repo.putTranslation("shop", key, "en", value, "reviewed");
    return key;
  }
  return { db, repo, store, api, existing };
}

const previewPath = "/projects/shop/translations/import/preview";
const applyPath = "/projects/shop/translations/import";
const source = (value: Record<string, unknown>, locale = "en") => ({ format: "i18next", files: [
  { name: `${locale}.json`, content: JSON.stringify(value), locale },
] });

test("파일 미리보기는 기존 검증 후 차이만 반환하고 저장하지 않는다", async (t) => {
  const { api, repo, db, existing } = await fixture(t);
  existing();
  const before = repo.exportProject("shop");
  const result = await api("POST", previewPath, source({ hello: "Updated", welcome: "Welcome" }));
  assert.equal(result.status, 200);
  assert.equal(result.body.createdKeys, 1);
  assert.equal(result.body.updatedKeys, 1);
  assert.equal(result.body.translations, 2);
  assert.deepEqual(result.body.locales, ["en"]);
  assert.deepEqual(result.body.conflicts, [{ key: "hello", locale: "en", type: "changed", before: "Original", after: "Updated", beforeState: "reviewed", afterState: "draft" }]);
  assert.match(result.body.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(repo.exportProject("shop"), before);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log").get()!.n, 0);
});

test("새 번역은 확인한 revision으로만 draft 저장하고 기존 미포함 키는 유지한다", async (t) => {
  const { api, repo, existing } = await fixture(t);
  existing("untouched");
  const input = source({ hello: "Hello" });
  assert.equal((await api("POST", applyPath, input)).status, 400);
  assert.equal(repo.getKeyByName("shop", "hello"), undefined);
  const preview = await api("POST", previewPath, input);
  assert.equal((await api("POST", applyPath, { ...input, revision: preview.body.revision, overwrite: false })).status, 200);
  const key = repo.getKeyByName("shop", "hello")!;
  assert.equal(repo.getTranslation(key.id, "en")!.state, "draft");
  assert.ok(repo.getKeyByName("shop", "untouched"));
});

test("기존 값 덮어쓰기는 명시 동의가 필요하고 변경한 값은 재검수한다", async (t) => {
  const { api, repo, existing } = await fixture(t);
  const key = existing();
  const input = source({ hello: "Updated" });
  const preview = await api("POST", previewPath, input);
  assert.equal((await api("POST", applyPath, { ...input, revision: preview.body.revision })).status, 409);
  assert.equal(repo.getTranslation(key, "en")!.value, "Original");
  assert.equal((await api("POST", applyPath, { ...input, revision: preview.body.revision, overwrite: "true" })).status, 400);
  const applied = await api("POST", applyPath, { ...input, revision: preview.body.revision, overwrite: true });
  assert.equal(applied.status, 200);
  assert.equal(repo.getTranslation(key, "en")!.value, "Updated");
  assert.equal(repo.getTranslation(key, "en")!.state, "draft");
});

for (const update of ["value", "review", "description", "signature"] as const) {
  test(`미리보기 후 ${update} 변경은 409로 전체 가져오기를 막는다`, async (t) => {
    const { api, repo, existing } = await fixture(t);
    const key = existing();
    const input = source({ hello: "Updated", added: "Added" });
    const preview = await api("POST", previewPath, input);
    if (update === "value") repo.putTranslation("shop", key, "en", "Concurrent", "reviewed");
    if (update === "review") repo.putTranslation("shop", key, "en", "Original", "draft");
    if (update === "description") repo.setKeyDescription("shop", "hello", "Concurrent explanation");
    if (update === "signature") repo.upsertKey("shop", "hello", "name:simple", false);
    const before = repo.exportProject("shop");
    const applied = await api("POST", applyPath, { ...input, revision: preview.body.revision, overwrite: true });
    assert.equal(applied.status, 409);
    assert.match(applied.body.error.message, /다시 미리보기/);
    assert.deepEqual(repo.exportProject("shop"), before);
    assert.equal(repo.getKeyByName("shop", "added"), undefined);
  });
}

test("동일한 네이티브 값을 다시 가져와도 검수 상태는 유지한다", async (t) => {
  const { api, repo, existing } = await fixture(t);
  const key = existing();
  const input = source({ hello: "Original" });
  const preview = await api("POST", previewPath, input);
  assert.equal(preview.body.changes[0].type, "unchanged");
  assert.deepEqual(preview.body.conflicts, []);
  assert.equal((await api("POST", applyPath, { ...input, revision: preview.body.revision, overwrite: false })).status, 200);
  assert.equal(repo.getTranslation(key, "en")!.state, "reviewed");
});

test("설명 변경도 미리보기와 덮어쓰기 동의 대상이며 파일 상태 표시는 승인을 대신하지 않는다", async (t) => {
  const { api, repo, existing } = await fixture(t);
  const key = existing("hello", "Original", "Old context");
  const input = { format: "arb", files: [{ name: "app_en.arb", content: JSON.stringify({ "@@locale": "en", hello: "Original", "@hello": { description: "New context" } }) }] };
  const preview = await api("POST", previewPath, input);
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.metadataChanges, [{ key: "hello", beforeDescription: "Old context", afterDescription: "New context" }]);
  assert.equal((await api("POST", applyPath, { ...input, revision: preview.body.revision })).status, 409);
  assert.equal(repo.getKeyByName("shop", "hello")!.description, "Old context");
  assert.equal((await api("POST", applyPath, { ...input, revision: preview.body.revision, overwrite: true })).status, 200);
  assert.equal(repo.getTranslation(key, "en")!.state, "reviewed");
  assert.equal(repo.getKeyByName("shop", "hello")!.description, "New context");
});

test("미지원 로케일·기존 서명 불일치·잘못된 파일은 쓰기 전에 거절한다", async (t) => {
  const { api, repo, existing } = await fixture(t);
  const key = existing("hello", "Hello {name}");
  repo.upsertKey("shop", "hello", "name:simple", false);
  assert.equal((await api("POST", previewPath, source({ hello: "Text" }, "ja"))).status, 400);
  assert.equal((await api("POST", previewPath, source({ hello: "Text" }))).status, 422);
  assert.equal((await api("POST", previewPath, { format: "android-xml", files: [{ name: "strings.xml", locale: "en", content: "<!DOCTYPE resources><resources/>" }] })).status, 400);
  assert.equal(repo.getTranslation(key, "en")!.value, "Hello {name}");
});

test("기존 JSON API는 호환되고 네이티브 미리보기의 추가 메타데이터도 500이 되지 않는다", async (t) => {
  const { api, repo } = await fixture(t);
  const body = { keys: [{ name: "legacy", translations: [{ locale: "en", value: "Legacy", state: "reviewed" }] }] };
  assert.equal((await api("POST", applyPath, body)).status, 200);
  assert.equal(repo.getTranslation(repo.getKeyByName("shop", "legacy")!.id, "en")!.state, "reviewed");
  const input = { format: "rynl10n", files: [{ name: "translations.json", content: JSON.stringify({ ...body, metadata: 1.5 }) }] };
  assert.equal((await api("POST", previewPath, input)).status, 200);
  const bad = { keys: [{ name: "__proto__", translations: [{ locale: "en", value: "Bad" }] }] };
  assert.equal((await api("POST", applyPath, bad)).status, 400);
});

test("미리보기·가져오기·정책 설정은 기존 RBAC와 프로젝트 스코프를 따른다", async (t) => {
  const { api } = await fixture(t);
  const input = source({ hello: "Hello" });
  assert.equal((await api("POST", previewPath, input, "")).status, 401);
  assert.equal((await api("POST", previewPath, input, "viewer")).status, 403);
  assert.equal((await api("POST", previewPath, input, "elsewhere")).status, 403);
  assert.equal((await api("POST", applyPath, input, "viewer")).status, 403);
  const body = { publishPolicy: { requireReviewed: true, requireDefaultLocale: true } };
  assert.equal((await api("PATCH", "/projects/shop", body)).status, 403);
  assert.equal((await api("PATCH", "/projects/shop", body, "viewer")).status, 403);
  const saved = await api("PATCH", "/projects/shop", body, "maintainer");
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.publishPolicy, body.publishPolicy);
  assert.equal((await api("PATCH", "/projects/shop", { publishPolicy: { requireReviewed: "true", requireDefaultLocale: true } }, "maintainer")).status, 400);
});

test("HTTP 게시 미리보기와 422 정책 오류는 같은 판정을 반환한다", async (t) => {
  const { api, repo, store } = await fixture(t);
  const key = repo.upsertKey("shop", "hello", "", false);
  repo.putTranslation("shop", key, "ko", "안녕", "draft");
  repo.createRelease("shop", "R1", "First", { strategy: "exact-label", value: "stable" }, "draft");
  repo.addReleaseKey("shop", "R1", key);
  await api("PATCH", "/projects/shop", { publishPolicy: { requireReviewed: true, requireDefaultLocale: true } }, "maintainer");
  const preview = await api("GET", "/projects/shop/releases/R1/changes", undefined, "viewer");
  assert.equal(preview.body.publishCheck.ok, false);
  const publish = await api("POST", "/projects/shop/releases/R1/publish", {}, "maintainer");
  assert.equal(publish.status, 422);
  assert.equal(publish.body.error.code, "publish_policy_failed");
  assert.deepEqual(publish.body.error.publishCheck, preview.body.publishCheck);
  assert.equal(store.readManifest("shop"), undefined);
  assert.equal(repo.getRelease("shop", "R1")!.state, "draft");
  repo.putTranslation("shop", key, "en", "Hello", "reviewed");
  repo.putTranslation("shop", key, "ko", "안녕", "reviewed");
  assert.equal((await api("POST", "/projects/shop/releases/R1/publish", {}, "maintainer")).status, 202);
});

test("프로젝트 생성·백업 복원은 정책을 검증하고 구 백업은 기본값으로 받는다", async (t) => {
  const { api, repo } = await fixture(t);
  const policy = { requireReviewed: true, requireDefaultLocale: false };
  assert.equal((await api("POST", "/projects", { id: "strict", name: "Strict", defaultLocale: "en", publishPolicy: policy }, "admin")).status, 201);
  assert.deepEqual(repo.getProject("strict")!.publishPolicy, policy);
  assert.equal((await api("POST", "/projects", { id: "invalid", name: "Invalid", defaultLocale: "en", publishPolicy: { requireReviewed: true } }, "admin")).status, 400);
  assert.equal(repo.getProject("invalid"), undefined);
  const exported = repo.exportProject("strict");
  const imported = { ...exported, project: { ...exported.project, id: "copy" } };
  assert.equal((await api("POST", "/projects/import", imported, "admin")).status, 201);
  assert.deepEqual(repo.getProject("copy")!.publishPolicy, policy);
  const old = { ...exported, project: { id: "old", name: "Old", defaultLocale: "en" } };
  assert.equal((await api("POST", "/projects/import", old, "admin")).status, 201);
  assert.deepEqual(repo.getProject("old")!.publishPolicy, { requireReviewed: false, requireDefaultLocale: false });
  const invalid = { ...exported, project: { ...exported.project, id: "bad-copy", publishPolicy: { requireReviewed: 1, requireDefaultLocale: false } } };
  assert.equal((await api("POST", "/projects/import", invalid, "admin")).status, 400);
  assert.equal(repo.getProject("bad-copy"), undefined);
});
