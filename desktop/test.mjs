import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createProxyServer } from '../proxy/server.mjs';
import { createSyncServer } from '../sync/server.mjs';
import { createLanController, detectLanAddresses } from './lan-server.mjs';

test('Desktop LAN Share controller serves SPA, Sync API (with auto proxy token), and token-gated Proxy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-lan-test-'));
  const webDir = join(root, 'web');
  const dataDir = join(root, 'lan-sync-data');
  const configFile = join(root, 'lan-share.json');
  rmSync(webDir, { recursive: true, force: true });
  const { mkdirSync } = await import('node:fs');
  mkdirSync(webDir, { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>PaperBridge LAN</title>');

  const controller = createLanController({
    webDir,
    dataDir,
    configFile,
    createSyncServer,
    createProxyHandler: (token) => {
      const proxySrv = createProxyServer({ env: { PROXY_TOKEN: token, ALLOWED_HOSTS: '*' } });
      return (req, res) => proxySrv.emit('request', req, res);
    },
  });

  try {
    assert.equal(controller.getStatus().running, false);

    // Pick a free ephemeral-like high port
    const st = await controller.configure({ enabled: true, port: 18787 });
    assert.equal(st.enabled, true);
    assert.equal(st.running, true);
    assert.equal(st.port, 18787);
    assert.equal(st.error, '');
    const base = st.localUrl;

    // 1. Static SPA
    const htmlRes = await fetch(`${base}/`);
    assert.equal(htmlRes.status, 200);
    assert.match(await htmlRes.text(), /PaperBridge LAN/);

    // 2. Path traversal blocked
    const travRes = await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`);
    assert.equal(travRes.status, 403);

    // 3. Sync API health + signup automatically returns LAN proxy token
    const apiHealth = await fetch(`${base}/api/health`);
    assert.equal(apiHealth.status, 200);
    assert.equal((await apiHealth.json()).ok, true);

    const regRes = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ipaduser', password: 'password123', device: 'iPadOS' }),
    });
    assert.equal(regRes.status, 201);
    const regJson = await regRes.json();
    assert.equal(regJson.username, 'ipaduser');
    assert.ok(regJson.proxy?.token && regJson.proxy.token.length >= 16);

    // 4. Proxy health works, unauthenticated /proxy is rejected
    const pHealth = await fetch(`${base}/health`);
    assert.equal(pHealth.status, 200);
    const pDenied = await fetch(`${base}/proxy?url=https://example.com`);
    assert.equal(pDenied.status, 403);

    // 5. Stopping cleanly releases the server
    const stopped = await controller.configure({ enabled: false });
    assert.equal(stopped.running, false);
    assert.equal(stopped.enabled, false);

    // 6. detectLanAddresses returns structured array without 169.254 link-local
    const addrs = detectLanAddresses();
    assert.ok(Array.isArray(addrs));
    for (const a of addrs) {
      assert.ok(!a.address.startsWith('169.254.'));
    }
  } finally {
    await controller.close();
    rmSync(root, { recursive: true, force: true });
  }
});
