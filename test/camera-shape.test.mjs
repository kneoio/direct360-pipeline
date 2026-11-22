import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BULGE_REACH, bulgeOf, bulgeReach, bulgeWarp, fieldOfView, hasBulge, projectedFieldOfView, projectionStage, sameBulge,
} from '../src/formats.js';
import { layoutBulges, sanitizeLayouts } from '../src/matrix.js';
import { planSegments, renderFromEdl, resolveView } from '../src/edl.js';

const youtubeLayout = (extra = {}) => ({
  yaws: Array.from({ length: 18 }, (_, i) => i * 10),
  pitches: Array.from({ length: 18 }, () => 0),
  removed: [],
  ...extra,
});
const STRAIGHT = { top: 0, right: 0, bottom: 0, left: 0 };

// ---------------------------------------------------------------- shape maths
test('bulgeWarp: corners stay, each side middle moves BULGE_REACH out at 1 and in at -1, the straight shape is the identity', () => {
  const shape = { top: 1, right: -1, bottom: 0.5, left: 0 };
  for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) assert.deepEqual(bulgeWarp(shape, u, v), [u, v]);
  assert.deepEqual(bulgeWarp(shape, 0, 1), [0, 1 + BULGE_REACH]);
  assert.deepEqual(bulgeWarp(shape, 1, 0), [1 - BULGE_REACH, 0]);
  assert.deepEqual(bulgeWarp(shape, 0, -1), [0, -(1 + BULGE_REACH * 0.5)]);
  assert.deepEqual(bulgeWarp(shape, -1, 0), [-1, 0]);
  assert.deepEqual(bulgeWarp(STRAIGHT, 0.3, -0.7), [0.3, -0.7]);
  assert.deepEqual(bulgeWarp(null, 0.3, -0.7), [0.3, -0.7]);
  // Each side only moves its own half: the top side does not touch the bottom half.
  assert.deepEqual(bulgeWarp({ top: 1 }, 0.2, -0.5), [0.2, -0.5]);
  assert.deepEqual(bulgeReach(shape), { x: 1, y: 1 + BULGE_REACH });
});

test('the warp never folds over: at the strongest shapes every step right and up still moves right and up', () => {
  for (const shape of [{ top: 1, right: 1, bottom: 1, left: 1 }, { top: -1, right: -1, bottom: -1, left: -1 }, { top: 1, right: -1, bottom: -1, left: 1 }]) {
    for (let i = 0; i < 40; i++) {
      for (let j = 0; j < 40; j++) {
        const u = -1 + (2 * i) / 40;
        const v = -1 + (2 * j) / 40;
        const [a, b] = bulgeWarp(shape, u, v);
        assert.ok(bulgeWarp(shape, u + 0.05, v)[0] > a, `${JSON.stringify(shape)} at ${u},${v}`);
        assert.ok(bulgeWarp(shape, u, v + 0.05)[1] > b, `${JSON.stringify(shape)} at ${u},${v}`);
      }
    }
  }
});

test('bulgeOf holds sides inside -1..1 at two decimals; hasBulge and sameBulge treat missing as 0', () => {
  assert.deepEqual(bulgeOf({ top: 3, right: -2, bottom: 0.12345, left: 'x' }), { top: 1, right: -1, bottom: 0.12, left: 0 });
  assert.deepEqual(bulgeOf(undefined), STRAIGHT);
  assert.equal(hasBulge(STRAIGHT), false);
  assert.equal(hasBulge(null), false);
  assert.equal(hasBulge({ left: 0.1 }), true);
  assert.equal(sameBulge(null, STRAIGHT), true);
  assert.equal(sameBulge({ top: 0.5 }, { top: 0.5, left: 0 }), true);
  assert.equal(sameBulge({ top: 0.5 }, { top: 0.4 }), false);
});

test('a bows-only shape renders exactly as before (the v360 stage and its warp maps are unchanged)', () => {
  const stage = projectionStage('flat', 192, 108, 100, { top: 0.5 });
  assert.equal(stage.w, 384);
  assert.equal(stage.h, 270);
  assert.equal(stage.post, "[wv];nullsrc=s=384x216:d=1,format=gray16le,geq=lum='clip(floor(192+((2*X+1)/W-1)*(1+if(gte(((2*X+1)/W-1),0),0,0)*(1-(1-(2*Y+1)/H)*(1-(2*Y+1)/H)))*192),0,383)',trim=end_frame=1,setpts=PTS-1000000/TB[wx];nullsrc=s=384x216:d=1,format=gray16le,geq=lum='clip(floor(135-(1-(2*Y+1)/H)*(1+if(gte((1-(2*Y+1)/H),0),0.25,0)*(1-((2*X+1)/W-1)*((2*X+1)/W-1)))*108),0,269)',trim=end_frame=1,setpts=PTS-1000000/TB[wy];[wv][wx][wy]remap=fill=black,scale=192:108:flags=area");
  assert.deepEqual(bulgeOf({ top: 0.5 }), { top: 0.5, right: 0, bottom: 0, left: 0 });
});

test('a moved corner lands where it was put and the opposite corner stays; a shifted top middle slides along the top', () => {
  const corners = [[0.2, -0.1], [0, 0], [0, 0], [0, 0]];
  const shape = { ...STRAIGHT, corners };
  const [x, y] = bulgeWarp(shape, -1, 1);
  assert.ok(Math.abs(x - (-1 + 0.2)) < 1e-12 && Math.abs(y - (1 - 0.1)) < 1e-12);
  assert.deepEqual(bulgeWarp(shape, 1, -1), [1, -1]);
  assert.deepEqual(bulgeWarp(shape, 1, 1), [1, 1]);
  const top = 0.4;
  const shifted = { top, right: 0, bottom: 0, left: 0, shift: { top: 0.3, right: 0, bottom: 0, left: 0 } };
  assert.deepEqual(bulgeWarp(shifted, 0, 1), [0.3, 1 + BULGE_REACH * top]);
  // The shift fades to nothing at the side's corners and at the frame's middle line.
  assert.deepEqual(bulgeWarp(shifted, 1, 1), [1, 1]);
  assert.deepEqual(bulgeWarp(shifted, 0.5, 0), [0.5, 0]);
  assert.equal(hasBulge({ shift: { left: 0.1 } }), true);
  assert.equal(hasBulge({ corners: [[0, 0], [0, 0], [0, 0.01], [0, 0]] }), true);
  assert.equal(sameBulge(shape, { ...shape, corners: [[0.2, -0.1], [0, 0], [0, 0], [0, 0.001]] }), false);
  assert.equal(sameBulge(shape, { corners }), true);
});

test('the canvas reach grows with an outward corner and with a shifted middle', () => {
  assert.deepEqual(bulgeReach(STRAIGHT), { x: 1, y: 1 });
  const out = bulgeReach({ corners: [[-0.3, 0.2], [0, 0], [0, 0], [0, 0]] });
  assert.ok(Math.abs(out.x - 1.3) < 1e-12 && Math.abs(out.y - 1.2) < 1e-12, JSON.stringify(out));
  // An inward corner reaches no further than the straight frame.
  assert.deepEqual(bulgeReach({ corners: [[0.3, -0.2], [0, 0], [0, 0], [0, 0]] }), { x: 1, y: 1 });
  const flat = projectionStage('flat', 192, 108, 100, { corners: [[-0.3, 0.2], [0, 0], [0, 0], [0, 0]] });
  assert.equal(flat.w, 2 * Math.ceil((192 * 2 * 1.3) / 2));
  assert.equal(flat.h, 2 * Math.ceil((108 * 2 * 1.2) / 2));
});

// ---------------------------------------------------------------- layouts
test('layouts keep corners and shift, clamped to ±0.75 at three decimals; all-zero ones are dropped', () => {
  const bulges = Array(18).fill(null);
  bulges[1] = { top: 0, shift: { top: 0.12345, right: 2, bottom: 0, left: -9 }, corners: [[0.1, 0], [0, -1], [0, 0], [0.0004, 0]] };
  bulges[3] = { left: 0.2, shift: { top: 0, right: 0, bottom: 0, left: 0 }, corners: [[0, 0], [0, 0], [0, 0], [0, 0]] };
  const kept = sanitizeLayouts({ youtube: youtubeLayout({ bulges }) }).youtube;
  assert.deepEqual(kept.bulges[1], {
    ...STRAIGHT, shift: { top: 0.123, right: 0.75, bottom: 0, left: -0.75 }, corners: [[0.1, 0], [0, -0.75], [0, 0], [0, 0]],
  });
  assert.deepEqual(kept.bulges[3], { ...STRAIGHT, left: 0.2 });
  assert.deepEqual(layoutBulges(kept, 18)[1], kept.bulges[1]);
  // Only moved points (no bows) still keep the shapes.
  const only = Array(18).fill(null);
  only[0] = { corners: [[0, 0], [0, 0], [0.2, 0], [0, 0]] };
  assert.deepEqual(sanitizeLayouts({ youtube: youtubeLayout({ bulges: only }) }).youtube.bulges[0], { ...STRAIGHT, corners: [[0, 0], [0, 0], [0.2, 0], [0, 0]] });
  for (const broken of [{ corners: [[0, 0]] }, { corners: [[0, 0], [0, 0], [0, 0], [0, '1']] }, { shift: { middle: 1 } }, { shift: [1, 0, 0, 0] }]) {
    assert.throws(() => sanitizeLayouts({ youtube: youtubeLayout({ bulges: Array(18).fill(broken) }) }), (e) => e.status === 400, JSON.stringify(broken));
  }
  // Plans carry the whole shape.
  const plan = planSegments([{ t: 0, camera: 1 }], [0], [0], 2, false, null, null, { bulges: [kept.bulges[1]] });
  assert.deepEqual(plan[0].bulge, kept.bulges[1]);
});

test('layouts keep bulges only when a side bows; a straight or missing shape is the old layout; bad shapes are a 400', () => {
  const old = sanitizeLayouts({ youtube: youtubeLayout() }).youtube;
  const zero = sanitizeLayouts({ youtube: youtubeLayout({ bulges: Array(18).fill(STRAIGHT) }) }).youtube;
  const nulls = sanitizeLayouts({ youtube: youtubeLayout({ bulges: Array(18).fill(null) }) }).youtube;
  assert.deepEqual(zero, old);
  assert.deepEqual(nulls, old);
  assert.ok(!('bulges' in old));
  assert.deepEqual(layoutBulges(old, 18), Array(18).fill(STRAIGHT));
  const bulges = Array(18).fill(null);
  bulges[2] = { top: 0.5, left: -7 };
  const kept = sanitizeLayouts({ youtube: youtubeLayout({ bulges }) }).youtube;
  assert.deepEqual(kept.bulges[2], { top: 0.5, right: 0, bottom: 0, left: -1 });
  assert.deepEqual(kept.bulges[0], STRAIGHT);
  for (const broken of [[STRAIGHT], Array(18).fill('round'), Array(18).fill({ middle: 1 }), Array(18).fill({ top: '1' }), Array(18).fill([1, 0, 0, 0])]) {
    assert.throws(() => sanitizeLayouts({ youtube: youtubeLayout({ bulges: broken }) }), (e) => e.status === 400, JSON.stringify(broken[0]));
  }
});

test('sanitizeLayouts keeps a camera strength (held to -1 … 1) and refuses one that is not a number', () => {
  const bulges = Array(18).fill(null);
  bulges[4] = { ...STRAIGHT, strength: 0.27 };
  bulges[5] = { ...STRAIGHT, strength: 3 };
  const kept = sanitizeLayouts({ youtube: youtubeLayout({ bulges }) }).youtube;
  assert.deepEqual(kept.bulges[4], { ...STRAIGHT, strength: 0.27 });
  assert.deepEqual(kept.bulges[5], { ...STRAIGHT, strength: 1 });
  assert.throws(() => sanitizeLayouts({ youtube: youtubeLayout({ bulges: Array(18).fill({ strength: '0.5' }) }) }), (e) => e.status === 400);
});

test('resolveView fills a straight shape for each camera; a list for other cameras is ignored', () => {
  assert.deepEqual(resolveView({ format: 'youtube', yaws: [0, 10], pitches: [0, 0], bulges: [{ top: 1 }, null] }).bulges, [{ ...STRAIGHT, top: 1 }, STRAIGHT]);
  assert.deepEqual(resolveView({ format: 'youtube', yaws: [0, 10], pitches: [0, 0], bulges: [{ top: 1 }] }).bulges, [STRAIGHT, STRAIGHT]);
});

// ---------------------------------------------------------------- plans and v360 sizes
test('a pan between two shapes is a cut at the edit time; the same shape pans', () => {
  const edl = [{ t: 0, camera: 1 }, { t: 3, camera: 2, panSpeed: 30 }];
  const kinds = (bulges) => planSegments(edl, [0, 30], [0, 0], 6, false, null, null, { bulges }).map((s) => s.type);
  assert.deepEqual(kinds([{ top: 0.5 }, { top: 0.5 }]), ['hold', 'pan', 'hold']);
  assert.deepEqual(kinds([{ top: 0.5 }, null]), ['hold', 'hold']);
  assert.deepEqual(kinds(null), ['hold', 'pan', 'hold']);
  const plan = planSegments(edl, [0, 30], [0, 0], 6, false, null, null, { bulges: [{ top: 0.5 }, null] });
  assert.deepEqual(plan[0].bulge, { top: 0.5, right: 0, bottom: 0, left: 0 });
  assert.ok(!('bulge' in plan[1]), 'a straight camera carries no shape');
});

test('a bowed view is drawn twice the size and wider by the reach, with the fov widened in each projection\'s own image plane', () => {
  const shape = { top: 1, left: 0.5 };
  const flat = projectionStage('flat', 192, 108, 100, shape);
  assert.equal(flat.w, 2 * 192 * 1.25);
  assert.equal(flat.h, 2 * 108 * 1.5);
  assert.match(flat.post, /remap=fill=black,scale=192:108:flags=area$/);
  const base = fieldOfView(192, 108, 100);
  const wide = projectedFieldOfView(192, 108, 100, 'flat', shape);
  const tan = (deg) => Math.tan((deg * Math.PI) / 360);
  assert.ok(Math.abs(tan(wide.hfov) / tan(base.hfov) - 1.25) < 1e-9);
  assert.ok(Math.abs(tan(wide.vfov) / tan(base.vfov) - 1.5) < 1e-9);
  const fish = projectedFieldOfView(192, 108, 160, 'fisheye', shape);
  assert.ok(Math.abs(fish.hfov - 200) < 1e-9);
  // Pannini keeps its square: the frame is warped out of it.
  const pan = projectionStage('pannini', 192, 108, 140, shape);
  assert.equal(pan.w, pan.h);
  assert.ok(!pan.post.includes('crop='));
  // Straight: exactly what it always was.
  assert.deepEqual(projectionStage('flat', 192, 108, 100, STRAIGHT), projectionStage('flat', 192, 108, 100));
  assert.deepEqual(projectedFieldOfView(192, 108, 100, 'flat', STRAIGHT), base);
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

function pixel(file, x, y) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
  return [...r.stdout];
}

// A smooth equirect whose colour is the direction: red/green/blue are its x (right), y (up) and z (ahead).
const W = 1024;
const H = 512;
const GEQ = `geq=r='127.5+127.5*cos((0.5-Y/${H})*PI)*sin((X/${W}-0.5)*2*PI)':g='127.5+127.5*sin((0.5-Y/${H})*PI)':b='127.5+127.5*cos((0.5-Y/${H})*PI)*cos((X/${W}-0.5)*2*PI)'`;

function makeSource(dir, seconds = 1) {
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

/** The colour the source has in the direction a straight-ahead flat camera sees at frame point (u, v). */
function flatColour(u, v, { hfov, vfov }) {
  const x = u * Math.tan((hfov * Math.PI) / 360);
  const y = v * Math.tan((vfov * Math.PI) / 360);
  const n = Math.hypot(x, y, 1);
  return [x / n, y / n, 1 / n].map((c) => 127.5 + 127.5 * c);
}

/** Pixel (column, row) of a width×height frame as frame coordinates u right, v up. */
const frameUV = (px, py, width, height) => [((2 * px + 1) / width) - 1, 1 - ((2 * py + 1) / height)];

const SHAPE = { top: 1, right: -1, bottom: 0.5, left: 0 };
// Inside the frame, away from the matrix label in the top-left corner.
const SPOTS = [[96, 2], [189, 54], [96, 105], [2, 54], [96, 54], [150, 20], [60, 90], [189, 2], [180, 100]];

function assertShows(file, width, height, view, label, shape = SHAPE) {
  for (const [px, py] of SPOTS) {
    const sx = Math.round((px * width) / 192);
    const sy = Math.round((py * height) / 108);
    const [u, v] = frameUV(sx, sy, width, height);
    const want = flatColour(...bulgeWarp(shape, u, v), view);
    const got = pixel(file, sx, sy);
    const off = Math.max(...got.map((c, k) => Math.abs(c - want[k])));
    assert.ok(off <= 10, `${label} at ${sx},${sy}: got ${got}, want ${want.map(Math.round)}`);
  }
}

test('a final hold shows the bowed frame: each output pixel is the direction bulgeWarp says, and a straight shape is the old picture', { timeout: 240000 }, async () => {
  await withTemp('d360-shape-hold-', async (tmp) => {
    const src = makeSource(tmp);
    const common = { format: 'youtube', yaws: [0], pitches: [0], width: 192, height: 108, log: () => {} };
    const bowed = path.join(tmp, 'bowed.mp4');
    const trace = [];
    await renderFromEdl(src, bowed, [{ t: 0, camera: 1 }], { ...common, bulges: [SHAPE], trace });
    assert.equal(frameCount(bowed), 30);
    assert.ok(trace.some((args) => args.some((a) => String(a).includes('remap=fill=black'))), 'the hold warps');
    const png = path.join(tmp, 'bowed.png');
    frameOf(bowed, png, 5);
    assertShows(png, 192, 108, fieldOfView(192, 108, 100), 'hold');
    // The straight frame is a different picture, and a straight shape renders exactly the old one.
    const old = path.join(tmp, 'old.mp4');
    const zero = path.join(tmp, 'zero.mp4');
    await renderFromEdl(src, old, [{ t: 0, camera: 1 }], common);
    await renderFromEdl(src, zero, [{ t: 0, camera: 1 }], { ...common, bulges: [STRAIGHT] });
    assert.equal(psnrOf(old, zero), Infinity);
    assert.ok(psnrOf(old, bowed) < 35);
  });
});

test('a final hold shows moved corners and shifted middles where bulgeWarp puts them', { timeout: 240000 }, async () => {
  await withTemp('d360-shape-points-', async (tmp) => {
    const src = makeSource(tmp);
    const shape = bulgeOf({
      top: 0.5, right: -0.3,
      corners: [[-0.2, 0.15], [0.1, 0.2], [0.25, -0.1], [-0.15, -0.2]],
      shift: { top: 0.3, right: -0.2, bottom: -0.25, left: 0.15 },
    });
    const out = path.join(tmp, 'points.mp4');
    await renderFromEdl(src, out, [{ t: 0, camera: 1 }], { format: 'youtube', yaws: [0], pitches: [0], width: 192, height: 108, bulges: [shape], log: () => {} });
    const png = path.join(tmp, 'points.png');
    frameOf(out, png, 5);
    assertShows(png, 192, 108, fieldOfView(192, 108, 100), 'points', shape);
  });
});

test('a pan between two cameras of the same shape pans (pitch and zoom sent per frame) and ends on the second camera', { timeout: 240000 }, async () => {
  await withTemp('d360-shape-pan-', async (tmp) => {
    const src = makeSource(tmp, 3);
    const base = { format: 'youtube', yaws: [0, 24], pitches: [0, 6], fovs: [100, 80], bulges: [SHAPE, SHAPE], width: 160, height: 90, log: () => {} };
    const out = path.join(tmp, 'pan.mp4');
    const trace = [];
    await renderFromEdl(src, out, [{ t: 0, camera: 1 }, { t: 2.5, camera: 2, panSpeed: 20 }], { ...base, trace });
    assert.equal(frameCount(out), 90);
    assert.ok(trace.some((args) => args.some((a) => String(a).includes('sendcmd='))), 'pitch pan used sendcmd');
    const hold = path.join(tmp, 'hold.mp4');
    await renderFromEdl(src, hold, [{ t: 0, camera: 2 }], base);
    const got = path.join(tmp, 'last.png');
    const want = path.join(tmp, 'want.png');
    frameOf(out, got, 89);
    frameOf(hold, want, 5);
    assert.ok(psnrOf(got, want) >= 28, `pan ends on camera 2: ${psnrOf(got, want)}`);
  });
});

test('previews render a bowed camera too, through the same warp', { timeout: 240000 }, async () => {
  await withTemp('d360-shape-preview-', async (tmp) => {
    const src = makeSource(tmp, 2);
    const out = path.join(tmp, 'preview.mp4');
    const trace = [];
    await renderFromEdl(src, out, [{ t: 0, camera: 1 }, { t: 1.5, camera: 2, panSpeed: 40 }], {
      format: 'youtube', yaws: [0, 20], pitches: [0, 0], bulges: [SHAPE, SHAPE], preview: true, log: () => {}, trace,
    });
    assert.equal(frameCount(out), 60);
    assert.ok(trace.filter((args) => args.some((a) => String(a).includes('remap=fill=black'))).length >= 2, 'the hold and the pan frames are warped');
  });
});
