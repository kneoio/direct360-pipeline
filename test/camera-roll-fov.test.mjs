import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fieldOfView } from '../src/formats.js';
import { buildMatrix, layoutFovs, layoutRolls, matrixCellSize, sanitizeLayouts } from '../src/matrix.js';
import {
  chunkCost, panFieldOfView, panPose, planChunks, planSegments, renderFromEdl, resolveView, stabilizedCommands,
} from '../src/edl.js';
import { aimQuat, composeView, qaxis, viewAngles } from '../src/stabilize.js';

// ---------------------------------------------------------------- layouts
const youtubeLayout = (extra = {}) => ({
  yaws: Array.from({ length: 18 }, (_, i) => i * 10),
  pitches: Array.from({ length: 18 }, () => 0),
  removed: [],
  ...extra,
});

test('a layout without rolls and fovs is kept as it was, and an all-default one is the same layout', () => {
  const old = sanitizeLayouts({ youtube: youtubeLayout() }).youtube;
  assert.deepEqual(Object.keys(old).sort(), ['pitches', 'removed', 'yaws']);
  const explicit = sanitizeLayouts({
    youtube: youtubeLayout({ rolls: Array(18).fill(0), fovs: Array(18).fill(100) }),
  }).youtube;
  assert.deepEqual(explicit, old);
  assert.deepEqual(layoutRolls(old, 18), Array(18).fill(0));
  assert.deepEqual(layoutFovs(old, 18), Array(18).fill(100));
});

test('rolls wrap into -180..180 and fovs clamp to 60..120', () => {
  const rolls = Array(18).fill(0);
  const fovs = Array(18).fill(100);
  rolls[0] = 30.123;
  rolls[1] = 190;
  rolls[2] = -270;
  rolls[3] = 180;
  fovs[0] = 80.456;
  fovs[1] = 10;
  fovs[2] = 500;
  const got = sanitizeLayouts({ youtube: youtubeLayout({ rolls, fovs }) }).youtube;
  assert.deepEqual(got.rolls.slice(0, 4), [30.12, -170, 90, -180]);
  assert.deepEqual(got.fovs.slice(0, 3), [80.46, 60, 120]);
  assert.equal(got.fovs[3], 100);
});

test('rolls and fovs of the wrong length or type are a 400', () => {
  for (const extra of [
    { rolls: [0, 1] },
    { fovs: Array(17).fill(100) },
    { rolls: Array(18).fill('3') },
    { fovs: Array(18).fill(NaN) },
    { rolls: 5 },
  ]) {
    assert.throws(() => sanitizeLayouts({ youtube: youtubeLayout(extra) }), (e) => e.status === 400, JSON.stringify(extra).slice(0, 40));
  }
});

// -------------------------------------------------------------- planning
test('a pan between cameras that differ in roll or zoom takes time; without them nothing changes', () => {
  const edl = [{ t: 0, camera: 1 }, { t: 6, camera: 2, panSpeed: 30 }];
  const before = planSegments(edl, [0, 30], [0, 0], 6);
  assert.deepEqual(planSegments(edl, [0, 30], [0, 0], 6, null, [0, 0], [100, 100]), before);
  assert.deepEqual(planSegments(edl, [0, 30], [0, 0], 6, null, null, null), before);
  assert.equal(before.find((seg) => seg.type === 'pan').dur, 1);

  // Same aim: only the tilt and the zoom move. 30° of roll and 40° of fov is 50°.
  const rolled = planSegments(edl, [0, 0], [0, 0], 6, null, [0, 30], [100, 60]);
  const pan = rolled.find((seg) => seg.type === 'pan');
  assert.ok(Math.abs(pan.dur - 50 / 30) < 1e-9, `pan lasts ${pan.dur}`);
  assert.equal(pan.fromRoll, 0);
  assert.equal(pan.toRoll, 30);
  assert.equal(pan.fromFov, 100);
  assert.equal(pan.toFov, 60);
  assert.equal(rolled[0].roll, 0);
  assert.equal(rolled[0].fov, 100);
});

test('a pan that only turns stays a yaw pan; a roll or zoom change leaves that route', () => {
  const edl = [{ t: 0, camera: 1 }, { t: 4, camera: 2, panSpeed: 30 }];
  const chunks = (rolls, fovs) => planChunks(
    planSegments(edl, [0, 40], [0, 0], 4, null, rolls, fovs),
    { totalFrames: 120, fps: 30, chunkSeconds: 1 },
  ).filter((chunk) => chunk.type === 'pan');
  assert.ok(chunks([0, 0], [100, 100]).every((chunk) => chunk.yawOnly));
  // Same roll and zoom on both cameras is still a pure spin of the equirect.
  assert.ok(chunks([20, 20], [80, 80]).every((chunk) => chunk.yawOnly));
  assert.ok(chunks([0, 25], [100, 100]).every((chunk) => !chunk.yawOnly));
  assert.ok(chunks([0, 0], [100, 85]).every((chunk) => !chunk.yawOnly));
});

test('pan poses move roll the short way and fov linearly on the shared ease, ending on the holds', () => {
  const extra = { fromRoll: 170, toRoll: -170, fromFov: 100, toFov: 80 };
  const first = panPose(0, 0, 0, 0, 0, 30, extra);
  const last = panPose(0, 0, 0, 0, 29, 30, extra);
  assert.equal(first.roll, 170);
  assert.equal(first.fov, 100);
  assert.ok(Math.abs(last.roll - -170) < 1e-9);
  assert.ok(Math.abs(last.fov - 80) < 1e-9);
  const mid = panPose(0, 0, 0, 0, 15, 30, extra);
  assert.ok(Math.abs(Math.abs(mid.roll) - 180) < 5, `mid roll ${mid.roll}`);
  // Same p as yaw: the eases are one function.
  assert.equal(mid.p, panPose(0, 90, 0, 0, 15, 30).p);
  assert.ok(Math.abs(mid.fov - (100 - 20 * mid.p)) < 1e-9);

  const a = fieldOfView(160, 90, 100);
  const b = fieldOfView(160, 90, 80);
  assert.deepEqual(panFieldOfView(160, 90, 100, 80, 0), a);
  assert.deepEqual(panFieldOfView(160, 90, 100, 80, 1), b);
});

test('a pan that rolls or zooms costs more than a pitch pan, which keeps its old weight', () => {
  const size = { width: 1920, height: 1080 };
  const pan = (extra) => ({ type: 'pan', frames: 10, yawOnly: false, fromPitch: 0, toPitch: 0, ...extra });
  assert.equal(chunkCost({ type: 'pan', frames: 10, yawOnly: false }, size), 30);
  assert.equal(chunkCost(pan({ toPitch: 8 }), size), 30);
  assert.equal(chunkCost(pan({ toRoll: 30 }), size), 50);
  assert.equal(chunkCost(pan({ toPitch: 8, toRoll: 30 }), size), 90);
  assert.equal(chunkCost(pan({ toFov: 80, fromFov: 100 }), size), 90);
  assert.equal(chunkCost(pan({ toRoll: 30 }), { width: 1280, height: 720 }), 30);
  assert.equal(chunkCost(pan({ toRoll: 30 }), { width: 480, height: 270 }), 10);
  assert.equal(chunkCost({ type: 'pan', frames: 10, yawOnly: true, fromRoll: 20, toRoll: 20 }, size), 10);
  assert.equal(chunkCost({ type: 'hold', frames: 10, roll: 30 }, size), 10);
});

test('resolveView fits rolls and fovs to the cameras and falls back to the defaults', () => {
  const view = resolveView({ format: 'youtube', yaws: [0, 10], pitches: [0, 0], rolls: [0, 30], fovs: [100, 70] });
  assert.deepEqual(view.rolls, [0, 30]);
  assert.deepEqual(view.fovs, [100, 70]);
  const bad = resolveView({ format: 'youtube', yaws: [0, 10], pitches: [0, 0], rolls: [1], fovs: 'x' });
  assert.deepEqual(bad.rolls, [0, 0]);
  assert.deepEqual(bad.fovs, [100, 100]);
  assert.deepEqual(resolveView({ format: 'youtube', yaws: [0], fov: 90 }).fovs, [90]);
});

// ---------------------------------------------------------- stabilization
test('a camera roll is composed with the correction, not added to it', () => {
  const identity = [1, 0, 0, 0];
  const [still] = viewAngles([identity], { yaw: 10, pitch: 5, roll: 30 });
  assert.ok(Math.abs(still.roll - 30) < 1e-6);
  assert.ok(Math.abs(still.yaw - 10) < 1e-6);
  assert.ok(Math.abs(still.pitch - 5) < 1e-6);

  // A heading change in the correction leaves the camera's own tilt.
  const turned = qaxis([0, 1, 0], 40);
  const [moved] = viewAngles([turned], { yaw: 0, pitch: 0, roll: 30 });
  assert.ok(Math.abs(moved.yaw - 40) < 1e-6, `yaw ${moved.yaw}`);
  assert.ok(Math.abs(moved.roll - 30) < 1e-6, `roll ${moved.roll}`);

  // A leveling tilt composes by quaternion: equals composeView, not 30 + 15.
  const tilted = qaxis([0, 0, 1], -15);
  const [both] = viewAngles([tilted], { yaw: 20, pitch: 10, roll: 30 });
  const want = composeView(tilted, 20, 10, 30);
  assert.ok(Math.abs(both.roll - want.roll) < 1e-6);
  assert.ok(Math.abs(both.yaw - want.yaw) < 1e-6);
  assert.ok(Math.abs(both.pitch - want.pitch) < 1e-6);
  assert.ok(aimQuat(20, 10, 30).every(Number.isFinite));
});

test('stabilized commands add h_fov and v_fov only when the zoom is given', () => {
  const angles = [{ yaw: 1, pitch: 2, roll: 3 }, { yaw: 1, pitch: 2, roll: 4 }];
  const plain = stabilizedCommands(angles, { num: 30, den: 1 });
  assert.ok(!plain.includes('fov'));
  const zoomed = stabilizedCommands(angles, {
    num: 30, den: 1, views: [{ hfov: 100, vfov: 56 }, { hfov: 99, vfov: 55.5 }],
  });
  const lines = zoomed.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /v360@s roll 4\.0000, v360@s h_fov 99\.0000, v360@s v_fov 55\.5000;$/);
});

// ----------------------------------------------------------------- ffmpeg
function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `ffmpeg exited ${result.status}`);
}

function ffprobe(args) {
  const result = spawnSync('ffprobe', ['-v', 'error', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `ffprobe exited ${result.status}`);
  return result.stdout;
}

function psnrOf(a, b) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-'], { encoding: 'utf8' });
  const text = (result.stderr.match(/average:(\S+)/) || [])[1];
  return text === 'inf' ? Infinity : Number(text);
}

function frameCount(file) {
  const facts = JSON.parse(ffprobe(['-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'json', file]));
  return Number(facts.streams[0].nb_read_frames);
}

// An equirect that is smooth everywhere and different in every direction
// (red/green/blue are the x/y/z of the direction), the same for every frame.
// Any wrong roll, zoom or aim shows as a large error; encoding noise does not.
const W = 1024;
const H = 512;
const GEQ = `geq=r='127.5+127.5*cos((0.5-Y/${H})*PI)*sin((X/${W}-0.5)*2*PI)':g='127.5+127.5*sin((0.5-Y/${H})*PI)':b='127.5+127.5*cos((0.5-Y/${H})*PI)*cos((X/${W}-0.5)*2*PI)'`;

function makeSource(dir, seconds = 4) {
  const src = path.join(dir, 'src.mp4');
  ffmpeg([
    '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=30:d=${seconds},format=gbrp,${GEQ},format=yuv420p`,
    '-c:v', 'libx264', '-crf', '8', '-pix_fmt', 'yuv420p', src,
  ]);
  return src;
}

function referenceFrame(src, file, { yaw, pitch, roll, hfov, vfov, width, height }) {
  ffmpeg([
    '-i', src, '-frames:v', '1',
    '-vf', `v360=input=e:output=flat:yaw=${yaw}:pitch=${pitch}:roll=${roll}:h_fov=${hfov}:v_fov=${vfov}:w=${width}:h=${height}`,
    file,
  ]);
}

function frameOf(video, file, n, crop = null) {
  ffmpeg(['-i', video, '-vf', `select=eq(n\\,${n})${crop ? `,crop=${crop}` : ''}`, '-frames:v', '1', file]);
}

async function withTemp(name, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  const previous = {
    preset: process.env.D360_RENDER_PRESET,
    crf: process.env.D360_RENDER_CRF,
    chunk: process.env.D360_CHUNK_MIN_SEC,
  };
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

test('a camera with roll 30: its matrix cell and its hold match a v360 with roll=30', { timeout: 180000 }, async () => {
  await withTemp('d360-roll-', async (tmp) => {
    const src = makeSource(tmp, 2);

    // Matrix cell. Camera 2 sits in the right cell, rolled 30° and zoomed to 80°.
    const grid = path.join(tmp, 'grid.mp4');
    const { cw, ch } = matrixCellSize(1, 2, 'youtube');
    await buildMatrix(src, grid, {
      grid: '2x1', format: 'youtube', yaws: [0, 20], pitches: [0, 5], rolls: [0, 30], fovs: [100, 80], fps: 12,
    });
    const cell = fieldOfView(cw, ch, 80);
    const noLabel = `${cw - 40}:${ch - 50}:${cw + 40}:50`; // right cell, clear of the number
    const wantCell = path.join(tmp, 'want-cell.png');
    ffmpeg([
      '-i', src, '-frames:v', '1',
      '-vf', `v360=input=e:output=flat:yaw=20:pitch=5:roll=30:h_fov=${cell.hfov}:v_fov=${cell.vfov}:w=${cw}:h=${ch},crop=${cw - 40}:${ch - 50}:40:50`,
      wantCell,
    ]);
    const gotCell = path.join(tmp, 'got-cell.png');
    frameOf(grid, gotCell, 3, noLabel);
    const matrixPsnr = psnrOf(wantCell, gotCell);
    assert.ok(matrixPsnr >= 35, `matrix cell PSNR ${matrixPsnr}`);

    // Rolling really changed the picture: the unrolled cell would not pass.
    const unrolled = path.join(tmp, 'unrolled-cell.png');
    ffmpeg([
      '-i', src, '-frames:v', '1',
      '-vf', `v360=input=e:output=flat:yaw=20:pitch=5:roll=0:h_fov=${cell.hfov}:v_fov=${cell.vfov}:w=${cw}:h=${ch},crop=${cw - 40}:${ch - 50}:40:50`,
      unrolled,
    ]);
    assert.ok(psnrOf(unrolled, gotCell) < 30, 'the roll made no difference to the cell');

    // Hold render of the same camera.
    const out = path.join(tmp, 'hold.mp4');
    const width = 192;
    const height = 108;
    await renderFromEdl(src, out, [{ t: 0, camera: 1 }], {
      format: 'youtube', yaws: [20], pitches: [5], rolls: [30], fovs: [80], width, height, log: () => {},
    });
    assert.equal(frameCount(out), 60);
    const view = fieldOfView(width, height, 80);
    const want = path.join(tmp, 'want-hold.png');
    referenceFrame(src, want, { yaw: 20, pitch: 5, roll: 30, ...view, width, height });
    const got = path.join(tmp, 'got-hold.png');
    frameOf(out, got, 30);
    const holdPsnr = psnrOf(want, got);
    assert.ok(holdPsnr >= 35, `hold PSNR ${holdPsnr}`);
    const flat = path.join(tmp, 'flat-hold.png');
    referenceFrame(src, flat, { yaw: 20, pitch: 5, roll: 0, ...view, width, height });
    assert.ok(psnrOf(flat, got) < 30, 'the roll made no difference to the hold');
  });
});

test('layouts without rolls and fovs render exactly as they did, and spelled-out defaults are the same render', { timeout: 180000 }, async () => {
  await withTemp('d360-roll-old-', async (tmp) => {
    const src = makeSource(tmp, 2);
    const edl = [{ t: 0, camera: 1 }, { t: 1.5, camera: 2, panSpeed: 60 }];
    const common = { format: 'youtube', yaws: [0, 30], pitches: [0, 6], width: 160, height: 90, log: () => {} };
    const old = path.join(tmp, 'old.mp4');
    const same = path.join(tmp, 'same.mp4');
    await renderFromEdl(src, old, edl, common);
    await renderFromEdl(src, same, edl, { ...common, rolls: [0, 0], fovs: [100, 100] });
    assert.equal(frameCount(old), 60);
    assert.equal(psnrOf(old, same), Infinity);

    const gridOld = path.join(tmp, 'grid-old.mp4');
    const gridSame = path.join(tmp, 'grid-same.mp4');
    await buildMatrix(src, gridOld, { grid: '2x1', format: 'youtube', yaws: [0, 30], pitches: [0, 6], fps: 12 });
    await buildMatrix(src, gridSame, { grid: '2x1', format: 'youtube', yaws: [0, 30], pitches: [0, 6], rolls: [0, 0], fovs: [100, 100], fps: 12 });
    assert.equal(psnrOf(gridOld, gridSame), Infinity);

    // And the hold itself is the plain v360 it always was.
    const want = path.join(tmp, 'want.png');
    referenceFrame(src, want, { yaw: 0, pitch: 0, roll: 0, ...fieldOfView(160, 90), width: 160, height: 90 });
    const got = path.join(tmp, 'got.png');
    frameOf(old, got, 5);
    assert.ok(psnrOf(want, got) >= 35);
  });
});

test('a pan from roll 0 / fov 100 to roll 45 / fov 80 is smooth across chunk borders and keeps the frame count', { timeout: 240000 }, async () => {
  await withTemp('d360-roll-pan-', async (tmp) => {
    const src = makeSource(tmp, 4);
    const width = 160;
    const height = 90;
    const edl = [{ t: 0, camera: 1 }, { t: 3, camera: 2, panSpeed: 25 }];
    const yaws = [0, 24];
    const pitches = [0, 6];
    const rolls = [0, 45];
    const fovs = [100, 80];

    const segments = planSegments(edl, yaws, pitches, 4, null, rolls, fovs);
    const pan = segments.find((seg) => seg.type === 'pan');
    assert.ok(pan.dur > 1.5, `pan ${pan.dur}s`);
    const chunks = planChunks(segments, { totalFrames: 120, fps: 30, chunkSeconds: 0.5 });
    const panChunks = chunks.filter((chunk) => chunk.type === 'pan');
    assert.ok(panChunks.length >= 3 && panChunks.every((chunk) => !chunk.yawOnly));

    const out = path.join(tmp, 'pan.mp4');
    const lines = [];
    const rendered = await renderFromEdl(src, out, edl, {
      format: 'youtube', yaws, pitches, rolls, fovs, width, height, log: (line) => lines.push(line),
    });
    assert.equal(rendered.chunks, chunks.length);
    assert.equal(frameCount(out), 120);
    assert.ok(lines.some((line) => /pan pitch/.test(line)));

    const panFrames = panChunks[0].panFrames;
    const firstFrame = panChunks[0].seekFrame;
    const sample = new Set([0, 1, 59, firstFrame - 1]);
    // Every frame on either side of every chunk border inside the pan, and a few in between.
    for (const chunk of panChunks) {
      for (const n of [chunk.seekFrame - 1, chunk.seekFrame, chunk.seekFrame + 1]) sample.add(n);
    }
    for (let n = firstFrame; n < firstFrame + panFrames; n += 7) sample.add(n);
    sample.add(firstFrame + panFrames - 1);
    sample.add(119);

    let worst = Infinity;
    for (const n of [...sample].filter((k) => k >= 0 && k < 120).sort((a, b) => a - b)) {
      const local = n - firstFrame;
      const inPan = local >= 0 && local < panFrames;
      const pose = inPan
        ? panPose(pan.fromYaw, pan.toYaw, pan.fromPitch, pan.toPitch, local, panFrames, {
          fromRoll: pan.fromRoll, toRoll: pan.toRoll, fromFov: pan.fromFov, toFov: pan.toFov,
        })
        : (local < 0
          ? { yaw: 0, pitch: 0, roll: 0, fov: 100, p: 0 }
          : { yaw: 24, pitch: 6, roll: 45, fov: 80, p: 1 });
      const view = inPan ? panFieldOfView(width, height, 100, 80, pose.p) : fieldOfView(width, height, pose.fov);
      const want = path.join(tmp, `want-${n}.png`);
      const got = path.join(tmp, `got-${n}.png`);
      referenceFrame(src, want, { yaw: pose.yaw.toFixed(3), pitch: pose.pitch.toFixed(3), roll: pose.roll.toFixed(3), ...view, width, height });
      frameOf(out, got, n);
      const psnr = psnrOf(want, got);
      worst = Math.min(worst, psnr);
      // 1024px is coarse (~2.8 px/degree) and the yaw is carried by whole-pixel scrolls.
      assert.ok(psnr >= 30, `frame ${n} (pan frame ${local}) PSNR ${psnr}`);
    }
    console.log(`pan roll/fov: ${chunks.length} chunks, ${panChunks.length} pan chunks, worst PSNR ${worst.toFixed(1)} over ${sample.size} frames`);

    // No jump at the borders: the step across a border is no bigger than the steps around it.
    const diff = (a, b) => psnrOf(a, b);
    for (const chunk of panChunks.slice(1)) {
      const n = chunk.seekFrame;
      const files = [n - 2, n - 1, n, n + 1].map((k) => {
        const f = path.join(tmp, `step-${k}.png`);
        frameOf(out, f, k);
        return f;
      });
      const before = diff(files[0], files[1]);
      const across = diff(files[1], files[2]);
      const after = diff(files[2], files[3]);
      assert.ok(across >= Math.min(before, after) - 4, `border at frame ${n}: steps ${before.toFixed(1)} / ${across.toFixed(1)} / ${after.toFixed(1)} dB`);
    }
  });
});

test('a pan that also changes roll and fov matches the same pan rendered as chunks of a part range', { timeout: 240000 }, async () => {
  await withTemp('d360-roll-part-', async (tmp) => {
    const src = makeSource(tmp, 4);
    const edl = [{ t: 0, camera: 1 }, { t: 3, camera: 2, panSpeed: 25 }];
    const common = {
      format: 'youtube', yaws: [0, 24], pitches: [0, 6], rolls: [0, 45], fovs: [100, 80], width: 160, height: 90, includeAudio: false, log: () => {},
    };
    const whole = path.join(tmp, 'whole.mp4');
    const whole0 = await renderFromEdl(src, whole, edl, common);
    const first = path.join(tmp, 'a.mp4');
    const second = path.join(tmp, 'b.mp4');
    const mid = Math.floor(whole0.chunks / 2);
    const planned = { expectedChunks: whole0.chunks, expectedFrames: 120, chunkSeconds: whole0.chunkSeconds };
    await renderFromEdl(src, first, edl, { ...common, ...planned, chunkRange: [0, mid - 1] });
    await renderFromEdl(src, second, edl, { ...common, ...planned, chunkRange: [mid, whole0.chunks - 1] });
    assert.equal(frameCount(first) + frameCount(second), 120);
    // The second part starts mid-pan, on the same ease as the whole render.
    const framesFirst = frameCount(first);
    const a = path.join(tmp, 'whole-frame.png');
    const b = path.join(tmp, 'part-frame.png');
    frameOf(whole, a, framesFirst + 5);
    frameOf(second, b, 5);
    assert.ok(psnrOf(a, b) >= 35);
  });
});

test('a roll in a stabilized chunk comes out the same as the unstabilized one when the correction is level', { timeout: 180000 }, async () => {
  await withTemp('d360-roll-stab-', async (tmp) => {
    const src = makeSource(tmp, 2);
    const common = { format: 'youtube', yaws: [20], pitches: [5], rolls: [30], fovs: [90], width: 160, height: 90, log: () => {} };
    const plain = path.join(tmp, 'plain.mp4');
    const stab = path.join(tmp, 'stab.mp4');
    await renderFromEdl(src, plain, [{ t: 0, camera: 1 }], common);
    await renderFromEdl(src, stab, [{ t: 0, camera: 1 }], {
      ...common, stabilization: { corrections: Array.from({ length: 60 }, () => [1, 0, 0, 0]) },
    });
    assert.equal(frameCount(stab), 60);
    const a = path.join(tmp, 'a.png');
    const b = path.join(tmp, 'b.png');
    frameOf(plain, a, 20);
    frameOf(stab, b, 20);
    assert.ok(psnrOf(a, b) >= 35, `stabilized roll PSNR ${psnrOf(a, b)}`);
  });
});
