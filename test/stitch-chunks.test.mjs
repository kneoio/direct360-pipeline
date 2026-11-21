import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eacToEquirectFilter, stitchGopro, stitchPreset, stitchEngine, gpuStitchCq } from '../src/gopro.js';
import { chunkMinSeconds, containerLimits, planChunks } from '../src/edl.js';

test('stitch preset is veryfast unless D360_STITCH_PRESET names an x264 preset', () => {
  assert.equal(stitchPreset({}), 'veryfast');
  assert.equal(stitchPreset({ D360_STITCH_PRESET: 'medium' }), 'medium');
  assert.throws(() => stitchPreset({ D360_STITCH_PRESET: 'placebo' }), /D360_STITCH_PRESET/);
});

test('a chunked stitch trims both lenses to the same frame count', () => {
  const filter = eacToEquirectFilter(0, 4, { width: 4096, height: 1344, face: 1344, overlap: 128 }, 12);
  assert.match(filter, /\[0:0\]trim=end_frame=12,setpts=PTS-STARTPTS,split=7/);
  assert.match(filter, /\[0:4\]trim=end_frame=12,setpts=PTS-STARTPTS,split=7/);
  assert.match(filter, /\[fin0\]crop=/);
  assert.match(filter, /\[bin0\]crop=/);
  assert.match(filter, /\[out\]$/);
  const whole = eacToEquirectFilter(0, 4, { width: 4096, height: 1344, face: 1344, overlap: 128 });
  assert.doesNotMatch(whole, /trim=/);
  assert.match(whole, /\[0:0\]crop=/);
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

test('chunked stitch keeps the source frame count and puts an IDR on every chunk', { timeout: 180000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd360-stitch-test-'));
  const previous = {
    preset: process.env.D360_STITCH_PRESET,
    chunk: process.env.D360_CHUNK_MIN_SEC,
    parallel: process.env.D360_MAX_PARALLEL,
  };
  process.env.D360_STITCH_PRESET = 'ultrafast';
  process.env.D360_CHUNK_MIN_SEC = '0.2';
  process.env.D360_MAX_PARALLEL = '2';
  try {
    const src = path.join(tmp, 'dual.mp4');
    ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=4096x1344:rate=10:duration=0.6',
      '-f', 'lavfi', '-i', 'testsrc2=size=4096x1344:rate=10:duration=0.6',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.6',
      '-map', '0:v', '-map', '2:a', '-map', '1:v',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-g', '2',
      '-c:a', 'aac', '-shortest', src,
    ]);
    const out = path.join(tmp, 'equirect.mp4');
    const lines = [];
    const stitched = await stitchGopro(src, out, { log: (line) => lines.push(line) });
    const planned = planChunks(
      [{ type: 'hold', start: 0, dur: 0.6 }],
      { totalFrames: 6, fps: 10, chunkSeconds: chunkMinSeconds(0.6, containerLimits().cpus) },
    );
    assert.equal(stitched.chunks, planned.length, lines.join('\n'));
    assert.equal(stitched.frames, 6);
    assert.equal(stitched.preset, 'ultrafast');
    const facts = JSON.parse(ffprobe([
      '-count_packets', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_packets,codec_name',
      '-show_entries', 'format=duration',
      '-of', 'json', out,
    ]));
    assert.equal(Number(facts.streams[0].nb_read_packets), 6);
    assert.equal(facts.streams[0].codec_name, 'h264');
    assert.ok(Math.abs(Number(facts.format.duration) - 0.6) < 1.5 / 10);
    const streams = JSON.parse(ffprobe([
      '-show_entries', 'stream=codec_type,codec_name',
      '-of', 'json', out,
    ])).streams;
    assert.ok(streams.some((stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
    // JSON, not csv: ffprobe 5's csv adds a side-data row after each chunk's IDR, which would shift the indices.
    const keys = JSON.parse(ffprobe([
      '-select_streams', 'v:0',
      '-show_entries', 'frame=key_frame',
      '-of', 'json', out,
    ])).frames.map((f) => String(f.key_frame));
    const keyAt = new Set(planned.map((chunk) => chunk.seekFrame));
    assert.equal(keys.length, 6);
    keys.forEach((flag, index) => {
      if (keyAt.has(index)) assert.equal(flag, '1', `frame ${index} starts a chunk`);
    });
    assert.ok(lines.some((line) => line.startsWith('peak concurrent ffmpeg:')));
  } finally {
    if (previous.preset == null) delete process.env.D360_STITCH_PRESET;
    else process.env.D360_STITCH_PRESET = previous.preset;
    if (previous.chunk == null) delete process.env.D360_CHUNK_MIN_SEC;
    else process.env.D360_CHUNK_MIN_SEC = previous.chunk;
    if (previous.parallel == null) delete process.env.D360_MAX_PARALLEL;
    else process.env.D360_MAX_PARALLEL = previous.parallel;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the stitch engine is cpu by default and rejects unknown values', () => {
  assert.equal(stitchEngine({}), 'cpu');
  assert.equal(stitchEngine({ D360_STITCH_ENGINE: 'gpu' }), 'gpu');
  assert.throws(() => stitchEngine({ D360_STITCH_ENGINE: 'nvidia' }), /cpu or gpu/);
  assert.equal(gpuStitchCq({}), 24);
  assert.throws(() => gpuStitchCq({ D360_STITCH_GPU_CQ: 'high' }), /whole number/);
});
