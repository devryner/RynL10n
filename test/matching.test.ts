import { test } from "node:test";
import assert from "node:assert/strict";
import { findRangeConflicts, selectRelease, comparatorsToInterval, intervalsOverlap } from "../src/core/matching.ts";
import { parseRange } from "../src/core/semver.ts";
import type { ManifestRelease } from "../src/core/types.ts";

function rel(id: string, value: string, state: ManifestRelease["state"] = "published", strategy: "semver-range" | "exact-label" = "semver-range"): ManifestRelease {
  return { id, state, versionMatch: { strategy, value }, base: id.toLowerCase(), overlay: id.toLowerCase(), rollout: 100, snapshot: `releases/${id}/snapshot-${id.toLowerCase()}.json` };
}

test("인접 범위는 겹치지 않는다 ( <3.3.0 vs >=3.3.0 )", () => {
  const a = comparatorsToInterval(parseRange(">=3.2.0 <3.3.0"));
  const b = comparatorsToInterval(parseRange(">=3.3.0 <3.4.0"));
  assert.ok(!intervalsOverlap(a, b));
});

test("겹치는 범위는 충돌로 탐지 (8.2/11.3)", () => {
  const conflicts = findRangeConflicts([
    { id: "R1", versionMatch: { strategy: "semver-range", value: ">=3.2.0 <3.4.0" } },
    { id: "R2", versionMatch: { strategy: "semver-range", value: ">=3.3.0 <3.5.0" } },
  ]);
  assert.equal(conflicts.length, 1);
});

test("인접 범위는 충돌 없음 → publish 허용", () => {
  const conflicts = findRangeConflicts([
    { id: "R42", versionMatch: { strategy: "semver-range", value: ">=3.2.0 <3.3.0" } },
    { id: "R50", versionMatch: { strategy: "semver-range", value: ">=3.3.0" } },
  ]);
  assert.equal(conflicts.length, 0);
});

test("exact-label 중복은 충돌, 다른 strategy는 상호 배제", () => {
  const dup = findRangeConflicts([
    { id: "A", versionMatch: { strategy: "exact-label", value: "web-stable" } },
    { id: "B", versionMatch: { strategy: "exact-label", value: "web-stable" } },
  ]);
  assert.equal(dup.length, 1);
  const mixed = findRangeConflicts([
    { id: "A", versionMatch: { strategy: "exact-label", value: "web-stable" } },
    { id: "B", versionMatch: { strategy: "semver-range", value: ">=1.0.0" } },
  ]);
  assert.equal(mixed.length, 0);
});

test("클라이언트 판정: 자기 버전에 맞는 릴리스 1개 선택", () => {
  const releases = [rel("R42", ">=3.2.0 <3.3.0"), rel("R50", ">=3.3.0")];
  const r = selectRelease(releases, { appVersion: "3.2.5" });
  assert.equal(r.kind, "matched");
  assert.equal(r.kind === "matched" ? r.release.id : "", "R42");
});

test("superseded 릴리스도 라우팅 후보 (8.1 조정)", () => {
  const releases = [rel("R42", ">=3.2.0 <3.3.0", "superseded"), rel("R50", ">=3.3.0")];
  const r = selectRelease(releases, { appVersion: "3.2.5" });
  assert.equal(r.kind === "matched" ? r.release.id : "", "R42");
});

test("archived/draft는 후보 제외", () => {
  const releases = [rel("R42", ">=3.2.0 <3.3.0", "archived"), rel("R99", ">=3.2.0", "draft")];
  const r = selectRelease(releases, { appVersion: "3.2.5" });
  assert.equal(r.kind, "bundle-only");
});

test("미매칭 fallback: 기본 bundle-only, nearest-lower 정책 선택 가능", () => {
  const releases = [rel("R42", ">=3.2.0 <3.3.0")];
  assert.equal(selectRelease(releases, { appVersion: "5.0.0" }).kind, "bundle-only");
  const nl = selectRelease(releases, { appVersion: "5.0.0", fallbackPolicy: "nearest-lower" });
  assert.equal(nl.kind, "nearest-lower");
  assert.equal(nl.kind === "nearest-lower" ? nl.release.id : "", "R42");
});

test("exact-label 판정 (Web)", () => {
  const releases = [rel("W1", "web-stable", "published", "exact-label")];
  assert.equal(selectRelease(releases, { releaseLabel: "web-stable" }).kind, "matched");
  assert.equal(selectRelease(releases, { releaseLabel: "web-beta" }).kind, "bundle-only");
});

test("방어적 다중 매칭: 가장 좁은 범위 선택", () => {
  const releases = [rel("WIDE", ">=3.0.0 <4.0.0"), rel("NARROW", ">=3.2.0 <3.3.0")];
  const r = selectRelease(releases, { appVersion: "3.2.5" });
  assert.equal(r.kind === "matched" ? r.release.id : "", "NARROW");
});
