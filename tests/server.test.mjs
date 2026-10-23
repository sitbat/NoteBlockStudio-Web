import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createLocalServer } from '../server.mjs';

let fixtureDirectory;
let publicDirectory;
let outsideDirectory;
let server;
let port;

before(async () => {
  fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), 'noteblock-web-server-'));
  publicDirectory = path.join(fixtureDirectory, 'public');
  outsideDirectory = path.join(fixtureDirectory, 'private');
  await mkdir(path.join(publicDirectory, 'assets'), { recursive: true });
  await mkdir(outsideDirectory);
  await writeFile(path.join(publicDirectory, 'index.html'), '<!doctype html><title>Local music</title>');
  await writeFile(path.join(publicDirectory, 'app.js'), 'export const local = true;');
  await writeFile(path.join(publicDirectory, 'dsp.wasm'), Buffer.from([0,97,115,109,1,0,0,0]));
  await writeFile(path.join(publicDirectory, 'assets', 'harp.ogg'), Buffer.from([0x4f, 0x67, 0x67, 0x53]));
  await writeFile(path.join(publicDirectory, 'assets', 'demo song.nbs'), Buffer.from([0, 0, 5, 16]));
  await writeFile(path.join(publicDirectory, '.env'), 'private=value');
  await writeFile(path.join(outsideDirectory, 'secret.txt'), 'outside public root');
  server = createLocalServer(publicDirectory);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = server.address().port;
});

after(async () => {
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
});

const request = (requestPath, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
  const client = http.request({ hostname: '127.0.0.1', port, path: requestPath, method, headers, agent: false }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    response.on('error', reject);
  });
  client.on('error', reject);
  client.end();
});

test('server serves the index, scripts and binary assets with correct MIME and lengths', async () => {
  const index = await request('/');
  assert.equal(index.status, 200);
  assert.match(index.headers['content-type'], /^text\/html/);
  assert.match(index.body.toString(), /Local music/);
  assert.equal(index.headers['x-content-type-options'], 'nosniff');
  assert.equal(index.headers['cache-control'], 'no-cache');
  assert.equal(index.headers['cross-origin-opener-policy'],'same-origin');
  assert.equal(index.headers['cross-origin-embedder-policy'],'require-corp');
  const script = await request('/app.js?cache=test');
  assert.equal(script.status, 200);
  assert.match(script.headers['content-type'], /^text\/javascript/);
  const wasm=await request('/dsp.wasm');
  assert.equal(wasm.headers['content-type'],'application/wasm');
  assert.equal(WebAssembly.validate(wasm.body),true);
  const audio = await request('/assets/harp.ogg');
  assert.equal(audio.headers['content-type'], 'audio/ogg');
  assert.deepEqual([...audio.body], [0x4f, 0x67, 0x67, 0x53]);
  const song = await request('/assets/demo%20song.nbs');
  assert.equal(song.status, 200);
  assert.equal(song.headers['content-type'], 'application/octet-stream');
  assert.equal(Number(song.headers['content-length']), song.body.byteLength);
  assert.deepEqual([...song.body], [0, 0, 5, 16]);
});

test('HEAD returns headers without a response body', async () => {
  const response = await request('/app.js', { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.ok(Number(response.headers['content-length']) > 0);
  assert.equal(response.body.byteLength, 0);
});

test('server accepts local Host values and rejects remote Host values', async () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]', `localhost:${port}`]) {
    assert.equal((await request('/', { headers: { Host: host } })).status, 200, host);
  }
  for (const host of ['example.com', 'localhost.example.com', '127.0.0.1.example.com', 'localhost@evil.example']) {
    assert.equal((await request('/', { headers: { Host: host } })).status, 403, host);
  }
});

test('server rejects write methods', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await request('/app.js', { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, 'GET, HEAD');
  }
});

test('server rejects hidden files, encoded traversal, backslashes and null bytes', async () => {
  for (const pathname of ['/.env', '/.git/config', '/assets/.hidden', '/%2e%2e%2fprivate%2fsecret.txt', '/..%5Cprivate%5Csecret.txt', '/%00']) {
    assert.equal((await request(pathname)).status, 403, pathname);
  }
});

test('server returns 400 for malformed URI encoding and 404 for missing files or directories', async () => {
  assert.equal((await request('/%zz')).status, 400);
  assert.equal((await request('/missing')).status, 404);
  assert.equal((await request('/assets')).status, 404);
});

test('server refuses a symbolic link or junction pointing outside its root', async t => {
  try {
    await symlink(outsideDirectory, path.join(publicDirectory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('This environment does not permit creating symlinks.');
    throw error;
  }
  const response = await request('/escape/secret.txt');
  assert.equal(response.status, 403);
  assert.ok(!response.body.toString().includes('outside public root'));
});
