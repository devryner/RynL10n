import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { openDatabase } from "../../../backend/src/db/schema.ts";
import { Repo } from "../../../backend/src/db/repo.ts";
import { FsArtifactStore } from "../../../backend/src/storage/store.ts";
import { TokenRegistry } from "../../../backend/src/auth/rbac.ts";
import { Notifier } from "../../../backend/src/observability/notifier.ts";
import { createManagementServer } from "../../../backend/src/api/server.ts";
import { RynL10nClient, type DeliveryStore } from "../../../src/client/client.ts";
import { HttpRynL10n } from "../src/http.ts";
import { TelemetryReporter, versionBucket } from "../src/telemetry.ts";
import type { Manifest, Snapshot } from "../../../src/core/types.ts";

const BUNDLE: Snapshot = {
  schemaVersion: 1, release: "R42", base: "b0", defaultLocale: "en",
  locales: { en: { "pay.button": "Pay" } },
};

const MANIFEST: Manifest = {
  schemaVersion: 1, project: "demo", defaultLocale: "en", updatedAt: "2026-08-20T00:00:00Z",
  releases: [{
    id: "R42", state: "published",
    versionMatch: { strategy: "semver-range", value: ">=1.0.0 <2.0.0" },
    base: "b0", overlay: "b0", rollout: 100, snapshot: "releases/R42/snapshot-b0.json",
  }],
};

const emptyStore: DeliveryStore = { getSnapshot: () => undefined, getDelta: () => undefined };

/** 릴리스가 정해진 클라이언트 + 미해결 키 1건. */
function reportingClient(telemetry: "off" | "aggregate" = "aggregate"): RynL10nClient {
  const client = new RynL10nClient({
    bundle: BUNDLE, store: emptyStore, context: { appVersion: "1.2.3" }, telemetry,
  });
  client.refresh(MANIFEST);
  client.t("missing.key");
  return client;
}

test("텔레메트리: 익명 집계만 5개 필드로 올린다 (9.3 프라이버시 가드)", async () => {
  const sent: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), body: String(init?.body) });
    return new Response(JSON.stringify({ accepted: 1, rejected: 0 }), { status: 200 });
  }) as unknown as typeof fetch;

  const client = reportingClient();
  const reporter = new TelemetryReporter({ endpoint: "https://admin.test", projectKey: "demo", appVersion: "1.2.3", fetchImpl });

  assert.equal(await reporter.flush(client), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, "https://admin.test/projects/demo/telemetry");

  const batch = JSON.parse(sent[0]!.body) as Record<string, unknown>[];
  assert.equal(batch.length, 1, "0인 이벤트는 보내지 않는다");
  assert.deepEqual(
    Object.keys(batch[0]!).sort(),
    ["appVersionBucket", "count", "event", "projectId", "releaseId"],
    "서버가 미정의 필드를 거부하므로 배치 전체가 버려진다",
  );
  assert.equal(batch[0]!["event"], "key_unresolved");
  assert.equal(batch[0]!["releaseId"], "R42");
  assert.equal(batch[0]!["appVersionBucket"], "1.2", "개별 빌드가 아니라 버전군이어야 익명이다");
  assert.ok(!sent[0]!.body.includes("missing.key"), "키 이름은 실리지 않는다");

  assert.deepEqual(client.drainTelemetry(), { overlay_applied: 0, format_guard_rejected: 0, key_unresolved: 0, delta_failed: 0 });
});

test("텔레메트리: 전송 실패·5xx면 카운트를 되돌린다", async () => {
  const throwing = (() => { throw new Error("offline"); }) as unknown as typeof fetch;
  const offline = reportingClient();
  const r1 = new TelemetryReporter({ endpoint: "https://admin.test", projectKey: "demo", fetchImpl: throwing });
  assert.equal(await r1.flush(offline), false);
  assert.equal(offline.drainTelemetry().key_unresolved, 1, "실패 구간이 사라지면 8.4 판정이 건강해 보인다");

  const failing = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
  const broken = reportingClient();
  const r2 = new TelemetryReporter({ endpoint: "https://admin.test", projectKey: "demo", fetchImpl: failing });
  assert.equal(await r2.flush(broken), false);
  assert.equal(broken.drainTelemetry().key_unresolved, 1);
});

test("텔레메트리: 릴리스 전이면 드레인하지 않고, 수집이 off면 보낼 것이 없다", async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;

  // ① 번들만 쓰는 상태(매칭 릴리스 없음) → 귀속시킬 릴리스가 없다.
  const bundleOnly = new RynL10nClient({ bundle: BUNDLE, store: emptyStore, context: { appVersion: "9.9.9" }, telemetry: "aggregate" });
  bundleOnly.refresh(MANIFEST);
  bundleOnly.t("missing.key");
  const reporter = new TelemetryReporter({ endpoint: "https://admin.test", projectKey: "demo", fetchImpl });
  assert.equal(await reporter.flush(bundleOnly), true);
  assert.equal(calls, 0);
  assert.equal(bundleOnly.drainTelemetry().key_unresolved, 1, "다음 기회에 릴리스와 함께 나가야 한다");

  // ② 수집 옵트인이 아니면 카운트 자체가 0이라 네트워크로 아무것도 나가지 않는다.
  assert.equal(await reporter.flush(reportingClient("off")), true);
  assert.equal(calls, 0);
});

test("텔레메트리: 앱 버전군 라벨", () => {
  assert.equal(versionBucket("3.2.1"), "3.2");
  assert.equal(versionBucket("3.2.1-beta.4"), "3.2");
  assert.equal(versionBucket("4"), "4");
  assert.equal(versionBucket(undefined), "unknown");
  assert.equal(versionBucket(""), "unknown");
});

function listen(s: Server): Promise<string> {
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
}

test("텔레메트리: 실제 관리 서버가 배치를 수용해 집계에 반영한다 (9.3 → 관측성 탭)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "rynl10n-tel-"));
  const repo = new Repo(openDatabase());
  const store = new FsArtifactStore(tmp);
  const tokens = new TokenRegistry();
  tokens.issue("admin", { actor: "a", role: "admin", projects: "*" });
  const mgmt = createManagementServer({ repo, store, tokens, notifier: new Notifier() });
  const mgmtUrl = await listen(mgmt);

  const delivery = createServer((req, res) => {
    readFile(join(tmp, decodeURIComponent(req.url ?? "/")))
      .then((d) => { res.writeHead(200, { "content-type": "application/json" }); res.end(d); })
      .catch(() => { res.writeHead(404).end(); });
  });
  const deliveryUrl = await listen(delivery);

  const api = (method: string, path: string, body?: unknown) => {
    const init: RequestInit = { method, headers: { authorization: "Bearer admin", "content-type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(mgmtUrl + path, init);
  };
  await api("POST", "/projects", { id: "shop", name: "S", defaultLocale: "en", locales: ["en"] });
  await api("PUT", "/projects/shop/keys/pay.button");
  await api("PUT", "/projects/shop/translations/pay.button/en", { value: "Pay", state: "reviewed" });
  await api("POST", "/projects/shop/releases", { id: "R1", name: "v1", versionMatch: { strategy: "semver-range", value: ">=1.0.0" }, keys: ["pay.button"] });
  await api("POST", "/projects/shop/releases/R1/publish");

  const manifest = (await (await fetch(`${deliveryUrl}/shop/manifest.json`)).json()) as Manifest;
  const bundle = (await (await fetch(`${deliveryUrl}/shop/${manifest.releases[0]!.snapshot}`)).json()) as Snapshot;

  const sdk = new HttpRynL10n({
    projectKey: "shop", endpoint: deliveryUrl, bundle, context: { appVersion: "2.4.7" },
    telemetry: "aggregate", telemetryEndpoint: mgmtUrl,
  });
  await sdk.refresh();
  sdk.t("nope.one");
  sdk.t("nope.two");

  assert.equal(await sdk.flushTelemetry(), true);

  const rows = repo.listTelemetry("shop");
  assert.deepEqual(rows, [{ releaseId: "R1", event: "key_unresolved", appVersionBucket: "2.4", count: 2 }]);

  const health = (await (await api("GET", "/projects/shop/releases/R1/health")).json()) as { keyUnresolvedRate: number };
  assert.ok(health.keyUnresolvedRate > 0, "카나리 판정(8.4)이 같은 집계를 본다");

  sdk.stop();
  mgmt.close();
  delivery.close();
});
