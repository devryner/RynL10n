import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db/schema.ts";
import { Repo } from "../src/db/repo.ts";
import { MemoryArtifactStore } from "../src/storage/store.ts";
import { publishRelease, rollbackRelease, RangeConflictError } from "../src/pipeline/publish.ts";
import { RynL10nClient } from "../../src/client/client.ts";
import type { Snapshot } from "../../src/core/types.ts";

function seed() {
  const repo = new Repo(openDatabase());
  const store = new MemoryArtifactStore();
  repo.createProject("shop", "Shop", "en", ["en", "ja", "ko"]);
  repo.createRelease("shop", "R42", "v3.2", { strategy: "semver-range", value: ">=3.2.0" }, "draft");
  const pay = repo.upsertKey("shop", "pay.button", "", false);
  const home = repo.upsertKey("shop", "home.title", "", false);
  repo.putTranslation("shop", pay, "en", "Pay", "reviewed");
  repo.putTranslation("shop", pay, "ja", "支払―", "reviewed"); // 오타
  repo.putTranslation("shop", home, "en", "Home", "reviewed");
  repo.putTranslation("shop", home, "ko", "홈", "reviewed");
  repo.addReleaseKey("shop", "R42", pay);
  repo.addReleaseKey("shop", "R42", home);
  return { repo, store, pay, home };
}

test("파이프라인: publish → SDK 소비 → 편집·델타 → 롤백 (7.4/8.3)", () => {
  const { repo, store } = seed();

  // 1) 최초 publish
  const r1 = publishRelease(repo, store, "shop", "R42", "pm@shop");
  assert.match(r1.base, /^[0-9a-f]{16}$/);
  assert.equal(r1.base, r1.overlay); // 최초는 base==overlay
  const manifest1 = store.readManifest("shop")!;
  assert.equal(manifest1.releases[0]!.id, "R42");
  assert.equal(manifest1.releases[0]!.state, "published");

  // 2) 백엔드 산출물을 M0 SDK 클라이언트가 소비 (M2→M1 연결)
  const bundle = store.readSnapshot("shop", "R42", r1.base)!;
  const reader = store.deliveryReader("shop");
  const client = new RynL10nClient({ bundle, store: reader, context: { appVersion: "3.2.1" } });
  client.refresh(manifest1);
  assert.equal(client.t("pay.button", {}, "ja"), "支払―"); // 오타 상태
  assert.equal(client.t("home.title", {}, "ko"), "홈");

  // 3) 오타 수정 → republish → 델타 생성 → SDK 반영
  repo.putTranslation("shop", seed_pay(repo), "ja", "支払い", "reviewed");
  const r2 = publishRelease(repo, store, "shop", "R42", "pm@shop");
  assert.notEqual(r2.overlay, r2.base); // 델타 생김
  client.refresh(store.readManifest("shop")!);
  assert.equal(client.t("pay.button", {}, "ja"), "支払い"); // OTA 반영

  // 4) 롤백 → overlay를 base로 → SDK 원복
  rollbackRelease(repo, store, "shop", "R42", r2.base, "pm@shop");
  client.refresh(store.readManifest("shop")!);
  assert.equal(client.t("pay.button", {}, "ja"), "支払―");
});

function seed_pay(repo: Repo): number {
  return repo.getKeyByName("shop", "pay.button")!.id;
}

test("버전 격리: 신규 릴리스 publish → 자동 상한 닫힘 + superseded, 신규 키 격리 (8.2/4.3)", () => {
  const { repo, store } = seed();
  publishRelease(repo, store, "shop", "R42", "pm"); // R42 '>=3.2.0' 열린 상한

  // R50: 신규 키 home.newBadge 추가, '>=3.3.0'
  repo.createRelease("shop", "R50", "v3.3", { strategy: "semver-range", value: ">=3.3.0" }, "draft");
  const badge = repo.upsertKey("shop", "home.newBadge", "", false);
  const home = repo.getKeyByName("shop", "home.title")!.id;
  repo.putTranslation("shop", badge, "en", "NEW", "reviewed");
  repo.addReleaseKey("shop", "R50", home);
  repo.addReleaseKey("shop", "R50", badge);
  publishRelease(repo, store, "shop", "R50", "pm");

  // R42는 상한 자동 닫힘 + superseded
  const r42 = repo.getRelease("shop", "R42")!;
  assert.equal(r42.versionMatch.value, ">=3.2.0 <3.3.0");
  assert.equal(r42.state, "superseded");

  const manifest = store.readManifest("shop")!;
  const reader = store.deliveryReader("shop");

  // 구버전 앱 3.2.5 → R42 → 신규 키 미노출(격리)
  const oldBundle = store.readSnapshot("shop", "R42", r42.base!)!;
  const oldApp = new RynL10nClient({ bundle: oldBundle, store: reader, context: { appVersion: "3.2.5" } });
  oldApp.refresh(manifest);
  assert.equal(oldApp.status().releaseId, "R42");
  assert.equal(oldApp.t("home.newBadge"), "⟪home.newBadge⟫");

  // 신규 앱 3.3.1 → R50 → 신규 키 노출
  const r50 = repo.getRelease("shop", "R50")!;
  const newBundle = store.readSnapshot("shop", "R50", r50.base!)!;
  const newApp = new RynL10nClient({ bundle: newBundle, store: reader, context: { appVersion: "3.3.1" } });
  newApp.refresh(manifest);
  assert.equal(newApp.status().releaseId, "R50");
  assert.equal(newApp.t("home.newBadge"), "NEW");
});

test("겹치는 범위 publish는 409 (RangeConflictError)", () => {
  const { repo, store } = seed();
  publishRelease(repo, store, "shop", "R42", "pm"); // '>=3.2.0'

  // R70 '>=3.1.0 <3.5.0' — R42 하한보다 낮게 시작 → 자동 닫힘으로 분리 불가 → 충돌
  repo.createRelease("shop", "R70", "wide", { strategy: "semver-range", value: ">=3.1.0 <3.5.0" }, "draft");
  const home = repo.getKeyByName("shop", "home.title")!.id;
  repo.addReleaseKey("shop", "R70", home);
  assert.throws(() => publishRelease(repo, store, "shop", "R70", "pm"), RangeConflictError);
});

test("롤백 보존 창: 21회 publish 후 이력 20개로 유지 (8.3)", () => {
  const { repo, store } = seed();
  for (let i = 0; i < 21; i++) {
    // 매번 값 변경으로 새 산출물 유발
    repo.putTranslation("shop", repo.getKeyByName("shop", "home.title")!.id, "en", `Home ${i}`, "reviewed");
    publishRelease(repo, store, "shop", "R42", "pm");
  }
  const history = repo.listManifestHistory("shop");
  assert.equal(history.length, 20);
});

// 결정성: 백엔드가 만든 base 해시는 참조 빌더와 동일해야 한다(같은 카탈로그).
test("결정성: 백엔드 스냅샷 base가 M0 참조와 일치", async () => {
  const { repo, store } = seed();
  const r = publishRelease(repo, store, "shop", "R42", "pm");
  const { buildSnapshot } = await import("../../src/builder/builder.ts");
  const catalog = repo.catalogForRelease("shop", "R42");
  const ref = buildSnapshot({ release: "R42", defaultLocale: "en", locales: catalog });
  assert.equal(r.base, ref.base);
});
