/**
 * MCP `validate_translation` — 쓰기 전 검증 (도구 1/2).
 *
 * 여기서 지키는 계약은 둘이다:
 *  ① **판정이 실제 쓰기 경로와 항상 같다.** dry-run이 통과시킨 값이 쓰기에서 422가 되면
 *     도구가 거짓말을 한 것이고, 그 순간 존재 이유가 사라진다. 모든 케이스에서
 *     `ok === (requireTranslationImport가 던지지 않음)`을 직접 대조한다.
 *  ② **문제가 구조적으로 온다.** 서명 불일치는 문자열 두 개가 아니라 어느 인자가
 *     빠졌는지/남았는지로 온다 — 호출자가 한 번에 고칠 수 있어야 한다.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db/schema.ts";
import { Repo } from "../src/db/repo.ts";
import { requireTranslationImport } from "../src/api/translation-import.ts";
import { validateTranslation, type ValidateEntry, type ValidateResult } from "../src/mcp/validate.ts";

let repo: Repo;

before(() => {
  repo = new Repo(openDatabase());
  repo.createProject("shop", "Shop", "en", ["en", "ko"]);
  // greet: 서명 확정된 키(name:simple) + 설명
  const greet = repo.upsertKey("shop", "greet", "name:simple", false);
  repo.putTranslation("shop", greet, "en", "Hello {name}", "reviewed");
  repo.setKeyDescription("shop", "greet", "홈 상단 인사말. 사용자 이름을 그대로 노출한다.");
  // cart.items: 복수형 키
  const cart = repo.upsertKey("shop", "cart.items", "count:plural", true);
  repo.putTranslation("shop", cart, "en", { one: "{count} item", other: "{count} items" }, "reviewed");
});

/** ①의 불변식: 도구 판정과 실제 쓰기 경로 판정이 갈라지지 않는다. */
function check(key: string, entries: ValidateEntry[]): ValidateResult {
  const result = validateTranslation(repo, { project: "shop", key, entries });
  let writeWouldThrow = false;
  try {
    requireTranslationImport(
      { keys: [{ name: key, translations: entries.map((e) => ({ locale: e.locale, value: e.value, state: e.state ?? "draft" })) }] },
      repo, "shop",
    );
  } catch { writeWouldThrow = true; }
  assert.equal(result.ok, !writeWouldThrow, `판정 불일치: ok=${result.ok}인데 쓰기 경로는 ${writeWouldThrow ? "실패" : "성공"}`);
  return result;
}

test("통과: 서명이 맞으면 ok — 키 설명을 함께 돌려준다", () => {
  const r = check("greet", [{ locale: "ko", value: "안녕하세요 {name}님" }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
  assert.equal(r.signature.established, true);
  assert.equal(r.signature.expected, "name:simple");
  assert.equal(r.key.description, "홈 상단 인사말. 사용자 이름을 그대로 노출한다.");
  assert.equal(r.wouldCreateKey, false);
});

test("서명 불일치: 어느 인자가 빠졌는지까지 돌려준다", () => {
  const r = check("greet", [{ locale: "ko", value: "안녕하세요" }]);
  assert.equal(r.ok, false);
  const p = r.problems.find((x) => x.code === "signature_mismatch");
  assert.ok(p, "signature_mismatch가 있어야 한다");
  assert.equal(p.locale, "ko");
  assert.deepEqual(p.missingArgs, ["name"]);
  assert.deepEqual(p.extraArgs, []);
});

test("서명 불일치: 인자 이름을 바꿔버린 경우 — missing과 extra가 함께 잡힌다", () => {
  const r = check("greet", [{ locale: "ko", value: "안녕하세요 {userName}님" }]);
  assert.equal(r.ok, false);
  const p = r.problems.find((x) => x.code === "signature_mismatch")!;
  assert.deepEqual(p.missingArgs, ["name"]);
  assert.deepEqual(p.extraArgs, ["userName"]);
});

/**
 * 코어 `signature()`의 인자 이름 스캔은 `[A-Za-z0-9_]+`라 **비ASCII 인자 이름을 인자로 보지
 * 않는다**(ICU 스펙의 argName은 비ASCII를 허용하므로 under-match다). 그래서 `{이름}`은
 * 플레이스홀더가 아니라 리터럴로 취급돼 서명이 빈 문자열이 된다.
 *
 * 결과적으로 **가드는 여전히 건다**(기대 "name:simple" ≠ 실제 "") — 안전한 방향이다. 다만
 * extraArgs로 "{이름}을 새로 넣었다"까지는 말해 주지 못한다. 고치려면 4개 언어 SDK의 같은
 * 정규식을 동시에 바꾸고 골든 벡터를 재생성해야 하므로(크로스언어 계약) 여기서 건드리지 않고
 * 현재 동작을 못박아 둔다 — 조용히 달라지면 안 되는 자리다.
 */
test("비ASCII 인자 이름은 인자로 인식되지 않는다 — 가드는 걸리되 진단은 반쪽(현재 동작 고정)", () => {
  const r = check("greet", [{ locale: "ko", value: "안녕하세요 {이름}님" }]);
  assert.equal(r.ok, false);
  const p = r.problems.find((x) => x.code === "signature_mismatch")!;
  assert.deepEqual(p.missingArgs, ["name"]);
  assert.deepEqual(p.extraArgs, []);
});

test("복수형 형태 불일치: 맵이어야 하는데 문자열", () => {
  const r = check("cart.items", [{ locale: "ko", value: "{count}개" }]);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((x) => x.code === "plural_shape_mismatch"));
});

test("복수형 맵에 other가 없으면 잡는다", () => {
  const r = check("cart.items", [{ locale: "ko", value: { one: "{count}개" } }]);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((x) => x.code === "plural_missing_other"));
});

test("미등록 로케일 — 프로젝트가 지원하지 않는 언어를 채우려는 흔한 실수", () => {
  const r = check("greet", [{ locale: "ja", value: "こんにちは {name}" }]);
  assert.equal(r.ok, false);
  const p = r.problems.find((x) => x.code === "locale_not_supported")!;
  assert.equal(p.locale, "ja");
});

test("엔트리 간 서명 불일치 — 단건 검증으로는 영영 못 잡는 축", () => {
  const r = check("new.key", [
    { locale: "en", value: "Hi {name}" },
    { locale: "ko", value: "안녕 {name}님 {count}" },
  ]);
  assert.equal(r.ok, false);
  const p = r.problems.find((x) => x.code === "signature_inconsistent_across_locales")!;
  assert.ok(p, "엔트리 간 문제로 분류돼야 한다");
  assert.deepEqual(p.extraArgs, ["count"]);
});

test("같은 로케일 중복", () => {
  const r = check("greet", [
    { locale: "ko", value: "안녕 {name}" },
    { locale: "ko", value: "반가워 {name}" },
  ]);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((x) => x.code === "duplicate_locale"));
});

test("신규 키는 서명을 확정시킨다 — 실패가 아니라 경고", () => {
  const r = check("promo.badge", [{ locale: "en", value: "{percent}% off" }]);
  assert.equal(r.ok, true);
  assert.equal(r.wouldCreateKey, true);
  assert.equal(r.signature.established, false);
  const w = r.problems.find((x) => x.code === "signature_will_be_established")!;
  assert.equal(w.severity, "warning");
  assert.match(w.message, /percent:simple/);
});

test("state는 draft·reviewed만", () => {
  const r = check("greet", [{ locale: "ko", value: "안녕 {name}", state: "published" }]);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((x) => x.code === "invalid_state"));
});

test("검증은 쓰지 않는다 — 여러 번 불러도 DB가 그대로", () => {
  const before = repo.listKeyDetails("shop").length;
  check("promo.badge", [{ locale: "en", value: "{percent}% off" }]);
  check("greet", [{ locale: "ko", value: "안녕하세요 {name}님" }]);
  assert.equal(repo.listKeyDetails("shop").length, before);
  assert.equal(repo.getKeyByName("shop", "promo.badge"), undefined);
});
