import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, applySchema } from "../src/db/schema.ts";
import { Repo, type ProjectExport } from "../src/db/repo.ts";
import { MemoryArtifactStore } from "../src/storage/store.ts";
import { publishRelease, publishReleaseJob, releaseChanges, rollbackRelease } from "../src/pipeline/publish.ts";
import { rebuildAllArtifacts } from "../src/admin/rebuild.ts";
import { checkPublishPolicy, requirePublishPolicy, PublishPolicyError } from "../src/pipeline/publish-policy.ts";
import { Metrics } from "../src/observability/metrics.ts";
import { Notifier } from "../src/observability/notifier.ts";
import { handleMcpMessage } from "../src/mcp/server.ts";
import type { Principal } from "../src/auth/rbac.ts";

const OPEN = { requireReviewed: false, requireDefaultLocale: false };
const STRICT = { requireReviewed: true, requireDefaultLocale: true };

function fixture() {
  const db = openDatabase();
  const repo = new Repo(db);
  const store = new MemoryArtifactStore();
  repo.createProject("shop", "Shop", "en", ["en", "ko", "ja"]);
  const key = repo.upsertKey("shop", "hello", "", false);
  repo.putTranslation("shop", key, "ko", "안녕", "draft");
  repo.createRelease("shop", "R1", "First", { strategy: "semver-range", value: ">=1.0.0" }, "draft");
  repo.addReleaseKey("shop", "R1", key);
  return { db, repo, store, key };
}

function publishedState(repo: Repo, store: MemoryArtifactStore, db: DatabaseSync) {
  return {
    releases: repo.listReleases("shop"), manifest: store.readManifest("shop"),
    history: repo.listManifestHistory("shop"), recovery: repo.listPublicationRecoveries(),
    audit: db.prepare("SELECT * FROM audit_log").all(),
  };
}

test("정책 기본값은 기존 draft·기본 로케일 누락 게시 동작을 유지한다", (t) => {
  const { db, repo, store } = fixture();
  t.after(() => db.close());
  assert.deepEqual(repo.getProject("shop")!.publishPolicy, OPEN);
  assert.deepEqual(repo.listProjects()[0]!.publishPolicy, OPEN);
  assert.deepEqual(releaseChanges(repo, store, "shop", "R1").publishCheck, { ok: true, policy: OPEN, issues: [] });
  publishRelease(repo, store, "shop", "R1", "pm");
  assert.equal(store.readManifest("shop")!.releases.length, 1);
});

test("검수 정책만 켜면 draft를 제외하지 않고 전체 게시를 막는다", (t) => {
  const { db, repo, store } = fixture();
  t.after(() => db.close());
  repo.setPublishPolicy("shop", { requireReviewed: true, requireDefaultLocale: false });
  const before = publishedState(repo, store, db);
  const preview = releaseChanges(repo, store, "shop", "R1").publishCheck;
  assert.deepEqual(preview.issues, [{ code: "unreviewed_translation", key: "hello", locale: "ko" }]);
  assert.throws(() => publishRelease(repo, store, "shop", "R1", "pm"), (e: unknown) => {
    assert.ok(e instanceof PublishPolicyError);
    assert.equal(e.status, 422);
    assert.deepEqual(e.publishCheck, preview);
    return true;
  });
  assert.deepEqual(publishedState(repo, store, db), before);
});

test("기본 로케일 정책은 해당 키의 기본 언어만 요구하고 다른 미번역 언어는 허용한다", (t) => {
  const { db, repo, store, key } = fixture();
  t.after(() => db.close());
  repo.setPublishPolicy("shop", { requireReviewed: false, requireDefaultLocale: true });
  assert.deepEqual(releaseChanges(repo, store, "shop", "R1").publishCheck.issues,
    [{ code: "default_locale_missing", key: "hello", locale: "en" }]);
  assert.throws(() => publishRelease(repo, store, "shop", "R1", "pm"), PublishPolicyError);
  repo.putTranslation("shop", key, "en", "Hello", "draft");
  publishRelease(repo, store, "shop", "R1", "pm");
  const snap = store.readSnapshot("shop", "R1", repo.getRelease("shop", "R1")!.overlay!)!;
  assert.equal(snap.locales.en!.hello, "Hello");
  assert.equal(snap.locales.ja, undefined);
});

test("두 정책의 문제를 함께 보여 주고 수정·검수 후 동일 릴리스를 게시한다", (t) => {
  const { db, repo, store, key } = fixture();
  t.after(() => db.close());
  repo.setPublishPolicy("shop", STRICT);
  assert.deepEqual(releaseChanges(repo, store, "shop", "R1").publishCheck.issues, [
    { code: "default_locale_missing", key: "hello", locale: "en" },
    { code: "unreviewed_translation", key: "hello", locale: "ko" },
  ]);
  repo.putTranslation("shop", key, "en", "Hello", "reviewed");
  repo.putTranslation("shop", key, "ko", "안녕", "reviewed");
  assert.equal(releaseChanges(repo, store, "shop", "R1").publishCheck.ok, true);
  publishRelease(repo, store, "shop", "R1", "pm");
});

test("릴리스 밖 키와 지원하지 않는 로케일의 초안은 정책 검사 대상이 아니다", (t) => {
  const { db, repo, store, key } = fixture();
  t.after(() => db.close());
  repo.putTranslation("shop", key, "en", "Hello", "reviewed");
  repo.putTranslation("shop", key, "ko", "안녕", "reviewed");
  repo.putTranslation("shop", key, "zz", "Unused", "draft");
  const outside = repo.upsertKey("shop", "outside", "", false);
  repo.putTranslation("shop", outside, "ko", "바깥", "draft");
  repo.setPublishPolicy("shop", STRICT);
  const check = checkPublishPolicy(repo, repo.getProject("shop")!, "R1");
  assert.equal(check.ok, true);
  publishRelease(repo, store, "shop", "R1", "pm");
});

test("기본 로케일의 의도한 빈 문자열은 누락이 아니다", (t) => {
  const { db, repo, store, key } = fixture();
  t.after(() => db.close());
  repo.putTranslation("shop", key, "en", "", "draft");
  repo.setPublishPolicy("shop", { requireReviewed: false, requireDefaultLocale: true });
  assert.equal(releaseChanges(repo, store, "shop", "R1").publishCheck.ok, true);
  publishRelease(repo, store, "shop", "R1", "pm");
});

test("재편집해 draft로 돌아간 값은 재게시 전에 다시 검수해야 한다", (t) => {
  const { db, repo, store, key } = fixture();
  t.after(() => db.close());
  repo.putTranslation("shop", key, "en", "Hello", "reviewed");
  repo.putTranslation("shop", key, "ko", "안녕", "reviewed");
  repo.setPublishPolicy("shop", STRICT);
  publishRelease(repo, store, "shop", "R1", "pm");
  const before = publishedState(repo, store, db);
  repo.putTranslation("shop", key, "ko", "반가워", "draft");
  assert.throws(() => publishRelease(repo, store, "shop", "R1", "pm"), PublishPolicyError);
  assert.deepEqual(publishedState(repo, store, db), before);
  repo.putTranslation("shop", key, "ko", "반가워", "reviewed");
  const result = publishRelease(repo, store, "shop", "R1", "pm");
  assert.notEqual(result.overlay, before.releases[0]!.overlay);
});

test("정책 위반 신규 게시가 이전 릴리스의 상한·상태·포인터를 바꾸지 않는다", (t) => {
  const { db, repo, store, key } = fixture();
  t.after(() => db.close());
  publishRelease(repo, store, "shop", "R1", "pm");
  repo.createRelease("shop", "R2", "Second", { strategy: "semver-range", value: ">=2.0.0" }, "draft");
  repo.addReleaseKey("shop", "R2", key);
  repo.setPublishPolicy("shop", STRICT);
  const before = publishedState(repo, store, db);
  assert.throws(() => publishRelease(repo, store, "shop", "R2", "pm"), PublishPolicyError);
  assert.deepEqual(publishedState(repo, store, db), before);
  assert.equal(repo.getRelease("shop", "R1")!.versionMatch.value, ">=1.0.0");
});

test("재생성도 모든 서빙 릴리스를 먼저 검사해 초안을 게시하는 우회를 막는다", (t) => {
  const { db, repo, store, key } = fixture();
  t.after(() => db.close());
  repo.putTranslation("shop", key, "en", "Hello", "reviewed");
  repo.putTranslation("shop", key, "ko", "안녕", "reviewed");
  publishRelease(repo, store, "shop", "R1", "pm");
  const pending = repo.upsertKey("shop", "pending", "", false);
  repo.putTranslation("shop", pending, "ko", "초안", "draft");
  repo.createRelease("shop", "R2", "Second", { strategy: "exact-label", value: "beta" }, "draft");
  repo.addReleaseKey("shop", "R2", pending);
  publishRelease(repo, store, "shop", "R2", "pm");
  repo.setPublishPolicy("shop", STRICT);
  const before = publishedState(repo, store, db);
  const write = store.writeSnapshot.bind(store);
  let snapshotWrites = 0;
  store.writeSnapshot = (...args) => { snapshotWrites++; return write(...args); };
  assert.throws(() => rebuildAllArtifacts(repo, store, "shop"), PublishPolicyError);
  assert.equal(snapshotWrites, 0, "뒤쪽 릴리스의 정책 위반도 첫 파일 쓰기 전에 발견해야 한다");
  assert.deepEqual(publishedState(repo, store, db), before);
  repo.putTranslation("shop", pending, "en", "Ready", "reviewed");
  repo.putTranslation("shop", pending, "ko", "검수 완료", "reviewed");
  rebuildAllArtifacts(repo, store, "shop");
  assert.equal(snapshotWrites, 2);
});

test("롤백은 현재 DB 초안과 무관하게 이미 게시한 불변 산출물로 복구한다", (t) => {
  const { db, repo, store, key } = fixture();
  t.after(() => db.close());
  repo.putTranslation("shop", key, "en", "Hello", "reviewed");
  repo.putTranslation("shop", key, "ko", "안녕", "reviewed");
  const first = publishRelease(repo, store, "shop", "R1", "pm");
  repo.putTranslation("shop", key, "ko", "반가워", "reviewed");
  publishRelease(repo, store, "shop", "R1", "pm");
  repo.setPublishPolicy("shop", STRICT);
  repo.putTranslation("shop", key, "ko", "다음 초안", "draft");
  assert.equal(releaseChanges(repo, store, "shop", "R1").publishCheck.ok, false);
  rollbackRelease(repo, store, "shop", "R1", first.base, "pm");
  assert.equal(repo.getRelease("shop", "R1")!.overlay, first.base);
  assert.equal(store.readSnapshot("shop", "R1", first.base)!.locales.ko!.hello, "안녕");
  assert.equal(repo.getTranslation(key, "ko")!.value, "다음 초안");
});

test("정책 위반은 error와 분리한 지표·실패 잡을 남기고 푸시하지 않는다", (t) => {
  const { db, repo, store } = fixture();
  t.after(() => db.close());
  repo.setPublishPolicy("shop", STRICT);
  const metrics = new Metrics();
  const notifier = new Notifier();
  let pushed = false;
  notifier.subscribe("shop", () => { pushed = true; });
  assert.throws(() => publishReleaseJob({ repo, store, metrics, notifier }, "shop", "R1", "pm"), PublishPolicyError);
  assert.match(metrics.render(), /rynl10n_publish_total\{result="policy"\} 1/);
  assert.doesNotMatch(metrics.render(), /result="error"/);
  assert.equal(db.prepare("SELECT state FROM jobs").get()!.state, "failed");
  assert.equal(pushed, false);
  assert.equal(store.readManifest("shop"), undefined);
  assert.deepEqual(repo.listPublicationRecoveries(), []);
});

test("정책은 boolean 둘만 허용하며 누락·오타·문자열·임의 필드를 거절한다", () => {
  assert.deepEqual(requirePublishPolicy(STRICT), STRICT);
  for (const bad of [null, [], true, {}, { requireReviewed: true },
    { requireReviewed: "true", requireDefaultLocale: true },
    { ...STRICT, extra: false }, { requireReview: true, requireDefaultLocale: true }, Object.create(STRICT)]) {
    assert.throws(() => requirePublishPolicy(bad), (e: unknown) => (e as { status?: number }).status === 400);
  }
});

test("정책은 파일 DB 재시작·export/import에서 보존되고 구 백업에는 기본값을 준다", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rynl10n-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "db.sqlite");
  const originalDb = openDatabase(path);
  const original = new Repo(originalDb);
  original.createProject("shop", "Shop", "en", ["en"]);
  original.setPublishPolicy("shop", STRICT);
  originalDb.close();
  const reopenedDb = openDatabase(path);
  t.after(() => reopenedDb.close());
  const reopened = new Repo(reopenedDb);
  assert.deepEqual(reopened.getProject("shop")!.publishPolicy, STRICT);
  const exported = reopened.exportProject("shop");
  assert.deepEqual(exported.project.publishPolicy, STRICT);
  const restoredDb = openDatabase();
  t.after(() => restoredDb.close());
  const restored = new Repo(restoredDb);
  restored.importProject(exported);
  assert.deepEqual(restored.getProject("shop")!.publishPolicy, STRICT);
  const { publishPolicy: _unused, ...legacyProject } = exported.project;
  const legacy: ProjectExport = { ...exported, project: { ...legacyProject, id: "legacy" } };
  restored.importProject(legacy);
  assert.deepEqual(restored.getProject("legacy")!.publishPolicy, OPEN);
});

test("구 스키마 마이그레이션은 기존 데이터에 기본값을 주며 두 번 적용해도 정책을 보존한다", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,default_locale TEXT NOT NULL)");
  db.exec("INSERT INTO projects(id,name,default_locale) VALUES('shop','Shop','en')");
  applySchema(db);
  const repo = new Repo(db);
  assert.deepEqual(repo.getProject("shop")!.publishPolicy, OPEN);
  repo.setPublishPolicy("shop", STRICT);
  applySchema(db);
  assert.deepEqual(repo.getProject("shop")!.publishPolicy, STRICT);
});

test("잘못된 백업 정책은 복원을 일부만 적용하지 않는다", (t) => {
  const { db, repo } = fixture();
  t.after(() => db.close());
  const exported = repo.exportProject("shop");
  const restoredDb = openDatabase();
  t.after(() => restoredDb.close());
  const restored = new Repo(restoredDb);
  const malformed = { ...exported, project: { ...exported.project, publishPolicy: { requireReviewed: 1, requireDefaultLocale: true } } };
  assert.throws(() => restored.importProject(malformed as unknown as ProjectExport), (e: unknown) => (e as { status?: number }).status === 400);
  assert.deepEqual(restored.listProjects(), []);
});

test("MCP 게시도 동일한 정책 사유를 isError 결과로 전달한다", (t) => {
  const { db, repo, store } = fixture();
  t.after(() => db.close());
  repo.setPublishPolicy("shop", STRICT);
  const expected = releaseChanges(repo, store, "shop", "R1").publishCheck;
  const principal: Principal = { actor: "pm", role: "maintainer", projects: "*" };
  const result = handleMcpMessage({ repo, store, metrics: new Metrics(), notifier: new Notifier() }, principal,
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "publish_release", arguments: { project: "shop", release: "R1" } } }) as any;
  assert.equal(result.result.isError, true);
  assert.equal(result.result.structuredContent.error.code, "publish_policy_failed");
  assert.deepEqual(result.result.structuredContent.error.publishCheck, expected);
  assert.match(result.result.content[0].text, /미검수 번역: hello\(ko\)/);
});
