import { describe, expect, it } from 'vitest';
import { sha256Hex, sha256HexSync } from '../src/sha256.js';

async function viaWebCrypto(input: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

describe('sha256HexSync', () => {
  it('matches the published vectors', async () => {
    expect(sha256HexSync('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256HexSync('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  // The fallback only earns its place if it is byte-identical to the path it
  // replaces: a host key hashed on a LAN phone must verify against one hashed
  // in a browser on HTTPS.
  it('agrees with WebCrypto across lengths, unicode and block boundaries', async () => {
    const cases = [
      '',
      'a',
      'abc',
      'host-key-3f9a2c1b8e4d7605',
      'ห้องประชุม agent room',
      'x'.repeat(55),  // one byte under a padded block
      'x'.repeat(56),  // forces a second block
      'x'.repeat(64),
      'x'.repeat(1000),
    ];
    for (const input of cases) {
      expect(sha256HexSync(input), `mismatch for ${JSON.stringify(input.slice(0, 24))}`)
        .toBe(await viaWebCrypto(input));
    }
  });
});

describe('sha256Hex', () => {
  it('produces the same digest whether or not crypto.subtle exists', async () => {
    const input = 'host-key-3f9a2c1b8e4d7605';
    const withSubtle = await sha256Hex(input);

    // Simulate a plain-HTTP LAN origin, where the browser exposes `crypto`
    // but not `crypto.subtle`. This is the case that broke room creation.
    const real = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', {
        value: { getRandomValues: real.getRandomValues.bind(real) },
        configurable: true,
      });
      expect(await sha256Hex(input)).toBe(withSubtle);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
    }
  });
});
