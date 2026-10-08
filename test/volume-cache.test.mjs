import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { cachedSource, jobStats } from '../worker/render.js';
import {
  cacheFile, cacheKey, cleanupCache, multipartEtag, storeProduced, volumeCacheDir,
} from '../worker/volumeCache.js';

const HOUR = 3600 * 1000;

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'd360-vol-'));
}

function serve(size, delayMs = 0) {
  const stats = { bodies: 0 };
  const body = Buffer.alloc(size, 5);
  const server = http.createServer((req, res) => {
    const base = { 'Accept-Ranges': 'bytes', ETag: '"abc"' };
    if (req.method === 'HEAD') {
      res.writeHead(200, { ...base, 'Content-Length': size });
      res.end();
      return;
    }
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    const start = m && m[1] ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : size - 1;
    if (!(start === 0 && end === 0)) stats.bodies++;
    const send = () => {
      res.writeHead(m ? 206 : 200, {
        ...base,
        'Content-Length': end - start + 1,
        ...(m ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      });
      res.end(body.subarray(start, end + 1));
    };
    if (delayMs && !(start === 0 && end === 0)) setTimeout(send, delayMs);
    else send();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, stats })));
}

function age(file, ms) {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(file, t, t);
}

test('miss downloads into the volume, hit reuses it and reports both', async () => {
  const { server, stats } = await serve(2 * 1024 * 1024);
  const volume = tmp();
  try {
    const url = `http://127.0.0.1:${server.address().port}/footage/a.mp4?sig=1`;
    const first = await cachedSource(url, { volume });
    assert.equal(first.download.cache.hit, false);
    assert.equal(first.download.cache.volume, true);
    assert.equal(first.download.cache.bytes, 2 * 1024 * 1024);
    assert.equal(first.download.cached, false);
    assert.equal(first.download.bytes, 2 * 1024 * 1024);
    assert.ok(first.path.startsWith(volume));
    assert.equal(fs.readdirSync(volume).some((n) => n.endsWith('.part')), false);
    first.release();
    const bodies = stats.bodies;
    const second = await cachedSource(url.replace('sig=1', 'sig=2'), { volume });
    assert.equal(second.download.cache.hit, true);
    assert.equal(second.download.cache.waitedMs, 0);
    assert.equal(second.download.cached, true);
    assert.equal(second.path, first.path);
    assert.equal(stats.bodies, bodies);
    const report = jobStats(tmp()).report(second.download);
    assert.equal(report.cache.hit, true);
    assert.equal(jobStats(tmp()).report(first.download).cache.hit, false);
    second.release();
  } finally {
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(volume, { recursive: true, force: true });
  }
});

test('two concurrent jobs for one file download it once', async () => {
  const volume = tmp();
  let downloads = 0;
  const id = cacheKey('http://h/b/k.mp4?x=1', 100, '"e"');
  const download = async (partial) => {
    downloads++;
    await new Promise((r) => setTimeout(r, 150));
    fs.writeFileSync(partial, Buffer.alloc(100, 1));
    return { bytes: 100 };
  };
  try {
    const opts = { pollMs: 10 };
    const [a, b] = await Promise.all([
      cacheFile(volume, id, 100, download, opts),
      cacheFile(volume, id, 100, download, opts),
    ]);
    assert.equal(downloads, 1);
    assert.deepEqual([a.hit, b.hit].sort(), [false, true]);
    assert.equal(a.path, b.path);
    assert.equal(fs.statSync(a.path).size, 100);
    assert.equal(fs.existsSync(path.join(volume, `${id}.lock`)), false);
    a.release();
    b.release();
    assert.deepEqual(fs.readdirSync(volume), [`${id}.mp4`]);
  } finally {
    fs.rmSync(volume, { recursive: true, force: true });
  }
});

test('a waiter takes over when the downloader died', async () => {
  const volume = tmp();
  const id = 'a'.repeat(24);
  fs.writeFileSync(path.join(volume, `${id}.lock`), '1');
  age(path.join(volume, `${id}.lock`), HOUR);
  try {
    const got = await cacheFile(volume, id, 3, async (p) => { fs.writeFileSync(p, 'abc'); }, { staleMs: 1000, pollMs: 10 });
    assert.equal(got.hit, false);
    got.release();
  } finally {
    fs.rmSync(volume, { recursive: true, force: true });
  }
});

test('idle files are deleted, recently used ones stay', () => {
  const volume = tmp();
  try {
    fs.writeFileSync(path.join(volume, `${'1'.repeat(24)}.mp4`), 'old');
    fs.writeFileSync(path.join(volume, `${'2'.repeat(24)}.mp4`), 'new');
    age(path.join(volume, `${'1'.repeat(24)}.mp4`), 25 * HOUR);
    age(path.join(volume, `${'2'.repeat(24)}.mp4`), 23 * HOUR);
    const removed = cleanupCache(volume, { idleMs: 24 * HOUR, maxBytes: 1e9 });
    assert.deepEqual(removed, ['1'.repeat(24)]);
    assert.deepEqual(fs.readdirSync(volume), [`${'2'.repeat(24)}.mp4`]);
  } finally {
    fs.rmSync(volume, { recursive: true, force: true });
  }
});

test('size limit evicts least recently used first and keeps held files', async () => {
  const volume = tmp();
  const ids = ['1', '2', '3', '4'].map((c) => c.repeat(24));
  try {
    ids.forEach((id, i) => {
      fs.writeFileSync(path.join(volume, `${id}.mp4`), Buffer.alloc(100));
      age(path.join(volume, `${id}.mp4`), (10 - i) * HOUR); // 1 oldest ... 4 newest
    });
    // Job holds the oldest file through cacheFile; it is a hit and must survive.
    const held = await cacheFile(volume, ids[0], 100, async () => assert.fail('no download'), { limits: { idleMs: 1e12, maxBytes: 250 } });
    assert.equal(held.hit, true);
    // The clean-up at job start dropped the next-oldest files, not the held (oldest) one.
    assert.deepEqual(fs.readdirSync(volume).filter((n) => n.endsWith('.mp4')).sort(), [`${ids[0]}.mp4`, `${ids[3]}.mp4`]);
    // Held and aged again, it still survives a clean-up that needs room.
    age(path.join(volume, `${ids[0]}.mp4`), 20 * HOUR);
    assert.deepEqual(cleanupCache(volume, { idleMs: 1e12, maxBytes: 50 }), [ids[3]]);
    assert.equal(fs.existsSync(path.join(volume, `${ids[0]}.mp4`)), true);
    held.release();
  } finally {
    fs.rmSync(volume, { recursive: true, force: true });
  }
});

test('a file being downloaded is not evicted even when idle', () => {
  const volume = tmp();
  const id = '9'.repeat(24);
  try {
    fs.writeFileSync(path.join(volume, `${id}.mp4.part`), Buffer.alloc(100));
    fs.writeFileSync(path.join(volume, `${id}.lock`), '1');
    age(path.join(volume, `${id}.mp4.part`), 48 * HOUR);
    assert.deepEqual(cleanupCache(volume, { idleMs: HOUR, maxBytes: 10 }), []);
    assert.equal(fs.existsSync(path.join(volume, `${id}.mp4.part`)), true);
  } finally {
    fs.rmSync(volume, { recursive: true, force: true });
  }
});

test('an uploaded file is cached under its object key and the next job hits it', async () => {
  const { server, stats } = await serve(1024);
  const volume = tmp();
  const dir = tmp();
  try {
    const url = `http://127.0.0.1:${server.address().port}/footage/proxy.mp4?sig=1`;
    const file = path.join(dir, 'proxy.mp4');
    fs.writeFileSync(file, Buffer.alloc(1024, 5));
    // The server's ETag is the multipart one for these parts.
    const parts = [{ partNumber: 1, etag: '"00112233445566778899aabbccddeeff"' }];
    const etag = multipartEtag(parts);
    assert.match(etag, /^[0-9a-f]{32}-1$/);
    assert.equal(storeProduced(volume, file, `${url}&partNumber=1&uploadId=u`, parts), true);
    assert.equal(fs.existsSync(path.join(volume, `${cacheKey(url, 1024, `"${etag}"`)}.mp4`)), true);
    assert.equal(storeProduced(volume, file, url, parts), false); // already there
    assert.deepEqual(fs.readdirSync(volume).filter((n) => !n.endsWith('.mp4')), []);
  } finally {
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(volume, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without the volume the per-worker behaviour is unchanged', async () => {
  assert.equal(volumeCacheDir({ D360_CACHE_DIR: '/nonexistent-volume-xyz/d360-cache' }), null);
  const present = tmp();
  assert.equal(volumeCacheDir({ D360_CACHE_DIR: path.join(present, 'c') }), path.join(present, 'c'));
  fs.rmSync(present, { recursive: true, force: true });
  const { server } = await serve(1024 * 1024);
  const local = tmp();
  const fallback = path.join(local, 'source.mp4');
  try {
    const url = `http://127.0.0.1:${server.address().port}/footage/s.mp4`;
    const got = await cachedSource(url, { dir: path.join(local, 'worker'), fallback, volume: volumeCacheDir({ D360_CACHE_DIR: '/nonexistent-volume-xyz/d360-cache' }) });
    assert.ok(got.path.startsWith(path.join(local, 'worker')));
    assert.equal(got.download.cache.volume, false);
    assert.equal(got.download.cache.hit, false);
    assert.equal(got.download.cached, false);
    got.release();
  } finally {
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(local, { recursive: true, force: true });
  }
});
