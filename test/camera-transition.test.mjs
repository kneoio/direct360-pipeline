import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  MATCH_AT, PAN_KINDS, PLANET_FADE, TRANSITION_MIN, panProgress, panYawDelta, planSegments, renderFromEdl, sanitizeEdl,
  transitionKinds, transitionLayers, transitionWeight,
} from '../src/edl.js';
import { frameBase, frameVector, strengthOf } from '../src/formats.js';
import { TRANSITION_REACH, bendFrame, slerpDirection, transitionDirection, transitionPoint } from '../src/morph.js';
import { CAMERAS, FRAMES, PS, SAME_AIM, transitionCases } from './fixtures/transition-cases.mjs';

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

test('the new picture fades in along the pan for blend; planet fades only at its flat end, softly at both ends', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} vs ${b}`);
  assert.equal(transitionWeight('blend', 'flat', 0.3), 0.3);
  assert.equal(transitionWeight('planet', 'flat', 0), 0);
  near(transitionWeight('planet', 'flat', PLANET_FADE / 2), 0.5);
  near(transitionWeight('planet', 'flat', PLANET_FADE / 4), 0.15625); // smoothstep: x²(3 − 2x) at x ¼
  assert.equal(transitionWeight('planet', 'flat', PLANET_FADE), 1);
  assert.equal(transitionWeight('planet', 'flat', 0.9), 1);
  assert.equal(transitionWeight('planet', 'planet', 0.5), 0);
  near(transitionWeight('planet', 'planet', 1 - PLANET_FADE / 2), 0.5);
  near(transitionWeight('planet', 'planet', 1 - PLANET_FADE / 4), 0.84375);
  assert.equal(transitionWeight('planet', 'planet', 1), 1);
  // No corner where the fade starts or stops: its slope there is 0.
  const slope = (p) => (transitionWeight('planet', 'flat', p + 1e-6) - transitionWeight('planet', 'flat', p - 1e-6)) / 2e-6;
  assert.ok(Math.abs(slope(1e-6)) < 1e-3 && Math.abs(slope(PLANET_FADE - 1e-6)) < 1e-3);
});

test('the bend: a point slides along the sphere by the weight; a round picture holds short of straight behind', () => {
  const near = (a, b) => a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < 1e-12, `${a} vs ${b}`));
  near(slerpDirection([0, 0, 1], [1, 0, 0], 0), [0, 0, 1]);
  near(slerpDirection([0, 0, 1], [1, 0, 0], 1), [1, 0, 0]);
  near(slerpDirection([0, 0, 1], [1, 0, 0], 0.5), [Math.SQRT1_2, 0, Math.SQRT1_2]);
  const base = { hfov: 100, vfov: 56 };
  // A fisheye of 160 degrees zoomed 3 times reaches 240 degrees off its middle at the frame's side: held at TRANSITION_REACH.
  const [u] = transitionPoint({ projection: 'fisheye', fov: 160, zoom: [3, 3] }, 1, 0, base);
  assert.ok(Math.abs(u * 80 * (Math.PI / 180) - TRANSITION_REACH) < 1e-9);
  // Flat and a planet (a tan-like curve) are never held.
  assert.deepEqual(transitionPoint({ projection: 'flat', fov: 100, zoom: [5, 5] }, 1, 1, base), [5, 5]);
  assert.deepEqual(transitionPoint({ projection: 'planet', fov: 260, zoom: [5, 5] }, 1, 1, base), [5, 5]);
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

// ---------------------------------------------------------------- the web editor's transitions
/**
 * Camera transitions as the render draws them, measured as direct360-web's test/transitions.test.mjs measures its live
 * view: every pair of camera kinds (flat, fisheye, tiny planet, pannini, and the fisheye and planet bent by a strength),
 * each way, in a landscape and a portrait frame. The picture is one, bent from the first camera into the second
 * (morph.js transitionDirection, each camera at its frame zoom from transitionLayers), followed through the direction
 * it shows at 600 scattered points:
 * - it is still where a pan starts and ends (no jolt from or into a hold);
 * - it never jolts on the way: how fast the picture moves changes by at most 5% of its top speed per 1/400 of the move;
 * - nothing ever shows twice: it never folds back over itself, and never tears;
 * - a transition takes time even between two cameras aimed the same way.
 */
const NAMES = Object.keys(CAMERAS);
const RAD = Math.PI / 180;
const camerasOf = (cams) => ({
  yaws: cams.map((c) => c[2]),
  pitches: cams.map((c) => c[3]),
  fovs: cams.map((c) => c[1]),
  projections: cams.map((c) => c[0]),
  bulges: cams.map((c) => c[4]),
});
const RIG = camerasOf(NAMES.map((n) => CAMERAS[n]));
const pictureOf = (rig, camera) => ({ projection: rig.projections[camera - 1], fov: rig.fovs[camera - 1], bulge: rig.bulges[camera - 1] });

/** The pan segment of a move from camera `a` to `b` (1-based) as `kind`, planned as the render plans it. */
function panOf(rig, a, b, kind) {
  const edl = [{ t: 0, camera: a }, { t: 30, camera: b, panSpeed: 30, ...(kind === 'pan' ? {} : { panKind: kind }) }];
  return planSegments(edl, rig.yaws, rig.pitches, 60, false, null, rig.fovs, { projections: rig.projections, bulges: rig.bulges }).find((s) => s.type === 'pan');
}

/** The render's side of transition-cases.mjs: the same shape as the web editor's, from src/edl.js. */
const pipelineLens = { transitionLayers };
const pipelinePlan = {
  transitionKinds,
  transitionWeight,
  pictureOf: (cfg, camera) => pictureOf(cfg, camera),
  cutMotion: (edl, cfg) => {
    const seg = planSegments(edl, cfg.yaws, cfg.pitches, 60, false, null, cfg.fovs, { projections: cfg.projections, bulges: cfg.bulges }).find((s) => s.type === 'pan');
    return seg ? [{ type: 'pan', start: seg.start, end: seg.start + seg.dur }] : [];
  },
};

// web lens.js orient and rolled: a camera-frame direction turned to the camera's aim.
function orient(yaw, pitch, x, y, z) {
  const cp = Math.cos(pitch * RAD), sp = Math.sin(pitch * RAD);
  const cy = Math.cos(yaw * RAD), sy = Math.sin(yaw * RAD);
  const y2 = y * cp + z * sp;
  const z2 = -y * sp + z * cp;
  const x3 = x * cy + z2 * sy;
  const z3 = -x * sy + z2 * cy;
  const len = Math.hypot(x3, y2, z3);
  return [x3 / len, y2 / len, z3 / len];
}
function direction(pic, u, v, frame) {
  const z = pic.zoom ?? [1, 1];
  const [x, y, d] = frameVector(pic.projection, u * z[0], v * z[1], frame, pic.fov, strengthOf(pic.bulge));
  const a = -(pic.roll ?? 0) * RAD;
  return orient(pic.yaw, pic.pitch, x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), d);
}

const POINTS = 600;
const GRID = Array.from({ length: POINTS }, (_, i) => [((0.5 + i * 0.7548776662466927) % 1) * 2 - 1, ((0.5 + i * 0.5698402909980532) % 1) * 2 - 1]);
const STEPS = 400;
const angleOf = (a, b) => (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dotOf = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const E = 0.01;

/**
 * The move from `a` to `b` as `kind`, measured at STEPS + 1 even moments (the web test's measure): how fast the bent
 * picture moves, whether it ever folds back over itself (a mirror image beside the true one: a double image) and how
 * much it tears (the most degrees between two points E apart, over the most in either camera's own picture).
 */
function measure(rig, a, b, kind, frame) {
  const seg = panOf(rig, a, b, kind);
  if (!seg) return null;
  const from = pictureOf(rig, a);
  const to = pictureOf(rig, b);
  const len = seg.dur;
  const motion = [];
  let folds = 0;
  let tear = 0;
  let own = 0;
  let prev = null;
  for (let i = 0; i <= STEPS; i++) {
    const p = panProgress(seg.panCurve, Math.min(len - 1e-7, i * (len / STEPS)) / len);
    const aim = {
      yaw: seg.fromYaw + panYawDelta(seg.fromYaw, seg.toYaw, seg.panDirection) * p,
      pitch: seg.fromPitch + (seg.toPitch - seg.fromPitch) * p,
      roll: 0,
    };
    const blend = Boolean(seg.blend);
    const layers = blend ? transitionLayers({ ...from, mix: { ...to, p } }, frame) : null;
    const weight = blend ? transitionWeight(seg.blend, seg.projection, p) : 0;
    const at = (u, v) => (blend ? transitionDirection(layers, weight, u, v, frame, aim) : direction({ ...from, ...aim }, u, v, frame));
    const dirs = GRID.map(([u, v]) => at(u, v));
    if (prev) {
      let m = 0;
      for (let k = 0; k < GRID.length; k++) m += angleOf(prev[k], dirs[k]);
      motion.push(m / GRID.length / (len / STEPS));
    }
    if (i % 8 === 0 || i === STEPS) {
      let steep = 0;
      for (let k = 0; k < GRID.length; k += 3) {
        const [u, v] = GRID[k];
        const d = dirs[k];
        const across = at(u + E, v);
        const up = at(u, v + E);
        if (dotOf(cross(sub(across, d), sub(up, d)), d) <= 0) folds++;
        steep = Math.max(steep, angleOf(d, across) / E, angleOf(d, up) / E);
      }
      if (i === 0) own = steep;
      else if (i === STEPS) own = Math.max(own, steep);
      else tear = Math.max(tear, steep);
    }
    prev = dirs;
  }
  const peak = Math.max(...motion);
  let jolt = 0;
  for (let i = 1; i < motion.length; i++) jolt = Math.max(jolt, Math.abs(motion[i] - motion[i - 1]) / peak);
  const ends = Math.max(...motion.slice(0, 2), ...motion.slice(-2)) / peak;
  return { len, ends, jolt, folds, tear: tear / own };
}

const MOVES = [];
for (let a = 1; a <= NAMES.length; a++) {
  for (let b = 1; b <= NAMES.length; b++) {
    if (a === b) continue;
    for (const kind of transitionKinds(pictureOf(RIG, a), pictureOf(RIG, b))) MOVES.push({ a, b, kind, label: `${NAMES[a - 1]} → ${NAMES[b - 1]} (${kind})` });
  }
}
const measured = new Map();
function everyMove(check) {
  const bad = [];
  for (const [frameName, frame] of Object.entries(FRAMES)) {
    for (const move of MOVES) {
      const key = `${move.label}|${frameName}`;
      if (!measured.has(key)) measured.set(key, measure(RIG, move.a, move.b, move.kind, frame));
      const m = measured.get(key);
      const why = m ? check(m, move.label) : 'no move at all';
      if (why) bad.push(`${move.label}, ${frameName}: ${why}`);
    }
  }
  assert.deepEqual(bad, []);
}

test('every pair of camera kinds can move into each other, each way', () => {
  assert.equal(MOVES.length, 34);
});

test('a transition eases in and out: the picture is still where it leaves one camera and reaches the next', () => {
  everyMove((m) => (m.ends > 0.06 ? `moves at ${(m.ends * 100).toFixed(0)}% of its top speed at an end` : null));
});

test('a transition never jolts: how fast the picture moves changes smoothly all the way', () => {
  everyMove((m) => (m.jolt > 0.05 ? `its speed jumps by ${(m.jolt * 100).toFixed(0)}% of its top speed in 1/${STEPS} of the move` : null));
});

test('nothing ever shows twice: the bent picture never folds back over itself, and never tears', () => {
  // On the way the picture stretches up to about twice what either camera's own picture does at its steepest (a
  // pannini zoomed against the edge of its square, a bent picture near the last angle of its curve), never several
  // times as much (a seam).
  everyMove((m) => (m.folds ? `the picture folds over itself at ${m.folds} points` : m.tear > 3 ? `it tears (${m.tear.toFixed(1)} times either camera's steepest)` : null));
});

test('a transition takes time even between two cameras aimed the same way at the same zoom', () => {
  assert.equal(TRANSITION_MIN, 45);
  const bad = [];
  for (const [pa, pb] of SAME_AIM) {
    const rig = camerasOf([[pa, 150, 30, 0, {}], [pb, 150, 30, 0, {}]]);
    for (const kind of transitionKinds(pictureOf(rig, 1), pictureOf(rig, 2))) {
      const m = measure(rig, 1, 2, kind, FRAMES.landscape);
      if (!m || m.len < 0.5) bad.push(`${pa} → ${pb} (${kind}): ${m ? `${m.len.toFixed(2)}s` : 'an instant cut'}`);
    }
  }
  assert.deepEqual(bad, []);
  // The same picture is still a plain pan of its own length.
  const same = planSegments([{ t: 0, camera: 1 }, { t: 3, camera: 2, panSpeed: 60 }], [0, 30], [0, 0], 6);
  assert.ok(Math.abs(same.find((s) => s.type === 'pan').dur - 0.5) < 1e-9);
});

test('each picture of a transition is its own camera at the ends: zoom 1 for the first at p 0 and the second at p 1', () => {
  const base = FRAMES.landscape;
  for (const a of NAMES) {
    for (const b of NAMES) {
      if (a === b) continue;
      const from = pictureOf(RIG, NAMES.indexOf(a) + 1);
      const to = pictureOf(RIG, NAMES.indexOf(b) + 1);
      assert.deepEqual(transitionLayers({ ...from, mix: { ...to, p: 0 } }, base)[0].zoom, [1, 1]);
      assert.deepEqual(transitionLayers({ ...from, mix: { ...to, p: 1 } }, base)[1].zoom, [1, 1]);
      // In between both show the same angle MATCH_AT out, across and up.
      const layers = transitionLayers({ ...from, mix: { ...to, p: 0.4 } }, base);
      for (const [u, v] of [[MATCH_AT, 0], [0, MATCH_AT]]) {
        const [d0, d1] = layers.map((l) => frameVector(l.projection, u * l.zoom[0], v * l.zoom[1], base, l.fov, strengthOf(l.bulge)));
        assert.ok(Math.abs(Math.acos(d0[2]) - Math.acos(d1[2])) < 1e-9, `${a} → ${b}`);
      }
    }
  }
});

// ---------------------------------------------------------------- parity with the web editor
/** direct360-web's live view for these moves: test/fixtures/web-transitions.json (make-web-transitions.mjs). */
const WEB = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/web-transitions.json'), 'utf8'));

function assertParity(web, ours) {
  const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)), `${what}: web ${a}, render ${b}`);
  assert.equal(ours.moves.length, web.moves.length);
  web.moves.forEach((w, i) => {
    const o = ours.moves[i];
    const what = `${w.from} → ${w.to} (${w.kind})`;
    assert.deepEqual([o.from, o.to, o.kind], [w.from, w.to, w.kind]);
    near(w.len, o.len, `${what} length`);
    w.weights.forEach((x, k) => near(x, o.weights[k], `${what} weight at p ${PS[k]}`));
    for (const frame of Object.keys(FRAMES)) {
      w.frames[frame].forEach((layers, k) => layers.forEach((zoom, side) => zoom.forEach((z, axis) => near(z, o.frames[frame][k][side][axis], `${what} ${frame} zoom at p ${PS[k]}`))));
    }
  });
  assert.deepEqual(ours.same.map((s) => [s.from, s.to, s.kind]), web.same.map((s) => [s.from, s.to, s.kind]));
  web.same.forEach((w, i) => near(w.len, ours.same[i].len, `${w.from} → ${w.to} aimed the same way, length`));
}

test('the render draws each transition as the web editor does: the same frame zooms, weights and lengths', () => {
  assertParity(WEB, transitionCases(pipelineLens, pipelinePlan));
});

test('… and against a direct360-web checkout beside this one, when there is one', async (t) => {
  const webDir = process.env.D360_WEB_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../direct360-web');
  if (!fs.existsSync(path.join(webDir, 'src/editor/lens.js'))) return t.skip('no direct360-web checkout');
  const lens = await import(pathToFileURL(path.join(webDir, 'src/editor/lens.js')));
  const plan = await import(pathToFileURL(path.join(webDir, 'src/editor/plan.js')));
  if (!lens.transitionLayers) return t.skip('that direct360-web predates transitionLayers');
  assertParity(transitionCases(lens, plan), transitionCases(pipelineLens, pipelinePlan));
});


test('… and bends each point of the frame to the same direction as that web editor\'s live view', async (t) => {
  const webDir = process.env.D360_WEB_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../direct360-web');
  if (!fs.existsSync(path.join(webDir, 'src/editor/lens.js'))) return t.skip('no direct360-web checkout');
  const lens = await import(pathToFileURL(path.join(webDir, 'src/editor/lens.js')));
  if (!lens.transitionDirection) return t.skip('that direct360-web predates transitionDirection');
  let worst = 0;
  for (const move of MOVES) {
    const from = pictureOf(RIG, move.a);
    const to = pictureOf(RIG, move.b);
    for (const frame of Object.values(FRAMES)) {
      for (const p of [0.2, 0.5, 0.8]) {
        const aim = { yaw: 25, pitch: -30, roll: 10 };
        const weight = transitionWeight(move.kind, from.projection, p);
        const ours = transitionLayers({ ...from, mix: { ...to, p } }, frame);
        const web = lens.transitionLayers({ ...from, ...aim, mix: { ...to, ...aim, p } }, frame);
        for (const [u, v] of GRID.slice(0, 60)) {
          worst = Math.max(worst, angleOf(transitionDirection(ours, weight, u, v, frame, aim), lens.transitionDirection(web, weight, u, v, frame)));
        }
      }
    }
  }
  assert.ok(worst < 1e-4, `up to ${worst} degrees apart`);
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
      assert.ok(trace.some((args) => args.includes('rawvideo') && args.includes('pipe:1')), 'the transition is drawn from the decoded frames');
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

test('a transition frame is drawn as v360 draws each camera: at either end it is that camera\'s own picture', { timeout: 300000 }, async () => {
  await withTemp('d360-bend-', async (tmp) => {
    const src = makeCheckerSource(tmp, 1);
    const equirect = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', src, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 }).stdout;
    const [w, h] = [320, 180];
    const base = frameBase(w, h);
    for (const [projection, fov, yaw, pitch, roll] of [['flat', 90, -50, -20, 15], ['fisheye', 160, 60, 0, 0], ['planet', 260, 120, -90, 0], ['pannini', 140, -160, 5, 0]]) {
      const hold = path.join(tmp, `${projection}.mp4`);
      await renderFromEdl(src, hold, [{ t: 0, camera: 1 }], { format: 'youtube', yaws: [yaw], pitches: [pitch], rolls: [roll], fovs: [fov], projections: [projection], width: w, height: h, log: () => {} });
      const want = framesOf(hold, w, h)[0];
      const pic = { projection, fov, bulge: null, zoom: [1, 1] };
      const other = { projection: projection === 'flat' ? 'planet' : 'flat', fov: 100, bulge: null, zoom: [1, 1] };
      for (const [layers, weight] of [[[pic, other], 0], [[other, pic], 1]]) {
        const got = bendFrame(equirect, W, H, Buffer.alloc(w * h * 3), w, h, layers, weight, { yaw, pitch, roll }, base);
        let se = 0;
        for (let i = 0; i < got.length; i++) se += (got[i] - want[i]) ** 2;
        const psnr = 10 * Math.log10((255 * 255) / (se / got.length));
        assert.ok(psnr >= 28, `${projection} at weight ${weight}: PSNR ${psnr.toFixed(1)}`);
      }
    }
  });
});

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

// ---------------------------------------------------------------- what a transition chunk looks like
/** Every frame of `video` as rgb24 at w×h. */
function framesOf(video, w, h) {
  const out = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', video, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 });
  if (out.status !== 0) throw new Error(String(out.stderr));
  const size = w * h * 3;
  return Array.from({ length: out.stdout.length / size }, (_, n) => out.stdout.subarray(n * size, (n + 1) * size));
}

/**
 * How a frame's edges hold up: `black`, the share of its pixels that are near black (the test picture has none);
 * `smear`, the least detail across any band along an edge (8% of the frame) over the detail across the whole frame,
 * where a picture zoomed out past its edge and smeared shows as a band of repeated pixels with no detail across it.
 */
function edgeCheck(frame, w, h) {
  const at = (x, y, c) => frame[(y * w + x) * 3 + c];
  let black = 0;
  for (let i = 0; i < w * h; i++) if (Math.max(frame[i * 3], frame[i * 3 + 1], frame[i * 3 + 2]) < 24) black++;
  // Detail across: differences between neighbours along x (for the left and right bands) or y (top and bottom).
  const detail = (x0, x1, y0, y1, dx, dy) => {
    let sum = 0;
    let n = 0;
    for (let y = y0; y < y1 - dy; y++) {
      for (let x = x0; x < x1 - dx; x++) {
        for (let c = 0; c < 3; c++) sum += Math.abs(at(x + dx, y + dy, c) - at(x, y, c));
        n++;
      }
    }
    return sum / Math.max(1, n);
  };
  const bw = Math.round(w * 0.08);
  const bh = Math.round(h * 0.08);
  const across = detail(0, w, 0, h, 1, 0);
  const up = detail(0, w, 0, h, 0, 1);
  const smear = Math.min(
    detail(0, bw, 0, h, 1, 0) / across,
    detail(w - bw, w, 0, h, 1, 0) / across,
    detail(0, w, 0, bh, 0, 1) / up,
    detail(0, w, h - bh, h, 0, 1) / up,
  );
  return { black: black / (w * h), smear };
}

/** A test picture with detail everywhere, across and up: the colour ball under a fine checker, no black anywhere. */
function makeCheckerSource(dir, seconds) {
  const src = path.join(dir, 'checker.mp4');
  const shade = (c) => `${c}(X,Y)*(0.7+0.3*mod(floor(X/6)+floor(Y/6),2))`;
  ffmpeg(['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=30:d=${seconds},format=gbrp,${GEQ},geq=r='${shade('r')}':g='${shade('g')}':b='${shade('b')}',format=yuv420p`, '-c:v', 'libx264', '-crf', '8', '-pix_fmt', 'yuv420p', src]);
  return src;
}

for (const [label, projections, fovs, pitches] of [
  ['flat → planet', ['flat', 'planet'], [100, 260], [0, -90]],
  ['pannini → planet', ['pannini', 'planet'], [140, 260], [0, -90]],
  ['flat → pannini', ['flat', 'pannini'], [100, 140], [0, 0]],
]) {
  test(`a ${label} blend chunk has no smeared edge band and no black areas`, { timeout: 300000 }, async () => {
    await withTemp('d360-transition-edges-', async (tmp) => {
      const src = makeCheckerSource(tmp, 2);
      const [w, h] = [320, 180];
      const out = path.join(tmp, 'move.mp4');
      // One chunk, all of it the transition.
      process.env.D360_CHUNK_MIN_SEC = '10';
      await renderFromEdl(src, out, [{ t: 0, camera: 1 }, { t: 1.8, camera: 2, panSpeed: 25, panKind: 'blend' }], {
        format: 'youtube', yaws: [0, 40], pitches, fovs, projections, width: w, height: h, log: () => {},
      });
      const frames = framesOf(out, w, h);
      assert.equal(frames.length, 60);
      const bad = [];
      frames.forEach((frame, n) => {
        const { black, smear } = edgeCheck(frame, w, h);
        if (black > 0.001) bad.push(`frame ${n}: ${(black * 100).toFixed(1)}% black`);
        if (smear < 0.3) bad.push(`frame ${n}: an edge band with ${(smear * 100).toFixed(0)}% of the frame's detail`);
      });
      assert.deepEqual(bad, []);
      // The check sees a smear: the middle frame with its left 10% smeared from the column next to it.
      const smeared = path.join(tmp, 'smeared.mp4');
      ffmpeg(['-i', out, '-vf', `select=eq(n\\,30),fillborders=left=${Math.round(w * 0.1)}:mode=smear`, '-frames:v', '1', '-c:v', 'libx264', '-crf', '8', smeared]);
      assert.ok(edgeCheck(framesOf(smeared, w, h)[0], w, h).smear < 0.3, 'a smeared band is caught');
    });
  });
}
