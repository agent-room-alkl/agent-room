// Pure-JS SHA-256, used only when WebCrypto's subtle API is unavailable.
//
// Why this exists: `crypto.subtle` is exposed ONLY in a secure context, which
// means HTTPS or localhost. Opening the dev server on a phone over a plain
// HTTP LAN address (http://192.168.x.x:5173) leaves `crypto.subtle` undefined,
// so hashing the host key threw "Cannot read properties of undefined (reading
// 'digest')" and creating a room failed outright. Production is HTTPS and was
// never affected; testing on a real device was.
//
// This is a byte-exact SHA-256, not a weaker substitute: sha256.test.ts pins
// every output against WebCrypto's own digest, so the stored `hostKeyHash` is
// identical whichever path produced it.

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

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** Synchronous SHA-256 over a UTF-8 string, returned as lowercase hex. */
export function sha256HexSync(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLenHi = Math.floor((bytes.length * 8) / 0x100000000);
  const bitLenLo = (bytes.length * 8) >>> 0;
  // message + 0x80 marker + 8-byte length, rounded up to whole 64-byte blocks
  const blocks = Math.ceil((bytes.length + 9) / 64);
  const buf = new Uint8Array(blocks * 64);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(blocks * 64 - 8, bitLenHi, false);
  dv.setUint32(blocks * 64 - 4, bitLenLo, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let block = 0; block < blocks; block++) {
    const off = block * 64;
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const p = w[i - 15]!, q = w[i - 2]!;
      const s0 = (rotr(p, 7) ^ rotr(p, 18) ^ (p >>> 3)) >>> 0;
      const s1 = (rotr(q, 17) ^ rotr(q, 19) ^ (q >>> 10)) >>> 0;
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

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map(x => x.toString(16).padStart(8, '0'))
    .join('');
}

/**
 * SHA-256 hex, preferring WebCrypto and falling back to the JS implementation
 * when `crypto.subtle` is missing (any non-secure context).
 */
export async function sha256Hex(input: string): Promise<string> {
  const cryptoObj: Crypto | undefined = (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (cryptoObj?.subtle) {
    const buf = await cryptoObj.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  }
  return sha256HexSync(input);
}
