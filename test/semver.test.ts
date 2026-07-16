import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRange, versionInRange, compare, parseVersion } from "../src/core/semver.ts";

test("지원 비교자 + 공백 AND 결합", () => {
  assert.ok(versionInRange("3.2.5", ">=3.2.0 <3.3.0"));
  assert.ok(!versionInRange("3.3.0", ">=3.2.0 <3.3.0"));
  assert.ok(!versionInRange("3.1.9", ">=3.2.0 <3.3.0"));
  assert.ok(versionInRange("3.2.0", ">=3.2.0 <3.3.0")); // 하한 포함
});

test("정확 일치(=)와 열린 상한(>=)", () => {
  assert.ok(versionInRange("3.2.0", "=3.2.0"));
  assert.ok(!versionInRange("3.2.1", "=3.2.0"));
  assert.ok(versionInRange("9.9.9", ">=3.2.0"));
});

test("미지원 문법은 파싱 거부 (11.3)", () => {
  assert.throws(() => parseRange(">=3.2.0 || >=4.0.0"), /미지원/);
  assert.throws(() => parseRange("^3.2.0"), /미지원|캐럿/);
  assert.throws(() => parseRange("~3.2.0"), /미지원|틸드/);
  assert.throws(() => parseRange("3.2.x"), /미지원|유효하지/);
  assert.throws(() => parseRange("3.2.0 - 3.3.0"), /미지원|hyphen/);
  assert.throws(() => parseRange("1.2"), /미지원|유효하지/); // 부분 버전
});

test("프리릴리스: 기본 미매칭, matchPrerelease일 때만 같은 튜플 범위에서 평가", () => {
  assert.ok(!versionInRange("3.2.0-rc1", ">=3.2.0 <3.3.0"));
  assert.ok(!versionInRange("3.2.0-rc1", ">=3.2.0 <3.3.0", { matchPrerelease: true })); // 튜플에 프리릴리스 비교자 없음
  assert.ok(versionInRange("3.2.0-rc1", ">=3.2.0-rc0 <3.3.0", { matchPrerelease: true }));
});

test("compare: 프리릴리스는 정식보다 낮다", () => {
  assert.equal(compare(parseVersion("3.2.0-rc1"), parseVersion("3.2.0")), -1);
  assert.equal(compare(parseVersion("3.2.0"), parseVersion("3.2.1")), -1);
  assert.equal(compare(parseVersion("3.2.0-rc2"), parseVersion("3.2.0-rc1")), 1);
});
