import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { openDatabase } from "../../../backend/src/db/schema.ts";
import { Repo } from "../../../backend/src/db/repo.ts";
import { FsArtifactStore } from "../../../backend/src/storage/store.ts";
import { TokenRegistry } from "../../../backend/src/auth/rbac.ts";
import { Notifier } from "../../../backend/src/observability/notifier.ts";
import { createManagementServer } from "../../../backend/src/api/server.ts";
import { HttpRynL10n } from "../src/http.ts";
import type { Manifest, Snapshot } from "../../../src/core/types.ts";

function listen(s: Server): Promise<string> {
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
}
function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (cond()) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error("timeout")); }
    }, 10);
  });
}

test("실시간 푸시: publish 신호(SSE) 수신 → Web SDK 즉시 갱신 (M4/8.4)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "rynl10n-push-"));
  const repo = new Repo(openDatabase());
  const store = new FsArtifactStore(tmp);
  const tokens = new TokenRegistry();
  tokens.issue("admin", { actor: "a", role: "admin", projects: "*" });
  const notifier = new Notifier();
  const mgmt = createManagementServer({ repo, store, tokens, notifier });
  const mgmtUrl = await listen(mgmt);

  // 배포 플레인(정적) — tmp의 산출물을 그대로 서빙(ETag 없음 → 항상 재요청).
  const delivery = createServer((req, res) => {
    readFile(join(tmp, decodeURIComponent(req.url ?? "/")))
      .then((d) => { res.writeHead(200, { "content-type": "application/json" }); res.end(d); })
      .catch(() => { res.writeHead(404).end(); });
  });
  const deliveryUrl = await listen(delivery);

  const api = (method: string, path: string, body?: unknown) => {
    const init: RequestInit = { method, headers: { authorization: "Bearer admin", "content-type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(mgmtUrl + path, init);
  };

  // 시드 + 최초 publish
  await api("POST", "/projects", { id: "shop", name: "S", defaultLocale: "en", locales: ["en", "ja"] });
  await api("PUT", "/projects/shop/keys/pay.button");
  await api("PUT", "/projects/shop/translations/pay.button/ja", { value: "支払―", state: "reviewed" });
  await api("POST", "/projects/shop/releases", { id: "R1", name: "v1", versionMatch: { strategy: "semver-range", value: ">=1.0.0" }, keys: ["pay.button"] });
  await api("POST", "/projects/shop/releases/R1/publish");

  // 번들 = 배포 플레인의 현재 스냅샷(빌드 플러그인 bake 시뮬)
  const manifest = (await (await fetch(`${deliveryUrl}/shop/manifest.json`)).json()) as Manifest;
  const bundle = (await (await fetch(`${deliveryUrl}/shop/${manifest.releases[0]!.snapshot}`)).json()) as Snapshot;

  const sdk = new HttpRynL10n({ projectKey: "shop", endpoint: deliveryUrl, pushEndpoint: mgmtUrl, bundle, context: { appVersion: "1.0.0" } });
  await sdk.refresh();
  assert.equal(sdk.t("pay.button", {}, "ja"), "支払―");

  // 푸시 연결 + 이벤트 대기 준비
  let pushed = 0;
  void sdk.connectServerPush(() => { pushed++; });
  await waitFor(() => notifier.subscriberCount("shop") > 0); // SSE 연결 확립 대기

  // 오타 수정 → republish → SSE 신호 → SDK 자동 갱신
  await api("PUT", "/projects/shop/translations/pay.button/ja", { value: "支払い", state: "reviewed" });
  await api("POST", "/projects/shop/releases/R1/publish");

  await waitFor(() => pushed > 0); // 폴링 없이 푸시로 갱신됨
  assert.equal(sdk.t("pay.button", {}, "ja"), "支払い");

  sdk.stop();
  mgmt.close();
  delivery.close();
});
