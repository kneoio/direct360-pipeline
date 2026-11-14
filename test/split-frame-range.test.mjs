import assert from 'node:assert/strict';
import test from 'node:test';
import { splitFrameRange } from 'direct360-pipeline/src/edl.js';

function checkContiguous(parts, totalFrames) {
  assert.equal(parts[0].startFrame, 0);
  let cursor = 0;
  for (const part of parts) {
    assert.equal(part.startFrame, cursor);
    assert.ok(part.frames > 0, 'every part has at least one frame');
    cursor += part.frames;
  }
  assert.equal(cursor, totalFrames);
}

test('splitFrameRange tiles [0, totalFrames) with no gap or overlap', () => {
  checkContiguous(splitFrameRange(3000, 30, 1), 3000);
  checkContiguous(splitFrameRange(3000, 30, 3), 3000);
  checkContiguous(splitFrameRange(3000, 30, 5), 3000);
  // Non-integer fps (29.97): still exact, no drift.
  const fps = 30000 / 1001;
  const frames = Math.round(104 * fps); // ~1:44 clip
  checkContiguous(splitFrameRange(frames, fps, 3), frames);
  // Fewer whole seconds than workers requested: fewer, larger parts, never empty.
  const short = splitFrameRange(Math.round(5 * fps), fps, 8);
  checkContiguous(short, Math.round(5 * fps));
  assert.ok(short.length <= 5);
});

test('splitFrameRange boundaries land on a whole second, within half a frame', () => {
  const fps = 30000 / 1001;
  const totalFrames = Math.round(123.4 * fps);
  const parts = splitFrameRange(totalFrames, fps, 4);
  for (const part of parts) {
    const seconds = part.startFrame / fps;
    const nearest = Math.round(seconds);
    assert.ok(Math.abs(seconds - nearest) <= 0.5 / fps + 1e-9, `start ${part.startFrame} (${seconds}s) is not on a whole second`);
  }
});

