/**
 * M0 스파이크 데모 — 실행: `npm run demo` (또는 `node examples/demo.ts`)
 * 시나리오 A(OTA 긴급 수정)와 C(버전 격리)를 콘솔에 재현한다.
 */
import {
  buildSnapshot, buildDelta, compileManifest, rollbackOverlay,
  publishWithAutoClose, snapshotPath, deltaPath, type ReleaseRecord,
} from "../src/builder/builder.ts";
import { RynL10nClient, InMemoryDeliveryStore } from "../src/client/client.ts";

function line(s: string) { console.log(s); }

line("━━━ 시나리오 A: 출시 직후 오타 OTA 긴급 수정 ━━━");
{
  const v0 = buildSnapshot({ release: "R42", defaultLocale: "en", locales: { en: { "pay.button": "Pay" }, ja: { "pay.button": "支払―" } } });
  const v1 = buildSnapshot({ release: "R42", defaultLocale: "en", locales: { en: { "pay.button": "Pay" }, ja: { "pay.button": "支払い" } } });
  const delta = buildDelta(v0, v1);
  const store = new InMemoryDeliveryStore();
  store.putSnapshot(snapshotPath("R42", v0.base), v0);
  store.putDelta(deltaPath("R42", v0.base, v1.base), delta);

  const rec: ReleaseRecord = { id: "R42", versionMatch: { strategy: "semver-range", value: ">=3.2.0 <3.3.0" }, state: "published", base: v0.base, overlay: v1.base };
  const manifest = compileManifest({ project: "shop", defaultLocale: "en", updatedAt: "T1", records: [rec] });

  const client = new RynL10nClient({ bundle: v0, store, context: { appVersion: "3.2.1" } });
  line(`  번들만(출시 직후):  ja pay.button = "${client.t("pay.button", {}, "ja")}"  ← 오타`);
  client.refresh(manifest);
  line(`  OTA 오버레이 적용:  ja pay.button = "${client.t("pay.button", {}, "ja")}"  ← 심사 없이 수정`);
  client.refresh(rollbackOverlay(manifest, "R42", v0.base));
  line(`  롤백(포인터 되돌림): ja pay.button = "${client.t("pay.button", {}, "ja")}"  ← 즉시·무손실`);
  line(`  base=${v0.base}  target=${v1.base}  delta.ops=${JSON.stringify(delta.ops)}`);
}

line("");
line("━━━ 시나리오 C: 앱 버전별 격리 (신규 키가 구버전에 새지 않음) ━━━");
{
  const store = new InMemoryDeliveryStore();
  const r42 = buildSnapshot({ release: "R42", defaultLocale: "en", locales: { en: { "home.title": "Home" } } });
  const r50 = buildSnapshot({ release: "R50", defaultLocale: "en", locales: { en: { "home.title": "Home", "home.newBadge": "NEW" } } });
  store.putSnapshot(snapshotPath("R42", r42.base), r42);
  store.putSnapshot(snapshotPath("R50", r50.base), r50);

  const records = publishWithAutoClose(
    [{ id: "R42", versionMatch: { strategy: "semver-range", value: ">=3.2.0" }, state: "published", base: r42.base, overlay: r42.base }],
    { id: "R50", versionMatch: { strategy: "semver-range", value: ">=3.3.0" }, state: "published", base: r50.base, overlay: r50.base },
  );
  const manifest = compileManifest({ project: "app", defaultLocale: "en", updatedAt: "T", records });
  line(`  publish 자동 상한 닫힘: R42 → "${records.find((r) => r.id === "R42")!.versionMatch.value}" (${records.find((r) => r.id === "R42")!.state})`);

  const oldApp = new RynL10nClient({ bundle: r42, store, context: { appVersion: "3.2.5" } });
  oldApp.refresh(manifest);
  line(`  구버전 앱 3.2.5 → 릴리스 ${oldApp.status().releaseId}: home.newBadge = "${oldApp.t("home.newBadge")}"  ← 격리(미해결)`);

  const newApp = new RynL10nClient({ bundle: r50, store, context: { appVersion: "3.3.1" } });
  newApp.refresh(manifest);
  line(`  신규 앱 3.3.1 → 릴리스 ${newApp.status().releaseId}: home.newBadge = "${newApp.t("home.newBadge")}"  ← 정상 노출`);
}
