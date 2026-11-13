import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  aria2Completed, cachedSource, downloadFile, downloadSource, downloadWatchdog, fetchSource, objectSize, tailBytes,
} from 'direct360-pipeline/worker/render.js';

const hasAria2 = spawnSync('aria2c', ['--version']).status === 0;

function serve(body) {
  const server = http.createServer((req, res) => {
    const size = body.length;
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' });
      res.end();
      return;
    }
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : size - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
      });
      res.end(body.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('source download matches the object size', async () => {
  const body = Buffer.alloc(20 * 1024 * 1024, 7);
  const server = await serve(body);
  const dest = path.join(os.tmpdir(), `d360-dl-${Date.now()}.bin`);
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return write.call(process.stderr, chunk, ...rest);
  };
  try {
    const { port } = server.address();
    const size = await downloadSource(`http://127.0.0.1:${port}/clip.bin`, dest);
    assert.equal(size, body.length);
    assert.equal(fs.statSync(dest).size, body.length);
    assert.equal(fs.readFileSync(dest).compare(body), 0);
    const summary = lines.join('');
    assert.match(summary, /source download 20971520 bytes in [\d.]+s \([\d.]+ MB\/s, (?:\d+ connections|1 connection)\)/);
    if (!/aria2c download failed/.test(summary)) assert.doesNotMatch(summary, /single-connection fallback/);
  } finally {
    process.stderr.write = write;
    server.close();
    fs.rmSync(dest, { force: true });
  }
});

test('missing aria2c falls back to one connection', async () => {
  const body = Buffer.alloc(64 * 1024, 3);
  const server = await serve(body);
  const dest = path.join(os.tmpdir(), `d360-dl-fallback-${Date.now()}.bin`);
  const previous = process.env.PATH;
  process.env.PATH = '/usr/bin';
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return write.call(process.stderr, chunk, ...rest);
  };
  try {
    const { port } = server.address();
    const size = await downloadSource(`http://127.0.0.1:${port}/clip.bin`, dest);
    assert.equal(size, body.length);
    const summary = lines.join('');
    assert.match(summary, /single-connection fallback/);
    assert.match(summary, /1 connection\)/);
    assert.equal(fs.existsSync(`${dest}.aria2`), false);
  } finally {
    process.env.PATH = previous;
    process.stderr.write = write;
    server.close();
    fs.rmSync(dest, { force: true });
    fs.rmSync(`${dest}.aria2`, { force: true });
  }
});

test('objectSize uses a 2xx length and ignores a failed range', async () => {
  const server = http.createServer((req, res) => {
    if (req.headers.range) {
      res.writeHead(500, { 'Content-Length': '9', 'Content-Range': 'bytes 0-0/999' });
      res.end('nope');
      return;
    }
    res.writeHead(200, { 'Content-Length': '12' });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    assert.equal(await objectSize(`http://127.0.0.1:${port}/a`), 12);
  } finally {
    server.close();
  }
});

test('a 200 on resume restarts the file from the beginning', async () => {
  const body = Buffer.from('abcdefghijklmnopqrstuvwxyz');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Length': body.length });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dest = path.join(os.tmpdir(), `d360-resume-${Date.now()}.bin`);
  fs.writeFileSync(dest, body.subarray(0, 10));
  try {
    const { port } = server.address();
    const size = await downloadFile(`http://127.0.0.1:${port}/a`, dest, body.length);
    assert.equal(size, body.length);
    assert.equal(fs.readFileSync(dest).compare(body), 0);
  } finally {
    server.close();
    fs.rmSync(dest, { force: true });
  }
});

test('aria2c summary lines give the completed bytes', () => {
  assert.equal(aria2Completed('[#2967b7 4.5MiB/8.0MiB(57%) CN:4 DL:4.8MiB]'), 4.5 * 1024 ** 2);
  assert.equal(aria2Completed('[#a 0B/0B CN:1 DL:0B]\n[#a 12KiB/1.0GiB(0%) CN:16 DL:3KiB]'), 12 * 1024);
  assert.equal(aria2Completed('FILE: ./out.bin'), null);
});

test('the watchdog defaults to a 45 s no-bytes stall window with 2 restarts', () => {
  assert.deepEqual(downloadWatchdog({}), { windowMs: 45_000, restarts: 2 });
  assert.deepEqual(downloadWatchdog({ D360_DOWNLOAD_STALL_SEC: '10', D360_DOWNLOAD_RESTARTS: '1' }),
    { windowMs: 10_000, restarts: 1 });
});

test('the tail is 5% of the object or 32 MB, whichever is larger', () => {
  assert.equal(tailBytes(185.6e6), 32 * 1024 * 1024);
  assert.equal(tailBytes(2e9), 2e9 * 0.05);
});

/** Serves `size` bytes at roughly `bytesPerSec`, with Range. Counts GETs that send body bytes. */
function slowServer(size, bytesPerSec) {
  const stats = { bodies: 0 };
  const server = http.createServer((req, res) => {
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    const start = m && m[1] ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : size - 1;
    res.writeHead(m ? 206 : 200, {
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      ETag: '"v1"',
    });
    if (end - start + 1 > 1) stats.bodies++;
    let left = end - start + 1;
    const step = Math.max(1, Math.round(bytesPerSec / 20));
    const timer = setInterval(() => {
      const n = Math.min(left, step);
      res.write(Buffer.alloc(n, 1));
      left -= n;
      if (!left) {
        clearInterval(timer);
        res.end();
      }
    }, 50);
    res.on('close', () => clearInterval(timer));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, stats })));
}

/**
 * Range server with per-byte-offset pacing. `rate(offset)` is bytes/s for the
 * bytes starting at `offset` (per connection). `hold()` true pauses every body
 * (no bytes at all). `hangRanged` hangs aria2c's bodies, so only the
 * single-connection fallback GET gets data.
 */
function pacedServer(size, { rate = () => 50e6, hold = () => false, hangRanged = false } = {}) {
  const server = http.createServer((req, res) => {
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    const start = m && m[1] ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : size - 1;
    res.writeHead(m ? 206 : 200, {
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      ETag: '"v1"',
    });
    if (end === start) {
      res.end(Buffer.alloc(1, 1));
      return;
    }
    const hung = hangRanged && /aria2/i.test(req.headers['user-agent'] || '');
    let at = start;
    const timer = setInterval(() => {
      if (hung || hold()) return;
      const n = Math.min(end + 1 - at, Math.max(1, Math.round(rate(at) / 20)));
      res.write(Buffer.alloc(n, 1));
      at += n;
      if (at > end) {
        clearInterval(timer);
        res.end();
      }
    }, 50);
    res.on('close', () => clearInterval(timer));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function withDownload(server, body) {
  const dest = path.join(os.tmpdir(), `d360-wd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.bin`);
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return write.call(process.stderr, chunk, ...rest);
  };
  try {
    const { port } = server.address();
    await body(`http://127.0.0.1:${port}/clip.bin`, dest, () => lines.join(''));
  } finally {
    process.stderr.write = write;
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(dest, { force: true });
    fs.rmSync(`${dest}.aria2`, { force: true });
  }
}

test('a slow tail (last 5 MB at 0.3 MB/s) completes without a restart', { skip: !hasAria2 && 'aria2c not installed', timeout: 90_000 }, async () => {
  const size = 40 * 1024 * 1024;
  const server = await pacedServer(size, { rate: (at) => (at >= size - 5 * 1024 * 1024 ? 0.3e6 : 50e6) });
  await withDownload(server, async (url, dest, out) => {
    // Average is far under any old MB/s floor, but bytes keep arriving.
    const watch = { windowMs: 3_000, restarts: 2, tickMs: 250 };
    const stats = await fetchSource(url, dest, { watch });
    assert.equal(stats.bytes, size);
    assert.equal(stats.restarts, 0);
    assert.equal(stats.fallback, false);
    assert.equal(stats.tailSlow, true);
    assert.doesNotMatch(out(), /restarting aria2c/);
    assert.match(out(), /slow tail/);
  });
});

test('a full stall (no bytes for the window) restarts aria2c and then completes', { skip: !hasAria2 && 'aria2c not installed', timeout: 60_000 }, async () => {
  const size = 24 * 1024 * 1024;
  const until = Date.now() + 4_000;
  const server = await pacedServer(size, { rate: () => 20e6, hold: () => Date.now() < until });
  await withDownload(server, async (url, dest, out) => {
    const watch = { windowMs: 2_000, restarts: 3, tickMs: 250 };
    const stats = await fetchSource(url, dest, { watch });
    assert.equal(stats.bytes, size);
    assert.ok(stats.restarts >= 1);
    assert.equal(stats.fallback, false);
    assert.match(out(), /no new bytes for 2s .*restarting aria2c \(1\/3\)/);
  });
});

test('restarts exhausted falls back to the single-connection GET and completes', { skip: !hasAria2 && 'aria2c not installed', timeout: 60_000 }, async () => {
  const size = 12 * 1024 * 1024;
  const server = await pacedServer(size, { rate: () => 50e6, hangRanged: true });
  await withDownload(server, async (url, dest, out) => {
    const watch = { windowMs: 1_500, restarts: 1, tickMs: 250 };
    const stats = await fetchSource(url, dest, { watch });
    assert.equal(stats.bytes, size);
    assert.equal(stats.connections, 1);
    assert.equal(stats.restarts, 1);
    assert.equal(stats.fallback, true);
    assert.match(out(), /restarting aria2c \(1\/1\)/);
    assert.match(out(), /stalled .* after 1 restart; single-connection fallback/);
    assert.equal(fs.statSync(dest).size, size);
  });
});

test('a fast aria2c download passes the watchdog and reports MB/s', { skip: !hasAria2 && 'aria2c not installed' }, async () => {
  const body = Buffer.alloc(24 * 1024 * 1024, 5);
  const server = await serve(body);
  const dest = path.join(os.tmpdir(), `d360-fast-${Date.now()}.bin`);
  try {
    const { port } = server.address();
    const stats = await fetchSource(`http://127.0.0.1:${port}/clip.bin`, dest, { watch: { windowMs: 2_000, restarts: 0, tickMs: 100 } });
    assert.equal(stats.bytes, body.length);
    assert.equal(stats.restarts, 0);
    assert.equal(stats.connections, 16);
    assert.ok(stats.mbps > 0);
    assert.equal(fs.readFileSync(dest).compare(body), 0);
  } finally {
    server.close();
    fs.rmSync(dest, { force: true });
  }
});

test('a part input is downloaded once per worker and reused by the next part', async () => {
  const { server, stats } = await slowServer(3 * 1024 * 1024, 50 * 1024 * 1024);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd360-cache-'));
  fs.writeFileSync(path.join(dir, 'stale-other-source.mp4'), 'old');
  try {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/footage/source.mp4?X-Amz-Signature=a`;
    const first = await cachedSource(url, { dir });
    // A second job while the first still holds the cache downloads on its own.
    const fallback = path.join(dir, '..', `d360-cache-fallback-${Date.now()}.mp4`);
    const busy = await cachedSource(url, { dir, fallback: fallback });
    assert.equal(busy.path, fallback);
    fs.rmSync(fallback, { force: true });
    first.release();
    assert.equal(first.download.cached, false);
    assert.equal(first.download.bytes, 3 * 1024 * 1024);
    assert.equal(fs.existsSync(path.join(dir, 'stale-other-source.mp4')), false);
    const bodies = stats.bodies;
    // Another presigned URL for the same object: same file.
    const second = await cachedSource(`http://127.0.0.1:${port}/footage/source.mp4?X-Amz-Signature=b`, { dir });
    assert.equal(second.download.cached, true);
    assert.equal(second.path, first.path);
    assert.equal(stats.bodies, bodies);
    second.release();
    const other = await cachedSource(`http://127.0.0.1:${port}/footage/other.mp4`, { dir });
    assert.equal(other.download.cached, false);
    assert.notEqual(other.path, first.path);
    assert.equal(fs.existsSync(first.path), false);
    other.release();
  } finally {
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
