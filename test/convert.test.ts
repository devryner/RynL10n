import { test } from "node:test";
import assert from "node:assert/strict";
import { toAndroidStringsXml, toXcstrings, toWebJson, toArb } from "../src/builder/convert.ts";
import type { Snapshot, TranslationValue } from "../src/core/types.ts";

const catalog: Record<string, TranslationValue> = {
  "home.title": "Home",
  "greet": "Hello {name}",
  "cart.items": { one: "{n} item", other: "{n} items" },
  "files": "{count, number} files in {folder}",
};

test("Android strings.xml: 이름 sanitize + 위치 플레이스홀더 + <plurals>", () => {
  const { output, warnings } = toAndroidStringsXml(catalog);
  assert.match(output, /<string name="home_title">Home<\/string>/);
  assert.match(output, /<string name="greet">Hello %1\$s<\/string>/);
  // 복수형: count는 %1$d
  assert.match(output, /<plurals name="cart_items">/);
  assert.match(output, /<item quantity="one">%1\$d item<\/item>/);
  assert.match(output, /<item quantity="other">%1\$d items<\/item>/);
  // number 타입 → %$d, 두 번째 인자 %2$s
  assert.match(output, /<string name="files">%1\$d files in %2\$s<\/string>/);
  // sanitize 경고
  assert.ok(warnings.some((w) => w.includes("home.title")));
});

test("Android XML 이스케이프", () => {
  const { output } = toAndroidStringsXml({ x: "a & b < c > d ' e \" f" });
  assert.match(output, /a &amp; b &lt; c &gt; d \\' e &quot; f/);
});

test("iOS .xcstrings: sourceLanguage + localizations + variations/plural", () => {
  const snap: Snapshot = {
    schemaVersion: 1, release: "R1", base: "x", defaultLocale: "en",
    locales: { en: { "greet": "Hello {name}", "cart.items": { one: "{n} item", other: "{n} items" } } },
  };
  const { output } = toXcstrings(snap);
  assert.equal((output as any).sourceLanguage, "en");
  assert.equal((output as any).version, "1.0");
  const greet = (output as any).strings["greet"].localizations.en;
  assert.equal(greet.stringUnit.value, "Hello %1$@");
  const items = (output as any).strings["cart.items"].localizations.en;
  assert.equal(items.variations.plural.one.stringUnit.value, "%1$lld item");
  assert.equal(items.variations.plural.other.stringUnit.value, "%1$lld items");
});

test("Web JSON: ICU 유지, 복수형은 카테고리 객체", () => {
  const { output } = toWebJson(catalog);
  assert.equal(output["greet"], "Hello {name}");
  assert.deepEqual(output["cart.items"], { one: "{n} item", other: "{n} items" });
});

test("Flutter .arb: ICU plural in-string + @key placeholders 메타", () => {
  const { output } = toArb(catalog, "en");
  assert.equal(output["@@locale"], "en");
  assert.equal(output["greet"], "Hello {name}");
  assert.equal((output as any)["@greet"].placeholders.name.type, "String");
  assert.equal(output["cart.items"], "{n, plural, one{{n} item} other{{n} items}}");
  assert.equal((output as any)["files"], "{count, number} files in {folder}");
  assert.equal((output as any)["@files"].placeholders.count.type, "int");
});

test("복수형 카테고리 CLDR 순서 유지", () => {
  const { output } = toAndroidStringsXml({ k: { other: "O", one: "1", few: "F" } as TranslationValue });
  const oneIdx = output.indexOf('quantity="one"');
  const fewIdx = output.indexOf('quantity="few"');
  const otherIdx = output.indexOf('quantity="other"');
  assert.ok(oneIdx < fewIdx && fewIdx < otherIdx, "CLDR 순: one < few < other");
});

// ── 키 설명(5.1) → 네이티브 주석 필드 ─────────────────────────────────────────

const descriptions = {
  "home.title": "홈 탭 상단 제목. 짧게 -- 12자 이내.",
  "cart.items": "장바구니 수량 표시.\n복수형 유지.",
};

test("설명 미지정 시 산출물은 설명 도입 이전과 바이트 동일(하위호환)", () => {
  assert.equal(toAndroidStringsXml(catalog, {}).output, toAndroidStringsXml(catalog).output);
  assert.deepEqual(toArb(catalog, "en", {}).output, toArb(catalog, "en").output);
});

test("Android: 설명은 항목 위 XML 주석 — `--`는 보존하되 XML 규칙에 맞게 분리", () => {
  const { output } = toAndroidStringsXml(catalog, descriptions);
  // 주석은 대상 항목 바로 위에 온다.
  assert.match(output, /<!-- 홈 탭 상단 제목\. 짧게 - - 12자 이내\. -->\n  <string name="home_title">/);
  // 개행은 한 줄로 접힌다(결정적 출력).
  assert.match(output, /<!-- 장바구니 수량 표시\. 복수형 유지\. -->\n  <plurals name="cart_items">/);
  // XML 1.0 §2.5: 주석 본문에 "--"가 남아 있으면 안 된다.
  for (const line of output.split("\n").filter((l) => l.includes("<!--"))) {
    assert.equal(line.slice(6, -4).includes("--"), false, `주석에 -- 가 남음: ${line}`);
  }
  // 설명이 없는 키에는 주석을 달지 않는다.
  assert.match(output, /\n  <string name="greet">/);
  assert.equal(output.includes("<!-- undefined"), false);
});

test("iOS .xcstrings: 설명은 표준 comment 필드로", () => {
  const snap: Snapshot = { schemaVersion: 1, release: "R1", base: "b", defaultLocale: "en", locales: { en: catalog } };
  const { output } = toXcstrings(snap, descriptions);
  const strings = (output as any).strings;
  assert.equal(strings["home.title"].comment, "홈 탭 상단 제목. 짧게 -- 12자 이내.");
  assert.equal(strings["cart.items"].comment, "장바구니 수량 표시.\n복수형 유지.");
  assert.equal("comment" in strings["greet"], false, "설명 없는 키엔 comment를 넣지 않는다");
  assert.ok(strings["home.title"].localizations.en, "설명이 있어도 값 구조는 그대로");
});

test("Flutter .arb: 설명은 @key.description — placeholders와 공존", () => {
  const { output } = toArb(catalog, "en", descriptions) as { output: Record<string, any> };
  assert.equal(output["@home.title"].description, "홈 탭 상단 제목. 짧게 -- 12자 이내.");
  assert.equal(output["@home.title"].placeholders, undefined, "인자 없는 키엔 placeholders 없음");
  assert.equal(output["@cart.items"].description, "장바구니 수량 표시.\n복수형 유지.");
  assert.deepEqual(output["@cart.items"].placeholders, { n: { type: "int" } }, "설명과 placeholders가 함께");
  assert.equal(output["@greet"].description, undefined);
  assert.deepEqual(output["@greet"].placeholders, { name: { type: "String" } });
});
