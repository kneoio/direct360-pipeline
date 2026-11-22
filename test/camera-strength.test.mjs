import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bulgeOf, bulgeReach, fieldOfView, frameWarp, hasBulge, panniniSide, projectedFieldOfView, projectionStage, radial, radialInverse,
  sameBulge, strengthCurves, strengthOf, strengthWarp, STRENGTH_REACH_MAX,
} from '../src/formats.js';
import { fixedZoom, renderFromEdl, samePicture, transitionFovs } from '../src/edl.js';

// ---------------------------------------------------------------- strength maths
test('the curve family: tan for k > 0, sin for k < 0, the plain angle at 0; each inverse undoes it', () => {
  assert.equal(radial(0, 0.7), 0.7);
  assert.ok(Math.abs(radial(0.5, 1) - 2 * Math.tan(0.5)) < 1e-12);
  assert.ok(Math.abs(radial(-1, 1) - Math.sin(1)) < 1e-12);
  for (const k of [-1.06, -0.5, 0, 0.3, 0.5, 0.6]) for (const t of [0.1, 0.6, 1.2]) assert.ok(Math.abs(radialInverse(k, radial(k, t)) - t) < 1e-9);
});

test('strength 0 is each projection\'s standard curve, and the editor\'s numbers', () => {
  assert.deepEqual(strengthCurves('fisheye', 0), [-0, 0]);
  assert.deepEqual(strengthCurves('planet', 0, 260), [0.5, 0]);
  assert.deepEqual(strengthCurves('pannini', 0), [-1, 1]);
  // The same values the web editor's lens.js gives (test/lens-strength.test.mjs there).
  assert.deepEqual(strengthCurves('fisheye', 1, 160), [-0.9, 0]);
  assert.deepEqual(strengthCurves('fisheye', -1, 160), [0.85, 0]);
  assert.ok(Math.abs(strengthCurves('planet', 1, 260)[0] - ((0.98 * 90) / 130 - 0.06)) < 1e-12);
  assert.deepEqual(strengthCurves('planet', -1, 260), [-0.25, 0]);
  assert.ok(Math.abs(strengthCurves('pannini', 1)[1] + 0.6) < 1e-12);
});

test('strengthWarp: flat or strength 0 leaves the point; the frame\'s long edge stays; a stronger fisheye draws the middle larger', () => {
  assert.deepEqual(strengthWarp('flat', 192, 108, 100, 0.8, 0.3, 0.2), [0.3, 0.2]);
  assert.deepEqual(strengthWarp('fisheye', 192, 108, 160, 0, 0.3, 0.2), [0.3, 0.2]);
  for (const s of [-1, -0.4, 0.5, 1]) {
    const [u, v] = strengthWarp('fisheye', 192, 108, 160, s, 1, 0);
    assert.ok(Math.abs(u - 1) < 1e-9 && Math.abs(v) < 1e-12, `edge at ${s}: ${u}`);
  }
  // Stronger: a point halfway out sees a direction the standard picture has nearer the middle.
  assert.ok(strengthWarp('fisheye', 192, 108, 160, 1, 0.5, 0)[0] < 0.5);
  assert.ok(strengthWarp('fisheye', 192, 108, 160, -1, 0.5, 0)[0] > 0.5);
  // The shape comes first, then the strength.
  const shape = { top: 0.5, strength: 0.6 };
  assert.deepEqual(frameWarp('planet', 192, 108, 260, shape, 0, 0.5), strengthWarp('planet', 192, 108, 260, 0.6, 0, 0.5 * (1 + 0.5 * 0.5)));
});

test('the strength is part of the shape: kept when not 0, needs the warp, makes another picture, and holds its zoom', () => {
  assert.deepEqual(bulgeOf({ strength: 0.456 }), { top: 0, right: 0, bottom: 0, left: 0, strength: 0.46 });
  assert.deepEqual(bulgeOf({ strength: 0 }), { top: 0, right: 0, bottom: 0, left: 0 });
  assert.equal(bulgeOf({ strength: -4 }).strength, -1);
  assert.equal(strengthOf({ strength: 0.3 }), 0.3);
  assert.equal(hasBulge({ strength: 0.3 }), true);
  assert.equal(sameBulge({ strength: 0.3 }, null), false);
  const bent = { projection: 'fisheye', fov: 160, bulge: { strength: 0.5 } };
  assert.equal(fixedZoom(bent), true);
  assert.equal(fixedZoom({ projection: 'fisheye', fov: 160, bulge: null }), false);
  assert.equal(fixedZoom({ projection: 'flat', fov: 100, bulge: { strength: 0.5 } }), false);
  // A zoom change on a bent fisheye is not a plain pan; without the strength it is.
  assert.equal(samePicture(bent, { ...bent, fov: 140 }), false);
  assert.equal(samePicture({ ...bent, bulge: null }, { ...bent, fov: 140, bulge: null }), true);
  // In a transition a bent picture keeps its own zoom.
  assert.equal(transitionFovs(bent, { projection: 'flat', fov: 90, bulge: null }, 0.5).from, 160);
});

test('a strength widens what v360 draws as far as the frame reaches, never past STRENGTH_REACH_MAX', () => {
  const view = { projection: 'fisheye', width: 192, height: 108, fov: 160 };
  const loose = bulgeReach({ strength: -1 }, view);
  assert.ok(loose.x >= 1 && loose.y >= 1);
  const far = bulgeReach({ strength: -1 }, { projection: 'planet', width: 192, height: 108, fov: 300 });
  assert.ok(far.x <= STRENGTH_REACH_MAX && far.y <= STRENGTH_REACH_MAX);
  const stage = projectionStage('fisheye', 192, 108, 160, { strength: 0.5 });
  assert.match(stage.post, /remap=fill=black/);
  assert.match(stage.post, /st\(0,/);
  // Without a strength the stage is the plain one, as before.
  assert.deepEqual(projectionStage('fisheye', 192, 108, 160, { strength: 0 }), projectionStage('fisheye', 192, 108, 160));
  assert.deepEqual(projectedFieldOfView(192, 108, 160, 'fisheye', { strength: 0 }), projectedFieldOfView(192, 108, 160, 'fisheye'));
});

// ---------------------------------------------------------------- real renders
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
function pixel(file, x, y) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
  return [...r.stdout];
}

// A smooth equirect whose colour is the direction: red/green/blue are its x (right), y (up) and z (ahead).
const W = 1024;
const H = 512;
const GEQ = `geq=r='127.5+127.5*cos((0.5-Y/${H})*PI)*sin((X/${W}-0.5)*2*PI)':g='127.5+127.5*sin((0.5-Y/${H})*PI)':b='127.5+127.5*cos((0.5-Y/${H})*PI)*cos((X/${W}-0.5)*2*PI)'`;
function makeSource(dir) {
  const src = path.join(dir, 'src.mp4');
  ffmpeg(['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=30:d=1,format=gbrp,${GEQ},format=yuv420p`, '-c:v', 'libx264', '-crf', '8', '-pix_fmt', 'yuv420p', src]);
  return src;
}
async function withTemp(name, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  const previous = { preset: process.env.D360_RENDER_PRESET, crf: process.env.D360_RENDER_CRF };
  process.env.D360_RENDER_PRESET = 'ultrafast';
  process.env.D360_RENDER_CRF = '10';
  try {
    await run(dir);
  } finally {
    for (const [key, value] of [['D360_RENDER_PRESET', previous.preset], ['D360_RENDER_CRF', previous.crf]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The direction a straight-ahead camera of `projection` at `strength` sees at frame point (u, v), worked out as the
 * editor's lens.js does it (frameVector), independently of the render's warp.
 */
function editorDirection(projection, strength, width, height, fov, u, v) {
  const [k, kv] = strengthCurves(projection, strength, fov);
  if (projection === 'pannini') {
    const side = panniniSide(width, height, fov);
    const r = side / width;
    const rq = side / height;
    const lon = radialInverse(k, (Math.min(r, Math.max(-r, u)) / r) * radial(k, (84 * Math.PI) / 180));
    const lat = radialInverse(kv, Math.min(rq, Math.max(-rq, v)) / rq);
    return [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
  }
  const base = fieldOfView(width, height, 100);
  const s = base.vfov / base.hfov;
  const rho = Math.hypot(u, v * s);
  const phi = Math.atan2(v * s, u);
  const off = radialInverse(k, rho * radial(k, (fov * Math.PI) / 360));
  return [Math.sin(off) * Math.cos(phi), Math.sin(off) * Math.sin(phi), Math.cos(off)];
}

const SPOTS = [[96, 2], [189, 54], [96, 105], [2, 54], [96, 54], [150, 20], [60, 90], [189, 2], [180, 100], [130, 70]];

for (const [projection, fov, strength] of [['fisheye', 160, 0.8], ['fisheye', 160, -0.7], ['planet', 260, -0.6], ['planet', 260, 0.7], ['pannini', 140, -0.8], ['pannini', 140, 0.9]]) {
  test(`a final ${projection} hold at strength ${strength} shows each pixel where the editor's maths looks, and is not the standard picture`, { timeout: 240000 }, async () => {
    await withTemp('d360-strength-', async (tmp) => {
      const src = makeSource(tmp);
      const common = { format: 'youtube', yaws: [0], pitches: [0], projections: [projection], fovs: [fov], width: 192, height: 108, log: () => {} };
      const bent = path.join(tmp, 'bent.mp4');
      await renderFromEdl(src, bent, [{ t: 0, camera: 1 }], { ...common, bulges: [{ strength }] });
      const png = path.join(tmp, 'bent.png');
      frameOf(bent, png, 5);
      for (const [px, py] of SPOTS) {
        const u = ((2 * px + 1) / 192) - 1;
        const v = 1 - ((2 * py + 1) / 108);
        const want = editorDirection(projection, strength, 192, 108, fov, u, v).map((c) => 127.5 + 127.5 * c);
        const got = pixel(png, px, py);
        const off = Math.max(...got.map((c, n) => Math.abs(c - want[n])));
        assert.ok(off <= 12, `${projection} ${strength} at ${px},${py}: got ${got}, want ${want.map(Math.round)}`);
      }
      const standard = path.join(tmp, 'standard.mp4');
      await renderFromEdl(src, standard, [{ t: 0, camera: 1 }], common);
      // v360's pannini is already the most squeezed of its family, so stronger only squeezes top and bottom a little more.
      const psnr = psnrOf(standard, bent);
      assert.ok(psnr < (projection === 'pannini' && strength > 0 ? 60 : 40), `the strength changes the picture: ${psnr}`);
    });
  });
}
