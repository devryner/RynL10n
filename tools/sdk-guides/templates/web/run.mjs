import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";

const { API, CDN } = JSON.parse(readFileSync("../server.json", "utf8"));
const dom = new JSDOM('<span id="cart-title"></span>', { url: CDN });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage });
const realFetch = globalThis.fetch;
const realInterval = globalThis.setInterval;
const timers = new Set();
const sdks = [];
let allowNetwork;
const networkReady = new Promise((resolve) => { allowNetwork = resolve; });
let pushConnected = false;
globalThis.setInterval = (...args) => {
  const timer = realInterval(...args);
  timers.add(timer);
  return timer;
};
globalThis.fetch = async (url, options) => {
  await networkReady;
  const address = new URL(String(url).replace("https://cdn.example.com", CDN).replace("https://api.example.com", API), CDN);
  const response = await realFetch(address, options);
  if (address.pathname.endsWith("/events")) pushConnected = true;
  return response;
};

async function compile(name, exports) {
  const contents = readFileSync(name, "utf8") + `\nexport { ${exports} };\n`;
  await build({
    stdin: { contents, resolveDir: process.cwd(), sourcefile: name, loader: name.endsWith("tsx") ? "tsx" : "ts" },
    bundle: true, platform: "node", format: "esm", packages: "external", outfile: `run-${name}.mjs`,
  });
  return import(`./run-${name}.mjs`);
}
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert(check(), "SDK 가이드 실행 결과 대기 시간 초과");
}
const headers = { authorization: "Bearer dev-admin-token", "content-type": "application/json" };
async function telemetryCount() {
  const response = await realFetch(`${API}/projects/shop/telemetry`, { headers });
  assert(response.ok);
  const { telemetry } = await response.json();
  return telemetry.filter((row) => row.event === "release_applied").reduce((total, row) => total + row.count, 0);
}
try {
  const main = await compile("l10n.ts", "sdk");
  sdks.push(main.sdk);
  assert.equal(document.getElementById("cart-title").textContent, "Cart");
  allowNetwork();
  await until(() => document.getElementById("cart-title").textContent === "Updated Cart");
  assert.equal(main.sdk.t("cart.items", { n: 2 }), "2 items");
  main.sdk.stop();
  console.log("PASS Web config, DOM initial render, remote update, plural");

  const imported = await compile("bundle-import.ts", "bundle");
  assert.equal(imported.bundle.locales.en["cart.title"], "Cart");
  const fetched = await compile("bundle-fetch.ts", "bundle, lock");
  assert.equal(fetched.bundle.base, imported.bundle.base);
  assert.equal(fetched.lock.release, "R1");
  console.log("PASS Web bundle import and HTTP snapshot/lockfile loader");

  const cache = await compile("cache.ts", "sdk");
  sdks.push(cache.sdk);
  await cache.sdk.refresh();
  assert.equal(cache.sdk.t("home.title"), "Updated Home");
  cache.sdk.clearCache();
  console.log("PASS Web explicit memory cache, refresh, clear");

  const push = await compile("push.ts", "sdk");
  sdks.push(push.sdk);
  await until(() => pushConnected && push.sdk.t("cart.title") === "Updated Cart");
  assert((await realFetch(`${API}/projects/shop/translations/cart.title/en`, {
    method: "PUT", headers, body: JSON.stringify({ value: "Push Cart" }),
  })).ok);
  assert((await realFetch(`${API}/projects/shop/releases/R1/publish`, { method: "POST", headers })).ok);
  await until(() => push.sdk.t("cart.title") === "Push Cart");
  push.sdk.stop();
  console.log("PASS Web push subscription and published update");

  const before = await telemetryCount();
  const telemetry = await compile("telemetry.ts", "sdk");
  sdks.push(telemetry.sdk);
  await until(() => telemetry.sdk.t("cart.title") === "Push Cart");
  assert(await telemetry.sdk.flushTelemetry());
  assert(await telemetryCount() > before, "SDK 텔레메트리가 서버에 집계되어야 한다");
  telemetry.sdk.stop();
  console.log("PASS Web telemetry collection and upload");

  const react = await compile("react.tsx", "store");
  sdks.push(react.store);
  const render = () => renderToString(React.createElement(() => React.createElement("span", null, react.useTranslation()("cart.title"))));
  assert.equal(render(), "<span>Cart</span>");
  await react.store.refresh();
  assert.equal(render(), "<span>Push Cart</span>");
  console.log("PASS React useSyncExternalStore render before and after update");
} finally {
  allowNetwork();
  for (const sdk of sdks) sdk.stop();
  for (const timer of timers) clearInterval(timer);
  dom.window.close();
}
