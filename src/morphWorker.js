import { parentPort } from 'node:worker_threads';
import { bendFrame } from './morph.js';

/**
 * A transition chunk's frames drawn off the main thread (edl.js renderTransition), so chunks rendered side by side
 * draw side by side. Each message is one decoded equirect frame with what to draw from it; the drawn frame goes back.
 */
parentPort.on('message', ({ src, sw, sh, w, h, layers, weight, aim, base }) => {
  const out = Buffer.alloc(w * h * 3);
  bendFrame(Buffer.from(src), sw, sh, out, w, h, layers, weight, aim, base);
  const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
  parentPort.postMessage(buf, [buf]);
});
