import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketOf, inRollout } from "../src/core/canary.ts";
import { intInRange, parseIntRange } from "../src/core/intrange.ts";
import { selectRelease, findRangeConflicts } from "../src/core/matching.ts";
import { RynL10nClient, InMemoryDeliveryStore } from "../src/client/client.ts";
import type { ManifestRelease, Manifest, Snapshot } from "../src/core/types.ts";

test("카나리 버킷: 결정적(같은 입력 → 같은 버킷), 릴리스별 독립", () => {
  const iid = "550e8400-e29b-41d4-a716-446655440000";
  assert.equal(bucketOf(iid, "R42"), bucketOf(iid, "R42")); // 결정적
  const b42 = bucketOf(iid, "R42"), b50 = bucketOf(iid, "R50");
  assert.ok(b42 >= 0 && b42 < 100);
  // 릴리스별 독립 버킷(대개 다름 → 편향 방지)
  assert.notEqual(b42, b50);
});

test("inRollout: 100=전체, 0=없음, installId 없으면 rollout<100 미수신", () => {
  const iid = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
  assert.equal(inRollout(100, iid, "R42"), true);
  assert.equal(inRollout(0, iid, "R42"), false);
  assert.equal(inRollout(50, undefined, "R42"), false); // installId 없음 → 안전(미수신)
  assert.equal(inRollout(50, iid, "R42"), bucketOf(iid, "R42") < 50);
});

test("카나리 게이트: rollout<100이고 버킷 밖이면 오버레이 미수신(base만)", () => {
  const bundle: Snapshot = { schemaVersion: 1, release: "R1", base: "b0", defaultLocale: "en", locales: { en: { greet: "old" } } };
  const store = new InMemoryDeliveryStore();
  store.putDelta("releases/R1/delta-b0-b1.json", { schemaVersion: 1, release: "R1", from: "b0", to: "b1", ops: [{ op: "set", key: "greet", locale: "en", value: "new" }] });
  const manifest: Manifest = {
    schemaVersion: 1, project: "p", defaultLocale: "en", updatedAt: "T",
    releases: [{ id: "R1", state: "published", versionMatch: { strategy: "semver-range", value: ">=1.0.0" }, base: "b0", overlay: "b1", rollout: 0, snapshot: "releases/R1/snapshot-b0.json", delta: "releases/R1/delta-b0-b1.json" }],
  };
  // rollout 0 → 아무도 카나리 미수신 → 번들 값 유지
  const c = new RynL10nClient({ bundle, store, context: { appVersion: "1.0.0" }, installId: "x" });
  c.refresh(manifest);
  assert.equal(c.t("greet"), "old");

  // rollout 100 → 전체 수신 → 새 값
  const c2 = new RynL10nClient({ bundle, store, context: { appVersion: "1.0.0" }, installId: "x" });
  c2.refresh({ ...manifest, releases: [{ ...manifest.releases[0]!, rollout: 100 }] });
  assert.equal(c2.t("greet"), "new");
});

test("정수 버전 매칭: 범위·거부", () => {
  assert.ok(intInRange(42, ">=42 <50"));
  assert.ok(!intInRange(50, ">=42 <50"));
  assert.ok(intInRange(100, ">=42"));
  assert.throws(() => parseIntRange(">=42 || >=100"), /미지원/);
  assert.throws(() => parseIntRange("1.2"), /유효하지/);
});

test("정수 range 라우팅 + 충돌 검사", () => {
  function rel(id: string, value: string): ManifestRelease {
    return { id, state: "published", versionMatch: { strategy: "integer-range", value }, base: id, overlay: id, rollout: 100, snapshot: `releases/${id}/snapshot-${id}.json` };
  }
  const releases = [rel("B1", ">=42 <50"), rel("B2", ">=50")];
  const idOf = (r: ReturnType<typeof selectRelease>) => (r.kind === "matched" ? r.release.id : null);
  assert.equal(idOf(selectRelease(releases, { buildNumber: 45 })), "B1");
  assert.equal(idOf(selectRelease(releases, { buildNumber: 60 })), "B2");
  // 인접(50 경계)은 충돌 없음
  assert.equal(findRangeConflicts(releases.map((r) => ({ id: r.id, versionMatch: r.versionMatch }))).length, 0);
  // 겹치면 충돌
  const overlap = [{ id: "B1", versionMatch: { strategy: "integer-range" as const, value: ">=42 <60" } }, { id: "B2", versionMatch: { strategy: "integer-range" as const, value: ">=50 <70" } }];
  assert.equal(findRangeConflicts(overlap).length, 1);
});
