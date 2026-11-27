import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createSyncServer, gcOrphanBlobs } from './server.mjs';

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

    // Connector endpoints: save CNKI paper with PDF + list collections
    const connSave = await (
      await fetch(`${srv.base}/api/connector/save`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${loginA2.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meta: { title: '知网测试论文标题很长用于去重', authors: [{ family: '李', given: '锋' }], venue: '情报理论与实践', year: 2024, type: 'article' },
          tags: ['知网', 'ChatGPT'],
          collectionId: 'col-ai',
          pdfBase64: pdfBytes.toString('base64'),
          pdfFileName: '知网测试论文_李锋.pdf',
        }),
      })
    ).json();
    assert.equal(connSave.ok, true);
    assert.equal(connSave.hasPdf, true);

    const connCols = await (
      await fetch(`${srv.base}/api/connector/collections`, {
        headers: { Authorization: `Bearer ${loginA2.token}` },
      })
    ).json();
    assert.equal(connCols.username, 'alice');
    assert.ok(Array.isArray(connCols.collections));

    // Incremental delta sync & gzip upload/download
    const fullSnap = await (
      await fetch(`${srv.base}/api/sync/merge`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${regA.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ docs: {}, deleted: {} }),
      })
    ).json();
    const baseRev = fullSnap.revision;
    assert.equal(fullSnap.mode, 'full');

    // Unchanged delta poll returns tiny unchanged response without bumping revision
    const idlePoll = await (
      await fetch(`${srv.base}/api/sync/merge`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${regA.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseRevision: baseRev, delta: true, docs: {}, deleted: {} }),
      })
    ).json();
    assert.equal(idlePoll.mode, 'unchanged');
    assert.equal(idlePoll.revision, baseRev);
    assert.equal(idlePoll.state, undefined);

    // Device 2 pushes ONE gzip-compressed ink stroke via delta; Device 1 pulls ONLY that stroke (not existing docs/translations)
    const gzipPayload = gzipSync(
      Buffer.from(
        JSON.stringify({
          baseRevision: baseRev,
          delta: true,
          inks: { ink1: { id: 'ink1', docId: 'd1', pageIndex: 0, layer: 'translated', kind: 'pen', color: '#e11d48', width: 2, points: [[0.1, 0.2, 0.5]], createdAt: 500 } },
          deleted: {},
        }),
      ),
    );
    const d2Push = await (
      await fetch(`${srv.base}/api/sync/merge`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${loginA2.token}`, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
        body: gzipPayload,
      })
    ).json();
    assert.equal(d2Push.mode, 'delta');
    assert.equal(d2Push.revision, baseRev + 1);
    assert.ok(d2Push.state.inks.ink1);
    assert.equal(Object.keys(d2Push.state.docs).length, 0);

    const d1Pull = await (
      await fetch(`${srv.base}/api/sync/merge`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${regA.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseRevision: baseRev, delta: true, docs: {}, deleted: {} }),
      })
    ).json();
    assert.equal(d1Pull.mode, 'delta');
    assert.equal(d1Pull.revision, baseRev + 1);
    assert.equal(d1Pull.state.inks.ink1.layer, 'translated');
    assert.equal(Object.keys(d1Pull.state.docs).length, 0);
  } finally {
    await srv.close();
  }
});

test('orphan PDF blob GC preserves shared blobs and deletes unreferenced blobs after permanent deletion', async () => {
  const srv = await start({ BLOB_GC_GRACE_MS: '0', BLOB_GC_DELAY_MS: '20' });
  try {
    const regA = await (
      await fetch(`${srv.base}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'usera', password: 'password123' }),
      })
    ).json();
    const regB = await (
      await fetch(`${srv.base}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'userb', password: 'password123' }),
      })
    ).json();

    const pdfBytes = Buffer.from('%PDF-1.4\n%shared-blob-for-gc\n%%EOF');
    const hash = createHash('sha256').update(pdfBytes).digest('hex');

    // Both userA and userB reference the same deduplicated PDF hash
    for (const tok of [regA.token, regB.token]) {
      await fetch(`${srv.base}/api/sync/merge`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ docs: { d1: { id: 'd1', title: 'Shared', hasPdf: true, hash, addedAt: 100, updatedAt: 100 } }, deleted: {} }),
      });
    }
    const putRes = await fetch(`${srv.base}/api/blobs/${hash}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${regA.token}`, 'Content-Type': 'application/pdf' },
      body: pdfBytes,
    });
    assert.equal(putRes.status, 201);

    // UserA permanently deletes d1 -> blob MUST stay because userB still references it
    await fetch(`${srv.base}/api/sync/merge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${regA.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ docs: {}, deleted: { docs: { d1: 200 } } }),
    });
    await new Promise((r) => setTimeout(r, 60));
    const headStillThere = await fetch(`${srv.base}/api/blobs/${hash}`, {
      method: 'HEAD',
      headers: { Authorization: `Bearer ${regB.token}` },
    });
    assert.equal(headStillThere.status, 200);

    // UserB also permanently deletes d1 -> blob becomes an orphan and auto-GC removes it
    await fetch(`${srv.base}/api/sync/merge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${regB.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ docs: {}, deleted: { docs: { d1: 300 } } }),
    });
    await new Promise((r) => setTimeout(r, 80));
    const headGone = await fetch(`${srv.base}/api/blobs/${hash}`, {
      method: 'HEAD',
      headers: { Authorization: `Bearer ${regB.token}` },
    });
    assert.equal(headGone.status, 404);
    assert.equal(typeof gcOrphanBlobs, 'function');
  } finally {
    await srv.close();
  }
});

test('ALLOW_REGISTER=0 blocks new signups while keeping health check accurate', async () => {
  const srv = await start({ ALLOW_REGISTER: '0' });
  try {
    const h = await (await fetch(`${srv.base}/api/health`)).json();
    assert.equal(h.ok, true);
    assert.equal(h.allowRegister, false);

    const reg = await fetch(`${srv.base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'stranger', password: 'password123' }),
    });
    assert.equal(reg.status, 403);
  } finally {
    await srv.close();
  }
});
