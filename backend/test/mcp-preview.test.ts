/**
 * MCP `resolve_preview` — 해석 경로 시뮬레이터 (도구 2/2).
 *
 * 이 도구가 답하는 질문은 하나다: "이 앱 버전에서 이 키가 실제로 무엇으로 보이고, 왜 그런가."
 * 그래서 검증 축도 값 하나가 아니라 **원인 코드가 실제 원인과 맞는가**이다 —
 * `refresh()`의 조기 반환 지점마다 그에 대응하는 diagnosis가 나와야 한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db/schema.ts";
import { Repo } from "../src/db/repo.ts";
import { MemoryArtifactStore } from "../src/storage/store.ts";
import { publishRelease } from "../src/pipeline/publish.ts";
import { resolvePreview, type DiagnosisCode } from "../src/mcp/preview.ts";
import type { Delta, Manifest, Snapshot } from "../../src/core/types.ts";

function seed() {
  const repo = new Repo(openDatabase());
  const store = new MemoryArtifactStore();
  repo.createProject("shop", "Shop", "en", ["en", "ko", "ja"]);
  return { repo, store };
}

function keys(repo: Repo, releaseId: string): void {
  const pay = repo.upsertKey("shop", "pay.button", "", false);
  const greet = repo.upsertKey("shop", "greet", "name:simple", false);
  repo.putTranslation("shop", pay, "en", "Pay", "reviewed");
  repo.putTranslation("shop", pay, "ja", "支払―", "reviewed"); // 오타
  repo.putTranslation("shop", pay, "ko", "결제", "reviewed");
  repo.putTranslation("shop", greet, "en", "Hello {name}", "reviewed");
  repo.addReleaseKey("shop", releaseId, pay);
  repo.addReleaseKey("shop", releaseId, greet);
}

const codes = (r: { diagnosis: readonly { code: DiagnosisCode }[] }): DiagnosisCode[] => r.diagnosis.map((d) => d.code);

test("게시 직후: 오버레이가 없으면 번들 그대로 — overlay_absent", () => {
  const { repo, store } = seed();
  repo.createRelease("shop", "R42", "v3.2", { strategy: "semver-range", value: ">=3.2.0" }, "draft");
  keys(repo, "R42");
  publishRelease(repo, store, "shop", "R42", "pm");

  const r = resolvePreview(repo, store, { project: "shop", key: "pay.button", locale: "ja", appVersion: "3.2.1" });
  assert.equal(r.value, "支払―");
  assert.equal(r.source, "bundle");
  assert.equal(r.release.selection, "matched");
  assert.equal(r.release.id, "R42");
  assert.ok(codes(r).includes("overlay_absent"));
});

test("OTA 수정 후: 오버레이에서 온다 — source=overlay", () => {
  const { repo, store } = seed();
  repo.createRelease("shop", "R42", "v3.2", { strategy: "semver-range", value: ">=3.2.0" }, "draft");
  keys(repo, "R42");
  publishRelease(repo, store, "shop", "R42", "pm");
  repo.putTranslation("shop", repo.getKeyByName("shop", "pay.button")!.id, "ja", "支払い", "reviewed");
  publishRelease(repo, store, "shop", "R42", "pm");

  const r = resolvePreview(repo, store, { project: "shop", key: "pay.button", locale: "ja", appVersion: "3.2.1" });
  assert.equal(r.value, "支払い");
  assert.equal(r.source, "overlay");
  assert.equal(codes(r).length, 0, `예상치 못한 진단: ${JSON.stringify(r.diagnosis)}`);
});

test("포맷 인자와 로케일 fallback — ko-KR은 ko로 떨어진다", () => {
  const { repo, store } = seed();
  repo.createRelease("shop", "R42", "v3.2", { strategy: "semver-range", value: ">=3.2.0" }, "draft");
  keys(repo, "R42");
  publishRelease(repo, store, "shop", "R42", "pm");

  const r = resolvePreview(repo, store, { project: "shop", key: "pay.button", locale: "ko-KR", appVersion: "3.2.1" });
  assert.equal(r.value, "결제");
  assert.equal(r.matchedLocale, "ko");
  assert.deepEqual(r.localeChain, ["ko-KR", "ko", "en"]);
  assert.ok(codes(r).includes("locale_fallback"));
});

test("포맷 가드: 오버레이 서명이 번들과 다르면 그 키만 번들로 되돌아간다", () => {
  const { repo, store } = seed();
  repo.createRelease("shop", "R42", "v3.2", { strategy: "semver-range", value: ">=3.2.0" }, "draft");
  keys(repo, "R42");
  publishRelease(repo, store, "shop", "R42", "pm");
  // 관리 API라면 422로 막히는 값이지만(서명 소실), 배포 산출물에 들어온 상황을 재현한다.
  repo.putTranslation("shop", repo.getKeyByName("shop", "greet")!.id, "en", "Hello", "reviewed");
  publishRelease(repo, store, "shop", "R42", "pm");

  const r = resolvePreview(repo, store, { project: "shop", key: "greet", locale: "en", appVersion: "3.2.1", args: { name: "Ryn" } });
  assert.equal(r.guardFallback, true);
  assert.equal(r.source, "bundle");
  assert.equal(r.value, "Hello Ryn"); // 번들 값이 살아남았다
  assert.ok(codes(r).includes("format_guard_fallback"));
});

test("스테일 번들: 앱이 다른 릴리스의 base를 구워 넣었다", () => {
  const { repo, store } = seed();
  repo.createRelease("shop", "R41", "v3.0", { strategy: "semver-range", value: ">=3.0.0 <3.2.0" }, "draft");
  repo.createRelease("shop", "R42", "v3.2", { strategy: "semver-range", value: ">=3.2.0" }, "draft");
  keys(repo, "R41");
  for (const n of ["pay.button", "greet"]) repo.addReleaseKey("shop", "R42", repo.getKeyByName("shop", n)!.id);
  const old = publishRelease(repo, store, "shop", "R41", "pm");
  const cur = publishRelease(repo, store, "shop", "R42", "pm");
  assert.notEqual(old.base, cur.base); // 릴리스가 다르면 카탈로그 해시도 다르다

  const r = resolvePreview(repo, store, {
    project: "shop", key: "pay.button", locale: "ja", appVersion: "3.2.1", bundleBase: old.base,
  });
  assert.equal(r.bundle.assumed, false);
  assert.equal(r.bundle.base, old.base);
  assert.equal(r.release.id, "R42");
  assert.ok(codes(r).includes("stale_bundle"));
});

test("bundleBase를 생략하면 '방금 빌드한 앱'을 가정한 것이라고 밝힌다", () => {
  const { repo, store } = seed();
  repo.createRelease("shop", "R42", "v3.2", { strategy: "semver-range", value: ">=3.2.0" }, "draft");
  keys(repo, "R42");
  publishRelease(repo, store, "shop", "R42", "pm");

  const r = resolvePreview(repo, store, { project: "shop", key: "pay.button", locale: "en", appVersion: "3.2.1" });
  assert.equal(r.bundle.assumed, true);
});

test("미매칭 + draft로 남은 릴리스를 짚어 준다", () => {
  const { repo, store } = seed();
  repo.createRelease("shop", "R42", "v3.2", { strategy: "semver-range", value: ">=3.2.0 <4.0.0" }, "draft");
  keys(repo, "R42");
  publishRelease(repo, store, "shop", "R42", "pm");
  repo.createRelease("shop", "R50", "v4.0", { strategy: "semver-range", value: ">=4.0.0" }, "draft");

  const r = resolvePreview(repo, store, { project: "shop", key: "pay.button", locale: "en", appVersion: "4.1.0" });
  assert.equal(r.release.selection, "bundle-only");
  assert.ok(codes(r).includes("no_release_matched"));
  assert.ok(codes(r).includes("release_not_published"));
  assert.match(r.diagnosis.find((d) => d.code === "release_not_published")!.detail, /R50/);
});

test("빌드넘버 축은 분리돼 있다 — appVersion만으로는 integer-range가 매칭되지 않는다", () => {
  const { repo, store } = seed();
  repo.createRelease("shop", "B7", "build 100~200", { strategy: "integer-range", value: ">=100 <=200" }, "draft");
  keys(repo, "B7");
  publishRelease(repo, store, "shop", "B7", "pm");

  const withoutBuild = resolvePreview(repo, store, { project: "shop", key: "pay.button", locale: "en", appVersion: "3.2.1" });
  assert.equal(withoutBuild.release.selection, "bundle-only");
  assert.ok(codes(withoutBuild).includes("no_release_matched"));

  const withBuild = resolvePreview(repo, store, { project: "shop", key: "pay.button", locale: "en", buildNumber: 150 });
  assert.equal(withBuild.release.id, "B7");
});

test("카나리: rollout 밖이면 오버레이를 못 받는다", () => {
  const { repo, store } = seed();
  repo.createRelease("shop", "R42", "v3.2", { strategy: "semver-range", value: ">=3.2.0" }, "draft", 10);
  keys(repo, "R42");
  publishRelease(repo, store, "shop", "R42", "pm");
  repo.putTranslation("shop", repo.getKeyByName("shop", "pay.button")!.id, "ja", "支払い", "reviewed");
  publishRelease(repo, store, "shop", "R42", "pm");

  // installId가 없으면 보수적으로 제외(8.4).
  const anon = resolvePreview(repo, store, { project: "shop", key: "pay.button", locale: "ja", appVersion: "3.2.1" });
  assert.equal(anon.value, "支払―"); // 오버레이 미수신 → 옛 문구
  assert.equal(anon.canary.inRollout, false);
  assert.ok(codes(anon).includes("canary_excluded"));
});

test("한 번도 게시되지 않은 프로젝트 — manifest_missing", () => {
  const { repo, store } = seed();
  const r = resolvePreview(repo, store, { project: "shop", key: "pay.button", locale: "en", appVersion: "3.2.1" });
  assert.equal(r.source, "unresolved");
  assert.ok(codes(r).includes("manifest_missing"));
});

test("매칭 축을 하나도 안 주면 400 — 답이 아니라 질문이 잘못된 것이다", () => {
  const { repo, store } = seed();
  assert.throws(
    () => resolvePreview(repo, store, { project: "shop", key: "pay.button", locale: "en" }),
    (e: { status?: number }) => e.status === 400,
  );
});

test("없는 프로젝트는 404", () => {
  const { repo, store } = seed();
  assert.throws(
    () => resolvePreview(repo, store, { project: "nope", key: "k", locale: "en", appVersion: "1.0.0" }),
    (e: { status?: number }) => e.status === 404,
  );
});

/**
 * tombstone(삭제 마커)은 델타 포맷과 SDK가 지원하지만 지금 관리 API에는 키·번역 삭제 경로가
 * 없어 백엔드가 스스로 만들어 내지 못한다. 배포 플레인은 정적 파일이라 다른 경로로 들어온
 * 산출물도 그대로 서빙되므로, 델타를 손으로 심어 그 분기를 덮는다.
 */
test("tombstone: 오버레이가 키를 가리면 번들 값도 안 보인다", () => {
  const { repo, store } = seed();
  repo.createRelease("shop", "R42", "v3.2", { strategy: "semver-range", value: ">=3.2.0" }, "draft");
  keys(repo, "R42");
  const pub = publishRelease(repo, store, "shop", "R42", "pm");

  const snapshot: Snapshot = store.readSnapshot("shop", "R42", pub.base)!;
  const delta: Delta = { schemaVersion: 1, release: "R42", from: pub.base, to: "deadbeefdeadbeef",
    ops: [{ op: "delete", key: "pay.button", locale: "ja" }] };
  const deltaPath = store.writeDelta("shop", "R42", delta);
  const manifest: Manifest = {
    schemaVersion: 1, project: "shop", defaultLocale: "en", updatedAt: "T",
    releases: [{ id: "R42", state: "published", versionMatch: { strategy: "semver-range", value: ">=3.2.0" },
      base: pub.base, overlay: delta.to, rollout: 100, snapshot: `releases/R42/snapshot-${snapshot.base}.json`, delta: deltaPath }],
  };
  store.writeManifest("shop", manifest);

  const r = resolvePreview(repo, store, { project: "shop", key: "pay.button", locale: "ja", appVersion: "3.2.1" });
  assert.ok(codes(r).includes("tombstoned"));
  assert.equal(r.matchedLocale, "en"); // ja가 가려져 다음 로케일로
  assert.equal(r.value, "Pay");
});

test("델타가 배포 플레인에 없으면 앱은 이전 상태에 머문다 — delta_missing", () => {
  const { repo, store } = seed();
  repo.createRelease("shop", "R42", "v3.2", { strategy: "semver-range", value: ">=3.2.0" }, "draft");
  keys(repo, "R42");
  const pub = publishRelease(repo, store, "shop", "R42", "pm");
  const manifest: Manifest = {
    schemaVersion: 1, project: "shop", defaultLocale: "en", updatedAt: "T",
    releases: [{ id: "R42", state: "published", versionMatch: { strategy: "semver-range", value: ">=3.2.0" },
      base: pub.base, overlay: "cafebabecafebabe", rollout: 100,
      snapshot: `releases/R42/snapshot-${pub.base}.json`, delta: "releases/R42/delta-없는것.json" }],
  };
  store.writeManifest("shop", manifest);

  const r = resolvePreview(repo, store, { project: "shop", key: "pay.button", locale: "ja", appVersion: "3.2.1" });
  assert.ok(codes(r).includes("delta_missing"));
  assert.equal(r.value, "支払―"); // 번들 값 유지
});
