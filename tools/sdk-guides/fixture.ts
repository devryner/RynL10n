import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import { openDatabase } from "../../backend/src/db/schema.ts";
import { Repo } from "../../backend/src/db/repo.ts";
import { FsArtifactStore } from "../../backend/src/storage/store.ts";
import { TokenRegistry } from "../../backend/src/auth/rbac.ts";
import { createManagementServer } from "../../backend/src/api/server.ts";
import { createDeliveryServer } from "../../backend/src/storage/delivery-server.ts";
import type { Snapshot } from "../../src/core/types.ts";

export async function fixture(work: string) {
  const db = openDatabase();
  const storage = join(work, "delivery");
  const tokens = new TokenRegistry();
  tokens.issue("dev-admin-token", { actor: "guide-check", role: "admin", projects: "*" });
  const api = createManagementServer({ repo: new Repo(db), store: new FsArtifactStore(storage), tokens });
  const cdn = createDeliveryServer({ root: storage });
  const servers = [api, cdn];
  const close = async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    })));
    db.close();
  };
  try {
    for (const server of servers) {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
      });
    }
    const url = (server: Server) => {
      const address = server.address();
      assert(address && typeof address !== "string");
      return `http://127.0.0.1:${address.port}`;
    };
    const API = url(api), CDN = url(cdn);
    async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
      const response = await fetch(API + path, {
        method, headers: { authorization: "Bearer dev-admin-token", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
      });
      assert(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text()}`);
      return response.json() as Promise<T>;
    }
    let snapshot: Snapshot | undefined;
    for (const project of ["myapp", "shop"]) {
      await request("POST", "/projects", { id: project, name: project, defaultLocale: "en", locales: ["en", "ko", "ja"] });
      const values = {
        "home.title": { en: "Home", ko: "홈", ja: "ホーム" },
        "cart.title": { en: "Cart", ko: "장바구니", ja: "カート" },
        "cart.items": { en: { one: "{n} item", other: "{n} items" }, ko: { other: "{n}개" }, ja: { other: "{n}個" } },
      };
      for (const [key, locales] of Object.entries(values)) {
        await request("PUT", `/projects/${project}/keys/${key}`, key === "cart.items" ? { isPlural: true, signature: "n:simple" } : {});
        for (const [locale, value] of Object.entries(locales)) {
          await request("PUT", `/projects/${project}/translations/${key}/${locale}`, { value });
        }
      }
      await request("POST", `/projects/${project}/releases`, {
        name: "guide", versionMatch: { strategy: "semver-range", value: ">=1.0.0 <4.0.0" }, keys: Object.keys(values),
      });
      await request("POST", `/projects/${project}/releases/R1/publish`);
      snapshot = await request<Snapshot>("GET", `/projects/${project}/releases/R1/snapshot`);
      if (project === "myapp") {
        writeFileSync(join(work, "snapshot.json"), JSON.stringify(snapshot));
        const assets = join(storage, "assets/rynl10n");
        mkdirSync(assets, { recursive: true });
        writeFileSync(join(assets, "snapshot.json"), JSON.stringify(snapshot));
        writeFileSync(join(assets, "rynl10n.lock"), JSON.stringify({ schemaVersion: 1, release: "R1", base: snapshot.base, keyCount: 3, locales: ["en", "ko", "ja"] }));
      }
      await request("PUT", `/projects/${project}/translations/home.title/en`, { value: "Updated Home" });
      await request("PUT", `/projects/${project}/translations/cart.title/en`, { value: "Updated Cart" });
      await request("POST", `/projects/${project}/releases/R1/publish`);
    }
    writeFileSync(join(work, "server.json"), JSON.stringify({ API, CDN }));
    return { API, CDN, close };
  } catch (error) {
    // A partially initialized fixture must not keep Node alive after a failed setup.
    for (const server of servers) { server.closeAllConnections(); server.close(); }
    db.close();
    throw error;
  }
}
