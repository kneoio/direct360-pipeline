import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { uploadParts } from '../worker/render.js';

test('the worker output carries upload counts, not per-part etags', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { etag: '"0123456789abcdef0123456789abcdef"' }); res.end(); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const parts = 400;
  const urls = Array.from({ length: parts }, (_, i) => `http://127.0.0.1:${port}/p/${i + 1}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd360-size-'));
  const file = path.join(dir, 'f.bin');
  fs.writeFileSync(file, Buffer.alloc(parts * 16));
  try {
    const got = await uploadParts(file, { partSize: 16, urls }, 'render part');
    assert.equal(got.count, parts);
    assert.equal(got.parts.length, parts); // kept in memory for the volume cache
    const printed = JSON.stringify({ part: true, upload: got });
    assert.ok(printed.length < 200, `printed ${printed.length} bytes`);
    assert.ok(!printed.includes('etag'));
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
