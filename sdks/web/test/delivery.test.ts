/**
 * 앱 적용 경로 — 배포 플레인 HTTP + 영속 캐시 + 번들 로더 (기획서 6.3 / 6.4).
 * 시나리오는 iOS `RemoteDeliveryTests` · Android `RemoteDeliveryTest`와 1:1로 맞춰 두었다
 * (같은 계약을 4개 플랫폼이 같은 방식으로 지키는지 확인하는 자리다).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildSnapshot, buildDelta } from "../../../src/builder/builder.ts";
import { HttpRynL10n, DeliveryError } from "../src/http.ts";
import { memoryCache, storageCache, type StorageLike } from "../src/cache.ts";
import { BakedBundle, BakedError } from "../src/baked.ts";
import type { Manifest } from "../../../src/core/types.ts";

const v0 = buildSnapshot({ release: "R1", defaultLocale: "en", locales: { en: { greet: "Hello" } } });
const v1 = buildSnapshot({ release: "R1", defaultLocale: "en", locales: { en: { greet: "Hi" } } });
const v2 = buildSnapshot({ release: "R2", defaultLocale: "en", locales: { en: { greet: "Howdy" } } });
const delta = buildDelta(v0, v1);

const SNAP0 = `releases/R1/snapshot-${v0.base}.json`;
const DELTA01 = `releases/R1/delta-${v0.base}-${v1.base}.json`;
const SNAP2 = `releases/R2/snapshot-${v2.base}.json`;

/** base==번들 → 스냅샷은 이미 손에 있고 델타만 받으면 되는 형태. */
const overlayManifest: Manifest = {
  schemaVersion: 1, project: "shop", defaultLocale: "en", updatedAt: "T1",
  releases: [{
    id: "R1", state: "published", versionMatch: { strategy: "semver-range", value: ">=1.0.0" },
    base: v0.base, overlay: v1.base, rollout: 100, snapshot: SNAP0, delta: DELTA01,
  }],
};
/** base!=번들 → 스냅샷을 새로 내려받아야 하는 형태. */
const newBaseManifest: Manifest = {
  schemaVersion: 1, project: "shop", defaultLocale: "en", updatedAt: "T2",
  releases: [{
    id: "R2", state: "published", versionMatch: { strategy: "semver-range", value: ">=1.0.0" },
    base: v2.base, overlay: v2.base, rollout: 100, snapshot: SNAP2,
  }],
};
/** 스냅샷 경로가 서버에 없는(404) 형태. */
const missingSnapshotManifest: Manifest = {
  schemaVersion: 1, project: "shop", defaultLocale: "en", updatedAt: "T3",
  releases: [{
    id: "R9", state: "published", versionMatch: { strategy: "semver-range", value: ">=1.0.0" },
    base: "deadbeefdeadbeef", overlay: "deadbeefdeadbeef", rollout: 100,
    snapshot: "releases/R9/snapshot-deadbeefdeadbeef.json",
  }],
};

const files = new Map<string, string>([
  [`/shop/${SNAP0}`, JSON.stringify(v0)],
  [`/shop/${DELTA01}`, JSON.stringify(delta)],
  [`/shop/${SNAP2}`, JSON.stringify(v2)],
  ["/assets/rynl10n/snapshot.json", JSON.stringify(v0)],
  ["/assets/rynl10n/rynl10n.lock", JSON.stringify({ schemaVersion: 1, release: "R1", base: v0.base, keyCount: 1, locales: ["en"] })],
  ["/assets-flat/snapshot.json", JSON.stringify(v1)],
  ["/assets-broken/rynl10n/snapshot.json", "{ not json"],
]);

// 서버 거동을 테스트마다 갈아끼운다.
let manifest: Manifest = overlayManifest;
let manifestEtag = "m1";
let manifestStatus = 200;
let manifestBodyOverride: string | undefined;

let server: Server;
let endpoint = "";
let assetRoot = "";

before(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/shop/manifest.json") {
      if (manifestStatus !== 200) { res.writeHead(manifestStatus).end(); return; }
      if (req.headers["if-none-match"] === manifestEtag) { res.writeHead(304).end(); return; }
      res.writeHead(200, { "content-type": "application/json", etag: manifestEtag });
      res.end(manifestBodyOverride ?? JSON.stringify(manifest));
      return;
    }
    const f = files.get(path);
    if (f) { res.writeHead(200, { "content-type": "application/json", "cache-control": "immutable" }); res.end(f); return; }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  endpoint = `http://127.0.0.1:${port}`;
  assetRoot = `${endpoint}/assets`;
});
after(() => server.close());

/** 기본 서버 거동으로 되돌린다(테스트 간 격리). */
function resetServer(): void {
  manifest = overlayManifest;
  manifestEtag = "m1";
  manifestStatus = 200;
  manifestBodyOverride = undefined;
}

/** 요청 수를 세는 fetch 래퍼 — "불변 산출물을 두 번 받지 않는가"를 관찰하는 눈이다. */
function countingFetch(): { impl: typeof fetch; paths: string[] } {
  const paths: string[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    paths.push(new URL(String(input)).pathname);
    return fetch(input as string, init);
  }) as typeof fetch;
  return { impl, paths };
}

/** 항상 실패하는 fetch — 오프라인 시뮬레이션. */
function offlineFetch(): { impl: typeof fetch; calls: () => number } {
  let calls = 0;
  const impl = (async () => { calls++; throw new TypeError("network down"); }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

test("update: 델타를 받아 오버레이를 적용한다", async () => {
  resetServer();
  const sdk = new HttpRynL10n({ projectKey: "shop", endpoint, bundle: v0, context: { appVersion: "1.0.0" }, cache: memoryCache() });
  assert.equal(sdk.t("greet"), "Hello");
  assert.equal(await sdk.refresh(), true);
  assert.equal(sdk.t("greet"), "Hi");
  assert.equal(sdk.status().releaseId, "R1");
});

test("update: base가 다르면 스냅샷을 내려받는다", async () => {
  resetServer();
  manifest = newBaseManifest;
  manifestEtag = "m-newbase";
  const { impl, paths } = countingFetch();
  const sdk = new HttpRynL10n({ projectKey: "shop", endpoint, bundle: v0, context: { appVersion: "1.0.0" }, cache: memoryCache(), fetchImpl: impl });
  assert.equal(await sdk.refresh(), true);
  assert.equal(sdk.t("greet"), "Howdy");
  assert.ok(paths.includes(`/shop/${SNAP2}`), "새 base의 스냅샷을 받아야 한다");
});

test("update: 매칭 릴리스가 없으면 번들만 쓰고 아무것도 받지 않는다", async () => {
  resetServer();
  const { impl, paths } = countingFetch();
  const sdk = new HttpRynL10n({ projectKey: "shop", endpoint, bundle: v0, context: { appVersion: "0.9.0" }, cache: memoryCache(), fetchImpl: impl });
  await sdk.refresh();
  assert.equal(sdk.t("greet"), "Hello");
  assert.deepEqual(paths, ["/shop/manifest.json"]); // 산출물 요청 0건
});

test("update: 불변 산출물은 두 번 받지 않는다", async () => {
  resetServer();
  const { impl, paths } = countingFetch();
  const sdk = new HttpRynL10n({ projectKey: "shop", endpoint, bundle: v0, context: { appVersion: "1.0.0" }, cache: memoryCache(), fetchImpl: impl });
  await sdk.refresh();
  await sdk.refresh();
  const deltaHits = paths.filter((p) => p === `/shop/${DELTA01}`).length;
  assert.equal(deltaHits, 1, "내용해시 URL이라 재요청할 이유가 없다");
});

test("loadManifest: ETag 304면 캐시본을 쓴다", async () => {
  resetServer();
  const sdk = new HttpRynL10n({ projectKey: "shop", endpoint, bundle: v0, context: { appVersion: "1.0.0" }, cache: memoryCache() });
  assert.equal(await sdk.refresh(), true);
  assert.equal(await sdk.refresh(), false); // If-None-Match → 304 → 변경 없음
  assert.equal((await sdk.loadManifest()).updatedAt, "T1");
  assert.equal(sdk.t("greet"), "Hi");
});

test("영속 캐시: 새 인스턴스가 네트워크 없이 마지막 카탈로그를 이어받는다", async () => {
  resetServer();
  const cache = memoryCache(); // 브라우저에선 localStorage — 탭을 새로 열어도 남는 자리
  const warm = new HttpRynL10n({ projectKey: "shop", endpoint, bundle: v0, context: { appVersion: "1.0.0" }, cache });
  assert.equal(await warm.refresh(), true);

  const offline = offlineFetch();
  const cold = new HttpRynL10n({ projectKey: "shop", endpoint, bundle: v0, context: { appVersion: "1.0.0" }, cache, fetchImpl: offline.impl });
  assert.equal(await cold.refresh(), true, "캐시된 manifest+델타만으로 오버레이가 복원돼야 한다");
  assert.equal(cold.t("greet"), "Hi");
  assert.equal(offline.calls(), 1, "manifest 재검증 1회뿐 — 산출물은 캐시에서 온다");
});

test("update: 네트워크가 끊겨도 마지막 캐시로 진행한다", async () => {
  resetServer();
  const cache = memoryCache();
  const online = new HttpRynL10n({ projectKey: "shop", endpoint, bundle: v0, context: { appVersion: "1.0.0" }, cache });
  await online.refresh();

  const offline = offlineFetch();
  const sdk = new HttpRynL10n({ projectKey: "shop", endpoint, bundle: v0, context: { appVersion: "1.0.0" }, cache, fetchImpl: offline.impl });
  const cached = await sdk.loadManifest();
  assert.equal(cached.updatedAt, "T1"); // 던지지 않고 캐시본
});

test("update: 캐시도 네트워크도 없으면 unavailable을 던진다", async () => {
  resetServer();
  const offline = offlineFetch();
  const sdk = new HttpRynL10n({ projectKey: "shop", endpoint, bundle: v0, context: { appVersion: "1.0.0" }, cache: memoryCache(), fetchImpl: offline.impl });
  await assert.rejects(() => sdk.loadManifest(), (e: unknown) => e instanceof DeliveryError && e.kind === "unavailable");
});

test("update: 실패해도 화면의 번역은 깨지지 않는다", async () => {
  resetServer();
  const offline = offlineFetch();
  const sdk = new HttpRynL10n({ projectKey: "shop", endpoint, bundle: v0, context: { appVersion: "1.0.0" }, cache: memoryCache(), fetchImpl: offline.impl });
  assert.equal(await sdk.refresh(), false); // refresh는 던지지 않는다(폴링 루프 자리)
  assert.equal(sdk.t("greet"), "Hello");    // 번들 fallback
});

test("loadManifest: 2xx가 아니고 캐시도 없으면 bad-status를 던진다", async () => {
  resetServer();
  manifestStatus = 500;
  const sdk = new HttpRynL10n({ projectKey: "shop", endpoint, bundle: v0, context: { appVersion: "1.0.0" }, cache: memoryCache() });
  await assert.rejects(() => sdk.loadManifest(), (e: unknown) => e instanceof DeliveryError && e.kind === "bad-status" && e.status === 500);
});

test("loadManifest: 본문이 manifest가 아니면 malformed를 던진다", async () => {
  resetServer();
  manifestBodyOverride = "{ not json";
  const sdk = new HttpRynL10n({ projectKey: "shop", endpoint, bundle: v0, context: { appVersion: "1.0.0" }, cache: memoryCache() });
  await assert.rejects(() => sdk.loadManifest(), (e: unknown) => e instanceof DeliveryError && e.kind === "malformed");
});

test("스냅샷 경로가 404여도 번들로 계속 동작한다", async () => {
  resetServer();
  manifest = missingSnapshotManifest;
  manifestEtag = "m-404";
  const sdk = new HttpRynL10n({ projectKey: "shop", endpoint, bundle: v0, context: { appVersion: "1.0.0" }, cache: memoryCache() });
  assert.equal(await sdk.refresh(), false); // 산출물이 없어 스왑 불가
  assert.equal(sdk.t("greet"), "Hello");    // 그래도 화면은 멀쩡하다
});

test("clearCache 이후에는 다시 받는다", async () => {
  resetServer();
  const { impl, paths } = countingFetch();
  const cache = memoryCache();
  const sdk = new HttpRynL10n({ projectKey: "shop", endpoint, bundle: v0, context: { appVersion: "1.0.0" }, cache, fetchImpl: impl });
  await sdk.refresh();
  sdk.clearCache();
  await sdk.refresh();
  const deltaHits = paths.filter((p) => p === `/shop/${DELTA01}`).length;
  assert.equal(deltaHits, 2);
});

test("storageCache: 네임스페이스로 격리하고 저장 실패를 삼킨다", () => {
  const backing = new Map<string, string>();
  let failWrites = false;
  const storage: StorageLike = {
    getItem: (k) => backing.get(k) ?? null,
    setItem: (k, v) => { if (failWrites) throw new Error("QuotaExceededError"); backing.set(k, v); },
    removeItem: (k) => void backing.delete(k),
    get length() { return backing.size; },
    key: (i) => [...backing.keys()][i] ?? null,
  };
  const shop = storageCache(storage, "shop");
  const blog = storageCache(storage, "blog");
  shop.set("manifest", "A");
  blog.set("manifest", "B");
  assert.equal(shop.get("manifest"), "A");
  assert.equal(blog.get("manifest"), "B");

  shop.clear();
  assert.equal(shop.get("manifest"), undefined);
  assert.equal(blog.get("manifest"), "B", "다른 네임스페이스는 건드리지 않는다");

  failWrites = true;
  assert.doesNotThrow(() => blog.set("manifest", "C")); // 용량 초과는 캐시 미사용으로 강등될 뿐
  assert.equal(blog.get("manifest"), "B");
});

test("BakedBundle.parse: import한 값을 검증한다", () => {
  const parsed = BakedBundle.parse(JSON.parse(JSON.stringify(v0)));
  assert.equal(parsed.base, v0.base);
  assert.throws(() => BakedBundle.parse({ nope: true }), BakedError);
  assert.throws(() => BakedBundle.parse("{ not json"), BakedError);
});

test("BakedBundle.load: 자산 루트에서 후보를 순서대로 찾는다", async () => {
  const nested = await BakedBundle.load(assetRoot);
  assert.equal(nested.base, v0.base); // rynl10n/snapshot.json

  const flat = await BakedBundle.load(`${endpoint}/assets-flat`);
  assert.equal(flat.base, v1.base);   // snapshot.json (두 번째 후보)

  await assert.rejects(() => BakedBundle.load(`${endpoint}/assets-missing`), BakedError);
  await assert.rejects(() => BakedBundle.load(`${endpoint}/assets-broken`), BakedError);
});

test("BakedBundle.loadLockfile: 없으면 undefined, 있으면 release·base를 읽는다", async () => {
  const lock = await BakedBundle.loadLockfile(assetRoot);
  assert.equal(lock?.release, "R1");
  assert.equal(lock?.base, v0.base);
  assert.equal(await BakedBundle.loadLockfile(`${endpoint}/assets-flat`), undefined);
});

test("로드한 번들로 클라이언트가 바로 조회한다", async () => {
  resetServer();
  const bundle = await BakedBundle.load(assetRoot);
  const sdk = new HttpRynL10n({ projectKey: "shop", endpoint, bundle, context: { appVersion: "1.0.0" }, cache: memoryCache() });
  assert.equal(sdk.t("greet"), "Hello");
});
