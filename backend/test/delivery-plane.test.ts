/**
 * 배포 플레인 정적 서버 (4.1 / 7.2 / 11.2).
 *
 * 여기서 지키는 것은 "CDN이 공짜로 주는 동작"이다 — ETag 조건부 요청과 CORS. 둘 중 하나만 빠져도
 * SDK는 죽지 않지만 갱신 경로가 조용히 반쪽이 된다(매 폴링마다 manifest 전량 재다운로드,
 * 브라우저에서는 응답 자체가 차단). 그래서 계약으로 못박아 둔다.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDeliveryServer, etagFor } from "../src/storage/delivery-server.ts";

const MANIFEST = JSON.stringify({ schemaVersion: 1, project: "shop", defaultLocale: "en", updatedAt: "T1", releases: [] });
const SNAPSHOT = JSON.stringify({ schemaVersion: 1, release: "R1", base: "abc", defaultLocale: "en", locales: {} });

let root: string;
let server: Server;
let base = "";

before(async () => {
  root = mkdtempSync(join(tmpdir(), "rynl10n-delivery-"));
  mkdirSync(join(root, "shop", "releases", "R1"), { recursive: true });
  writeFileSync(join(root, "shop", "manifest.json"), MANIFEST);
  writeFileSync(join(root, "shop", "releases", "R1", "snapshot-abc.json"), SNAPSHOT);

  server = createDeliveryServer({ root });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

test("manifest는 ETag를 발행하고 If-None-Match면 304를 준다", async () => {
  const first = await fetch(`${base}/shop/manifest.json`);
  assert.equal(first.status, 200);
  const etag = first.headers.get("etag");
  assert.ok(etag, "ETag가 없으면 조건부 요청이 성립할 수 없다");
  assert.equal(await first.text(), MANIFEST);

  const second = await fetch(`${base}/shop/manifest.json`, { headers: { "if-none-match": etag } });
  assert.equal(second.status, 304);
  assert.equal(await second.text(), "");
});

test("ETag는 내용해시 — 내용이 그대로면 검증자도 그대로다", async () => {
  const a = await fetch(`${base}/shop/manifest.json`);
  const b = await fetch(`${base}/shop/manifest.json`);
  assert.equal(a.headers.get("etag"), b.headers.get("etag"));
  assert.equal(a.headers.get("etag"), etagFor(Buffer.from(MANIFEST)));
});

test("검증자가 다르면 200 + 본문을 준다", async () => {
  const res = await fetch(`${base}/shop/manifest.json`, { headers: { "if-none-match": '"stale"' } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), MANIFEST);
});

test("If-None-Match 목록·와일드카드·약한 검증자를 이해한다", async () => {
  const etag = (await fetch(`${base}/shop/manifest.json`)).headers.get("etag")!;
  const list = await fetch(`${base}/shop/manifest.json`, { headers: { "if-none-match": `"other", ${etag}` } });
  assert.equal(list.status, 304);
  const star = await fetch(`${base}/shop/manifest.json`, { headers: { "if-none-match": "*" } });
  assert.equal(star.status, 304);
  const weak = await fetch(`${base}/shop/manifest.json`, { headers: { "if-none-match": `W/${etag}` } });
  assert.equal(weak.status, 304);
});

test("CORS: 브라우저 SDK가 응답과 ETag를 읽을 수 있다", async () => {
  const res = await fetch(`${base}/shop/manifest.json`);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  // ETag는 CORS 안전목록 응답 헤더가 아니라 명시 노출하지 않으면 JS가 못 읽는다.
  assert.match(res.headers.get("access-control-expose-headers") ?? "", /etag/i);
});

test("CORS preflight: If-None-Match를 허용한다", async () => {
  const res = await fetch(`${base}/shop/manifest.json`, { method: "OPTIONS" });
  assert.equal(res.status, 204);
  assert.match(res.headers.get("access-control-allow-headers") ?? "", /if-none-match/i);
  assert.match(res.headers.get("access-control-allow-methods") ?? "", /GET/);
});

test("allowOrigin으로 오리진을 좁힐 수 있다", async () => {
  const scoped = createDeliveryServer({ root, allowOrigin: "https://app.example.com" });
  await new Promise<void>((r) => scoped.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(scoped.address() as AddressInfo).port}/shop/manifest.json`;
    const res = await fetch(url);
    assert.equal(res.headers.get("access-control-allow-origin"), "https://app.example.com");
  } finally {
    scoped.close();
  }
});

test("불변 산출물은 영구 캐싱, manifest는 짧은 TTL(7.2)", async () => {
  const manifest = await fetch(`${base}/shop/manifest.json`);
  assert.match(manifest.headers.get("cache-control") ?? "", /must-revalidate/);

  const snapshot = await fetch(`${base}/shop/releases/R1/snapshot-abc.json`);
  assert.equal(snapshot.status, 200);
  assert.match(snapshot.headers.get("cache-control") ?? "", /immutable/);
});

test("없는 경로는 404, 쓰기 메서드는 405 (읽기 전용 플레인)", async () => {
  const missing = await fetch(`${base}/shop/nope.json`);
  assert.equal(missing.status, 404);

  const write = await fetch(`${base}/shop/manifest.json`, { method: "PUT", body: "{}" });
  assert.equal(write.status, 405);
  assert.match(write.headers.get("allow") ?? "", /GET/);
});

test("경로 순회로 루트를 벗어날 수 없다", async () => {
  // 서버에 닿기 전에 fetch가 정규화하는 경우가 있어 인코딩된 형태까지 확인한다.
  for (const path of ["/../../etc/passwd", "/shop/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd"]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 404, `${path} 가 루트를 벗어나면 안 된다`);
  }
});

test("HEAD는 헤더만 준다(본문 없음)", async () => {
  const res = await fetch(`${base}/shop/manifest.json`, { method: "HEAD" });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("etag"));
  assert.equal(await res.text(), "");
});
