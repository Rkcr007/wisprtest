/**
 * SHA-256, synchronous and dependency-free.
 *
 * Why this exists rather than a call to a platform API: the contract types every hash as
 * `Sha256Hex`, and both places this package runs need to produce one *synchronously*.
 * `crypto.subtle.digest` is asynchronous, and awaiting it inside `scoreCandidate` would put a
 * microtask hop in the middle of a 15 ms resolution budget for every candidate. Node's
 * `crypto.createHash` is synchronous but does not exist in a content script.
 *
 * So: FIPS 180-4 §6.2, about ninety lines, verified against the standard vectors in
 * `sha256.test.ts`. This is the one piece of algorithm in the package that is not about the
 * DOM, and it is here because the alternative is a fingerprint that cannot be computed in the
 * hot path.
 */

/** First 32 bits of the fractional parts of the cube roots of the first 64 primes. */
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

/** First 32 bits of the fractional parts of the square roots of the first 8 primes. */
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const encoder = new TextEncoder();

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/**
 * Read a word from a `Uint32Array`.
 *
 * `noUncheckedIndexedAccess` types every indexed read as `number | undefined`, which for a
 * typed array is a fiction: an in-bounds read is always a number and an out-of-bounds one is
 * `undefined` at runtime too. Every index below is provably in bounds from its loop, so the
 * alternative is a `?? 0` on each of them — a dozen branches that can never be taken, sitting
 * in the middle of the tightest loop in the package.
 */
function word(array: Uint32Array, index: number): number {
  return array[index] as number;
}

/** Big-endian byte length of the message plus padding, rounded to whole 64-byte blocks. */
function paddedLength(byteLength: number): number {
  return ((byteLength + 9 + 63) >> 6) << 6;
}

/**
 * Hash `input` and return the digest as 64 lowercase hexadecimal characters — the encoding
 * `Sha256Hex` in the protocol package requires.
 */
export function sha256Hex(input: string): string {
  const message = encoder.encode(input);
  const buffer = new Uint8Array(paddedLength(message.length));
  buffer.set(message);
  buffer[message.length] = 0x80;

  // The trailing 64-bit big-endian bit count. JavaScript numbers hold the bit length of any
  // string this package will ever hash without loss, so the high word is derived by division
  // rather than by tracking a separate counter.
  const bitLength = message.length * 8;
  const view = new DataView(buffer.buffer);
  view.setUint32(buffer.length - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(buffer.length - 4, bitLength >>> 0, false);

  const hash = new Uint32Array(H0);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < buffer.length; offset += 64) {
    for (let t = 0; t < 16; t += 1) {
      w[t] = view.getUint32(offset + t * 4, false);
    }
    for (let t = 16; t < 64; t += 1) {
      const w15 = word(w, t - 15);
      const w2 = word(w, t - 2);
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[t] = (word(w, t - 16) + s0 + word(w, t - 7) + s1) >>> 0;
    }

    let a = word(hash, 0);
    let b = word(hash, 1);
    let c = word(hash, 2);
    let d = word(hash, 3);
    let e = word(hash, 4);
    let f = word(hash, 5);
    let g = word(hash, 6);
    let h = word(hash, 7);

    for (let t = 0; t < 64; t += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + word(K, t) + word(w, t)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    for (const [index, value] of [a, b, c, d, e, f, g, h].entries()) {
      hash[index] = (word(hash, index) + value) >>> 0;
    }
  }

  let hex = '';
  for (const value of hash) {
    hex += value.toString(16).padStart(8, '0');
  }
  return hex;
}
