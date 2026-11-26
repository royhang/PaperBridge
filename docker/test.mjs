import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAllInOneServer } from './server.mjs';

test('All-in-One Docker server serves SPA, /api/health, and /health on one port', async () => {
  const webDir = mkdtempSync(join(tmpdir(), 'pb-docker-web-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'pb-docker-data-'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>PaperBridge</title>');
  const server = createAllInOneServer({ webDir, dataDir, env: { ALLOW_REGISTER: '1', ALLOWED_HOSTS: '*' } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const htmlRes = await fetch(`${base}/`);
    assert.equal(htmlRes.status, 200);
    assert.match(await htmlRes.text(), /PaperBridge/);

    const apiRes = await fetch(`${base}/api/health`);
    assert.equal(apiRes.status, 200);
    const apiJson = await apiRes.json();
    assert.equal(apiJson.ok, true);

    const proxyRes = await fetch(`${base}/health`);
    assert.equal(proxyRes.status, 200);

    const travRes = await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`);
    assert.equal(travRes.status, 403);
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(webDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
