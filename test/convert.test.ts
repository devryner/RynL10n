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
