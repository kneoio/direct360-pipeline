import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PAN_KINDS, PLANET_FADE, centreScale, planSegments, renderFromEdl, sanitizeEdl, transitionFovs, transitionKinds, transitionWeight,
} from 'direct360-helper/src/edl.js';

// ---------------------------------------------------------------- planning
test('transitions: a pan between the same picture, blend between any two pictures, planet between flat and planet', () => {
  assert.deepEqual(PAN_KINDS, ['blend', 'planet']);
  const flat = { projection: 'flat', fov: 100 };
  assert.deepEqual(transitionKinds(flat, { projection: 'flat', fov: 80 }), ['pan']);
  assert.deepEqual(transitionKinds(flat, { projection: 'planet', fov: 260 }), ['blend', 'planet']);
  assert.deepEqual(transitionKinds({ projection: 'planet', fov: 260 }, flat), ['blend', 'planet']);
  assert.deepEqual(transitionKinds(flat, { projection: 'fisheye', fov: 160 }), ['blend']);
  assert.deepEqual(transitionKinds({ projection: 'pannini', fov: 140 }, { projection: 'pannini', fov: 160 }), ['blend']);
  assert.deepEqual(transitionKinds({ projection: 'pannini', fov: 140 }, { projection: 'pannini', fov: 140 }), ['pan']);
  assert.deepEqual(transitionKinds(flat, { projection: 'flat', fov: 100, bulge: { top: 0.5 } }), ['blend']);
});

test('the new picture fades in along the pan for blend; planet fades only at its flat end', () => {
  assert.equal(transitionWeight('blend', 'flat', 0.3), 0.3);
  assert.equal(transitionWeight('planet', 'flat', 0), 0);
  assert.equal(transitionWeight('planet', 'flat', PLANET_FADE / 2), 0.5);
  assert.equal(transitionWeight('planet', 'flat', PLANET_FADE), 1);
  assert.equal(transitionWeight('planet', 'flat', 0.9), 1);
  assert.equal(transitionWeight('planet', 'planet', 0.5), 0);
  assert.equal(transitionWeight('planet', 'planet', 1 - PLANET_FADE / 2), 0.5);
  assert.equal(transitionWeight('planet', 'planet', 1), 1);
});

test('both pictures of a transition show the middle of the frame at the same size, from the first camera to the second', () => {
  const flat = { projection: 'flat', fov: 100 };
  const planet = { projection: 'planet', fov: 260 };
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);
  near(transitionFovs(flat, planet, 0).from, 100);
  near(transitionFovs(flat, planet, 1).to, 260);
  for (const p of [0, 0.3, 0.7, 1]) {
    const f = transitionFovs(flat, planet, p);
    near(centreScale('flat', f.from), centreScale('planet', f.to));
    assert.ok(f.from < 180, 'flat never reaches 180°');
  }
  // The size moves evenly (in log) between the two cameras'.
  const mid = transitionFovs(flat, planet, 0.5);
  near(centreScale('flat', mid.from), Math.sqrt(centreScale('flat', 100) * centreScale('planet', 260)));
  const fish = transitionFovs({ projection: 'fisheye', fov: 160 }, { projection: 'flat', fov: 90 }, 0.4);
  near(centreScale('fisheye', fish.from), centreScale('flat', fish.to));
  // Pannini keeps its own zoom; the other picture moves between the two fovs.
  const pan = transitionFovs(flat, { projection: 'pannini', fov: 150 }, 0.5);
  assert.equal(pan.to, 150);
  assert.equal(pan.from, 120);
});

test('an edit list keeps a transition kind only with a pan speed', () => {
  assert.deepEqual(sanitizeEdl([{ t: 0, camera: 1 }, { t: 2, camera: 2, panSpeed: 20, panKind: 'planet' }, { t: 4, camera: 1, panKind: 'blend' }, { t: 6, camera: 2, panSpeed: 20, panKind: 'warp' }], 2), [
    { t: 0, camera: 1 }, { t: 2, camera: 2, panSpeed: 20, panKind: 'planet' }, { t: 4, camera: 1 }, { t: 6, camera: 2, panSpeed: 20 },
  ]);
});

test('between two pictures: a plain pan is a cut, a transition the pair allows is a pan segment carrying both pictures', () => {
  const plan = (entry) => planSegments([{ t: 0, camera: 1 }, { t: 3, camera: 2, panSpeed: 200, ...entry }], [0, 30], [0, -90], 6, false, null, [100, 260], { projections: ['flat', 'planet'] });
  assert.deepEqual(plan({}).map((s) => s.type), ['hold', 'hold']);
  for (const kind of ['blend', 'planet']) {
    const segs = plan({ panKind: kind });
    assert.deepEqual(segs.map((s) => s.type), ['hold', 'pan', 'hold']);
    assert.equal(segs[1].blend, kind);
    assert.equal(segs[1].projection, 'flat');
    assert.equal(segs[1].toProjection, 'planet');
    assert.equal(segs[1].fromFov, 100);
    assert.equal(segs[1].toFov, 260);
    assert.equal(segs[2].projection, 'planet');
  }
  // Planet is only between flat and planet: fisheye to planet stays a cut with it, and blends.
  const fish = (kind) => planSegments([{ t: 0, camera: 1 }, { t: 3, camera: 2, panSpeed: 200, panKind: kind }], [0, 30], [0, -90], 6, false, null, [160, 260], { projections: ['fisheye', 'planet'] });
  assert.deepEqual(fish('planet').map((s) => s.type), ['hold', 'hold']);
  assert.deepEqual(fish('blend').map((s) => s.type), ['hold', 'pan', 'hold']);
  // The same picture ignores the kind: a plain pan.
  const same = planSegments([{ t: 0, camera: 1 }, { t: 3, camera: 2, panSpeed: 60, panKind: 'blend' }], [0, 30], [0, 0], 6);
  assert.deepEqual(same.map((s) => s.type), ['hold', 'pan', 'hold']);
  assert.ok(!('blend' in same[1]));
});

// ---------------------------------------------------------------- real ffmpeg
function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `ffmpeg exited ${result.status}`);
}

function psnrOf(a, b) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-'], { encoding: 'utf8' });
  const text = (result.stderr.match(/average:(\S+)/) || [])[1];
  return text === 'inf' ? Infinity : Number(text);
}

function frameCount(file) {
  const out = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return Number(out.stdout.trim());
}

function frameOf(video, file, n) {
  ffmpeg(['-i', video, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1', file]);
}

const W = 1024;
const H = 512;
const GEQ = `geq=r='127.5+127.5*cos((0.5-Y/${H})*PI)*sin((X/${W}-0.5)*2*PI)':g='127.5+127.5*sin((0.5-Y/${H})*PI)':b='127.5+127.5*cos((0.5-Y/${H})*PI)*cos((X/${W}-0.5)*2*PI)'`;

function makeSource(dir, seconds) {
  const src = path.join(dir, 'src.mp4');
  ffmpeg(['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=30:d=${seconds},format=gbrp,${GEQ},format=yuv420p`, '-c:v', 'libx264', '-crf', '8', '-pix_fmt', 'yuv420p', src]);
  return src;
}

async function withTemp(name, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  const previous = { preset: process.env.D360_RENDER_PRESET, crf: process.env.D360_RENDER_CRF, chunk: process.env.D360_CHUNK_MIN_SEC };
  process.env.D360_RENDER_PRESET = 'ultrafast';
  process.env.D360_RENDER_CRF = '10';
  process.env.D360_CHUNK_MIN_SEC = '0.5';
  try {
    await run(dir);
  } finally {
    for (const [key, value] of [['D360_RENDER_PRESET', previous.preset], ['D360_RENDER_CRF', previous.crf], ['D360_CHUNK_MIN_SEC', previous.chunk]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const [kind, projections, fovs, pitches] of [
  ['planet', ['flat', 'planet'], [100, 260], [0, -90]],
  ['planet', ['planet', 'flat'], [260, 100], [-90, 0]],
  ['blend', ['flat', 'pannini'], [100, 150], [0, 0]],
  ['blend', ['fisheye', 'flat'], [160, 90], [0, 10]],
]) {
  test(`a ${kind} transition ${projections.join(' → ')} renders every frame, starts on the first camera and ends on the second`, { timeout: 300000 }, async () => {
    await withTemp('d360-transition-', async (tmp) => {
      const src = makeSource(tmp, 3);
      const base = { format: 'youtube', yaws: [0, 40], pitches, fovs, projections, width: 160, height: 90, log: () => {} };
      const out = path.join(tmp, 'move.mp4');
      const trace = [];
      await renderFromEdl(src, out, [{ t: 0, camera: 1 }, { t: 2.5, camera: 2, panSpeed: 200, panKind: kind }], { ...base, trace });
      assert.equal(frameCount(out), 90);
      assert.ok(trace.some((args) => args.some((a) => String(a).includes('blend@m=all_mode=normal'))), 'the transition mixes two pictures');
      const firstHold = path.join(tmp, 'a.mp4');
      const lastHold = path.join(tmp, 'b.mp4');
      await renderFromEdl(src, firstHold, [{ t: 0, camera: 1 }], base);
      await renderFromEdl(src, lastHold, [{ t: 0, camera: 2 }], base);
      const [got0, want0, got1, want1] = ['g0', 'w0', 'g1', 'w1'].map((n) => path.join(tmp, `${n}.png`));
      frameOf(out, got0, 2);
      frameOf(firstHold, want0, 2);
      frameOf(out, got1, 89);
      frameOf(lastHold, want1, 5);
      assert.ok(psnrOf(got0, want0) >= 28, `starts on camera 1: ${psnrOf(got0, want0)}`);
      assert.ok(psnrOf(got1, want1) >= 28, `ends on camera 2: ${psnrOf(got1, want1)}`);
    });
  });
}

test('a transition renders with a watermark and in a preview too', { timeout: 300000 }, async () => {
  await withTemp('d360-transition-wm-', async (tmp) => {
    const src = makeSource(tmp, 2);
    const base = { format: 'youtube', yaws: [0, 40], pitches: [0, -90], fovs: [100, 260], projections: ['flat', 'planet'], log: () => {} };
    const edl = [{ t: 0, camera: 1 }, { t: 1.5, camera: 2, panSpeed: 200, panKind: 'planet' }];
    const marked = path.join(tmp, 'marked.mp4');
    await renderFromEdl(src, marked, edl, { ...base, width: 320, height: 180, watermark: true });
    assert.equal(frameCount(marked), 60);
    const preview = path.join(tmp, 'preview.mp4');
    await renderFromEdl(src, preview, edl, { ...base, preview: true });
    assert.equal(frameCount(preview), 60);
  });
});
