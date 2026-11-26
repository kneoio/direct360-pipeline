import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fieldOfView } from '../src/formats.js';
import { BLUR_EXPOSURE, BLUR_FROM, blurFilters, blurScroll, frameAcross, panBlurOf, panBlurPixels, panPose, planSegments, renderFromEdl } from '../src/edl.js';

test('the blur rule is the web editor\'s: none up to BLUR_FROM frame widths a second, then the extra turn over BLUR_EXPOSURE', () => {
  assert.equal(BLUR_FROM, 0.5);
  assert.equal(BLUR_EXPOSURE, 1 / 60);
  assert.equal(panBlurOf(50, 100), 0);
  assert.ok(Math.abs(panBlurOf(110, 100) - 1) < 1e-12);
  assert.equal(panBlurOf(-110, 100), panBlurOf(110, 100));
  assert.equal(frameAcross(100, 1920, 1080), 100);
  assert.ok(frameAcross(100, 1080, 1920) < 60);
});

test('panBlurPixels: an even pan blurs the same on every frame, a slow one not at all', () => {
  const even = [{ at: 0, level: 70 }, { at: 1, level: 70 }];
  const fast = (n) => panPose(0, 180, 0, 0, n, 31, { curve: even });
  const pxs = panBlurPixels(fast, 31, { fps: 30, fromFov: 100, toFov: 100, width: 1920, height: 1080, srcWidth: 3600 });
  // 180° in a second: 130° a second past the 50 it starts at, 130/60° of smear, 10 px a degree.
  for (const px of pxs) assert.ok(Math.abs(px - (130 / 60) * 10) < 1e-6, String(px));
  const slow = (n) => panPose(0, 30, 0, 0, n, 31, { curve: even });
  assert.ok(panBlurPixels(slow, 31, { fps: 30, fromFov: 100, toFov: 100, width: 1920, height: 1080, srcWidth: 3600 }).every((px) => px === 0));
});

test('blurFilters: nothing for a pan that does not blur; otherwise gblur across only, moved per frame', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd360-blur-'));
  try {
    const file = path.join(tmp, 'b.cmd');
    assert.equal(blurFilters([0, 0, 0], file, { num: 30, den: 1 }), '');
    assert.equal(fs.existsSync(file), false);
    const f = blurFilters([0, 12, 12, 24], file, { num: 30, den: 1 });
    assert.match(f, /^sendcmd=f='.*b\.cmd',gblur@mb=sigma=0\.000:sigmaV=0:steps=3,$/);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0], / gblur@mb sigma 0\.000;$/);
    assert.match(lines[1], / gblur@mb sigma 3\.464;$/);
    assert.match(lines[2], / gblur@mb sigma 6\.928;$/);
    // An even blur still has its one line (sendcmd refuses an empty file).
    blurFilters([12, 12, 12], file, { num: 30, den: 1 });
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('blurScroll puts the aim in the middle of the 360 picture', () => {
  assert.deepEqual(blurScroll(0), { hpos: 0, yaw: 0 });
  assert.ok(Math.abs(blurScroll(90).hpos - 0.75) < 1e-12);
  assert.ok(Math.abs(blurScroll(-170).hpos - 170 / 360) < 1e-12);
});

const ffmpeg = (args) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
};
const psnrOf = (a, b) => Number((spawnSync('ffmpeg', ['-hide_banner', '-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.match(/average:([\d.]+|inf)/) || [])[1]);

test('a fast pan renders blurred across, as the 360 picture smeared by its turn; a slow pan stays sharp', { timeout: 180000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd360-blur-'));
  const previous = { preset: process.env.D360_RENDER_PRESET, crf: process.env.D360_RENDER_CRF };
  process.env.D360_RENDER_PRESET = 'ultrafast';
  process.env.D360_RENDER_CRF = '10';
  try {
    const src = path.join(tmp, 'src.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1440x720:rate=30:duration=3', '-pix_fmt', 'yuv420p', src]);
    const width = 320;
    const height = 180;
    const fov = 90;
    const edl = [{ t: 0, camera: 1 }, { t: 2.5, camera: 2, panSpeed: 240 }];
    const out = path.join(tmp, 'fast.mp4');
    await renderFromEdl(src, out, edl, { format: 'youtube', yaws: [0, 170], pitches: [0, 0], width, height, fov, log: () => {} });
    const pan = planSegments(edl, [0, 170], [0, 0], 3).find((s) => s.type === 'pan');
    const panFrames = Math.round(pan.dur * 30);
    const first = Math.round(pan.start * 30);
    const local = Math.floor(panFrames / 2);
    const poseAt = (n) => panPose(0, 170, 0, 0, n, panFrames, { curve: pan.panCurve, direction: pan.panDirection });
    const px = panBlurPixels(poseAt, panFrames, { fps: 30, fromFov: fov, toFov: fov, width, height, srcWidth: 1440 })[local];
    assert.ok(px > 4, `the middle of the pan blurs (${px} px)`);
    const pose = poseAt(local);
    const { hfov, vfov } = fieldOfView(width, height, fov);
    const view = `v360=input=e:output=flat:yaw=${pose.yaw.toFixed(3)}:pitch=0:roll=0:h_fov=${hfov}:v_fov=${vfov}:w=${width}:h=${height}`;
    const at = first + local;
    const got = path.join(tmp, 'got.png');
    const sharp = path.join(tmp, 'sharp.png');
    const smeared = path.join(tmp, 'smeared.png');
    ffmpeg(['-i', out, '-vf', `select=eq(n\\,${at})`, '-frames:v', '1', got]);
    ffmpeg(['-i', src, '-vf', `select=eq(n\\,${at}),${view}`, '-frames:v', '1', sharp]);
    ffmpeg(['-i', src, '-vf', `select=eq(n\\,${at}),gblur=sigma=${(px / Math.sqrt(12)).toFixed(3)}:sigmaV=0:steps=3,${view}`, '-frames:v', '1', smeared]);
    const toSmeared = psnrOf(got, smeared);
    const toSharp = psnrOf(got, sharp);
    assert.ok(toSmeared >= 28, `matches the smeared picture: PSNR ${toSmeared}`);
    assert.ok(toSmeared > toSharp + 2, `closer to the smeared picture (${toSmeared}) than the sharp one (${toSharp})`);
  } finally {
    for (const [key, value] of Object.entries({ D360_RENDER_PRESET: previous.preset, D360_RENDER_CRF: previous.crf })) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
