import { describe, expect, it } from 'vitest';
import { decryptPayload, deriveKeyB64, encryptPayload } from '../sync';
import { isNewerVersion } from '../update';

describe('E2E sync encryption and update semver check', () => {
  it('round-trips AES-256-GCM settings encryption with PBKDF2 derived key and rejects wrong password', async () => {
    const key = await deriveKeyB64('Alice', 'super-secret-pass');
    const sameKey = await deriveKeyB64('alice', 'super-secret-pass');
    expect(key).toBe(sameKey);

    const payload = { providers: [{ id: 'p1', name: 'DeepSeek', kind: 'openai', apiKey: 'sk-12345' }] };
    const cipher = await encryptPayload(payload, key);
    expect(cipher.startsWith('v1:')).toBe(true);
    expect(cipher).not.toContain('sk-12345');

    const decoded = await decryptPayload<typeof payload>(cipher, sameKey);
    expect(decoded).toEqual(payload);

    const wrongKey = await deriveKeyB64('alice', 'wrong-pass');
    expect(await decryptPayload(cipher, wrongKey)).toBeNull();
  });

  it('compares release semver tags accurately', () => {
    expect(isNewerVersion('v0.3.0', '0.2.0')).toBe(true);
    expect(isNewerVersion('0.10.0', '0.2.9')).toBe(true);
    expect(isNewerVersion('0.2.0', '0.2.0')).toBe(false);
    expect(isNewerVersion('0.1.9', '0.2.0')).toBe(false);
  });
});
