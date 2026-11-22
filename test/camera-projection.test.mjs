import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FOV_RANGES, PROJECTIONS, clampFov, fieldOfView, panniniSide, projectedFieldOfView, projectionOf, projectionStage,
} from '../src/formats.js';
import { layoutFovs, layoutProjections, sanitizeLayouts } from '../src/matrix.js';
import { panFieldOfView, planChunks, planSegments, renderFromEdl, resolveView } from '../src/edl.js';

const youtubeLayout = (extra = {}) => ({
  yaws: Array.from({ length: 18 }, (_, i) => i * 10),
  pitches: Array.from({ length: 18 }, () => 0),
  removed: [],
  ...extra,
});

// ---------------------------------------------------------------- layouts and ranges
test('projections: flat is the default, unknown names are flat, and an all-flat array is dropped', () => {
  assert.deepEqual(PROJECTIONS, ['flat', 'fisheye', 'planet', 'pannini']);
  assert.equal(projectionOf(undefined), 'flat');
  assert.equal(projectionOf('cubemap'), 'flat');
  const old = sanitizeLayouts({ youtube: youtubeLayout() }).youtube;
  const flat = sanitizeLayouts({ youtube: youtubeLayout({ projections: Array(18).fill('flat') }) }).youtube;
  const unknown = sanitizeLayouts({ youtube: youtubeLayout({ projections: Array(18).fill('cubemap') }) }).youtube;
  assert.deepEqual(flat, old);
  assert.deepEqual(unknown, old);
  assert.ok(!('projections' in old));
  assert.deepEqual(layoutProjections(old, 18), Array(18).fill('flat'));
  assert.throws(() => sanitizeLayouts({ youtube: youtubeLayout({ projections: ['fisheye'] }) }), (e) => e.status === 400);
});

test('each camera keeps its fov inside the range of its own projection, and a projection default is dropped like 100° is', () => {
  const projections = ['flat', 'fisheye', 'planet', 'pannini', ...Array(14).fill('flat')];
  const fovs = Array(18).fill(100);
  fovs[0] = 500;
  fovs[1] = 100;
  fovs[2] = 100;
  fovs[3] = 400;
  const got = sanitizeLayouts({ youtube: youtubeLayout({ projections, fovs }) }).youtube;
  assert.deepEqual(got.projections.slice(0, 4), ['flat', 'fisheye', 'planet', 'pannini']);
  assert.deepEqual(got.fovs.slice(0, 4), [150, 100, 100, 170]);
  const defaults = ['flat', 'fisheye', 'planet', 'pannini'].map((p) => FOV_RANGES[p].default);
  assert.deepEqual(defaults, [100, 160, 260, 140]);
  const same = sanitizeLayouts({
    youtube: youtubeLayout({ projections, fovs: [...defaults, ...Array(14).fill(100)] }),
  }).youtube;
  assert.ok(!('fovs' in same), 'fovs at their projections\' defaults are the same layout as none');
  assert.deepEqual(layoutFovs(same, 18).slice(0, 4), defaults);
  for (const [name, [min, max]] of [['flat', [30, 150]], ['fisheye', [60, 280]], ['planet', [60, 340]], ['pannini', [120, 170]]]) {
    assert.deepEqual([clampFov(name, 0), clampFov(name, 999)], [min, max], name);
  }
});

test('projected field of view: flat as today, fisheye by angle, planet by tan(fov / 4)', () => {
  assert.deepEqual(projectedFieldOfView(1280, 720, 100), fieldOfView(1280, 720, 100));
  assert.deepEqual(projectedFieldOfView(1280, 720, 100, 'flat'), fieldOfView(1280, 720, 100));
  assert.deepEqual(projectedFieldOfView(1280, 720, 160, 'fisheye'), { hfov: 160, vfov: 90 });
  assert.deepEqual(projectedFieldOfView(720, 1280, 160, 'fisheye'), { hfov: 90, vfov: 160 });
  const planet = projectedFieldOfView(1280, 720, 260, 'planet');
  assert.equal(planet.hfov, 260);
  assert.ok(Math.abs(Math.tan((planet.vfov * Math.PI) / 720) - (720 / 1280) * Math.tan((260 * Math.PI) / 720)) < 0.01);
  assert.equal(projectedFieldOfView(720, 1280, 260, 'planet').vfov, 260);
  // A pan between two fovs of one projection moves along the same maths.
  assert.deepEqual(panFieldOfView(1280, 720, 100, 100, 0.5), fieldOfView(1280, 720, 100));
  assert.equal(panFieldOfView(1280, 720, 200, 300, 1, 'planet').hfov, 300);
  // Pannini zooms by cropping a larger square; a wider fov is a smaller square.
  assert.equal(projectionStage('flat', 192, 108, 100).crop, '');
  assert.ok(panniniSide(1920, 1080, 120) > panniniSide(1920, 1080, 170));
  // Across the long side: a tall 9:16 frame zooms too (it used to be held at its height whatever the fov).
  assert.ok(panniniSide(1080, 1920, 120) > panniniSide(1080, 1920, 170));
  assert.ok(panniniSide(1080, 1920, 170) >= 1920);
  assert.equal(panniniSide(1080, 1920, 140), panniniSide(1920, 1080, 140), 'the same zoom on the long side either way round');
  assert.equal(projectionStage('pannini', 192, 108, 140).crop, 'crop=192:108');
});

// ---------------------------------------------------------------- plans
test('a pan between cameras of different projections is a cut at the edit time; the same projection pans', () => {
  const edl = [{ t: 0, camera: 1 }, { t: 3, camera: 2, panSpeed: 30 }];
  const yaws = [0, 30];
  const pitches = [0, 0];
  const kinds = (projections, fovs = null) => planSegments(edl, yaws, pitches, 6, false, null, fovs, { projections }).map((s) => s.type);
  assert.deepEqual(kinds(['fisheye', 'fisheye']), ['hold', 'pan', 'hold']);
  assert.deepEqual(kinds(['flat', 'fisheye']), ['hold', 'hold']);
  assert.deepEqual(kinds(['planet', 'flat']), ['hold', 'hold']);
  const cut = planSegments(edl, yaws, pitches, 6, false, null, null, { projections: ['flat', 'fisheye'] });
  assert.deepEqual(cut.map((s) => [s.start, s.dur, s.projection]), [[0, 3, 'flat'], [3, 3, 'fisheye']]);
  // Pannini has no runtime zoom: two pannini cameras at different fov cut, at the same fov they pan.
  assert.deepEqual(kinds(['pannini', 'pannini'], [140, 160]), ['hold', 'hold']);
  assert.deepEqual(kinds(['pannini', 'pannini'], [140, 140]), ['hold', 'pan', 'hold']);
  // No projections: exactly the plan it always was.
  assert.deepEqual(planSegments(edl, yaws, pitches, 6, false, null, null).map((s) => s.type), ['hold', 'pan', 'hold']);
  const chunks = planChunks(cut, { totalFrames: 180, fps: 30, chunkSeconds: 1 });
  assert.deepEqual([...new Set(chunks.map((c) => c.projection))], ['flat', 'fisheye']);
});

test('resolveView fills projections and the default fov of each projection', () => {
  const view = resolveView({ format: 'youtube', yaws: [0, 10, 20], pitches: [0, 0, 0], projections: ['flat', 'fisheye', 'pannini'] });
  assert.deepEqual(view.projections, ['flat', 'fisheye', 'pannini']);
  assert.deepEqual(view.fovs, [100, 160, 140]);
  const plain = resolveView({ format: 'youtube', yaws: [0, 10, 20], pitches: [0, 0, 0] });
  assert.deepEqual(plain.projections, ['flat', 'flat', 'flat']);
  assert.deepEqual(plain.fovs, [100, 100, 100]);
});

// ---------------------------------------------------------------- ffmpeg
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

// The same smooth equirect the roll/fov tests use: red/green/blue are the x/y/z of the direction.
const W = 1024;
const H = 512;
const GEQ = `geq=r='127.5+127.5*cos((0.5-Y/${H})*PI)*sin((X/${W}-0.5)*2*PI)':g='127.5+127.5*sin((0.5-Y/${H})*PI)':b='127.5+127.5*cos((0.5-Y/${H})*PI)*cos((X/${W}-0.5)*2*PI)'`;

function makeSource(dir, seconds = 2) {
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

const filterOf = (trace) => trace.map((args) => args[args.indexOf('-vf') + 1]).find((f) => typeof f === 'string' && f.includes('v360='));

test('the hold filter carries the output of each projection; flat is the string it always was', { timeout: 240000 }, async () => {
  await withTemp('d360-proj-filter-', async (tmp) => {
    const src = makeSource(tmp, 1);
    const common = { format: 'youtube', yaws: [20], pitches: [5], width: 192, height: 108, log: () => {} };
    const filters = {};
    for (const [projection, fov] of [['flat', 100], ['fisheye', 160], ['planet', 260], ['pannini', 140]]) {
      const trace = [];
      await renderFromEdl(src, path.join(tmp, `${projection}.mp4`), [{ t: 0, camera: 1 }], {
        ...common, projections: [projection], fovs: [fov], trace,
      });
      filters[projection] = filterOf(trace);
    }
    assert.equal(filters.flat, 'v360=input=e:output=flat:yaw=20.000:pitch=5.000:roll=0:h_fov=100:v_fov=56:w=192:h=108,setpts=PTS-STARTPTS');
    assert.match(filters.fisheye, /^v360=input=e:output=fisheye:yaw=20\.000:pitch=5\.000:roll=0:h_fov=160:v_fov=90:w=192:h=108,/);
    assert.match(filters.planet, /^v360=input=e:output=sg:yaw=20\.000:pitch=5\.000:roll=0:h_fov=260:v_fov=\d+:w=192:h=108,/);
    const side = panniniSide(192, 108, 140);
    assert.ok(filters.pannini.startsWith(`v360=input=e:output=pannini:yaw=20.000:pitch=5.000:roll=0:h_fov=150:v_fov=84:w=${side}:h=${side},crop=192:108`), filters.pannini);

    // A layout with no projections, or all flat, renders exactly as before.
    const old = path.join(tmp, 'old.mp4');
    const spelled = path.join(tmp, 'spelled.mp4');
    const edl = [{ t: 0, camera: 1 }, { t: 0.6, camera: 2, panSpeed: 60 }];
    const two = { format: 'youtube', yaws: [0, 30], pitches: [0, 6], width: 160, height: 90, log: () => {} };
    await renderFromEdl(src, old, edl, two);
    await renderFromEdl(src, spelled, edl, { ...two, projections: ['flat', 'flat'] });
    assert.equal(psnrOf(old, spelled), Infinity);
  });
});

test('one real frame of each projection looks right: the aim is where it should be, and the view is not the flat one', { timeout: 240000 }, async () => {
  await withTemp('d360-proj-frame-', async (tmp) => {
    const src = makeSource(tmp, 1);
    const frames = {};
    for (const [projection, fov, pitch] of [['flat', 100, 0], ['fisheye', 160, 0], ['planet', 260, -90], ['pannini', 140, 0]]) {
      const out = path.join(tmp, `${projection}.mp4`);
      await renderFromEdl(src, out, [{ t: 0, camera: 1 }], {
        format: 'youtube', yaws: [0], pitches: [pitch], projections: [projection], fovs: [fov], width: 192, height: 108, log: () => {},
      });
      assert.equal(frameCount(out), 30, projection);
      frames[projection] = path.join(tmp, `${projection}.png`);
      frameOf(out, frames[projection], 5);
    }
    // The aim: straight ahead is (r, g, b) = (127, 127, 255) on this source; straight down is (127, 0, 127).
    for (const projection of ['flat', 'fisheye', 'pannini']) {
      const [r, g, b] = pixel(frames[projection], 96, 54);
      assert.ok(Math.abs(r - 127) < 30 && Math.abs(g - 127) < 30 && b > 225, `${projection} centre ${[r, g, b]}`);
    }
    const [r, g, b] = pixel(frames.planet, 96, 54);
    assert.ok(Math.abs(r - 127) < 30 && g < 30 && Math.abs(b - 127) < 30, `planet centre ${[r, g, b]}`);
    // Tiny planet at pitch -90 shows the whole sky around the nadir: the rim of the frame is not the nadir colour.
    const [er, eg] = pixel(frames.planet, 96, 2);
    assert.ok(eg > 60, `planet rim ${[er, eg]}`);
    // Each projection draws its own picture of the same sky.
    assert.ok(psnrOf(frames.flat, frames.fisheye) < 30);
    assert.ok(psnrOf(frames.flat, frames.pannini) < 30);
  });
});

test('pannini zoom works by cropping: a narrower fov is a closer view of the middle', { timeout: 240000 }, async () => {
  await withTemp('d360-proj-pannini-', async (tmp) => {
    const src = makeSource(tmp, 1);
    const shot = async (fov) => {
      const out = path.join(tmp, `p${fov}.mp4`);
      await renderFromEdl(src, out, [{ t: 0, camera: 1 }], { format: 'youtube', yaws: [0], pitches: [0], projections: ['pannini'], fovs: [fov], width: 192, height: 108, log: () => {} });
      const png = path.join(tmp, `p${fov}.png`);
      frameOf(out, png, 3);
      return png;
    };
    const wide = await shot(170);
    const close = await shot(120);
    assert.ok(psnrOf(wide, close) < 32, 'fov 170 and 120 are different pictures');
    // The right-hand edge: wider fov reaches further round, so its blue (z) falls off further.
    const [, , blueWide] = pixel(wide, 190, 54);
    const [, , blueClose] = pixel(close, 190, 54);
    assert.ok(blueWide < blueClose, `edge blue ${blueWide} vs ${blueClose}`);
  });
});

test('pans: same projection pans smoothly (fov moves too), different projections cut at the edit time', { timeout: 240000 }, async () => {
  await withTemp('d360-proj-pan-', async (tmp) => {
    const src = makeSource(tmp, 3);
    const base = { format: 'youtube', yaws: [0, 24], pitches: [0, 6], width: 160, height: 90, log: () => {} };
    for (const [projection, fovs] of [['fisheye', [140, 180]], ['planet', [220, 280]]]) {
      const out = path.join(tmp, `${projection}-pan.mp4`);
      const lines = [];
      await renderFromEdl(src, out, [{ t: 0, camera: 1 }, { t: 2.5, camera: 2, panSpeed: 20 }], {
        ...base, projections: [projection, projection], fovs, trace: lines,
      });
      assert.equal(frameCount(out), 90, projection);
      assert.ok(lines.some((args) => (args.find((a) => String(a).includes('sendcmd=f=')) || '').length > 0 || args.some((a) => String(a).includes('sendcmd='))), `${projection} used sendcmd`);
      // The last frame is the hold of camera 2 at its own fov.
      const hold = path.join(tmp, `${projection}-hold.mp4`);
      await renderFromEdl(src, hold, [{ t: 0, camera: 2 }], { ...base, projections: [projection, projection], fovs });
      const got = path.join(tmp, `${projection}-last.png`);
      const want = path.join(tmp, `${projection}-want.png`);
      frameOf(out, got, 89);
      frameOf(hold, want, 5);
      assert.ok(psnrOf(got, want) >= 28, `${projection} pan ends on camera 2: ${psnrOf(got, want)}`);
    }
    // A cut between projections: no pan chunks, and the second camera is its own hold from the edit time.
    const out = path.join(tmp, 'cut.mp4');
    const trace = [];
    await renderFromEdl(src, out, [{ t: 0, camera: 1 }, { t: 1.5, camera: 2, panSpeed: 20 }], {
      ...base, projections: ['flat', 'fisheye'], fovs: [100, 160], trace,
    });
    assert.equal(frameCount(out), 90);
    assert.ok(!trace.some((args) => args.some((a) => String(a).includes('sendcmd='))), 'no pan between projections');
    const filters = trace.map((args) => args[args.indexOf('-vf') + 1]).filter((f) => typeof f === 'string' && f.includes('v360='));
    assert.ok(filters.some((f) => f.includes('output=flat')) && filters.some((f) => f.includes('output=fisheye')));
    const cutHold = path.join(tmp, 'cut-hold.mp4');
    await renderFromEdl(src, cutHold, [{ t: 0, camera: 2 }], { ...base, projections: ['flat', 'fisheye'], fovs: [100, 160] });
    const got = path.join(tmp, 'cut-last.png');
    const want = path.join(tmp, 'cut-want.png');
    frameOf(out, got, 80);
    frameOf(cutHold, want, 5);
    assert.ok(psnrOf(got, want) >= 28);
  });
});
