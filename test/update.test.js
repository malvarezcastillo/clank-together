import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { createApp, DEFAULT_CONFIG } from '../src/server/app.js';

const exec = promisify(execFile);
const ASSET = process.platform === 'win32' ? 'td-windows-x64.exe' : `td-linux-${process.arch}`;
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
const installed = Buffer.from('installed td build');
const published = Buffer.from('newly published td build');

async function listen(t, server, dir) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function runUpdater(dir, server) {
  // Isolate the SEA gate and executable/home paths, not the updater's HTTP, hashing or writes.
  const script = `
    import { createRequire } from 'node:module';
    import path from 'node:path';
    const [dir, server, updater] = process.argv.slice(1);
    const require = createRequire(import.meta.url);
    require('node:sea').isSea = () => true;
    require('node:os').homedir = () => dir;
    process.execPath = path.join(dir, 'td');
    const { maybeUpdate } = await import(updater);
    const logs = [];
    const result = await maybeUpdate({ server, force: true, log: (message) => logs.push(message) });
    console.log(JSON.stringify({ result, logs }));
  `;
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script, dir, server, new URL('../src/client/update.js', import.meta.url).href], {
    env: { ...process.env, TD_NO_UPDATE: '0' },
    timeout: 15_000,
  });
  return JSON.parse(stdout);
}

async function cachedDownloads(t, corrupt = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-update-'));
  const exe = path.join(dir, 'td');
  fs.writeFileSync(exe, installed);
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/download/SHA256SUMS') {
      // A cache serves the old manifest unless the client requests revalidation.
      const revalidate = /(?:no-cache|no-store|max-age=0)/.test(req.headers['cache-control'] ?? '');
      return res.end(`${hash(revalidate ? published : installed)}  ${ASSET}\n`);
    }
    if (url.pathname === `/download/${ASSET}`) {
      // The mutable URL is stale; only a new content-keyed URL reaches the new build.
      const keyed = url.searchParams.get('sha256') === hash(published);
      return res.end(keyed && !corrupt ? published : installed);
    }
    res.writeHead(404);
    res.end();
  });
  return { dir, exe, requests, base: await listen(t, server, dir) };
}

test('self-update revalidates the manifest and bypasses a stale unversioned binary', async (t) => {
  const f = await cachedDownloads(t);
  const { result } = await runUpdater(f.dir, f.base);
  assert.equal(typeof result, 'string', 'the downloaded update was installed');
  assert.deepEqual(fs.readFileSync(f.exe), published);
  assert.deepEqual(f.requests, ['/download/SHA256SUMS', `/download/${ASSET}?sha256=${hash(published)}`]);
  assert.equal(fs.existsSync(f.exe + '.new'), false);
});

test('self-update rejects mismatched bytes even at the expected SHA256 URL', async (t) => {
  const f = await cachedDownloads(t, true);
  const { result } = await runUpdater(f.dir, f.base);
  assert.deepEqual(f.requests, ['/download/SHA256SUMS', `/download/${ASSET}?sha256=${hash(published)}`]);
  assert.equal(result, null);
  assert.deepEqual(fs.readFileSync(f.exe), installed, 'checksum failure must preserve the installed executable');
  assert.equal(fs.existsSync(f.exe + '.new'), false);
  assert.equal(fs.existsSync(f.exe + '.old'), false);
});

test('mutable downloads are not stored by caches for GET or HEAD, including gzip and missing assets', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-download-'));
  const downloads = path.join(dir, 'downloads');
  fs.mkdirSync(downloads);
  fs.writeFileSync(path.join(downloads, ASSET), published);
  const zipped = gzipSync(published);
  fs.writeFileSync(path.join(downloads, ASSET + '.gz'), zipped);
  const manifest = `${hash(published)}  ${ASSET}\n`;
  fs.writeFileSync(path.join(downloads, 'SHA256SUMS'), manifest);
  const server = createApp({ config: { ...DEFAULT_CONFIG, dataDir: dir }, project: {}, runsWorker: false });
  const base = await listen(t, server, dir);
  for (const method of ['GET', 'HEAD']) {
    for (const [asset, encoding, body, length] of [
      [ASSET, 'gzip', published, zipped.length],
      [`${ASSET}?sha256=${hash(published)}`, 'identity', published, published.length],
      ['SHA256SUMS', 'identity', Buffer.from(manifest), Buffer.byteLength(manifest)],
    ]) {
      const res = await fetch(`${base}/download/${asset}`, { method, headers: { 'accept-encoding': encoding } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('content-encoding'), encoding === 'gzip' ? 'gzip' : null);
      assert.equal(Number(res.headers.get('content-length')), length);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), method === 'HEAD' ? Buffer.alloc(0) : body);
    }
    const missing = await fetch(`${base}/download/missing`, { method });
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('cache-control'), 'no-store');
    await missing.arrayBuffer();
  }
});
