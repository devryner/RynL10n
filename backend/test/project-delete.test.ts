/**
 * DELETE /projects/{p} — 프로젝트 완전 삭제(7.1).
 *
 * 지키려는 계약:
 *   ① published 릴리스가 있으면 409 — 현장 SDK의 원격 갱신이 실수로 끊기지 않게
 *   ② DB 하위 엔티티가 남지 않는다 (FK 카스케이드가 닿지 않는 jobs·telemetry·audit_log 포함)
 *   ③ 배포 플레인 산출물도 함께 사라진다 — 정적 서빙이라 남으면 유령 프로젝트가 계속 응답한다
 *   ④ Admin 전용
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "../src/db/schema.ts";
import { Repo } from "../src/db/repo.ts";
import { MemoryArtifactStore, FsArtifactStore } from "../src/storage/store.ts";
import { TokenRegistry } from "../src/auth/rbac.ts";
import { createManagementHandler } from "../src/api/server.ts";

const ADMIN = "t-admin";
const MAINT = "t-maint";

interface Harness {
  base: string;
  repo: Repo;
  db: DatabaseSync;
  store: MemoryArtifactStore;
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const db = openDatabase();
  const repo = new Repo(db);
  const store = new MemoryArtifactStore();
  const tokens = new TokenRegistry();
  tokens.issue(ADMIN, { actor: "admin", role: "admin", projects: "*" });
  tokens.issue(MAINT, { actor: "mnt", role: "maintainer", projects: "*" });

  const server: Server = createServer(createManagementHandler({ repo, store, tokens }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    repo, db, store,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function api(base: string, method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const init: RequestInit = {
    method,
    headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await fetch(base + path, init);
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

/** 키 1개 + 번역 + 릴리스를 갖춘 프로젝트를 만든다. publish는 호출자가 선택. */
async function seed(base: string, id = "shop") {
  await api(base, "POST", "/projects", { token: ADMIN, body: { id, name: "Shop", defaultLocale: "en", locales: ["ko"] } });
  await api(base, "PUT", `/projects/${id}/keys/home.title`, { token: ADMIN, body: { description: "홈 제목" } });
  await api(base, "PUT", `/projects/${id}/translations/home.title/en`, { token: ADMIN, body: { value: "Home" } });
  await api(base, "POST", `/projects/${id}/releases`, {
    token: ADMIN,
    body: { name: "1.x", versionMatch: { strategy: "semver-range", value: ">=1.0.0 <2.0.0" }, keys: ["home.title"] },
  });
}

test("Admin은 draft 상태 프로젝트를 삭제한다", async () => {
  const h = await harness();
  try {
    await seed(h.base);
    const del = await api(h.base, "DELETE", "/projects/shop", { token: ADMIN });
    assert.equal(del.status, 200);
    assert.equal(del.body.deleted, true);
    assert.deepEqual(del.body.removed, { keys: 1, releases: 1, locales: 2 });

    assert.equal((await api(h.base, "GET", "/projects/shop", { token: ADMIN })).status, 404);
    assert.deepEqual((await api(h.base, "GET", "/projects", { token: ADMIN })).body.projects, []);
  } finally { await h.close(); }
});

test("published 릴리스가 있으면 409로 막고 아무것도 지우지 않는다", async () => {
  const h = await harness();
  try {
    await seed(h.base);
    await api(h.base, "POST", "/projects/shop/releases/R1/publish", { token: ADMIN });

    const del = await api(h.base, "DELETE", "/projects/shop", { token: ADMIN });
    assert.equal(del.status, 409);
    assert.equal(del.body.error.code, "conflict");
    assert.match(del.body.error.message, /R1/);

    // 프로젝트도 산출물도 그대로여야 한다.
    assert.equal((await api(h.base, "GET", "/projects/shop", { token: ADMIN })).status, 200);
    assert.ok(h.store.readManifest("shop"), "manifest가 사라졌다");
  } finally { await h.close(); }
});

test("archive 하면 삭제할 수 있다", async () => {
  const h = await harness();
  try {
    await seed(h.base);
    await api(h.base, "POST", "/projects/shop/releases/R1/publish", { token: ADMIN });
    assert.equal((await api(h.base, "DELETE", "/projects/shop", { token: ADMIN })).status, 409);

    await api(h.base, "PATCH", "/projects/shop/releases/R1", { token: ADMIN, body: { state: "archived" } });
    assert.equal((await api(h.base, "DELETE", "/projects/shop", { token: ADMIN })).status, 200);
  } finally { await h.close(); }
});

test("배포 플레인 산출물도 함께 사라진다", async () => {
  const h = await harness();
  try {
    await seed(h.base);
    await api(h.base, "POST", "/projects/shop/releases/R1/publish", { token: ADMIN });
    assert.ok(h.store.readManifest("shop"), "사전 조건: publish 됐어야 한다");

    await api(h.base, "PATCH", "/projects/shop/releases/R1", { token: ADMIN, body: { state: "archived" } });
    await api(h.base, "DELETE", "/projects/shop", { token: ADMIN });

    // 남아 있으면 배포 플레인이 지워진 프로젝트의 manifest를 계속 서빙한다.
    assert.equal(h.store.readManifest("shop"), undefined, "manifest가 남았다");
    assert.equal(h.store.readSnapshot("shop", "R1", "any"), undefined);
  } finally { await h.close(); }
});

test("FK가 닿지 않는 jobs·telemetry·audit_log도 남지 않는다", async () => {
  const h = await harness();
  try {
    await seed(h.base);
    // 카스케이드가 닿지 않는 세 테이블에 행을 만든다.
    h.repo.createJob("job-1", "shop", "publish");
    h.repo.addTelemetry("shop", "R1", "apply", "1.0.0", 3);
    h.repo.audit("shop", "someone", "test.action", { x: 1 });

    const count = (table: string): number =>
      (h.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id=?`).get("shop") as { n: number }).n;
    assert.ok(count("jobs") > 0 && count("telemetry") > 0 && count("audit_log") > 0, "사전 조건");

    await api(h.base, "DELETE", "/projects/shop", { token: ADMIN });

    for (const table of ["jobs", "telemetry", "audit_log", "keys", "translations", "releases", "locales"]) {
      assert.equal(count(table), 0, `${table}에 고아 행이 남았다`);
    }
  } finally { await h.close(); }
});

test("같은 id로 다시 만들어도 이전 이력이 딸려오지 않는다", async () => {
  const h = await harness();
  try {
    await seed(h.base);
    h.repo.audit("shop", "someone", "old.action", {});
    await api(h.base, "DELETE", "/projects/shop", { token: ADMIN });

    await api(h.base, "POST", "/projects", { token: ADMIN, body: { id: "shop", name: "새 Shop", defaultLocale: "en" } });
    const keys = await api(h.base, "GET", "/projects/shop/keys", { token: ADMIN });
    assert.deepEqual(keys.body.keys, [], "이전 키가 살아 있다");
    const n = (h.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE project_id=?").get("shop") as { n: number }).n;
    assert.equal(n, 0, "이전 감사 로그가 남았다");
  } finally { await h.close(); }
});

test("Admin 아니면 403, 없는 프로젝트는 404", async () => {
  const h = await harness();
  try {
    await seed(h.base);
    assert.equal((await api(h.base, "DELETE", "/projects/shop", { token: MAINT })).status, 403);
    assert.equal((await api(h.base, "DELETE", "/projects/shop")).status, 401);
    assert.equal((await api(h.base, "GET", "/projects/shop", { token: ADMIN })).status, 200, "403/401인데 지워졌다");
    assert.equal((await api(h.base, "DELETE", "/projects/nope", { token: ADMIN })).status, 404);
  } finally { await h.close(); }
});

// ── FsArtifactStore: 실제 파일 삭제와 경로 순회 가드 ──────────────────────────

test("FsArtifactStore.deleteProject는 프로젝트 트리만 지운다", () => {
  const root = mkdtempSync(join(tmpdir(), "rynl-store-"));
  const store = new FsArtifactStore(root);
  store.writeManifest("shop", { schemaVersion: 1, project: "shop", defaultLocale: "en", releases: [], updatedAt: "" } as never);
  store.writeManifest("other", { schemaVersion: 1, project: "other", defaultLocale: "en", releases: [], updatedAt: "" } as never);

  store.deleteProject("shop");

  assert.equal(existsSync(join(root, "shop")), false, "대상이 남았다");
  assert.equal(existsSync(join(root, "other")), true, "남의 프로젝트를 지웠다");
});

test("산출물이 없는 프로젝트를 지워도 실패하지 않는다", () => {
  const store = new FsArtifactStore(mkdtempSync(join(tmpdir(), "rynl-store-")));
  assert.doesNotThrow(() => store.deleteProject("never-published"));
});

test("스토리지 루트가 비면 생성 자체를 거부한다", () => {
  // 루트가 ""이면 join("", project, ...)이 cwd 기준 상대경로가 되어, deleteProject("src")가
  // 프로젝트 트리가 아니라 작업 디렉토리의 ./src를 재귀 삭제한다. 프로젝트 id 가드는
  // 세그먼트만 보므로 여기서 걸러야 한다(빈 RYNL10N_STORAGE가 실제 유입 경로).
  for (const bad of ["", " ", "\t"]) {
    assert.throws(() => new FsArtifactStore(bad), /스토리지 루트/, `막지 못함: ${JSON.stringify(bad)}`);
  }
});

test("경로 순회가 가능한 프로젝트 id는 거부한다", () => {
  const root = mkdtempSync(join(tmpdir(), "rynl-store-"));
  const store = new FsArtifactStore(root);
  // 통과하면 스토리지 루트 밖을 재귀 삭제하게 된다.
  for (const evil of ["..", "../..", "a/../..", "/etc", "a\\b", ""]) {
    assert.throws(() => store.deleteProject(evil), /프로젝트 id/, `막지 못함: ${JSON.stringify(evil)}`);
  }
  // 쓰기 경로도 같은 가드를 탄다.
  assert.throws(() => store.writeManifest("../escape", {} as never), /프로젝트 id/);
});
