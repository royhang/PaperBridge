import { describe, expect, it } from 'vitest';
import { sha256HexAsync, sha256Pure } from '../sha256';

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('pure-JS SHA-256 fallback (HTTP LAN compatibility)', () => {
  it('matches FIPS 180-4 test vectors', () => {
    const enc = new TextEncoder();
    expect(hex(sha256Pure(enc.encode('')))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hex(sha256Pure(enc.encode('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hex(sha256Pure(enc.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('matches native WebCrypto SHA-256 on arbitrary UTF-8 and multi-kilobyte binary payloads', async () => {
    const text = 'PaperBridge 局域网同步 PDF 哈希测试 — 100% deterministic!';
    const nativeText = await sha256HexAsync(text);
    expect(hex(sha256Pure(new TextEncoder().encode(text)))).toBe(nativeText);

    const big = new Uint8Array(65539);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 17) & 0xff;
    const nativeBin = await sha256HexAsync(big);
    expect(hex(sha256Pure(big))).toBe(nativeBin);
  });
});
