import assert from "node:assert/strict";
import test from "node:test";
import { assertConsumed, extract, replaceOnce, take } from "./examples.ts";

test("heading/order independent IDs, quoted snippets, non-code instructions", () => {
  const examples = extract('## example\n> <!-- sdk-guide:ios.x -->\n> ```swift\n> let x = 1\n> ```\n```bash\necho ok\n```', "guide.md");
  assert.deepEqual(examples, [{ id: "ios.x", language: "swift", code: "let x = 1\n", location: "guide.md:4" }]);
});

test("new/unclosed/duplicate/orphan examples cannot silently pass", () => {
  for (const [code, error] of [
    ["```dart\nvoid main() {}\n```", /마커가 없는/],
    ["<!-- sdk-guide:web.x -->\n```ts\nconst x = 1", /닫히지 않은/],
    ["<!-- sdk-guide:web.x -->", /코드 없는/],
    ["<!-- sdk-guide:web.x -->\n<!-- sdk-guide:web.y -->", /코드 없는/],
    ["<!-- sdk-guide:web.x -->\n```ts\nx\n```\n<!-- sdk-guide:web.x -->\n```ts\ny\n```", /중복/],
    ["<!-- sdk-guide:typo.x -->\n```ts\nx\n```", /알 수 없는/],
  ] as const) assert.throws(() => extract(code, "guide.md"), error);
});

test("missing IDs, changed languages and ambiguous substitutions fail", () => {
  const examples = new Map(extract("<!-- sdk-guide:web.x -->\n```ts\nconst x = 1\n```", "guide.md").map((e) => [e.id, e]));
  assert.throws(() => take(examples, "web.missing", "ts"), /없습니다/);
  assert.throws(() => take(examples, "web.x", "dart"), /ts|dart/);
  assert.throws(() => assertConsumed(examples, ["web"]), /검증에 연결하지 않은/);
  assert.doesNotThrow(() => assertConsumed(examples, ["ios"]));
  assert.equal(take(examples, "web.x", "ts"), "const x = 1\n");
  assert.equal(examples.size, 0);
  assert.doesNotThrow(() => assertConsumed(examples, ["web"]));
  assert.equal(replaceOnce("prefix URL suffix", "URL", "test"), "prefix test suffix");
  assert.throws(() => replaceOnce("URL URL", "URL", "test"), /치환/);
  assert.throws(() => replaceOnce("none", "URL", "test"), /치환/);
});
