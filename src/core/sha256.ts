/**
 * SHA-256 — 의존성 0 순수 구현 (FIPS 180-4).
 *
 * **왜 `node:crypto`를 쓰지 않는가.** 이 모듈은 SDK 런타임 경로(카나리 버킷 판정, 8.4)에 있고
 * 그 경로는 Web SDK가 그대로 재사용한다. `node:crypto`는 브라우저에 없으므로 최상위 import 하나만으로
 * **rollout이 100이라 버킷 판정을 한 번도 호출하지 않아도 모듈 로드 시점에 깨진다.**
 * Web 테스트가 Node에서 돌기 때문에 드러나지 않던 자리다.
 *
 * 반대로 `src/serialize/hash.ts`(콘텐츠 해시)는 **빌더·백엔드 전용**이라 `node:crypto`를 그대로 쓴다 —
 * SDK 런타임은 콘텐츠 해시를 계산하지 않고 읽기만 한다. 그 모듈을 SDK 경로로 끌어오면 같은 문제가
 * 되살아나므로, 런타임 경로에서 해시가 필요해지면 `node:crypto`가 아니라 이 파일을 쓴다.
 *
 * 결정성은 골든 벡터가 보증한다 — `fixtures/golden/canary.json`의 버킷값을 4개 언어가 같이 읽는다.
 */

// FIPS 180-4 §4.2.2 — 처음 64개 소수의 세제곱근 소수부 상위 32비트.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0;

/** UTF-8 인코더는 Node·브라우저 공통 전역이다(이 모듈이 양쪽에서 도는 이유). */
const utf8 = new TextEncoder();

/**
 * 바이트열의 SHA-256 다이제스트(32바이트).
 *
 * `noUncheckedIndexedAccess`가 켜져 있어 고정 크기 타입 배열 인덱싱에도 `!`가 붙는다 —
 * 길이가 루프 조건으로 보장되는 자리이므로 런타임 검사를 넣지 않는다.
 */
export function sha256(input: Uint8Array): Uint8Array {
  // 패딩(§5.1.1): 0x80 한 바이트 + 0 채움 + 64비트 빅엔디언 비트 길이.
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 1 + 8) / 64) * 64;
  const message = new Uint8Array(paddedLength);
  message.set(input);
  message[input.length] = 0x80;

  const view = new DataView(message.buffer);
  // 비트 길이는 2^53까지 안전하므로 상·하위 32비트로 나눠 쓴다.
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  // §5.3.3 — 처음 8개 소수의 제곱근 소수부 상위 32비트.
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!, y = w[i - 2]!;
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }

    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  const out = new DataView(digest.buffer);
  for (const [i, value] of [h0, h1, h2, h3, h4, h5, h6, h7].entries()) out.setUint32(i * 4, value);
  return digest;
}

/** 문자열(UTF-8)의 SHA-256 다이제스트. */
export function sha256Utf8(input: string): Uint8Array {
  return sha256(utf8.encode(input));
}
