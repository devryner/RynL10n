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
  assert.equal(t.release_applied, 1, "오버레이를 적용한 경우에도 '이 릴리스를 쓴다'는 함께 오른다");
  assert.equal(t.key_unresolved, 1);
  // drain은 리셋
  assert.deepEqual(client.drainTelemetry(), { release_applied: 0, overlay_applied: 0, format_guard_rejected: 0, key_unresolved: 0, delta_failed: 0 });
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
  assert.deepEqual(client.drainTelemetry(), { release_applied: 0, overlay_applied: 0, format_guard_rejected: 0, key_unresolved: 0, delta_failed: 0 });
});

test("텔레메트리: 델타 없는 릴리스도 적용을 알린다 — overlay_applied는 오르지 않는다", () => {
  // 한 번만 게시한 릴리스(overlay === base)에는 delta가 없다. 예전에는 이 앱이 릴리스를 쓰고 있어도
  // 카운터가 영영 0이라, 서버가 "안 쓰인다"와 "알릴 방법이 없다"를 구별할 수 없었다.
  const client = new RynL10nClient({
    bundle, store: new InMemoryDeliveryStore(), context: { appVersion: "1.0.0" }, telemetry: "aggregate",
  });
  assert.equal(client.refresh(manifest("b0")), true);

  const t = client.drainTelemetry();
  assert.equal(t.release_applied, 1);
  assert.equal(t.overlay_applied, 0, "오버레이를 적용한 적은 없다 — 건전성 비율의 분모를 흔들면 안 된다");
});

test("텔레메트리: 카나리 rollout 밖 기기도 적용은 알린다", () => {
  const store = new InMemoryDeliveryStore();
  store.putDelta("releases/R1/delta-b0-b1.json", {
    schemaVersion: 1, release: "R1", from: "b0", to: "b1",
    ops: [{ op: "set", key: "greet", locale: "en", value: "Hi {name}" }],
  });
  const client = new RynL10nClient({
    bundle, store, context: { appVersion: "1.0.0" }, installId: "device-x", telemetry: "aggregate",
  });
  const m = manifest("b1", "releases/R1/delta-b0-b1.json");
  client.refresh({ ...m, releases: [{ ...m.releases[0]!, rollout: 0 }] });

  const t = client.drainTelemetry();
  assert.equal(t.release_applied, 1, "오버레이는 못 받아도 그 릴리스의 base를 쓰고 있다");
  assert.equal(t.overlay_applied, 0);
});

test("텔레메트리: 릴리스가 없으면(번들만) 귀속시킬 릴리스가 없어 아무것도 안 센다", () => {
  const client = new RynL10nClient({
    bundle, store: new InMemoryDeliveryStore(), context: { appVersion: "9.0.0" }, telemetry: "aggregate",
  });
  client.refresh(manifest("b0")); // versionMatch >=1.0.0 이지만 9.0.0도 매칭되므로 별도 manifest 필요
  client.drainTelemetry();

  const bundleOnly = new RynL10nClient({
    bundle, store: new InMemoryDeliveryStore(), context: { appVersion: "0.1.0" }, telemetry: "aggregate",
  });
  bundleOnly.refresh(manifest("b0"));
  assert.equal(bundleOnly.drainTelemetry().release_applied, 0, "매칭된 릴리스가 없으면 셀 대상이 없다");
});
