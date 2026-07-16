import { test } from "node:test";
import assert from "node:assert/strict";
import { RynL10nClient, InMemoryDeliveryStore } from "../src/client/client.ts";
import type { Manifest, Snapshot } from "../src/core/types.ts";

const bundle: Snapshot = {
  schemaVersion: 1, release: "R1", base: "b0", defaultLocale: "en",
  locales: { en: { greet: "Hello {name}" } },
};
function manifest(overlay: string, deltaPath?: string): Manifest {
  return {
    schemaVersion: 1, project: "p", defaultLocale: "en", updatedAt: "T",
    releases: [{
      id: "R1", state: "published", versionMatch: { strategy: "semver-range", value: ">=1.0.0" },
      base: "b0", overlay, rollout: 100, snapshot: "releases/R1/snapshot-b0.json",
      ...(deltaPath ? { delta: deltaPath } : {}),
    }],
  };
}

test("텔레메트리 aggregate: overlay_applied · key_unresolved 집계 + drain 리셋", () => {
  const store = new InMemoryDeliveryStore();
  store.putDelta("releases/R1/delta-b0-b1.json", {
    schemaVersion: 1, release: "R1", from: "b0", to: "b1",
    ops: [{ op: "set", key: "greet", locale: "en", value: "Hi {name}" }],
  });
  const client = new RynL10nClient({ bundle, store, context: { appVersion: "1.0.0" }, telemetry: "aggregate" });
  client.refresh(manifest("b1", "releases/R1/delta-b0-b1.json"));
  client.t("greet", { name: "Sol" });
  client.t("missing.key");

  const t = client.drainTelemetry();
  assert.equal(t.overlay_applied, 1);
  assert.equal(t.key_unresolved, 1);
  // drain은 리셋
  assert.deepEqual(client.drainTelemetry(), { overlay_applied: 0, format_guard_rejected: 0, key_unresolved: 0, delta_failed: 0 });
});

test("텔레메트리: 포맷 가드 거부 카운트", () => {
  const store = new InMemoryDeliveryStore();
  store.putDelta("releases/R1/delta-b0-b2.json", {
    schemaVersion: 1, release: "R1", from: "b0", to: "b2",
    ops: [{ op: "set", key: "greet", locale: "en", value: "Hi {count}" }], // 서명 불일치({name}→{count})
  });
  const client = new RynL10nClient({ bundle, store, context: { appVersion: "1.0.0" }, telemetry: "aggregate" });
  client.refresh(manifest("b2", "releases/R1/delta-b0-b2.json"));
  client.t("greet", { name: "Sol" }); // 가드 발동 → 번들로 fallback
  assert.equal(client.drainTelemetry().format_guard_rejected, 1);
});

test("텔레메트리: 델타 다운로드 실패 카운트", () => {
  const store = new InMemoryDeliveryStore(); // 델타 없음
  const client = new RynL10nClient({ bundle, store, context: { appVersion: "1.0.0" }, telemetry: "aggregate" });
  const changed = client.refresh(manifest("bX", "releases/R1/delta-b0-bX.json"));
  assert.equal(changed, false);
  assert.equal(client.drainTelemetry().delta_failed, 1);
});

test("텔레메트리 기본 off: 활동해도 카운트 0(옵트인)", () => {
  const store = new InMemoryDeliveryStore();
  const client = new RynL10nClient({ bundle, store, context: { appVersion: "1.0.0" } }); // 기본 off
  client.refresh(manifest("bX", "releases/R1/delta-b0-bX.json"));
  client.t("missing");
  assert.deepEqual(client.drainTelemetry(), { overlay_applied: 0, format_guard_rejected: 0, key_unresolved: 0, delta_failed: 0 });
});
