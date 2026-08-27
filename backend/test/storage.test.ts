/**
 * 산출물 스토리지 — 경로 안전과 SDK 읽기 뷰.
 *
 * `deliveryReader`는 진단·시뮬레이션(MCP `resolve_preview`)이 SDK와 **같은 경로 규약**으로
 * 산출물을 읽기 위한 표면이다. manifest가 준 상대 경로를 그대로 join하므로, 프로젝트 id에
 * 이미 걸려 있던 경로 순회 가드가 릴리스 id와 그 경로에도 걸려야 한다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsArtifactStore, MemoryArtifactStore } from "../src/storage/store.ts";
import type { Delta, Snapshot } from "../../src/core/types.ts";

const SNAP: Snapshot = { schemaVersion: 1, release: "R1", base: "abc123", defaultLocale: "en", locales: { en: { k: "v" } } };
const DELTA: Delta = { schemaVersion: 1, release: "R1", from: "abc123", to: "def456", ops: [{ op: "set", key: "k", locale: "en", value: "v2" }] };

for (const [label, make] of [
  ["FsArtifactStore", () => new FsArtifactStore(mkdtempSync(join(tmpdir(), "rynl10n-store-")))],
  ["MemoryArtifactStore", () => new MemoryArtifactStore()],
] as const) {
  test(`${label}: 델타를 쓰고 다시 읽는다`, () => {
    const store = make();
    store.writeSnapshot("shop", "R1", SNAP);
    store.writeDelta("shop", "R1", DELTA);
    assert.deepEqual(store.readDelta("shop", "R1", "abc123", "def456"), DELTA);
    assert.equal(store.readDelta("shop", "R1", "abc123", "없음"), undefined);
  });

  test(`${label}: deliveryReader는 manifest가 주는 상대 경로로 읽는다(SDK와 같은 규약)`, () => {
    const store = make();
    const snapPath = store.writeSnapshot("shop", "R1", SNAP);
    const deltaPath = store.writeDelta("shop", "R1", DELTA);
    const reader = store.deliveryReader("shop");
    assert.deepEqual(reader.getSnapshot(snapPath), SNAP);
    assert.deepEqual(reader.getDelta(deltaPath), DELTA);
    assert.equal(reader.getSnapshot("releases/R1/snapshot-없는것.json"), undefined);
  });

  test(`${label}: 릴리스 id도 경로 세그먼트다 — 순회 시도를 거부한다`, () => {
    const store = make();
    // 막지 않으면 쓰기가 스토리지 루트 밖을 오염시킨다(프로젝트 id와 같은 부류의 문제).
    assert.throws(() => store.writeSnapshot("shop", "../../escape", SNAP), /릴리스 id/);
    assert.throws(() => store.readSnapshot("shop", "..", "abc123"), /릴리스 id/);
  });
}

test("FsArtifactStore: deliveryReader의 상대 경로도 루트 밖을 못 나간다", () => {
  const root = mkdtempSync(join(tmpdir(), "rynl10n-store-"));
  const store = new FsArtifactStore(root);
  const reader = store.deliveryReader("shop");
  assert.throws(() => reader.getSnapshot("../../../etc/passwd"), /경로 세그먼트/);
  assert.throws(() => reader.getSnapshot("/etc/passwd"), /상대 경로/);
  rmSync(root, { recursive: true, force: true });
});
