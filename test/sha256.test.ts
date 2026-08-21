/**
 * 순수 TS SHA-256이 `node:crypto`와 바이트 단위로 일치하는지 — 기획서 8.4(카나리 버킷)의 전제.
 *
 * 손으로 짠 SHA-256이 깨지는 자리는 거의 항상 **패딩과 블록 경계**다: 마지막 블록에 64비트 길이 필드가
 * 들어갈 자리가 남지 않아 블록이 하나 더 생기는 지점(55/56바이트), 정확히 한 블록(64), 그 직후(65).
 * 골든 벡터(canary.json)는 고정 입력 몇 개만 보므로 이 축은 여기서 따로 덮는다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256, sha256Utf8 } from "../src/core/sha256.ts";
import { bucketOf } from "../src/core/canary.ts";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const reference = (input: Uint8Array | string): string =>
  createHash("sha256").update(typeof input === "string" ? Buffer.from(input, "utf8") : input).digest("hex");

test("SHA-256: 알려진 벡터(FIPS 180-4 부록 B)", () => {
  assert.equal(
    hex(sha256Utf8("")),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(
    hex(sha256Utf8("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    hex(sha256Utf8("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

test("SHA-256: 블록 경계 길이에서 node:crypto와 일치(0~130바이트 전수)", () => {
  for (let length = 0; length <= 130; length++) {
    // 반복 패턴이 아니라 길이마다 다른 바이트열이라야 경계 버그가 값에 드러난다.
    const input = new Uint8Array(length);
    for (let i = 0; i < length; i++) input[i] = (i * 31 + length) & 0xff;
    assert.equal(hex(sha256(input)), reference(input), `길이 ${length}`);
  }
});

test("SHA-256: 멀티바이트 UTF-8·정규화 대상 문자열도 일치", () => {
  for (const s of ["한국어", "🇰🇷 emoji", "é", "é", "ß".repeat(100), "a".repeat(1000)]) {
    assert.equal(hex(sha256Utf8(s)), reference(s), JSON.stringify(s));
  }
});

test("카나리 버킷: node:crypto 기반 계산과 동일(교체 전후 동작 불변)", () => {
  // 교체 전 구현 = SHA-256 다이제스트 앞 32비트 빅엔디언 mod 100.
  const previous = (installId: string, releaseId: string): number =>
    createHash("sha256").update(`${installId}:${releaseId}`).digest().readUInt32BE(0) % 100;

  for (const installId of [
    "550e8400-e29b-41d4-a716-446655440000",
    "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    "00000000-0000-0000-0000-000000000000",
  ]) {
    for (const releaseId of ["R1", "R42", "R50", "2024-spring"]) {
      assert.equal(bucketOf(installId, releaseId), previous(installId, releaseId), `${installId}/${releaseId}`);
    }
  }
});
