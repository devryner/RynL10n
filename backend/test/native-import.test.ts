import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNativeImport } from "../src/api/native-import.ts";
import { requireTranslationImport } from "../src/api/translation-import.ts";
import { openDatabase } from "../src/db/schema.ts";
import { Repo } from "../src/db/repo.ts";
import { formatValue } from "../../src/core/resolve.ts";

function parse(format: string, content: string, locale?: string) {
  return parseNativeImport({ format, files: [{ name: "translations", content, ...(locale === undefined ? {} : { locale }) }] });
}
function keys(result: ReturnType<typeof parseNativeImport>): any[] { return (result.data as any).keys; }

test("xcstrings: 다국어·설명·위치 인자를 보존하고 가져온 상태는 draft", () => {
  const result = parse("xcstrings", JSON.stringify({ sourceLanguage: "en", version: "1.0", strings: {
    hello: { comment: "Greeting", localizations: {
      en: { stringUnit: { state: "translated", value: "Hello %1$@" } },
      ko: { stringUnit: { state: "translated", value: "%1$@ 안녕" } },
    } },
  } }));
  assert.deepEqual(keys(result), [{ name: "hello", description: "Greeting", translations: [
    { locale: "en", value: "Hello {arg1}", state: "draft" },
    { locale: "ko", value: "{arg1} 안녕", state: "draft" },
  ] }]);
});

test("xcstrings: 명시된 원문이 없으면 키를 원문으로 가져오고 경고", () => {
  const result = parse("xcstrings", '{"sourceLanguage":"en","strings":{"Welcome":{"localizations":{"ko":{"stringUnit":{"value":"환영"}}}}}}');
  assert.equal(keys(result)[0].translations.find((v: any) => v.locale === "en").value, "Welcome");
  assert.ok(result.warnings.some((warning) => warning.key === "Welcome"));
});

test("xcstrings: 복수형 분기에서 동일한 위치 이름 사용, 선택 count는 별도", () => {
  const result = parse("xcstrings", JSON.stringify({ sourceLanguage: "en", strings: { items: { localizations: {
    en: { variations: { plural: { one: { stringUnit: { value: "One item for %2$@" } }, other: { stringUnit: { value: "%1$lld items for %2$@" } } } } },
  } } } }));
  assert.deepEqual(keys(result)[0].translations[0].value, { one: "One item for {arg2}", other: "{arg1} items for {arg2}" });
  assert.ok(result.warnings.some((warning) => warning.message.includes("count를 별도로")));
});

test("Android: XML 엔터티·CDATA·주석·Android escape·인자를 읽는다", () => {
  const result = parse("android-xml", String.raw`<?xml version="1.0"?><resources>
    <!-- Greeting --> <string name="hello">Hello %1$s &amp; %2$d\nnext</string>
    <string name="quoted">"  keep   spacing  "</string>
    <string name="cdata"><![CDATA[<literal> & text]]></string>
    <string name="apostrophe">Don\'t</string>
  </resources>`, "en");
  assert.deepEqual(keys(result)[0], { name: "hello", description: "Greeting", translations: [{ locale: "en", value: "Hello {arg1} & {arg2}\nnext", state: "draft" }] });
  assert.equal(keys(result).find((key) => key.name === "quoted").translations[0].value, "  keep   spacing  ");
  assert.equal(keys(result).find((key) => key.name === "cdata").translations[0].value, "<literal> & text");
  assert.equal(keys(result).find((key) => key.name === "apostrophe").translations[0].value, "Don't");
});

test("Android: plurals를 카테고리 맵으로 가져오고 순서에 기대지 않는다", () => {
  const result = parse("android-xml", '<resources><plurals name="items"><item quantity="other">%1$d items</item><item quantity="one">One item</item></plurals></resources>', "en");
  assert.deepEqual(keys(result)[0].translations[0].value, { other: "{arg1} items", one: "One item" });
  assert.equal(formatValue(keys(result)[0].translations[0].value, "en", { count: 1, arg1: 9 }), "One item");
  assert.equal(formatValue(keys(result)[0].translations[0].value, "en", { count: 2, arg1: 9 }), "9 items");
});

test("ARB: 로케일·설명·단순 인자와 ICU plural의 바깥 문맥 보존", () => {
  const result = parse("arb", JSON.stringify({ "@@locale": "en", hello: "Hello {이름}", "@hello": { description: "Greeting" },
    items: "Cart: {count, plural, one{One item for {name}} other{{count} items for {name}}}!" }));
  assert.equal(keys(result)[0].description, "Greeting");
  assert.equal(keys(result)[0].translations[0].value, "Hello {이름}");
  const value = keys(result)[1].translations[0].value;
  assert.deepEqual(value, { one: "Cart: One item for {name}!", other: "Cart: {count} items for {name}!" });
  assert.equal(formatValue(value, "en", { count: 2, name: "Sam" }), "Cart: 2 items for Sam!");
});

test("i18next: 중첩 키·v4 복수형·한글 인자를 변환", () => {
  const result = parse("i18next", JSON.stringify({ home: { hello: "Hello {{이름}}", items_one: "One item", items_other: "{{count}} items" } }), "en");
  assert.deepEqual(keys(result), [
    { name: "home.hello", translations: [{ locale: "en", value: "Hello {이름}", state: "draft" }] },
    { name: "home.items", translations: [{ locale: "en", value: { one: "One item", other: "{count} items" }, state: "draft" }] },
  ]);
});

test("여러 파일의 같은 키·다른 로케일을 합친다", () => {
  const result = parseNativeImport({ format: "i18next", files: [
    { name: "en.json", content: '{"hello":"Hello {{name}}"}', locale: "en" },
    { name: "ko.json", content: '{"hello":"안녕 {{name}}"}', locale: "ko" },
  ] });
  assert.equal(keys(result).length, 1);
  assert.equal(keys(result)[0].translations.length, 2);
});

test("rynl10n JSON은 기존 명시적 state와 설명을 보존", () => {
  const input = { keys: [{ name: "hello", description: "Greeting", translations: [{ locale: "en", value: "Hello", state: "reviewed" }] }] };
  assert.deepEqual(parse("rynl10n", JSON.stringify(input)).data, input);
});

test("가져온 값은 기존 단일 검증기·런타임과 연결된다", (t) => {
  const db = openDatabase(); t.after(() => db.close());
  const repo = new Repo(db); repo.createProject("app", "App", "en", ["en"]);
  const parsed = parse("android-xml", '<resources><string name="hello">Hello %1$s</string></resources>', "en");
  const normalized = requireTranslationImport(parsed.data, repo, "app");
  repo.importTranslations("app", normalized.data);
  const value = repo.getTranslation(repo.getKeyByName("app", "hello")!.id, "en")!.value;
  assert.equal(formatValue(value, "en", { arg1: "Sam" }), "Hello Sam");
});

const invalid: Array<[string, string, string | undefined]> = [
  ["android-xml", '<!DOCTYPE resources [<!ENTITY x SYSTEM "file:///etc/passwd">]><resources><string name="x">&x;</string></resources>', "en"],
  ["android-xml", '<resources><string name="x">&unknown;</string></resources>', "en"],
  ["android-xml", '<resources><string name="x"><b>Styled</b></string></resources>', "en"],
  ["android-xml", '<resources><string name="x">@string/other</string></resources>', "en"],
  ["android-xml", '<resources><string name="x">%02d</string></resources>', "en"],
  ["android-xml", '<resources><string name="x">A</string><string name="x">B</string></resources>', "en"],
  ["android-xml", '<resources><plurals name="x"><item quantity="one">One</item></plurals></resources>', "en"],
  ["android-xml", '<resources><string name="x">A</plurals></resources>', "en"],
  ["arb", '{"@@locale":"en","x":"{count, plural, =0{none} other{{count}}}"}', undefined],
  ["arb", '{"@@locale":"en","x":"{gender, select, male{He} other{They}}"}', undefined],
  ["arb", '{"@@locale":"en","x":"{n, number}"}', undefined],
  ["i18next", '{"x":"{{author.name}}"}', "en"],
  ["i18next", '{"x":"{{n, number}}"}', "en"],
  ["i18next", '{"x":"$t(other)"}', "en"],
  ["i18next", '{"x":["one","two"]}', "en"],
  ["i18next", '{"x":"one","x":"two"}', "en"],
  ["i18next", '{"__proto__":"bad"}', "en"],
  ["i18next", '{"a.b":"one","a":{"b":"two"}}', "en"],
  ["i18next", '{"x_one":"one"}', "en"],
  ["xcstrings", '{"sourceLanguage":"en","strings":{"x":{"localizations":{"en":{"variations":{"device":{"iphone":{"stringUnit":{"value":"Phone"}}}}}}}}}}', undefined],
];
test("손실·모호성·잘못된 문법은 400으로 명시적으로 거절", () => {
  for (const [format, content, locale] of invalid) {
    assert.throws(() => parse(format, content, locale), (error: any) => error.status === 400, `${format}: ${content}`);
  }
});

test("native 위치 인자 타입 불일치·파일 중복 로케일·로케일 모호성 거절", () => {
  assert.throws(() => parseNativeImport({ format: "android-xml", files: [
    { name: "en.xml", locale: "en", content: '<resources><string name="x">%1$s</string></resources>' },
    { name: "ko.xml", locale: "ko", content: '<resources><string name="x">%1$d</string></resources>' },
  ] }), /인자.*타입/);
  assert.throws(() => parseNativeImport({ format: "i18next", files: [
    { name: "en.json", locale: "en", content: '{"x":"A"}' },
    { name: "also-en.json", locale: "en", content: '{"x":"B"}' },
  ] }), /중복/);
  assert.throws(() => parse("arb", '{"@@locale":"ko","x":"A"}', "en"), /로케일/);
  assert.throws(() => parse("i18next", '{"x":"A"}'), /locale/);
});

test("constructor·prototype은 리터럴 키로 안전하게 보존한다", () => {
  const result = parse("i18next", '{"constructor":"A","screen":{"prototype":"B"}}', "en");
  assert.deepEqual(keys(result).map((key) => key.name), ["constructor", "screen.prototype"]);
  assert.equal(({} as any).polluted, undefined);
});

test("i18next _zero는 CLDR zero와 의미가 같을 때만 허용", () => {
  assert.throws(() => parse("i18next", '{"items_zero":"None","items_one":"One","items_other":"{{count}} items"}', "en"), /정확한 0/);
  const result = parse("i18next", '{"items_zero":"صفر","items_other":"{{count}}"}', "ar");
  assert.deepEqual(keys(result)[0].translations[0].value, { zero: "صفر", other: "{count}" });
});

test("i18next ordinal은 거절하고 context 이름은 추측 없이 리터럴 키로 보존", () => {
  assert.throws(() => parse("i18next", '{"rank_ordinal_one":"First","rank_ordinal_other":"Nth"}', "en"), (error: any) => error.status === 400);
  const result = parse("i18next", '{"greeting_male":"He","greeting_female":"She"}', "en");
  assert.deepEqual(keys(result).map((key) => key.name), ["greeting_male", "greeting_female"]);
  assert.ok(result.warnings.some((warning) => warning.message.includes("context")));
});

test("ARB count가 아닌 복수 인자 이름은 명시 경고와 함께 SDK count로 매핑", () => {
  const result = parse("arb", '{"@@locale":"en","x":"{quantity, plural, one{One} other{{quantity} items}}"}');
  assert.deepEqual(keys(result)[0].translations[0].value, { one: "One", other: "{count} items" });
  assert.ok(result.warnings.some((warning) => warning.message.includes("quantity")));
  assert.equal(formatValue(keys(result)[0].translations[0].value, "en", { count: 2 }), "2 items");
});

test("잘못된 XML 문자·속성·처리 명령·중복 카테고리와 JSON 중복 escape 키를 거절", () => {
  for (const content of [
    '<resources><string name="x">\u0000</string></resources>',
    '<resources><string name="x">&#0;</string></resources>',
    '<resources><string name="x" name="y">A</string></resources>',
    '<resources><?other?><string name="x">A</string></resources>',
    '<resources><plurals name="x"><item quantity="other">A</item><item quantity="other">B</item></plurals></resources>',
  ]) assert.throws(() => parse("android-xml", content, "en"), (error: any) => error.status === 400);
  assert.throws(() => parse("i18next", String.raw`{"x":"A","\u0078":"B"}`, "en"), /중복/);
});

test("원문 없는 plural·ARB formatter 메타·서로 다른 설명은 조용히 축약하지 않는다", () => {
  assert.throws(() => parse("xcstrings", '{"sourceLanguage":"en","strings":{"items":{"localizations":{"ko":{"variations":{"plural":{"other":{"stringUnit":{"value":"%lld개"}}}}}}}}}'), /원문 로케일/);
  assert.throws(() => parse("arb", '{"@@locale":"en","x":"{n}","@x":{"placeholders":{"n":{"type":"int","format":"compact"}}}}'), /format/);
  assert.throws(() => parseNativeImport({ format: "arb", files: [
    { name: "en.arb", content: '{"@@locale":"en","x":"A","@x":{"description":"A"}}' },
    { name: "ko.arb", content: '{"@@locale":"ko","x":"B","@x":{"description":"B"}}' },
  ] }), /설명이 다릅니다/);
});

test("과도한 중첩·파일 크기·잘못된 입력 타입은 400으로 종료", () => {
  assert.throws(() => parse("i18next", '{"a":'.repeat(66) + '"value"' + "}".repeat(66), "en"), /64단계/);
  assert.throws(() => parse("i18next", "x".repeat(5 * 1024 * 1024 + 1), "en"), /5MiB/);
  for (const input of [null, [], {}, { format: "i18next", files: [] }, { format: "i18next", files: [{ name: "x", content: 2 }] }]) {
    assert.throws(() => parseNativeImport(input), (error: any) => error.status === 400);
  }
});

test("i18next one·other 이름은 일반 중첩 키이며 v4 suffix만 복수형으로 묶는다", () => {
  const result = parse("i18next", '{"messages":{"one":"First","other":"Rest"}}', "en");
  assert.deepEqual(keys(result).map((key) => key.name), ["messages.one", "messages.other"]);
});

test("ARB plural 바깥의 리터럴 #은 count 기호로 바뀌지 않도록 거절", () => {
  for (const message of ["# Cart {count, plural, one{One} other{Many}}", "{count, plural, one{One} other{Many}} #"]) {
    assert.throws(() => parse("arb", JSON.stringify({ "@@locale": "en", x: message })), /리터럴 #/);
  }
});
