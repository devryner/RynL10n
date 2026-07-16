import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildSnapshot, buildDelta } from "../../../src/builder/builder.ts";
import { HttpRynL10n } from "../src/http.ts";
import { createStore } from "../src/store.ts";
import type { Manifest } from "../../../src/core/types.ts";

// 배포 플레인(정적 CDN) 시뮬레이션 서버: manifest는 ETag 조건부, 산출물은 불변.
const v0 = buildSnapshot({ release: "R1", defaultLocale: "en", locales: { en: { greet: "Hello" } } });
const v1 = buildSnapshot({ release: "R1", defaultLocale: "en", locales: { en: { greet: "Hi" } } });
const delta = buildDelta(v0, v1);
const files = new Map<string, string>([
  [`/shop/releases/R1/snapshot-${v0.base}.json`, JSON.stringify(v0)],
  [`/shop/releases/R1/delta-${v0.base}-${v1.base}.json`, JSON.stringify(delta)],
]);
let manifest: Manifest = {
  schemaVersion: 1, project: "shop", defaultLocale: "en", updatedAt: "T1",
  releases: [{ id: "R1", state: "published", versionMatch: { strategy: "semver-range", value: ">=1.0.0" }, base: v0.base, overlay: v1.base, rollout: 100, snapshot: `releases/R1/snapshot-${v0.base}.json`, delta: `releases/R1/delta-${v0.base}-${v1.base}.json` }],
};
let manifestEtag = "m1";

let server: Server;
let endpoint = "";
before(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/shop/manifest.json") {
      if (req.headers["if-none-match"] === manifestEtag) { res.writeHead(304).end(); return; }
      res.writeHead(200, { "content-type": "application/json", etag: manifestEtag });
      res.end(JSON.stringify(manifest));
      return;
    }
    const f = files.get(path);
    if (f) { res.writeHead(200, { "content-type": "application/json", "cache-control": "immutable" }); res.end(f); return; }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test("Web SDK: manifest fetch → 델타 프리페치 → 동기 resolve", async () => {
  const sdk = new HttpRynL10n({ projectKey: "shop", endpoint, bundle: v0, context: { appVersion: "1.0.0" } });
  assert.equal(sdk.t("greet"), "Hello"); // 번들
  const changed = await sdk.refresh();
  assert.equal(changed, true);
  assert.equal(sdk.t("greet"), "Hi"); // OTA 오버레이 반영
  assert.equal(sdk.status().releaseId, "R1");
});

test("Web SDK: ETag 304 → 변경 없음", async () => {
  const sdk = new HttpRynL10n({ projectKey: "shop", endpoint, bundle: v0, context: { appVersion: "1.0.0" } });
  assert.equal(await sdk.refresh(), true);  // 최초
  assert.equal(await sdk.refresh(), false); // 두 번째는 If-None-Match → 304
});

test("Web SDK store: 갱신 시 version 증가(React useSyncExternalStore 호환)", async () => {
  const store = createStore({ projectKey: "shop", endpoint, bundle: v0, context: { appVersion: "1.0.0" } });
  let notified = 0;
  const unsub = store.subscribe(() => notified++);
  assert.equal(store.getVersion(), 0);
  await store.refresh();
  assert.equal(store.getVersion(), 1);
  assert.equal(notified, 1);
  assert.equal(store.t("greet"), "Hi");
  unsub();
});

test("Web SDK: 카나리 rollout 0 → 오버레이 미수신(번들 유지)", async () => {
  const prev = manifest;
  manifest = { ...manifest, releases: [{ ...manifest.releases[0]!, rollout: 0 }] };
  manifestEtag = "m2";
  try {
    const sdk = new HttpRynL10n({ projectKey: "shop", endpoint, bundle: v0, context: { appVersion: "1.0.0" }, installId: "device-1" });
    await sdk.refresh();
    assert.equal(sdk.t("greet"), "Hello"); // rollout 0 → 카나리 미수신
  } finally {
    manifest = prev; manifestEtag = "m1";
  }
});
