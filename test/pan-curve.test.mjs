import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_PAN_CURVE, panCurveMean, panPose, panProgress, panYawDelta, planChunks, planSegments, renderFromEdl, sanitizeEdl,
} from 'direct360-pipeline/src/edl.js';

const plan = (entry, { yaws = [0, 40], pitches = [0, 0], duration = 12 } = {}) => planSegments(
  [{ t: 0, camera: 1 }, { t: duration, camera: 2, panSpeed: 10, ...entry }], yaws, pitches, duration,
);
const panOf = (segments) => segments.find((seg) => seg.type === 'pan');

test('the default curve is today\'s ease, and a pan with it moves and lasts exactly as one without', () => {
  assert.equal(panCurveMean(DEFAULT_PAN_CURVE), 70);
  for (let i = 0; i <= 1000; i++) {
    const x = i / 1000;
    assert.ok(Math.abs(panProgress(DEFAULT_PAN_CURVE, x) - panProgress(null, x)) < 1e-12, `x=${x}`);
  }
  const frames = 90;
  for (let n = 0; n < frames; n++) {
    const plain = panPose(0, 40, 0, 6, n, frames);
    const curved = panPose(0, 40, 0, 6, n, frames, { curve: DEFAULT_PAN_CURVE });
    assert.ok(Math.abs(plain.yaw - curved.yaw) < 1e-9 && Math.abs(plain.pitch - curved.pitch) < 1e-9, `frame ${n}`);
  }
  assert.equal(panOf(plan({ panCurve: DEFAULT_PAN_CURVE })).dur, panOf(plan({})).dur);
  assert.equal(panOf(plan({})).dur, 4);
  assert.ok(!('capped' in panOf(plan({}))), 'a pan that fits is not capped');
});

test('a lower curve makes a longer pan and a higher one a shorter pan, by 70 over its mean', () => {
  const half = [{ at: 0, level: 0 }, { at: 0.3, level: 50 }, { at: 0.7, level: 50 }, { at: 1, level: 0 }];
  const flat = [{ at: 0, level: 100 }, { at: 1, level: 100 }];
  assert.equal(panCurveMean(half), 35);
  assert.ok(Math.abs(panOf(plan({ panCurve: half })).dur - 8) < 1e-9);
  assert.ok(Math.abs(panOf(plan({ panCurve: flat })).dur - 2.8) < 1e-9);
  assert.deepEqual(panOf(plan({ panCurve: half })).panCurve, half);
  // The progress is the share of the area under the curve so far, and ends on 1.
  assert.equal(panProgress(flat, 0.25), 0.25);
  assert.equal(panProgress(half, 1), 1);
  assert.equal(panProgress(half, 0), 0);
});

test('a pan that does not fit before the cut says it was capped, and how long it wanted to be', () => {
  const segments = planSegments([{ t: 0, camera: 1 }, { t: 2, camera: 2, panSpeed: 10 }], [0, 40], [0, 0], 4);
  const pan = panOf(segments);
  assert.equal(pan.dur, 2);
  assert.equal(pan.capped, true);
  assert.equal(pan.desiredSec, 4);
  // A lower curve wants longer still.
  const slow = panOf(planSegments([{ t: 0, camera: 1 }, { t: 2, camera: 2, panSpeed: 10, panCurve: [{ at: 0, level: 35 }, { at: 1, level: 35 }] }], [0, 40], [0, 0], 4));
  assert.equal(slow.capped, true);
  assert.ok(Math.abs(slow.desiredSec - 8) < 1e-9);
});

test('a stretch of the curve at level 0 holds the camera still', () => {
  const stop = [{ at: 0, level: 100 }, { at: 0.3, level: 100 }, { at: 0.3, level: 0 }, { at: 0.7, level: 0 }, { at: 0.7, level: 100 }, { at: 1, level: 100 }];
  const frames = 101;
  const yaw = (n) => panPose(0, 40, 0, 0, n, frames, { curve: stop }).yaw;
  for (let n = 30; n <= 70; n++) assert.ok(Math.abs(yaw(n) - yaw(30)) < 1e-9, `frame ${n}`);
  assert.ok(yaw(29) < yaw(30) && yaw(71) > yaw(70));
  assert.ok(Math.abs(yaw(100) - 40) < 1e-9 && yaw(0) === 0);
  // The pan is longer by the time spent standing: mean 60 of the 70.
  assert.ok(Math.abs(panCurveMean(stop) - 60) < 1e-9);
});

test('left and right fix the side the yaw turns; the long way is longer', () => {
  assert.equal(panYawDelta(0, 40), 40);
  assert.equal(panYawDelta(0, 40, 'right'), 40);
  assert.equal(panYawDelta(0, 40, 'left'), -320);
  assert.equal(panYawDelta(40, 0, 'left'), -40);
  assert.equal(panYawDelta(40, 0, 'right'), 320);
  assert.equal(panYawDelta(10, 10, 'left'), 0);
  assert.equal(panYawDelta(10, 10, 'right'), 0);
  assert.equal(panYawDelta(-170, 170, 'short'), -20);
  const short = panOf(plan({}, { duration: 60 }));
  const left = panOf(plan({ panDirection: 'left' }, { duration: 60 }));
  const right = panOf(plan({ panDirection: 'right' }, { duration: 60 }));
  assert.equal(short.dur, 4);
  assert.equal(right.dur, 4);
  assert.equal(left.dur, 32);
  assert.equal(left.panDirection, 'left');
  // The pose goes the forced way: half way round the long way is -160°.
  assert.ok(Math.abs(panPose(0, 40, 0, 0, 50, 101, { direction: 'left' }).yaw + 160) < 1e-9);
  assert.ok(Math.abs(panPose(0, 40, 0, 0, 50, 101, { direction: 'right' }).yaw - 20) < 1e-9);
  assert.ok(Math.abs(panPose(0, 40, 0, 0, 100, 101, { direction: 'left' }).yaw - 40) < 1e-9);
  // Chunks carry both, so every part of a split pan agrees.
  const chunks = planChunks(plan({ panDirection: 'left', panCurve: DEFAULT_PAN_CURVE }, { duration: 60 }), { totalFrames: 1800, fps: 30, chunkSeconds: 4 });
  const panChunks = chunks.filter((chunk) => chunk.type === 'pan');
  assert.ok(panChunks.length > 1 && panChunks.every((chunk) => chunk.panDirection === 'left' && chunk.panCurve === panChunks[0].panCurve && chunk.yawOnly));
  // Pitch, roll and fov keep their direct way: only the yaw is turned round.
  const tilted = panOf(planSegments([{ t: 0, camera: 1 }, { t: 60, camera: 2, panSpeed: 10, panDirection: 'left' }], [0, 40], [0, 30], 60));
  assert.ok(Math.abs(tilted.dur - Math.hypot(320, 30) / 10) < 1e-9);
});

test('sanitizeEdl keeps a good curve and direction, and drops bad ones without losing the entry', () => {
  const good = [{ at: 0, level: 0 }, { at: 0.5, level: 80 }, { at: 1, level: 10 }];
  const kept = sanitizeEdl([{ t: 0, camera: 1 }, { t: 5, camera: 2, panSpeed: 20, panCurve: good, panDirection: 'right' }], 3);
  assert.deepEqual(kept[1], { t: 5, camera: 2, panSpeed: 20, panCurve: good, panDirection: 'right' });
  const point = (at, level) => ({ at, level });
  const bad = [
    'ramp', null, [point(0, 50)], Array.from({ length: 13 }, (_, i) => point(i / 12, 50)),
    [point(0.1, 50), point(1, 50)], [point(0, 50), point(0.9, 50)], [point(0, 50), point(0.6, 50), point(0.4, 50), point(1, 50)],
    [point(0, 50), point(1, 101)], [point(0, -1), point(1, 50)], [point(0, 1), point(1, 8)], [point(0, 0), point(1, 8)], [point(0, 'a'), point(1, 50)], [point(0, NaN), point(1, 50)],
  ];
  for (const panCurve of bad) {
    const out = sanitizeEdl([{ t: 0, camera: 1 }, { t: 5, camera: 2, panSpeed: 20, panCurve }], 3);
    assert.deepEqual(out[1], { t: 5, camera: 2, panSpeed: 20 }, JSON.stringify(panCurve)?.slice(0, 60));
  }
  for (const panDirection of ['up', 'short', 3, null, '']) {
    const out = sanitizeEdl([{ t: 0, camera: 1 }, { t: 5, camera: 2, panSpeed: 20, panDirection }], 3);
    assert.deepEqual(out[1], { t: 5, camera: 2, panSpeed: 20 }, String(panDirection));
  }
  // Without a panSpeed there is no pan to shape.
  assert.deepEqual(sanitizeEdl([{ t: 5, camera: 2, panCurve: good, panDirection: 'left' }], 3), [{ t: 5, camera: 2 }]);
  // A mean level of 5 is the lowest allowed.
  assert.equal(sanitizeEdl([{ t: 1, camera: 1, panSpeed: 5, panCurve: [point(0, 5), point(1, 5)] }], 3)[0].panCurve.length, 2);
});

// ----------------------------------------------------------------- ffmpeg
function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `ffmpeg exited ${result.status}`);
}

function psnrOf(a, b) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-'], { encoding: 'utf8' });
  const text = (result.stderr.match(/average:(\S+)/) || [])[1];
  return text === 'inf' ? Infinity : Number(text);
}

function frameOf(video, file, n) {
  ffmpeg(['-i', video, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1', file]);
}

const W = 1024;
const H = 512;
const GEQ = `geq=r='127.5+127.5*cos((0.5-Y/${H})*PI)*sin((X/${W}-0.5)*2*PI)':g='127.5+127.5*sin((0.5-Y/${H})*PI)':b='127.5+127.5*cos((0.5-Y/${H})*PI)*cos((X/${W}-0.5)*2*PI)'`;

test('rendered yaw pans: the default curve is the pan it always was, a direction takes the other way round', { timeout: 240000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd360-pan-curve-'));
  const keep = { preset: process.env.D360_RENDER_PRESET, crf: process.env.D360_RENDER_CRF, chunk: process.env.D360_CHUNK_MIN_SEC };
  process.env.D360_RENDER_PRESET = 'ultrafast';
  process.env.D360_RENDER_CRF = '10';
  process.env.D360_CHUNK_MIN_SEC = '0.5';
  try {
    const src = path.join(tmp, 'src.mp4');
    ffmpeg(['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=30:d=3,format=gbrp,${GEQ},format=yuv420p`, '-c:v', 'libx264', '-crf', '8', '-pix_fmt', 'yuv420p', src]);
    const base = { format: 'youtube', yaws: [0, 40], pitches: [0, 0], width: 160, height: 90, log: () => {} };
    const render = async (name, entry) => {
      const out = path.join(tmp, `${name}.mp4`);
      await renderFromEdl(src, out, [{ t: 0, camera: 1 }, { t: 2.5, camera: 2, panSpeed: 40, ...entry }], base);
      return out;
    };
    const plain = await render('plain', {});
    const curved = await render('curved', { panCurve: DEFAULT_PAN_CURVE });
    assert.equal(psnrOf(plain, curved), Infinity);
    const right = await render('right', { panDirection: 'right' });
    assert.equal(psnrOf(plain, right), Infinity, 'right is the short way here');
    const left = await render('left', { panDirection: 'left' });
    // The long way round starts at once (it takes all the room before the cut); the short way still holds camera 1 then.
    const a = path.join(tmp, 'plain-early.png');
    const b = path.join(tmp, 'left-early.png');
    frameOf(plain, a, 20);
    frameOf(left, b, 20);
    assert.ok(psnrOf(a, b) < 30, 'left turns the other way');
    // A slower curve ends the same pan later: at the same frame it is not as far.
    const slow = await render('slow', { panCurve: [{ at: 0, level: 20 }, { at: 1, level: 20 }] });
    const c = path.join(tmp, 'slow-mid.png');
    const d = path.join(tmp, 'plain-mid.png');
    frameOf(slow, c, 60);
    frameOf(plain, d, 60);
    assert.ok(psnrOf(c, d) < 35, 'a slower curve is not at the same place');
  } finally {
    for (const [key, value] of [['D360_RENDER_PRESET', keep.preset], ['D360_RENDER_CRF', keep.crf], ['D360_CHUNK_MIN_SEC', keep.chunk]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
