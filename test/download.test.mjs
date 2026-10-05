import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { downloadSource } from '../worker/render.js';

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
    assert.match(summary, /source download 20971520 bytes in [\d.]+s \([\d.]+ MB\/s, \d+ connections\)/);
    assert.doesNotMatch(summary, /single-connection fallback/);
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
  } finally {
    process.env.PATH = previous;
    process.stderr.write = write;
    server.close();
    fs.rmSync(dest, { force: true });
  }
});
