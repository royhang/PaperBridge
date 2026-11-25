import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSyncServer } from './server.mjs';

async function start(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pb-sync-test-'));
  const server = createSyncServer({ dataDir: dir, env });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: async () => {
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('auth register/login, LWW + tombstone merge, encrypted settings, and per-user PDF blob isolation', async () => {
  const srv = await start({ INVITE_CODE: 'secret42', PROXY_TOKEN: 'ptok-xyz' });
  try {
    // Health
    const health = await (await fetch(`${srv.base}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.inviteRequired, true);

    // Bad invite rejected
    const badReg = await fetch(`${srv.base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'password123', inviteCode: 'wrong' }),
    });
    assert.equal(badReg.status, 403);

    // Register alice & bob
    const regA = await (
      await fetch(`${srv.base}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 'password123', inviteCode: 'secret42', device: 'win' }),
      })
    ).json();
    assert.ok(regA.token);
    assert.equal(regA.proxy?.token, 'ptok-xyz');

    const regB = await (
      await fetch(`${srv.base}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'bob', password: 'password456', inviteCode: 'secret42', device: 'web' }),
      })
    ).json();
    assert.ok(regB.token);

    // Device 1 pushes a doc + note + encrypted settings
    const pdfBytes = Buffer.from('%PDF-1.4\n%test-pdf-payload\n%%EOF');
    const hash = createHash('sha256').update(pdfBytes).digest('hex');

    const m1 = await (
      await fetch(`${srv.base}/api/sync/merge`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${regA.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          docs: { d1: { id: 'd1', title: 'Attention', hasPdf: true, hash, addedAt: 100, updatedAt: 100 } },
          notes: { n1: { id: 'n1', docId: 'd1', quote: 'hello', createdAt: 100 } },
          settings: { updatedAt: 100, encrypted: 'cipher-v1' },
          deleted: {},
        }),
      })
    ).json();
    assert.deepEqual(m1.missingBlobs, [hash]);
    assert.equal(m1.state.docs.d1.title, 'Attention');

    // Upload PDF blob (wrong hash rejected, right hash accepted)
    const badPut = await fetch(`${srv.base}/api/blobs/${hash}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${regA.token}`, 'Content-Type': 'application/pdf' },
      body: Buffer.from('%PDF-wrong'),
    });
    assert.equal(badPut.status, 400);

    const goodPut = await fetch(`${srv.base}/api/blobs/${hash}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${regA.token}`, 'Content-Type': 'application/pdf' },
      body: pdfBytes,
    });
    assert.equal(goodPut.status, 201);

    // Bob cannot download Alice's PDF blob
    const bobGet = await fetch(`${srv.base}/api/blobs/${hash}`, {
      headers: { Authorization: `Bearer ${regB.token}` },
    });
    assert.equal(bobGet.status, 403);

    // Alice's second device logs in, merges newer edit + deletes note n1
    const loginA2 = await (
      await fetch(`${srv.base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 'password123', device: 'mac' }),
      })
    ).json();
    assert.ok(loginA2.token);

    const m2 = await (
      await fetch(`${srv.base}/api/sync/merge`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${loginA2.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          docs: { d1: { id: 'd1', title: 'Attention Is All You Need', hasPdf: true, hash, addedAt: 100, updatedAt: 200 } },
          notes: {},
          settings: { updatedAt: 50, encrypted: 'older-cipher' },
          deleted: { notes: { n1: 150 } },
        }),
      })
    ).json();
    assert.deepEqual(m2.missingBlobs, []);
    assert.equal(m2.state.docs.d1.title, 'Attention Is All You Need');
    assert.equal(m2.state.notes.n1, undefined); // tombstone won
    assert.equal(m2.state.settings.encrypted, 'cipher-v1'); // newer v1 kept

    // Alice downloads the PDF blob cleanly
    const getPdf = await fetch(`${srv.base}/api/blobs/${hash}`, {
      headers: { Authorization: `Bearer ${loginA2.token}` },
    });
    assert.equal(getPdf.status, 200);
    assert.deepEqual(Buffer.from(await getPdf.arrayBuffer()), pdfBytes);
  } finally {
    await srv.close();
  }
});
