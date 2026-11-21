import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderFromEdl } from '../src/edl.js';
import {
  aimQuat, buildTrack, computeCorrection, decodeOrientation, encodeOrientation, qconj, qmul, qnorm, qrot,
  qToMat, qaxis, quatToV360, stabModeValid, viewAngles, yawSmoothSec,
} from '../src/stabilize.js';

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || `ffmpeg exited ${r.status}`);
}

function rawFrames(file, w, h) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 29 });
  if (r.status !== 0) throw new Error(String(r.stderr));
  const size = w * h * 3;
  const out = [];
  for (let o = 0; o + size <= r.stdout.length; o += size) out.push(r.stdout.subarray(o, o + size));
  return out;
}

function psnr(a, b) {
  let se = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; se += d * d; }
  if (se === 0) return Infinity;
  return 10 * Math.log10((255 * 255) / (se / a.length));
}

// ----------------------------------------------------------------- v360 order
const PROBE_W = 720, PROBE_H = 360, PROBE_N = 101, PROBE_FOV = 20;
const GEQ = `geq=r='127.5+127.5*cos((0.5-Y/${PROBE_H})*PI)*sin((X/${PROBE_W}-0.5)*2*PI)':g='127.5+127.5*sin((0.5-Y/${PROBE_H})*PI)':b='127.5+127.5*cos((0.5-Y/${PROBE_H})*PI)*cos((X/${PROBE_W}-0.5)*2*PI)'`;

/** Source directions seen at the output's forward/right/up, read from a direction-coded equirect. */
function probeV360(yaw, pitch, roll) {
  const vf = `format=gbrp,${GEQ},format=rgb24,v360=input=e:output=flat:w=${PROBE_N}:h=${PROBE_N}:h_fov=${PROBE_FOV}:v_fov=${PROBE_FOV}:yaw=${yaw}:pitch=${pitch}:roll=${roll}:rorder=ypr:interp=linear`;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${PROBE_W}x${PROBE_H}:d=1,format=rgb24`, '-vf', vf, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1e7 });
  if (r.status !== 0) throw new Error(String(r.stderr));
  const px = (x, y) => {
    const o = (y * PROBE_N + x) * 3;
    const v = [r.stdout[o], r.stdout[o + 1], r.stdout[o + 2]].map((c) => (c - 127.5) / 127.5);
    const n = Math.hypot(...v);
    return v.map((c) => c / n);
  };
  const c = (PROBE_N - 1) / 2;
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const unit = (a) => { const n = Math.hypot(...a); return a.map((x) => x / n); };
  const f = px(c, c);
  const orth = (v) => unit(v.map((x, i) => x - dot(v, f) * f[i]));
  return { right: orth(px(PROBE_N - 1, c)), up: orth(px(c, 0)), fwd: f };
}

test('v360 rorder=ypr is Ry(yaw) Rx(-pitch) Rz(-roll): quaternion matrix matches the probe', () => {
  for (const [yaw, pitch, roll] of [[30, 0, 0], [0, 30, 0], [0, 0, 30], [30, 20, 10], [-25, 15, 35], [40, -30, 20]]) {
    const m = qToMat(aimQuat(yaw, pitch, roll));
    const p = probeV360(yaw, pitch, roll);
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(m[i][0] - p.right[i]) < 0.05, `right ${yaw},${pitch},${roll}`);
      assert.ok(Math.abs(m[i][1] - p.up[i]) < 0.05, `up ${yaw},${pitch},${roll}`);
      assert.ok(Math.abs(m[i][2] - p.fwd[i]) < 0.05, `fwd ${yaw},${pitch},${roll}`);
    }
  }
});

test('quatToV360 inverts aimQuat', () => {
  for (const [yaw, pitch, roll] of [[10, 20, 30], [-120, -45, 170], [179, 80, -90]]) {
    const v = quatToV360(aimQuat(yaw, pitch, roll));
    assert.ok(Math.abs(v.yaw - yaw) < 1e-6 && Math.abs(v.pitch - pitch) < 1e-6 && Math.abs(v.roll - roll) < 1e-6);
  }
});

test('modes: off and horizon are valid, full lock is not exposed', () => {
  assert.equal(stabModeValid('off'), true);
  assert.equal(stabModeValid('horizon'), true);
  assert.equal(stabModeValid('full'), false);
  assert.throws(() => computeCorrection({ quats: [[1, 0, 0, 0]], grav: [[0, 1, 0]] }, { mode: 'full', fps: 30 }), /disabled/);
  assert.equal(yawSmoothSec(), 1);
});

test('orientation file round-trips and resampling is frame-exact', () => {
  const quats = [qnorm([1, 0.1, 0, 0]), qnorm([1, 0.2, 0.1, 0]), qnorm([1, 0.3, 0.1, 0.1])];
  const grav = [[0, -1, 0], [0.1, -0.99, 0], [0.2, -0.97, 0]];
  const back = decodeOrientation(encodeOrientation({ quats, grav, fps: 29.97 }));
  assert.equal(back.frames, 3);
  assert.ok(Math.abs(back.fps - 29.97) < 1e-3);
  quats.forEach((q, i) => q.forEach((x, k) => assert.ok(Math.abs(x - back.quats[i][k]) < 1e-6)));
  const exact = buildTrack(quats.map((v, i) => ({ t: i, v })), grav.map((v, i) => ({ t: i, v })), { frames: 3, fps: 30 });
  assert.equal(exact.resampled, false);
  const longer = buildTrack(quats.map((v, i) => ({ t: (i + 0.5) / 3, v })), grav.map((v, i) => ({ t: (i + 0.5) / 3, v })), { frames: 6, fps: 6, durationSec: 1 });
  assert.equal(longer.resampled, true);
  assert.equal(longer.quats.length, 6);
});

// ------------------------------------------------------- synthetic shaken clip
const FPS = 12;
const FRAMES = 24;
const W = 320, H = 180;

/** Fake GoPro track from the camera orientation of each frame (camera -> world, V basis). */
function synthTrack(cams) {
  const inv0 = qconj(cams[0]);
  const reflect = (q) => [q[0], -q[1], q[2], -q[3]];
  const quats = cams.map((a) => qconj(reflect(qmul(inv0, a))));
  const grav = cams.map((a) => {
    const g = qrot(qconj(a), [0, -1, 0]); // world down seen from the camera
    return [g[0], -g[1], g[2]];
  });
  return {
    quats: quats.map((q, i) => ({ t: (i + 0.5) / FPS, v: q })),
    grav: grav.map((v, i) => ({ t: (i + 0.5) / FPS, v })),
  };
}

function shakeAngles(kind) {
  return Array.from({ length: FRAMES }, (_, i) => {
    const roll = 12 * Math.sin(i * 0.9);
    const pitch = 8 * Math.sin(i * 1.3 + 0.0);
    const jitter = 4 * Math.sin(i * 2.1);
    const turn = kind === 'turn' ? (40 * i) / (FRAMES - 1) : 0;
    return { yaw: turn + jitter, pitch, roll };
  });
}

function makeFixtures(tmp, angles) {
  const png = path.join(tmp, 'world.png');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1024x512:rate=1:duration=1', '-vf', 'gblur=sigma=2.5', '-frames:v', '1', png]);
  const still = path.join(tmp, 'world.mp4');
  ffmpeg(['-loop', '1', '-framerate', String(FPS), '-i', png, '-frames:v', String(FRAMES), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '8', still]);
  const cmd = angles.map((a, i) => `${(i === 0 ? 0 : i / FPS - 0.01).toFixed(4)} v360@s yaw ${a.yaw}, v360@s pitch ${a.pitch}, v360@s roll ${a.roll};`).join('\n');
  const cmdFile = path.join(tmp, 'shake.cmd');
  fs.writeFileSync(cmdFile, `${cmd}\n`);
  const shaken = path.join(tmp, 'shaken.mp4');
  ffmpeg(['-loop', '1', '-framerate', String(FPS), '-i', png, '-frames:v', String(FRAMES),
    '-vf', `sendcmd=f=${cmdFile},v360@s=input=e:output=e:w=1024:h=512:reset_rot=1:interp=linear,format=yuv420p`,
    '-c:v', 'libx264', '-crf', '8', shaken]);
  return { still, shaken };
}

const EDL = [{ t: 0, camera: 1 }];
const VIEW = { format: 'youtube', yaws: [0], pitches: [0], width: W, height: H, fov: 90 };

async function render(src, out, extra = {}) {
  await renderFromEdl(src, out, EDL, { ...VIEW, ...extra });
}

test('horizon on a shaken clip: roll, pitch and yaw jitter are removed (PSNR >= 30 per sampled frame)', { timeout: 240000 }, async () => {
  process.env.D360_RENDER_PRESET = 'ultrafast';
  process.env.D360_RENDER_CRF = '10';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd360-stab-'));
  try {
    const angles = shakeAngles('jitter');
    const { still, shaken } = makeFixtures(tmp, angles);
    const cams = angles.map((a) => aimQuat(a.yaw, a.pitch, a.roll));
    const s = synthTrack(cams);
    const track = buildTrack(s.quats, s.grav, { frames: FRAMES, fps: FPS });
    assert.equal(track.resampled, false);
    const corrections = computeCorrection(track, { mode: 'horizon', fps: FPS });

    await render(still, path.join(tmp, 'ref.mp4'));
    await render(shaken, path.join(tmp, 'off.mp4'));
    await render(shaken, path.join(tmp, 'on.mp4'), { stabilization: { corrections } });
    const ref = rawFrames(path.join(tmp, 'ref.mp4'), W, H);
    const off = rawFrames(path.join(tmp, 'off.mp4'), W, H);
    const on = rawFrames(path.join(tmp, 'on.mp4'), W, H);
    assert.equal(on.length, FRAMES);
    const rows = [];
    for (let i = 0; i < FRAMES; i += 2) {
      const a = psnr(ref[i], on[i]);
      rows.push(`${i}: off ${psnr(ref[i], off[i]).toFixed(1)} on ${a.toFixed(1)}`);
      assert.ok(a >= 30, `frame ${i} PSNR ${a.toFixed(1)} < 30\n${rows.join('\n')}`);
    }
    console.log(rows.join('\n'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('horizon keeps a slow yaw turn: heading follows within the smoothing window', () => {
  const angles = shakeAngles('turn');
  const cams = angles.map((a) => aimQuat(a.yaw, a.pitch, a.roll));
  const s = synthTrack(cams);
  const track = buildTrack(s.quats, s.grav, { frames: FRAMES, fps: FPS });
  const corrections = computeCorrection(track, { mode: 'horizon', fps: FPS, yawSmoothSec: 1 });
  // World orientation of the output view = camera orientation ∘ correction.
  const heads = cams.map((cam, i) => {
    const f = qrot(qmul(cam, corrections[i]), [0, 0, 1]);
    const up = qrot(qmul(cam, corrections[i]), [0, 1, 0]);
    assert.ok(Math.abs(f[1]) < 1e-6 && Math.abs(up[0]) < 1e-6 && Math.abs(up[2]) < 1e-6, `frame ${i} is level`);
    return (Math.atan2(f[0], f[2]) * 180) / Math.PI;
  });
  const trend = (i) => (40 * i) / (FRAMES - 1);
  heads.forEach((h, i) => assert.ok(Math.abs(h - trend(i)) <= 6, `frame ${i} heading ${h.toFixed(1)} vs ${trend(i).toFixed(1)}`));
  const rms = (xs) => Math.sqrt(xs.reduce((a, x) => a + x * x, 0) / xs.length);
  const raw = angles.slice(6, 18).map((a, k) => a.yaw - trend(k + 6));
  const kept = heads.slice(6, 18).map((h, k) => h - trend(k + 6));
  assert.ok(heads[FRAMES - 1] - heads[0] > 25, 'the slow turn is kept');
  assert.ok(rms(kept) < rms(raw) * 0.5, `yaw jitter ${rms(raw).toFixed(2)} -> ${rms(kept).toFixed(2)}`);
});

test('level camera yields no correction', () => {
  const cams = Array.from({ length: 30 }, () => aimQuat(0, 0, 0));
  const s = synthTrack(cams);
  const track = buildTrack(s.quats, s.grav, { frames: 30, fps: 30 });
  const view = viewAngles(computeCorrection(track, { mode: 'horizon', fps: 30 }), { yaw: 25, pitch: -10 });
  for (const v of view) {
    assert.ok(Math.abs(v.yaw - 25) < 1e-6 && Math.abs(v.pitch + 10) < 1e-6 && Math.abs(v.roll) < 1e-6);
  }
});

test('1, 2 and 3 parts give identical frames, including at the borders', { timeout: 240000 }, async () => {
  process.env.D360_RENDER_PRESET = 'ultrafast';
  process.env.D360_RENDER_CRF = '10';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd360-stab-parts-'));
  try {
    const angles = shakeAngles('turn');
    const { shaken } = makeFixtures(tmp, angles);
    const cams = angles.map((a) => aimQuat(a.yaw, a.pitch, a.roll));
    const s = synthTrack(cams);
    const corrections = computeCorrection(buildTrack(s.quats, s.grav, { frames: FRAMES, fps: FPS }), { mode: 'horizon', fps: FPS });
    const edl = [{ t: 0, camera: 1 }, { t: 1.5, camera: 2, panSpeed: 40 }];
    const opts = { ...VIEW, yaws: [0, 30], pitches: [0, 5], chunkSeconds: 0.5, includeAudio: false, stabilization: { corrections } };
    const whole = path.join(tmp, 'whole.mp4');
    const wholeResult = await renderFromEdl(shaken, whole, edl, opts);
    const n = wholeResult.chunks;
    assert.ok(n >= 4, `chunks ${n}`);
    const base = rawFrames(whole, W, H);
    assert.equal(base.length, FRAMES);
    for (const ranges of [[[0, n - 1]], [[0, 1], [2, n - 1]], [[0, 1], [2, n - 2], [n - 1, n - 1]]]) {
      const frames = [];
      for (const [a, b] of ranges) {
        const part = path.join(tmp, `part-${a}-${b}.mp4`);
        await renderFromEdl(shaken, part, edl, { ...opts, chunkRange: [a, b] });
        frames.push(...rawFrames(part, W, H));
      }
      assert.equal(frames.length, FRAMES, `${ranges.length} parts`);
      for (let i = 0; i < FRAMES; i++) {
        assert.ok(psnr(base[i], frames[i]) >= 45, `${ranges.length} parts, frame ${i}`);
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
