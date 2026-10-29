import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/schema.ts";
import { Repo } from "../src/db/repo.ts";
import { FsArtifactStore, MemoryArtifactStore } from "../src/storage/store.ts";
import type { ArtifactStore } from "../src/storage/store.ts";
import { publishRelease, publishReleaseJob, rollbackRelease } from "../src/pipeline/publish.ts";
import { rebuildAllArtifacts } from "../src/admin/rebuild.ts";
import { createManagementHandler } from "../src/api/server.ts";
import { TokenRegistry } from "../src/auth/rbac.ts";
import { Metrics } from "../src/observability/metrics.ts";
import { Notifier } from "../src/observability/notifier.ts";
import type { Delta, Manifest, Snapshot } from "../../src/core/types.ts";

class FaultStore extends MemoryArtifactStore {
  failure: "snapshot" | "delta" | "manifest" | "after-manifest" | undefined;
  private fail(at: typeof this.failure): void {
    if (this.failure !== at) return;
    this.failure = undefined;
    throw new Error(`storage failed: ${at}`);
  }
  override writeSnapshot(project: string, release: string, snap: Snapshot): string {
    this.fail("snapshot");
    return super.writeSnapshot(project, release, snap);
  }
  override writeDelta(project: string, release: string, delta: Delta): string {
    this.fail("delta");
    return super.writeDelta(project, release, delta);
  }
  override writeManifest(project: string, manifest: Manifest): void {
    this.fail("manifest");
    super.writeManifest(project, manifest);
    this.fail("after-manifest");
  }
}

function seed() {
  const db = openDatabase();
  const repo = new Repo(db);
  const store = new FaultStore();
  repo.createProject("shop", "Shop", "en", ["en"]);
  const key = repo.upsertKey("shop", "hello", "", false);
  repo.putTranslation("shop", key, "en", "Original", "reviewed");
  repo.createRelease("shop", "R1", "First", { strategy: "semver-range", value: ">=1.0.0" }, "draft");
  repo.addReleaseKey("shop", "R1", key);
  return { db, repo, store, key };
}

function state(repo: Repo, store: ArtifactStore) {
  return {
    releases: repo.listReleases("shop"),
    manifest: store.readManifest("shop"),
    history: repo.listManifestHistory("shop"),
  };
}

for (const failure of ["snapshot", "manifest", "after-manifest"] as const) {
  test(`첫 게시 ${failure} 실패는 draft·빈 배포 상태 유지, 재시도 가능`, (t) => {
    const { db, repo, store } = seed();
    t.after(() => db.close());
    const before = state(repo, store);
    store.failure = failure;
    assert.throws(() => publishRelease(repo, store, "shop", "R1", "pm"), /storage failed/);
    assert.deepEqual(state(repo, store), before);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log").get()!.n, 0);
    publishRelease(repo, store, "shop", "R1", "pm");
    assert.equal(repo.getRelease("shop", "R1")!.state, "published");
    assert.equal(store.readManifest("shop")!.releases[0]!.overlay, repo.getRelease("shop", "R1")!.overlay);
  });
}

for (const failure of ["snapshot", "manifest", "after-manifest"] as const) {
  test(`신규 릴리스 ${failure} 실패는 이전 릴리스의 상한·상태까지 되돌린다`, (t) => {
    const { db, repo, store, key } = seed();
    t.after(() => db.close());
    publishRelease(repo, store, "shop", "R1", "pm");
    repo.createRelease("shop", "R2", "Second", { strategy: "semver-range", value: ">=2.0.0" }, "draft");
    repo.addReleaseKey("shop", "R2", key);
    const before = state(repo, store);
    store.failure = failure;
    assert.throws(() => publishRelease(repo, store, "shop", "R2", "pm"), /storage failed/);
    assert.deepEqual(state(repo, store), before);
    publishRelease(repo, store, "shop", "R2", "pm");
    assert.equal(repo.getRelease("shop", "R1")!.versionMatch.value, ">=1.0.0 <2.0.0");
  });
}

for (const failure of ["delta", "manifest", "after-manifest"] as const) {
  test(`재게시 ${failure} 실패는 포인터·배포본·이력 유지, 재시도 시 새 번역 게시`, (t) => {
    const { db, repo, store, key } = seed();
    t.after(() => db.close());
    publishRelease(repo, store, "shop", "R1", "pm");
    repo.putTranslation("shop", key, "en", "Edited", "reviewed");
    const before = state(repo, store);
    store.failure = failure;
    assert.throws(() => publishRelease(repo, store, "shop", "R1", "pm"), /storage failed/);
    assert.deepEqual(state(repo, store), before);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log").get()!.n, 1);
    const result = publishRelease(repo, store, "shop", "R1", "pm");
    assert.notEqual(result.overlay, before.releases[0]!.overlay);
    assert.equal(store.readSnapshot("shop", "R1", result.overlay)!.locales.en!.hello, "Edited");
  });
}

test("감사 기록 DB 오류도 게시 상태·배포본·이력을 되돌린다", (t) => {
  const { db, repo, store, key } = seed();
  t.after(() => db.close());
  publishRelease(repo, store, "shop", "R1", "pm");
  repo.putTranslation("shop", key, "en", "Edited", "reviewed");
  const before = state(repo, store);
  db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(FAIL, 'audit failed'); END");
  assert.throws(() => publishRelease(repo, store, "shop", "R1", "pm"), /audit failed/);
  assert.deepEqual(state(repo, store), before);
});

test("롤백 manifest 실패는 현재 overlay를 유지한다", (t) => {
  const { db, repo, store, key } = seed();
  t.after(() => db.close());
  const first = publishRelease(repo, store, "shop", "R1", "pm");
  repo.putTranslation("shop", key, "en", "Edited", "reviewed");
  publishRelease(repo, store, "shop", "R1", "pm");
  const before = state(repo, store);
  store.failure = "manifest";
  assert.throws(() => rollbackRelease(repo, store, "shop", "R1", first.base, "pm"), /storage failed/);
  assert.deepEqual(state(repo, store), before);
  rollbackRelease(repo, store, "shop", "R1", first.base, "pm");
  assert.equal(repo.getRelease("shop", "R1")!.overlay, first.base);
});

test("재생성 manifest 실패는 모든 릴리스 포인터를 유지한다", (t) => {
  const { db, repo, store, key } = seed();
  t.after(() => db.close());
  publishRelease(repo, store, "shop", "R1", "pm");
  repo.createRelease("shop", "R2", "Second", { strategy: "semver-range", value: ">=2.0.0" }, "draft");
  repo.addReleaseKey("shop", "R2", key);
  publishRelease(repo, store, "shop", "R2", "pm");
  repo.putTranslation("shop", key, "en", "Edited", "reviewed");
  const before = state(repo, store);
  store.failure = "manifest";
  assert.throws(() => rebuildAllArtifacts(repo, store, "shop"), /storage failed/);
  assert.deepEqual(state(repo, store), before);
  rebuildAllArtifacts(repo, store, "shop");
  assert.equal(repo.getRelease("shop", "R1")!.base, store.readManifest("shop")!.releases[0]!.base);
});

test("manifest 교체 후 DB COMMIT 실패도 이전 배포본을 복원한다", (t) => {
  const { db, repo, store, key } = seed();
  t.after(() => db.close());
  publishRelease(repo, store, "shop", "R1", "pm");
  repo.putTranslation("shop", key, "en", "Edited", "reviewed");
  const before = state(repo, store);
  const audit = repo.audit.bind(repo);
  repo.audit = (...args) => {
    audit(...args);
    // 실제 SQLite가 COMMIT에서 거부하게 한다 — 파일 교체 전에는 실패하지 않는다.
    db.exec("PRAGMA defer_foreign_keys=ON; INSERT INTO locales(project_id,tag) VALUES('missing-project','en')");
  };
  assert.throws(() => publishRelease(repo, store, "shop", "R1", "pm"), /FOREIGN KEY constraint failed/);
  assert.deepEqual(state(repo, store), before);
  assert.deepEqual(repo.listPublicationRecoveries(), []);
  repo.audit = audit;
  publishRelease(repo, store, "shop", "R1", "pm");
});

test("잡 완료 기록 실패도 게시를 되돌리고 실패한 잡으로 남긴다", (t) => {
  const { db, repo, store } = seed();
  t.after(() => db.close());
  const before = state(repo, store);
  db.exec("CREATE TRIGGER fail_done BEFORE UPDATE ON jobs WHEN NEW.state='done' BEGIN SELECT RAISE(FAIL, 'job failed'); END");
  assert.throws(() => publishReleaseJob({ repo, store, metrics: new Metrics(), notifier: new Notifier() }, "shop", "R1", "pm"), /job failed/);
  assert.deepEqual(state(repo, store), before);
  assert.equal(db.prepare("SELECT state FROM jobs").get()!.state, "failed");
});

test("알림 구독자 예외가 성공한 게시·잡을 실패로 바꾸지 않는다", (t) => {
  const { db, repo, store } = seed();
  t.after(() => db.close());
  const notifier = new Notifier();
  notifier.subscribe("shop", () => { throw new Error("subscriber failed"); });
  let observed = 0;
  notifier.subscribe("shop", () => { observed++; });
  const result = publishReleaseJob({ repo, store, metrics: new Metrics(), notifier }, "shop", "R1", "pm");
  assert.equal(observed, 1);
  assert.equal(repo.getJob(result.jobId)!.state, "done");
  assert.equal(store.readManifest("shop")!.releases[0]!.overlay, result.overlay);
});

test("복원도 실패하면 복구 표식을 보존하고 시작·재게시 전에 다시 복원한다", (t) => {
  const { db, repo, store, key } = seed();
  t.after(() => db.close());
  publishRelease(repo, store, "shop", "R1", "pm");
  const previous = store.readManifest("shop");
  repo.putTranslation("shop", key, "en", "Edited", "reviewed");
  const write = store.writeManifest.bind(store);
  store.writeManifest = () => { throw new Error("storage offline"); };
  assert.throws(() => publishRelease(repo, store, "shop", "R1", "pm"), AggregateError);
  assert.equal(repo.listPublicationRecoveries().length, 1);
  assert.throws(() => createManagementHandler({ repo, store, tokens: new TokenRegistry() }), /storage offline/);
  assert.equal(repo.listPublicationRecoveries().length, 1);
  store.writeManifest = write;
  createManagementHandler({ repo, store, tokens: new TokenRegistry() });
  assert.deepEqual(store.readManifest("shop"), previous);
  assert.deepEqual(repo.listPublicationRecoveries(), []);
  publishRelease(repo, store, "shop", "R1", "pm");
  assert.notEqual(store.readManifest("shop")!.releases[0]!.overlay, previous!.releases[0]!.overlay);
});

for (const initiallyPublished of [false, true]) {
  test(`manifest 교체 직후 프로세스 중단 → 시작 시 ${initiallyPublished ? "이전 배포본 복원" : "첫 게시 파일 제거"}`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "rynl10n-publish-crash-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const dbPath = join(root, "db.sqlite");
    const storagePath = join(root, "artifacts");
    const db = openDatabase(dbPath);
    const repo = new Repo(db);
    const store = new FsArtifactStore(storagePath);
    repo.createProject("shop", "Shop", "en", ["en"]);
    const key = repo.upsertKey("shop", "hello", "", false);
    repo.putTranslation("shop", key, "en", "Original", "reviewed");
    repo.createRelease("shop", "R1", "First", { strategy: "exact-label", value: "stable" }, "draft");
    repo.addReleaseKey("shop", "R1", key);
    if (initiallyPublished) publishRelease(repo, store, "shop", "R1", "pm");
    const before = state(repo, store);
    repo.putTranslation("shop", key, "en", "Edited", "reviewed");
    db.close();

    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { openDatabase } from ${JSON.stringify(new URL("../src/db/schema.ts", import.meta.url).href)};
      import { Repo } from ${JSON.stringify(new URL("../src/db/repo.ts", import.meta.url).href)};
      import { FsArtifactStore } from ${JSON.stringify(new URL("../src/storage/store.ts", import.meta.url).href)};
      import { publishReleaseJob } from ${JSON.stringify(new URL("../src/pipeline/publish.ts", import.meta.url).href)};
      import { Metrics } from ${JSON.stringify(new URL("../src/observability/metrics.ts", import.meta.url).href)};
      import { Notifier } from ${JSON.stringify(new URL("../src/observability/notifier.ts", import.meta.url).href)};
      class InterruptedStore extends FsArtifactStore {
        writeManifest(project, manifest) {
          super.writeManifest(project, manifest);
          process.kill(process.pid, 'SIGKILL');
        }
      }
      publishReleaseJob({ repo: new Repo(openDatabase(process.argv[1])), store: new InterruptedStore(process.argv[2]), metrics: new Metrics(), notifier: new Notifier() }, 'shop', 'R1', 'pm');
    `, dbPath, storagePath], { encoding: "utf8", timeout: 15_000 });
    assert.equal(child.signal, "SIGKILL", child.stderr);

    const reopenedDb = openDatabase(dbPath);
    t.after(() => reopenedDb.close());
    const reopened = new Repo(reopenedDb);
    assert.equal(reopened.listPublicationRecoveries().length, 1);
    const interruptedJobId = reopened.listPublicationRecoveries()[0]!.jobId!;
    assert.equal(reopened.getJob(interruptedJobId)!.state, "pending");
    assert.notDeepEqual(store.readManifest("shop"), before.manifest, "중단 지점에 새 파일은 이미 배포됐다");
    // 미게시 DB 편집을 새로 컴파일하면 안 된다 — 기록된 직전 배포본만 복원한다.
    createManagementHandler({ repo: reopened, store, tokens: new TokenRegistry() });
    assert.deepEqual(state(reopened, store), before);
    assert.deepEqual(reopened.listPublicationRecoveries(), []);
    assert.equal(reopened.getJob(interruptedJobId)!.state, "failed");
    publishRelease(reopened, store, "shop", "R1", "pm");
    assert.equal(store.readSnapshot("shop", "R1", reopened.getRelease("shop", "R1")!.overlay!)!.locales.en!.hello, "Edited");
  });
}
