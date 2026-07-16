import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { openDatabase } from "../src/db/schema.ts";
import { Repo } from "../src/db/repo.ts";
import { MemoryArtifactStore } from "../src/storage/store.ts";
import { TokenRegistry } from "../src/auth/rbac.ts";
import { createManagementServer } from "../src/api/server.ts";
import { publishRelease } from "../src/pipeline/publish.ts";
import { rebuildAllArtifacts } from "../src/admin/rebuild.ts";
import { canonicalStringify } from "../../src/serialize/jcs.ts";

// ── 관측성 (HTTP) ─────────────────────────────────────────────────────────────
let base = "";
let server: ReturnType<typeof createManagementServer>;
const ADMIN = "t-admin";

before(async () => {
  const repo = new Repo(openDatabase());
  const tokens = new TokenRegistry();
  tokens.issue(ADMIN, { actor: "admin", role: "admin", projects: "*" });
  server = createManagementServer({ repo, store: new MemoryArtifactStore(), tokens });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function api(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any; text?: string }> {
  const init: RequestInit = { method, headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await fetch(base + path, init);
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("json")) return { status: res.status, body: await res.json().catch(() => null) };
  return { status: res.status, body: null, text: await res.text() };
}

test("메트릭: publish 후 /metrics에 publish_total 노출 (9.3)", async () => {
  await api("POST", "/projects", { token: ADMIN, body: { id: "shop", name: "S", defaultLocale: "en", locales: ["en"] } });
  await api("PUT", "/projects/shop/keys/a", { token: ADMIN });
  await api("PUT", "/projects/shop/translations/a/en", { token: ADMIN, body: { value: "A" } });
  await api("POST", "/projects/shop/releases", { token: ADMIN, body: { id: "R1", name: "v1", versionMatch: { strategy: "semver-range", value: ">=1.0.0" }, keys: ["a"] } });
  const pub = await api("POST", "/projects/shop/releases/R1/publish", { token: ADMIN });
  assert.equal(pub.status, 202);

  const metrics = await api("GET", "/metrics");
  assert.match(metrics.text!, /rynl10n_publish_total\{result="success"\} 1/);
  assert.match(metrics.text!, /rynl10n_api_requests_total/);
});

test("텔레메트리: 유효 이벤트 집계 + PII 필드 거부(프라이버시 가드, 9.3)", async () => {
  const ok = await api("POST", "/projects/shop/telemetry", { body: [
    { projectId: "shop", releaseId: "R1", event: "overlay_applied", count: 90, appVersionBucket: "1.0" },
    { projectId: "shop", releaseId: "R1", event: "format_guard_rejected", count: 10, appVersionBucket: "1.0" },
  ] });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.accepted, 2);

  // 정의되지 않은 필드(예: 기기 식별자) → 거부
  const pii = await api("POST", "/projects/shop/telemetry", { body: [
    { projectId: "shop", releaseId: "R1", event: "overlay_applied", count: 1, appVersionBucket: "1.0", deviceId: "abc-123" },
  ] });
  assert.equal(pii.body.accepted, 0);
  assert.equal(pii.body.rejected, 1);

  // 텔레메트리는 인증 없이(익명) 수집
  const health = await api("GET", "/projects/shop/releases/R1/health", { token: ADMIN });
  assert.equal(health.status, 200);
  assert.ok(Math.abs(health.body.formatGuardRejectedRate - 0.1) < 1e-9); // 10/(90+10)
});

// ── 데이터 이식성 + 결정적 재생성 (9.2 / 9.4) ─────────────────────────────────
function seedAndPublish() {
  const repo = new Repo(openDatabase());
  const store = new MemoryArtifactStore();
  repo.createProject("shop", "Shop", "en", ["en", "ja"]);
  const pay = repo.upsertKey("shop", "pay.button", "", false);
  repo.putTranslation("shop", pay, "en", "Pay", "reviewed");
  repo.putTranslation("shop", pay, "ja", "支払―", "reviewed");
  repo.createRelease("shop", "R42", "v3.2", { strategy: "semver-range", value: ">=3.2.0" }, "draft");
  repo.addReleaseKey("shop", "R42", pay);
  publishRelease(repo, store, "shop", "R42", "pm");
  // 편집 → 델타 유발
  repo.putTranslation("shop", pay, "ja", "支払い", "reviewed");
  publishRelease(repo, store, "shop", "R42", "pm");
  return { repo, store };
}

test("export → 빈 DB import → 재생성 산출물이 원본과 바이트 동일 (9.2/9.4)", () => {
  const { repo } = seedAndPublish();
  const exported = repo.exportProject("shop");

  // 새 DB에 import(재해 복구 / 이관)
  const repo2 = new Repo(openDatabase());
  repo2.importProject(exported);

  // 양쪽 모두 DB만으로 산출물 재생성
  const storeA = new MemoryArtifactStore();
  const storeB = new MemoryArtifactStore();
  const mA = rebuildAllArtifacts(repo, storeA, "shop");
  const mB = rebuildAllArtifacts(repo2, storeB, "shop");

  const baseA = mA.releases[0]!.base;
  assert.equal(baseA, mB.releases[0]!.base, "재생성 base 해시가 이관 후에도 동일(결정성)");
  // 스냅샷 바이트 동일
  const snapA = canonicalStringify(storeA.readSnapshot("shop", "R42", baseA));
  const snapB = canonicalStringify(storeB.readSnapshot("shop", "R42", baseA));
  assert.equal(snapA, snapB);
});

test("재생성 결정성: 두 번 rebuild → 동일, 현재 상태(overlay)로 재베이스라인 (9.4)", () => {
  const { repo, store } = seedAndPublish();
  const overlayBefore = repo.getRelease("shop", "R42")!.overlay!;

  const m1 = rebuildAllArtifacts(repo, store, "shop");
  const m2 = rebuildAllArtifacts(repo, store, "shop");
  assert.equal(m1.releases[0]!.base, m2.releases[0]!.base);
  // 재생성은 현재 카탈로그(=overlay 상태)를 base로 재베이스라인
  assert.equal(m1.releases[0]!.base, overlayBefore);
  assert.equal(m1.releases[0]!.base, m1.releases[0]!.overlay);
});
