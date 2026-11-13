import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fieldOfView } from 'direct360-pipeline/src/formats.js';
import { chunkMinSeconds, containerLimits, panPose, planChunks, planSegments, renderFromEdl, keptFrameRanges } from 'direct360-pipeline/src/edl.js';

test('chunk length is at least the minimum and otherwise the clip over two waves of cores', () => {
  assert.equal(chunkMinSeconds(110, 16, {}), 4);
  assert.equal(chunkMinSeconds(600, 16, {}), 600 / 32);
  assert.equal(chunkMinSeconds(110, 16, { D360_CHUNK_MIN_SEC: '8' }), 8);
  assert.throws(() => chunkMinSeconds(10, 4, { D360_CHUNK_MIN_SEC: '0' }), /D360_CHUNK_MIN_SEC/);
});

test('a long pan splits on the same ease, and the next chunk does not restart it', () => {
  const segments = planSegments(
    [{ t: 0, camera: 1 }, { t: 8, camera: 2, panSpeed: 10 }],
    [0, 40],
    [0, 0],
    8,
  );
  const pan = segments.find((seg) => seg.type === 'pan');
  assert.equal(pan.dur, 4);
  const chunks = planChunks(segments, { totalFrames: 240, fps: 30, chunkSeconds: 1 });
  const panChunks = chunks.filter((chunk) => chunk.type === 'pan');
  assert.equal(panChunks.length, 4);
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.frames, 0), 240);
  assert.deepEqual(panChunks.map((chunk) => chunk.index0), [0, 30, 60, 90]);
  const border = panChunks[1].index0;
  const arriving = panPose(pan.fromYaw, pan.toYaw, pan.fromPitch, pan.toPitch, border, panChunks[0].panFrames);
  const previous = panPose(pan.fromYaw, pan.toYaw, pan.fromPitch, pan.toPitch, border - 1, panChunks[0].panFrames);
  assert.equal(arriving.yaw, panPose(pan.fromYaw, pan.toYaw, 0, 0, border, pan.dur * 30).yaw);
  assert.ok(Math.abs(arriving.unwrapped - previous.unwrapped) < 1);
  assert.ok(arriving.yaw !== pan.fromYaw);
  const pitchedSegments = planSegments(
    [{ t: 0, camera: 1 }, { t: 2, camera: 2, panSpeed: 30 }],
    [0, 10],
    [0, 20],
    2,
  );
  const pitchedChunks = planChunks(pitchedSegments, { totalFrames: 60, fps: 30, chunkSeconds: 1 });
  assert.equal(pitchedChunks.some((chunk) => chunk.type === 'pan' && chunk.yawOnly), false);
});

test('a trim keeps only its frames: chunks tile the kept range and a pan cut in half keeps its own ease', () => {
  const segments = planSegments(
    [{ t: 0, camera: 1 }, { t: 8, camera: 2, panSpeed: 10 }],
    [0, 40],
    [0, 0],
    8,
  );
  const ranges = keptFrameRanges([{ start: 1, end: 6 }], 30, 240);
  assert.deepEqual(ranges, [{ fromFrame: 30, toFrame: 180 }]);
  const chunks = planChunks(segments, { totalFrames: 240, fps: 30, chunkSeconds: 1, ranges });
  assert.equal(chunks[0].seekFrame, 30);
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.frames, 0), 150);
  for (let i = 1; i < chunks.length; i += 1) assert.equal(chunks[i].seekFrame, chunks[i - 1].seekFrame + chunks[i - 1].frames);
  const pan = chunks.filter((chunk) => chunk.type === 'pan');
  // The pan runs 4s..8s (frames 120..240); the trim ends at frame 180, two chunks into it.
  assert.deepEqual(pan.map((chunk) => [chunk.index0, chunk.frames, chunk.panFrames]), [[0, 30, 120], [30, 30, 120]]);
  const late = planChunks(segments, { totalFrames: 240, fps: 30, chunkSeconds: 1, ranges: keptFrameRanges([{ start: 5.5, end: 8 }], 30, 240) });
  assert.equal(late[0].type, 'pan');
  assert.equal(late[0].index0, 45);
  assert.equal(late[0].seekFrame, 165);
  assert.deepEqual(keptFrameRanges(null, 30, 240), [{ fromFrame: 0, toFrame: 240 }]);
  assert.throws(() => keptFrameRanges([{ start: 3, end: 3 }], 30, 240), /keep no frames/);
});

function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `ffmpeg exited ${result.status}`);
}

function ffprobe(args) {
  const result = spawnSync('ffprobe', ['-v', 'error', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `ffprobe exited ${result.status}`);
  return result.stdout;
}

test('a chunked yaw pan matches per-frame v360 and the joined frame count', { timeout: 120000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd360-pan-'));
  const previous = {
    preset: process.env.D360_RENDER_PRESET,
    crf: process.env.D360_RENDER_CRF,
    chunk: process.env.D360_CHUNK_MIN_SEC,
  };
  process.env.D360_RENDER_PRESET = 'ultrafast';
  process.env.D360_RENDER_CRF = '10';
    // Half a second on 16 cores splits the 1s pan, so the middle frame is the
    // first frame of the second pan chunk.
    process.env.D360_CHUNK_MIN_SEC = '0.5';
  try {
    const src = path.join(tmp, 'src.mp4');
    ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=960x480:rate=30:duration=4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src,
    ]);
    const out = path.join(tmp, 'out.mp4');
    const width = 160;
    const height = 90;
    const fov = 90;
    const lines = [];
    const rendered = await renderFromEdl(src, out, [
      { t: 0, camera: 1 },
      { t: 3, camera: 2, panSpeed: 24 },
    ], {
      format: 'youtube',
      yaws: [0, 24],
      pitches: [0, 0],
      width,
      height,
      fov,
      log: (line) => lines.push(line),
    });
    assert.ok(lines.some((line) => line.includes('160x90 yuv420p, 1.5× measured RSS')));
    assert.ok(lines.some((line) => line.startsWith('concat ')));
    assert.ok(lines.some((line) => line.startsWith('frame check ')));
    assert.ok(lines.some((line) => line.startsWith('audio encode ')));
    assert.ok(lines.some((line) => line.startsWith('concat + faststart ')));
    assert.ok(rendered.chunks > rendered.segments.length);

    const facts = JSON.parse(ffprobe([
      '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_frames,codec_name',
      '-show_entries', 'format=duration',
      '-of', 'json', out,
    ]));
    assert.equal(Number(facts.streams[0].nb_read_frames), 120);
    const streams = JSON.parse(ffprobe([
      '-show_entries', 'stream=codec_type,codec_name',
      '-of', 'json', out,
    ])).streams;
    assert.ok(streams.some((stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
    assert.ok(Math.abs(Number(facts.format.duration) - 4) < 1.5 / 30);

    const times = ffprobe([
      '-select_streams', 'v:0',
      '-show_entries', 'frame=key_frame,best_effort_timestamp_time',
      '-of', 'csv=p=0', out,
    ]).trim().split('\n');
    const keys = times.map((line, index) => (line.startsWith('1,') ? index : -1)).filter((index) => index >= 0);
    const srcInfo = JSON.parse(ffprobe([
      '-show_entries', 'format=duration',
      '-show_entries', 'stream=codec_type,avg_frame_rate,nb_frames,duration',
      '-of', 'json', src,
    ]));
    const video = srcInfo.streams.find((stream) => stream.codec_type === 'video');
    const [num, den] = String(video.avg_frame_rate).split('/').map(Number);
    const fps = num / den;
    const duration = Number(video.duration) || Number(srcInfo.format.duration);
    const totalFrames = Number(video.nb_frames) || Math.round(duration * fps);
    const planned = planChunks(
      planSegments(
        [{ t: 0, camera: 1 }, { t: 3, camera: 2, panSpeed: 24 }],
        [0, 24],
        [0, 0],
        duration,
      ),
      { totalFrames, fps, chunkSeconds: chunkMinSeconds(duration, containerLimits().cpus) },
    );
    assert.deepEqual(keys, planned.map((chunk) => chunk.seekFrame));
    const pts = times.map((line) => Number(line.split(',')[1]));
    for (let i = 1; i < pts.length; i++) {
      const step = pts[i] - pts[i - 1];
      assert.ok(step > 0.02 && step < 0.05, `frame ${i} step ${step}`);
    }

    const { hfov, vfov } = fieldOfView(width, height, fov);
    const panFrames = 30;
    for (const [local, label] of [[0, 'start'], [15, 'middle'], [29, 'end']]) {
      const pose = panPose(0, 24, 0, 0, local, panFrames);
      const absolute = 60 + local;
      const ref = path.join(tmp, `ref-${label}.png`);
      const got = path.join(tmp, `got-${label}.png`);
      const filter = `v360=input=e:output=flat:yaw=${pose.yaw.toFixed(3)}:pitch=${pose.pitch}:roll=0:h_fov=${hfov}:v_fov=${vfov}:w=${width}:h=${height}`;
      ffmpeg(['-i', src, '-vf', `select=eq(n\\,${absolute}),${filter}`, '-frames:v', '1', ref]);
      ffmpeg(['-i', out, '-vf', `select=eq(n\\,${absolute})`, '-frames:v', '1', got]);
      const psnr = spawnSync('ffmpeg', ['-hide_banner', '-i', ref, '-i', got, '-lavfi', 'psnr', '-f', 'null', '-'], { encoding: 'utf8' });
      const ssim = spawnSync('ffmpeg', ['-hide_banner', '-i', ref, '-i', got, '-lavfi', 'ssim', '-f', 'null', '-'], { encoding: 'utf8' });
      const psnrValue = Number((psnr.stderr.match(/average:([\d.]+)/) || [])[1]);
      const ssimValue = Number((ssim.stderr.match(/All:([\d.]+)/) || [])[1]);
      // 960px-wide is much coarser than a 5.7K equirect (~2.7 px/degree versus
      // ~16). A miss of a whole degree falls through these floors.
      assert.ok(psnrValue >= 28, `${label} PSNR ${psnrValue}`);
      assert.ok(ssimValue >= 0.94, `${label} SSIM ${ssimValue}`);
    }

    const preview = path.join(tmp, 'preview.mp4');
    await renderFromEdl(src, preview, [
      { t: 0, camera: 1 },
      { t: 3, camera: 2, panSpeed: 24 },
    ], {
      format: 'youtube',
      yaws: [0, 24],
      pitches: [0, 0],
      width,
      height,
      fov,
      preview: true,
      log: () => {},
    });
    const previewFacts = JSON.parse(ffprobe([
      '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_frames',
      '-of', 'json', preview,
    ]));
    assert.equal(Number(previewFacts.streams[0].nb_read_frames), 120);

    const pitched = path.join(tmp, 'pitch.mp4');
    await renderFromEdl(src, pitched, [
      { t: 0, camera: 1 },
      { t: 1.5, camera: 2, panSpeed: 80 },
    ], {
      format: 'youtube',
      yaws: [0, 10],
      pitches: [0, 8],
      width,
      height,
      fov,
      log: () => {},
    });
    const pitchedFacts = JSON.parse(ffprobe([
      '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_frames',
      '-of', 'json', pitched,
    ]));
    assert.equal(Number(pitchedFacts.streams[0].nb_read_frames), 120);
  } finally {
    for (const [key, value] of Object.entries({
      D360_RENDER_PRESET: previous.preset,
      D360_RENDER_CRF: previous.crf,
      D360_CHUNK_MIN_SEC: previous.chunk,
    })) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a pitch pan across camera rows keeps frame count, border continuity, and stays near yaw-pan time', { timeout: 120000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd360-pitch-'));
  const previous = {
    preset: process.env.D360_RENDER_PRESET,
    crf: process.env.D360_RENDER_CRF,
    chunk: process.env.D360_CHUNK_MIN_SEC,
  };
  process.env.D360_RENDER_PRESET = 'ultrafast';
  process.env.D360_RENDER_CRF = '10';
  process.env.D360_CHUNK_MIN_SEC = '0.5';
  try {
    const src = path.join(tmp, 'src.mp4');
    ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x960:rate=30:duration=4',
      '-pix_fmt', 'yuv420p', '-an', src,
    ]);
    const width = 320;
    const height = 180;
    const fov = 90;
    // Top row and bottom row. Speeds are set so both pans last two seconds
    // and land in the same 0.5s chunks.
    const yaws = [0, 24];
    const pitches = [-18, 22];
    const yawDistance = 24;
    const pitchDistance = Math.hypot(24, 22 - (-18));
    const yawEdl = [{ t: 0, camera: 1 }, { t: 3, camera: 2, panSpeed: yawDistance / 2 }];
    const pitchEdl = [{ t: 0, camera: 1 }, { t: 3, camera: 2, panSpeed: pitchDistance / 2 }];
    const yawLines = [];
    const pitchLines = [];
    const started = Date.now();
    await renderFromEdl(src, path.join(tmp, 'yaw.mp4'), yawEdl, {
      format: 'youtube', yaws, pitches: [0, 0], width, height, fov,
      log: (line) => yawLines.push(line),
    });
    const yawMs = Date.now() - started;
    const pitchStarted = Date.now();
    const rendered = await renderFromEdl(src, path.join(tmp, 'pitch.mp4'), pitchEdl, {
      format: 'youtube', yaws, pitches, width, height, fov,
      log: (line) => pitchLines.push(line),
    });
    const pitchMs = Date.now() - pitchStarted;
    assert.ok(pitchLines.some((line) => line.startsWith('pitch-pan per process ')));
    assert.equal(rendered.chunks > rendered.segments.length, true);

    const out = path.join(tmp, 'pitch.mp4');
    const facts = JSON.parse(ffprobe([
      '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_frames',
      '-show_entries', 'format=duration',
      '-of', 'json', out,
    ]));
    assert.equal(Number(facts.streams[0].nb_read_frames), 120);
    assert.ok(Math.abs(Number(facts.format.duration) - 4) < 1.5 / 30);

    const times = ffprobe([
      '-select_streams', 'v:0',
      '-show_entries', 'frame=key_frame,best_effort_timestamp_time',
      '-of', 'csv=p=0', out,
    ]).trim().split('\n');
    const keys = times.map((line, index) => (line.startsWith('1,') ? index : -1)).filter((index) => index >= 0);
    const srcInfo = JSON.parse(ffprobe([
      '-show_entries', 'format=duration',
      '-show_entries', 'stream=codec_type,avg_frame_rate,nb_frames,duration',
      '-of', 'json', src,
    ]));
    const video = srcInfo.streams.find((stream) => stream.codec_type === 'video');
    const [num, den] = String(video.avg_frame_rate).split('/').map(Number);
    const fps = num / den;
    const duration = Number(video.duration) || Number(srcInfo.format.duration);
    const totalFrames = Number(video.nb_frames) || Math.round(duration * fps);
    const planned = planChunks(
      planSegments(pitchEdl, yaws, pitches, duration),
      { totalFrames, fps, chunkSeconds: chunkMinSeconds(duration, containerLimits().cpus) },
    );
    assert.deepEqual(keys, planned.map((chunk) => chunk.seekFrame));
    const pts = times.map((line) => Number(line.split(',')[1]));
    for (let i = 1; i < pts.length; i++) {
      const step = pts[i] - pts[i - 1];
      assert.ok(step > 0.02 && step < 0.05, `frame ${i} step ${step}`);
    }
    const panChunks = planned.filter((chunk) => chunk.type === 'pan');
    assert.ok(panChunks.length >= 2);
    assert.equal(panChunks.every((chunk) => chunk.yawOnly), false);
    const border = panChunks[1].seekFrame;
    const { hfov, vfov } = fieldOfView(width, height, fov);
    const pan = planned.find((chunk) => chunk.type === 'pan');
    const samples = [
      [pan.seekFrame, pan.index0, 'start'],
      [border, panChunks[1].index0, 'border'],
      [panChunks.at(-1).seekFrame + panChunks.at(-1).frames - 1, panChunks.at(-1).index0 + panChunks.at(-1).frames - 1, 'end'],
    ];
    for (const [absolute, local, label] of samples) {
      const pose = panPose(pan.fromYaw, pan.toYaw, pan.fromPitch, pan.toPitch, local, pan.panFrames);
      const ref = path.join(tmp, `ref-${label}.png`);
      const got = path.join(tmp, `got-${label}.png`);
      const filter = `v360=input=e:output=flat:yaw=${pose.yaw.toFixed(3)}:pitch=${pose.pitch.toFixed(3)}:roll=0:h_fov=${hfov}:v_fov=${vfov}:w=${width}:h=${height}`;
      ffmpeg(['-i', src, '-vf', `select=eq(n\\,${absolute}),${filter}`, '-frames:v', '1', ref]);
      ffmpeg(['-i', out, '-vf', `select=eq(n\\,${absolute})`, '-frames:v', '1', got]);
      const psnr = spawnSync('ffmpeg', ['-hide_banner', '-i', ref, '-i', got, '-lavfi', 'psnr', '-f', 'null', '-'], { encoding: 'utf8' });
      const ssim = spawnSync('ffmpeg', ['-hide_banner', '-i', ref, '-i', got, '-lavfi', 'ssim', '-f', 'null', '-'], { encoding: 'utf8' });
      const psnrValue = Number((psnr.stderr.match(/average:([\d.]+|inf)/) || [])[1]);
      const ssimValue = Number((ssim.stderr.match(/All:([\d.]+)/) || [])[1]);
      assert.ok(psnrValue >= 28, `${label} PSNR ${psnrValue}`);
      assert.ok(ssimValue >= 0.9, `${label} SSIM ${ssimValue}`);
    }

    const secondsOf = (lines, kind) => lines
      .filter((line) => line.includes(kind))
      .map((line) => Number((line.match(/in ([\d.]+)s/) || [])[1]))
      .filter((n) => Number.isFinite(n));
    const yawChunk = Math.max(...secondsOf(yawLines, 'pan yaw'));
    const pitchChunk = Math.max(...secondsOf(pitchLines, 'pan pitch'));
    assert.ok(yawChunk > 0 && pitchChunk > 0, `yaw ${yawChunk} pitch ${pitchChunk}`);
    assert.ok(pitchChunk <= yawChunk * 2, `pitch chunk ${pitchChunk}s vs yaw chunk ${yawChunk}s (totals ${pitchMs}ms / ${yawMs}ms)`);
  } finally {
    for (const [key, value] of Object.entries({
      D360_RENDER_PRESET: previous.preset,
      D360_RENDER_CRF: previous.crf,
      D360_CHUNK_MIN_SEC: previous.chunk,
    })) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a trimmed render has the kept frames only, with the sound of that stretch', { timeout: 120000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd360-trim-'));
  try {
    const src = path.join(tmp, 'src.mp4');
    // Silence for 2s, then a tone: a trim from 2s starts on the tone.
    ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=960x480:rate=30:duration=4',
      '-f', 'lavfi', '-i', 'aevalsrc=if(lt(t\\,2)\\,0\\,0.5*sin(2*PI*440*t)):s=48000:d=4',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src,
    ]);
    const out = path.join(tmp, 'out.mp4');
    const rendered = await renderFromEdl(src, out, [{ t: 0, camera: 1 }, { t: 3, camera: 2, panSpeed: 24 }], {
      format: 'youtube', yaws: [0, 24], pitches: [0, 0], width: 160, height: 90, preview: true,
      ranges: [{ start: 2, end: 3.5 }],
    });
    assert.equal(rendered.frames, 45);
    const facts = JSON.parse(ffprobe(['-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-show_entries', 'format=duration', '-of', 'json', out]));
    assert.equal(Number(facts.streams[0].nb_read_frames), 45);
    assert.ok(Math.abs(Number(facts.format.duration) - 1.5) < 0.1);
    const head = spawnSync('ffmpeg', ['-hide_banner', '-t', '0.4', '-i', out, '-map', '0:a', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const mean = Number(/mean_volume: (-?[\d.]+) dB/.exec(head)?.[1]);
    assert.ok(mean > -20, `the trimmed sound starts on the tone (mean ${mean} dB)`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
