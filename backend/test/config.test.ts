/**
 * 기동 설정 — 빈 문자열은 "설정 없음"이다 (config.ts).
 *
 * 지키려는 계약: 값 없는 환경변수가 **빈 문자열로** 주입돼도 기본값이 살아남는다.
 * `process.env.X ?? 기본값`은 이걸 못 한다 — nullish만 걸러내므로 빈 값이 기본값을 덮어쓴다.
 * 그때 각 변수가 어떻게 망가지는지가 아래 테스트 이름이다. 전부 **조용한** 고장이라
 * (서버는 뜨고 요청도 받는다) 계약으로 못박지 않으면 운영에서야 드러난다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { envValue, envPort, loadConfig } from "../src/config.ts";

test("envValue: 미설정·빈 문자열·공백뿐인 값은 모두 '없음'", () => {
  assert.equal(envValue({}, "X"), undefined);
  assert.equal(envValue({ X: undefined }, "X"), undefined);
  assert.equal(envValue({ X: "" }, "X"), undefined);
  assert.equal(envValue({ X: "   " }, "X"), undefined);
  assert.equal(envValue({ X: "\t\n" }, "X"), undefined);
  // 값이 있으면 그대로 — 내용은 자르지 않는다(경로·토큰의 앞뒤 공백은 호출자 소관).
  assert.equal(envValue({ X: "v" }, "X"), "v");
  assert.equal(envValue({ X: " v " }, "X"), " v ");
});

test("envPort: 빈 값이면 기본값 — Number('')는 0이고 listen(0)은 OS 임의 포트다", () => {
  assert.equal(envPort({ P: "" }, "P", 8787), 8787);
  assert.equal(envPort({ P: "   " }, "P", 8787), 8787);
  assert.equal(envPort({}, "P", 8787), 8787);
  assert.equal(envPort({ P: "9999" }, "P", 8787), 9999);
  // 0은 "임의 포트를 달라"는 정상적인 요청이다(테스트 서버가 쓴다) — 막을 것은 빈 값이 0이 되는 쪽.
  assert.equal(envPort({ P: "0" }, "P", 8787), 0);
});

test("envPort: 정수가 아니면 기동을 멈춘다 — listen(NaN)은 조용히 통과한다", () => {
  for (const bad of ["abc", "80.5", "-1", "65536"]) {
    assert.throws(() => envPort({ P: bad }, "P", 8787), /0~65535/, `막지 못함: ${bad}`);
  }
});

test("loadConfig: 전 변수가 빈 문자열이어도 기본값으로 뜬다", () => {
  const cfg = loadConfig({
    RYNL10N_PORT: "",
    RYNL10N_DELIVERY_PORT: "",
    RYNL10N_DB: "",
    RYNL10N_STORAGE: "",
    RYNL10N_ADMIN_TOKEN: "",
    RYNL10N_DELIVERY_ALLOW_ORIGIN: "",
    RYNL10N_DELIVERY_URL: "",
  });
  assert.equal(cfg.managementPort, 8787);
  assert.equal(cfg.deliveryPort, 8788);
  // ":memory:"가 아니면 node:sqlite가 빈 경로를 익명 임시 DB로 연다(종료 시 소멸).
  assert.equal(cfg.dbPath, ":memory:");
  // ""이면 모든 산출물 경로가 cwd로 접힌다(FsArtifactStore가 별도로 한 번 더 막는다).
  assert.equal(cfg.storageRoot, "./.rynl10n-storage");
  // ""이면 부트스트랩 admin으로 로그인할 수단이 사라진다 — Bearer 뒤 빈 값은 헤더로 보낼 수 없다.
  assert.equal(cfg.adminToken, "dev-admin-token");
  // ""이면 `Access-Control-Allow-Origin: `이 나가 브라우저 SDK가 교차 오리진 읽기에 실패한다.
  assert.equal(cfg.deliveryAllowOrigin, "*");
  assert.equal(cfg.deliveryBaseUrl, "http://localhost:8788");
});

test("loadConfig: 값이 있으면 그 값을 쓴다", () => {
  const cfg = loadConfig({
    RYNL10N_PORT: "1234",
    RYNL10N_DELIVERY_PORT: "5678",
    RYNL10N_DB: "/data/rynl10n.db",
    RYNL10N_STORAGE: "/srv/artifacts",
    RYNL10N_ADMIN_TOKEN: "real-token",
    RYNL10N_DELIVERY_ALLOW_ORIGIN: "https://app.example.com",
    RYNL10N_DELIVERY_URL: "https://cdn.example.com",
    RYNL10N_MCP_ALLOWED_ORIGINS: "https://a.example.com, https://b.example.com",
  });
  assert.deepEqual(cfg, {
    managementPort: 1234,
    deliveryPort: 5678,
    dbPath: "/data/rynl10n.db",
    storageRoot: "/srv/artifacts",
    adminToken: "real-token",
    deliveryAllowOrigin: "https://app.example.com",
    deliveryBaseUrl: "https://cdn.example.com",
    mcpAllowedOrigins: ["https://a.example.com", "https://b.example.com"],
  });
});

/**
 * MCP Origin 허용 목록의 안전 기본값은 **빈 목록**이다 — "아무 Origin도 허용하지 않음".
 * `*`처럼 넓은 기본값을 두면 가드가 있으나 마나가 되고, 빈 문자열이 새어 들어와도 마찬가지다.
 * MCP 클라이언트는 Origin을 보내지 않으므로 이 기본값은 정상 사용을 막지 않는다.
 */
test("loadConfig: MCP Origin 허용 목록의 기본은 빈 목록이고, 빈 값·공백은 값이 아니다", () => {
  assert.deepEqual(loadConfig({}).mcpAllowedOrigins, []);
  assert.deepEqual(loadConfig({ RYNL10N_MCP_ALLOWED_ORIGINS: "" }).mcpAllowedOrigins, []);
  assert.deepEqual(loadConfig({ RYNL10N_MCP_ALLOWED_ORIGINS: "  " }).mcpAllowedOrigins, []);
  // 구분자만 남은 값도 목록을 만들지 않는다.
  assert.deepEqual(loadConfig({ RYNL10N_MCP_ALLOWED_ORIGINS: " , ," }).mcpAllowedOrigins, []);
  assert.deepEqual(loadConfig({ RYNL10N_MCP_ALLOWED_ORIGINS: "http://localhost:3000" }).mcpAllowedOrigins, ["http://localhost:3000"]);
});

test("loadConfig: deliveryBaseUrl 기본값은 실제로 쓰는 배포 포트를 따라간다", () => {
  assert.equal(loadConfig({ RYNL10N_DELIVERY_PORT: "9000" }).deliveryBaseUrl, "http://localhost:9000");
});
