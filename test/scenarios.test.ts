/**
 * DoD ① — 샘플 시나리오 A/B/C 재현 (기획서 3.3 / 10.1)
 *   A = 출시 직후 오타 OTA 긴급 수정
 *   B = 빌드타임 자동 번들링(결정적 재현)
 *   C = 앱 버전별 격리 (가장 어려운 4.3)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSnapshot,
  buildDelta,
  compileManifest,
  publishWithAutoClose,
  assertNoConflicts,
  rollbackOverlay,
  snapshotPath,
  deltaPath,
  type ReleaseRecord,
} from "../src/builder/builder.ts";
import { RynL10nClient, InMemoryDeliveryStore } from "../src/client/client.ts";

test("시나리오 A — 출시 직후 오타 OTA 긴급 수정", () => {
  // 1) R42 출시: 일본어 결제 화면에 오타("支払い" 대신 "支払―")
  const v0 = buildSnapshot({
    release: "R42", defaultLocale: "en",
    locales: {
      en: { "pay.button": "Pay" },
      ja: { "pay.button": "支払―" }, // 오타
    },
  });
  // 2) PM이 대시보드에서 수정 → 새 target 스냅샷 + 델타 사전 생성(publish 시점)
  const v1 = buildSnapshot({
    release: "R42", defaultLocale: "en",
    locales: {
      en: { "pay.button": "Pay" },
      ja: { "pay.button": "支払い" }, // 수정
    },
  });
  const delta = buildDelta(v0, v1);
  assert.deepEqual(delta.ops, [{ op: "set", key: "pay.button", locale: "ja", value: "支払い" }]);

  // 3) 배포 플레인에 산출물 업로드(불변)
  const store = new InMemoryDeliveryStore();
  store.putSnapshot(snapshotPath("R42", v0.base), v0);
  store.putDelta(deltaPath("R42", v0.base, v1.base), delta);

  // 4) 앱(v3.2.1)은 v0을 bake해 출시된 상태. overlay 포인터를 v1으로 건 manifest 게시
  const record: ReleaseRecord = {
    id: "R42", versionMatch: { strategy: "semver-range", value: ">=3.2.0 <3.3.0" },
    state: "published", base: v0.base, overlay: v1.base,
  };
  const manifest = compileManifest({ project: "shop", defaultLocale: "en", updatedAt: "T1", records: [record] });

  const client = new RynL10nClient({ bundle: v0, store, context: { appVersion: "3.2.1" } });
  let notified = 0;
  client.onCatalogUpdated(() => notified++);

  // 갱신 전: 번들의 오타
  assert.equal(client.t("pay.button", {}, "ja"), "支払―");
  // 갱신 후: OTA로 수정본 반영 (심사 없이)
  assert.equal(client.refresh(manifest), true);
  assert.equal(client.t("pay.button", {}, "ja"), "支払い");
  assert.equal(notified, 1);

  // 5) 롤백: overlay 포인터를 v0(base)으로 되돌려 재게시 → 즉시·무손실
  const rolledBack = rollbackOverlay(manifest, "R42", v0.base);
  assert.equal(rolledBack.releases[0]!.overlay, v0.base);
  client.refresh(rolledBack);
  assert.equal(client.t("pay.button", {}, "ja"), "支払―"); // 이전 상태로 복귀
});

test("시나리오 B — 빌드타임 자동 번들링(결정적 재현 · lockfile base 해시)", () => {
  const cat = {
    release: "R1", defaultLocale: "en" as const,
    locales: { en: { greet: "Hello" }, ko: { greet: "안녕하세요" } },
  };
  // 같은 소스 → 같은 base 해시(CI 재현성 · lockfile 고정의 근거)
  const a = buildSnapshot(cat);
  const b = buildSnapshot({ ...cat, locales: { ko: { greet: "안녕하세요" }, en: { greet: "Hello" } } });
  assert.equal(a.base, b.base); // 키 순서 무관
  assert.match(a.base, /^[0-9a-f]{16}$/); // 16 hex 파일 식별자

  // NFC: 조합형으로 들어와도 같은 번들 해시 → 빌드 산출물 안정
  const decomposed = buildSnapshot({
    release: "R1", defaultLocale: "en",
    locales: { en: { greet: "Hello" }, ko: { greet: "안녕하세요".normalize("NFD") } },
  });
  assert.equal(a.base, decomposed.base);
});

test("시나리오 C — 앱 버전별 격리(4.3): 신규 키가 구버전에 새지 않는다", () => {
  const store = new InMemoryDeliveryStore();

  // R42: 구버전 카탈로그 (신규 키 없음)
  const r42 = buildSnapshot({
    release: "R42", defaultLocale: "en",
    locales: { en: { "home.title": "Home" } },
  });
  // R50: 신규 키 "home.newBadge" 추가
  const r50 = buildSnapshot({
    release: "R50", defaultLocale: "en",
    locales: { en: { "home.title": "Home", "home.newBadge": "NEW" } },
  });
  store.putSnapshot(snapshotPath("R42", r42.base), r42);
  store.putSnapshot(snapshotPath("R50", r50.base), r50);

  // publish 절차: R42가 열린 상한(>=3.2.0)으로 먼저 published.
  // 이후 R50(>=3.3.0)을 publish → R42 상한 자동 닫힘 + superseded, 충돌 없음.
  const r42rec: ReleaseRecord = {
    id: "R42", versionMatch: { strategy: "semver-range", value: ">=3.2.0" },
    state: "published", base: r42.base, overlay: r42.base,
  };
  const r50rec: ReleaseRecord = {
    id: "R50", versionMatch: { strategy: "semver-range", value: ">=3.3.0" },
    state: "published", base: r50.base, overlay: r50.base,
  };
  const records = publishWithAutoClose([r42rec], r50rec);
  assert.doesNotThrow(() => assertNoConflicts(records));
  // R42는 상한이 닫히고 superseded로 전이
  const r42after = records.find((r) => r.id === "R42")!;
  assert.equal(r42after.versionMatch.value, ">=3.2.0 <3.3.0");
  assert.equal(r42after.state, "superseded");

  const manifest = compileManifest({ project: "app", defaultLocale: "en", updatedAt: "T", records });

  // 구버전 앱(3.2.5): R42로 라우팅 → 신규 키는 보이지 않음(격리, P3)
  const oldApp = new RynL10nClient({ bundle: r42, store, context: { appVersion: "3.2.5" } });
  oldApp.refresh(manifest);
  assert.equal(oldApp.status().releaseId, "R42");
  assert.equal(oldApp.t("home.title"), "Home");
  assert.equal(oldApp.t("home.newBadge"), "⟪home.newBadge⟫"); // 미해결 — 구버전에 새지 않음

  // 신규 앱(3.3.1): R50으로 라우팅 → 신규 키 정상 노출
  const newApp = new RynL10nClient({ bundle: r50, store, context: { appVersion: "3.3.1" } });
  newApp.refresh(manifest);
  assert.equal(newApp.status().releaseId, "R50");
  assert.equal(newApp.t("home.newBadge"), "NEW");
});

test("시나리오 C 보강 — 겹치는 범위 동시 published는 409로 차단", () => {
  // auto-close를 거치지 않고 두 릴리스가 겹친 채 published가 되려는 상황.
  const overlapping: ReleaseRecord[] = [
    { id: "R42", versionMatch: { strategy: "semver-range", value: ">=3.2.0 <3.4.0" }, state: "published", base: "x", overlay: "x" },
    { id: "R60", versionMatch: { strategy: "semver-range", value: ">=3.3.0 <3.5.0" }, state: "published", base: "y", overlay: "y" },
  ];
  assert.throws(() => assertNoConflicts(overlapping), /409|충돌/);
});
