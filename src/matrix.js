/**
 * Camera layouts (aims, names, colours, shapes per format) and the preview proxies a footage plays in the editor: the
 * 360° equirect proxy every camera is drawn from live, and a flat video's proxy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { run, FFMPEG, probe } from './encoder.js';
import { containerLimits } from './edl.js';
import { videoTiming, reconnectArgs } from './ffmpegTools.js';
import { FORMATS, getFormat, ROLL_LIMIT, FOV_RANGES, BULGE_SIDES, bulgeOf, hasBulge, clampFov, projectionOf } from './formats.js';
import { flatProxySize } from './flatCameras.js';

/** Parse "5x5" / "4x6" into {rows, cols, n}. */
export function parseGrid(spec) {
  const m = /^(\d+)x(\d+)$/i.exec(String(spec).trim());
  if (!m) throw new Error(`--grid must look like "5x5", got "${spec}"`);
  const cols = +m[1], rows = +m[2];
  return { rows, cols, n: rows * cols };
}

/** N yaw angles spread evenly around the full sphere, normalized to (-180, 180]. */
export function evenYaws(n) {
  return Array.from({ length: n }, (_, i) => {
    const raw = (i * 360) / n;
    return ((raw + 180) % 360 + 360) % 360 - 180;
  });
}

const normalizeYaw = (deg) => ((deg + 180) % 360 + 360) % 360 - 180;

/** Same test as the editor: closer to the back lens than the front. The seam stays front. */
export function isRearAim(yaw, pitch) {
  const r = Math.PI / 180;
  const z = Math.cos(pitch * r) * Math.cos(yaw * r);
  return Math.acos(Math.max(-1, Math.min(1, z))) / r > 90;
}

/**
 * Cameras that start off. Each lens is classified from its own aim, then the
 * format's `lensOn` mask (one lens, row-major) is applied to that lens alone.
 * Front and back get the same pattern without reading each other's result.
 * The editor can still turn any camera on or off.
 */
export function defaultRemoved(yaws, pitches = [], format) {
  const on = getFormat(format).lensOn;
  if (!on?.length) return [];
  const groups = { front: [], back: [] };
  yaws.forEach((yaw, i) => {
    groups[isRearAim(yaw, pitches[i] ?? 0) ? 'back' : 'front'].push(i);
  });
  const removed = [];
  for (const group of [groups.front, groups.back]) {
    if (group.length !== on.length) continue;
    group.forEach((index, k) => {
      if (!on[k]) removed.push(index + 1);
    });
  }
  return removed;
}

/**
 * Which camera sits in each grid cell: `layout[cell]` is a 0-based camera
 * index, cells in row-major order. Forward (the yaw nearest 0°) takes the
 * center cell; the other cells are ordered by signed distance from it —
 * left of center (plus the middle column above it) negative, right (plus
 * below) positive — and the cameras, sorted by yaw, are laid along that
 * order. So angles radiate out to the left and right (negative yaw turns
 * left in ffmpeg's v360) and the rear lands on the outer edges. An even
 * number of columns puts forward just right of the geometric center. An
 * even number of rows has no center row, so those grids are laid out as a
 * map around the viewer instead (see below). Works for any yaw list; with
 * gridYaws the result is the identity, since those are already in this order.
 */
export function centeredLayout(rows, cols, yaws) {
  const n = rows * cols;
  const cx = (cols - 1) / 2;
  const cy = (rows - 1) / 2;
  let cells;
  let center;
  if (rows % 2 === 0) {
    // No center row to put forward in, so lay it out like a map around the
    // viewer instead: each cell's direction from the grid's center is the
    // direction it looks. Forward is top-middle, the rear bottom-middle —
    // on 3x2 the top row is what's in front, the bottom row what's behind.
    cells = Array.from({ length: n }, (_, i) => {
      const dx = (i % cols) - cx;
      const dy = Math.floor(i / cols) - cy;
      return { i, bearing: Math.atan2(dx, -dy), dist: Math.hypot(dx, dy) };
    });
    cells.sort((a, b) => a.bearing - b.bearing || a.dist - b.dist);
    center = cells.reduce((best, c, k) => (Math.abs(c.bearing) < Math.abs(cells[best].bearing) - 1e-9 ? k : best), 0);
  } else {
    cells = Array.from({ length: n }, (_, i) => {
      const dx = (i % cols) - cx;
      const dy = Math.floor(i / cols) - cy;
      const side = dx !== 0 ? Math.sign(dx) : Math.sign(dy);
      return { i, dy, s: side * Math.hypot(dx, dy) };
    });
    // Same distance, same side: the more horizontal cell is the more directly
    // left/right one, so it gets the angle nearer forward.
    cells.sort((a, b) => a.s - b.s || (Math.abs(a.dy) - Math.abs(b.dy)) * Math.sign(a.s) || a.dy - b.dy);
    center = cells.findIndex((c) => c.s >= 0);
  }

  const byYaw = yaws.map((y, cam) => ({ cam, y: normalizeYaw(y) })).sort((a, b) => a.y - b.y);
  const forward = byYaw.reduce((best, c, k) => (Math.abs(c.y) < Math.abs(byYaw[best].y) ? k : best), 0);
  const layout = new Array(n);
  cells.forEach((c, p) => { layout[c.i] = byYaw[(((p - center + forward) % n) + n) % n].cam; });
  return layout;
}

/**
 * Default camera aims for a format's matrix, read from the format's `aims`
 * table. Cells with an aim become cameras (numbered 1..N in reading order).
 * layout[cell] is that 1-based number, or null for a blind hole.
 */
export function gridAims(rows, cols, format) {
  const { aims, lenses = null } = getFormat(format);
  if (aims.length !== rows * cols) {
    throw new Error(`${format} has ${aims.length} cells, which does not match grid ${cols}x${rows}`);
  }
  const yaws = [];
  const pitches = [];
  const layout = aims.map((aim) => {
    if (!aim) return null;
    yaws.push(aim[0]);
    pitches.push(aim[1]);
    return yaws.length; // 1-based camera number
  });
  return {
    yaws,
    pitches,
    layout,
    mask: aims.map(Boolean),
    cameras: yaws.length,
    lenses,
  };
}

/**
 * A user's camera aims per format, as sent by the editor's lens editor:
 * {youtube: {yaws, pitches, rolls?, fovs?, removed}, reels: {...}}. Each
 * list has one value per camera of that format; `removed` lists camera
 * numbers the user turned off. `rolls` (degrees, wrapped into -180..180)
 * and `fovs` (field of view across the frame's long side, clamped to the
 * range of the camera's projection, 60..120 for flat) are optional: a missing
 * array means every camera at 0° and its projection's default fov, and an
 * array of only those defaults is dropped, so a layout saved before these
 * existed compares equal to the same layout saved now. `projections` (flat,
 * fisheye, planet or pannini per camera; anything else is flat) is kept only
 * when some camera is not flat. `bulges` (per camera {top, right, bottom,
 * left}, each -1..1, see bulgeWarp) is kept only when some side bows; a
 * missing one is the straight frame. `names` (per camera a name the user
 * gave it, or null for its number; trimmed, at most CAMERA_NAME_MAX
 * characters) is kept only when some camera has one; `colors` (per camera a
 * colour the user gave it, '#rrggbb', or null for its own) likewise. Throws a
 * 400 error on anything else.
 */
export const CAMERA_NAME_MAX = 16;

/** A camera name as kept: control characters gone, spaces trimmed, at most CAMERA_NAME_MAX characters; null when empty. */
export function cameraNameOf(raw) {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = [...raw.replace(/[\u0000-\u001f\u007f]/g, '').trim()].slice(0, CAMERA_NAME_MAX).join('').trim();
  return clean || null;
}

/** A camera colour as kept: '#rrggbb' in lower case, or null. */
export function cameraColorOf(raw) {
  return typeof raw === 'string' && /^#[0-9a-f]{6}$/i.test(raw.trim()) ? raw.trim().toLowerCase() : null;
}

export function sanitizeLayouts(raw) {
  if (raw == null) return {};
  const bad = (message) => Object.assign(new Error(message), { status: 400 });
  if (typeof raw !== 'object' || Array.isArray(raw)) throw bad('layouts must be an object');
  const out = {};
  for (const [format, layout] of Object.entries(raw)) {
    const spec = FORMATS[format];
    if (!spec) throw bad(`unknown layout format "${format}"`);
    const cameras = spec.aims.filter(Boolean).length;
    const { yaws, pitches } = layout || {};
    if (!Array.isArray(yaws) || !Array.isArray(pitches) || yaws.length !== cameras || pitches.length !== cameras) {
      throw bad(`${format} layout needs ${cameras} yaws and ${cameras} pitches`);
    }
    if (![...yaws, ...pitches].every((v) => typeof v === 'number' && Number.isFinite(v))) {
      throw bad(`${format} layout angles must be numbers`);
    }
    const extras = {};
    if (layout.projections != null) {
      if (!Array.isArray(layout.projections) || layout.projections.length !== cameras) throw bad(`${format} layout needs ${cameras} projections`);
      const clean = layout.projections.map(projectionOf);
      if (clean.some((v) => v !== 'flat')) extras.projections = clean;
    }
    if (layout.bulges != null) {
      if (!Array.isArray(layout.bulges) || layout.bulges.length !== cameras) throw bad(`${format} layout needs ${cameras} bulges`);
      const ok = (b) => b == null || (typeof b === 'object' && !Array.isArray(b)
        && Object.keys(b).every((side) => BULGE_SIDES.includes(side))
        && BULGE_SIDES.every((side) => b[side] == null || (typeof b[side] === 'number' && Number.isFinite(b[side]))));
      if (!layout.bulges.every(ok)) throw bad(`${format} bulges must be {top, right, bottom, left} numbers`);
      const clean = layout.bulges.map(bulgeOf);
      if (clean.some(hasBulge)) extras.bulges = clean;
    }
    if (layout.names != null) {
      if (!Array.isArray(layout.names) || layout.names.length !== cameras) throw bad(`${format} layout needs ${cameras} names`);
      if (!layout.names.every((n) => n == null || typeof n === 'string')) throw bad(`${format} names must be text or null`);
      const clean = layout.names.map(cameraNameOf);
      if (clean.some(Boolean)) extras.names = clean;
    }
    if (layout.colors != null) {
      if (!Array.isArray(layout.colors) || layout.colors.length !== cameras) throw bad(`${format} layout needs ${cameras} colors`);
      if (!layout.colors.every((c) => c == null || typeof c === 'string')) throw bad(`${format} colors must be text or null`);
      const clean = layout.colors.map(cameraColorOf);
      if (clean.some(Boolean)) extras.colors = clean;
    }
    const kinds = layoutProjections(extras, cameras);
    for (const key of ['rolls', 'fovs']) {
      const list = layout[key];
      if (list == null) continue;
      if (!Array.isArray(list) || list.length !== cameras) throw bad(`${format} layout needs ${cameras} ${key}`);
      if (!list.every((v) => typeof v === 'number' && Number.isFinite(v))) throw bad(`${format} ${key} must be numbers`);
      const clean = list.map((v, i) => {
        const value = key === 'rolls'
          ? Math.min(ROLL_LIMIT, Math.max(-ROLL_LIMIT, v - 360 * Math.round(v / 360)))
          : clampFov(kinds[i], v);
        return Math.round(value * 100) / 100;
      });
      const fallbackAt = (i) => (key === 'rolls' ? 0 : FOV_RANGES[kinds[i]].default);
      if (clean.some((v, i) => v !== fallbackAt(i))) extras[key] = clean;
    }
    const removed = layout.removed ?? [];
    if (!Array.isArray(removed) || !removed.every((c) => Number.isInteger(c) && c >= 1 && c <= cameras)) {
      throw bad(`${format} removed cameras must be numbers from 1 to ${cameras}`);
    }
    const off = [...new Set(removed)].sort((a, b) => a - b);
    out[format] = {
      yaws: yaws.map((y) => Math.round(normalizeYaw(y) * 100) / 100),
      pitches: pitches.map((p) => Math.round(Math.max(-90, Math.min(90, p)) * 100) / 100),
      ...extras,
      removed: off,
    };
  }
  return out;
}

/** A layout's per-camera rolls and fovs with the defaults filled in for `cameras` cameras. */
export function layoutRolls(layout, cameras) {
  const list = layout?.rolls;
  return Array.from({ length: cameras }, (_, i) => (Number.isFinite(list?.[i]) ? list[i] : 0));
}

/** Each camera's fov; one without a value takes the default of its projection (100° for flat). */
export function layoutFovs(layout, cameras) {
  const list = layout?.fovs;
  const kinds = layoutProjections(layout, cameras);
  return Array.from({ length: cameras }, (_, i) => (Number.isFinite(list?.[i]) ? list[i] : FOV_RANGES[kinds[i]].default));
}

/** Each camera's projection, "flat" where the layout names none or an unknown one. */
export function layoutProjections(layout, cameras) {
  const list = layout?.projections;
  return Array.from({ length: cameras }, (_, i) => projectionOf(list?.[i]));
}

/** Each camera's shape, every side 0 where the layout has none. */
export function layoutBulges(layout, cameras) {
  const list = layout?.bulges;
  return Array.from({ length: cameras }, (_, i) => bulgeOf(list?.[i]));
}

/** Yaw half of gridAims, for callers that only store headings. */
export function gridYaws(rows, cols, format = 'youtube') {
  return gridAims(rows, cols, format).yaws;
}

export const MATRIX_PROXY_WIDTH = 2048;

/**
 * How the 360° preview proxy is encoded. The editor draws the camera on screen (pans, a bar's own camera settings) live
 * from it while the video plays, so it must stream on an ordinary line: CRF 30 capped at 2.5 Mbit/s (it was CRF 24,
 * about 10 Mbit/s, which a 2 Mbit/s line could never keep up with). Softer on fast motion, still clearly readable; final
 * renders read the original source, never the proxy.
 */
export const PROXY_MAX_KBPS = 2500;
export function proxyVideoArgs(gop, fps) {
  return [
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
    '-maxrate', `${PROXY_MAX_KBPS}k`, '-bufsize', `${PROXY_MAX_KBPS * 2}k`, '-pix_fmt', 'yuv420p',
    '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
    '-x264-params', 'rc-lookahead=20:scenecut=0',
    '-r', fps,
  ];
}

/**
 * The 360° preview proxy on its own: the equirect scaled to 2048×1024 (proxyVideoArgs), source frame rate as an exact
 * fraction, audio copied (or encoded to AAC). The editor plays this and draws every camera live from it, so a 360°
 * footage needs no camera grid video.
 */
export async function buildEquirectProxy(src, proxyOut, { onProgress, signal, log } = {}) {
  if (!proxyOut) throw new Error('a 360° proxy needs an output path');
  const info = await probe(src);
  const videoStream = info.streams.find((s) => s.codec_type === 'video');
  if (!videoStream) throw new Error(`${src} has no video stream`);
  const timing = videoTiming(videoStream);
  const audio = info.streams.find((s) => s.codec_type === 'audio');
  const w = MATRIX_PROXY_WIDTH;
  const h = MATRIX_PROXY_WIDTH / 2;
  fs.mkdirSync(path.dirname(proxyOut), { recursive: true });
  const gop = Math.max(1, Math.round(timing.num / timing.den));
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...reconnectArgs(src),
    '-i', src,
    '-filter_complex_threads', String(Math.max(1, containerLimits().cpus)),
    '-filter_complex', `[0:v]scale=${w}:${h}:flags=bilinear,format=yuv420p[proxy]`,
  ];
  if (onProgress && timing.duration) args.push('-progress', 'pipe:1');
  args.push('-map', '[proxy]');
  if (audio) args.push('-map', '0:a:0');
  args.push(...proxyVideoArgs(gop, `${timing.num}/${timing.den}`));
  if (audio) args.push(...(audio.codec_name === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k']));
  args.push('-movflags', '+faststart', proxyOut);
  const started = Date.now();
  await run(FFMPEG, args, {
    signal,
    onProgress: onProgress && timing.duration
      ? (secs) => onProgress(Math.min(1, Math.max(0, secs / timing.duration)))
      : undefined,
  });
  log?.(`360° preview proxy ${w}x${h}, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return { proxy: proxyOut, width: w, height: h, duration: timing.duration };
}

/**
 * A normal (non-360) video has one camera, the whole
 * frame. Only the preview proxy is built — the source scaled to
 * `flatProxySize`, aspect kept, source frame rate kept as an exact fraction
 * so previews share its time_base, audio copied (or encoded to AAC).
 */
export async function buildFlatProxy(src, proxyOut, { onProgress, signal, log } = {}) {
  if (!proxyOut) throw new Error('a flat proxy needs an output path');
  const info = await probe(src);
  const videoStream = info.streams.find((s) => s.codec_type === 'video');
  if (!videoStream) throw new Error(`${src} has no video stream`);
  const timing = videoTiming(videoStream);
  const audio = info.streams.find((s) => s.codec_type === 'audio');
  const proxy = flatProxySize(videoStream.width, videoStream.height);
  const graph = `[0:v]scale=${proxy.w}:${proxy.h}:flags=bilinear,format=yuv420p[proxy]`;
  if (graph.includes('v360')) throw new Error('flat proxy must not use v360');
  fs.mkdirSync(path.dirname(proxyOut), { recursive: true });
  const gop = Math.max(1, Math.round(timing.num / timing.den));
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...reconnectArgs(src),
    '-i', src,
    '-filter_complex_threads', String(Math.max(1, containerLimits().cpus)),
    '-filter_complex', graph,
  ];
  if (onProgress && timing.duration) args.push('-progress', 'pipe:1');
  args.push('-map', '[proxy]');
  if (audio) args.push('-map', '0:a:0');
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
    '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
    '-x264-params', 'rc-lookahead=20:scenecut=0',
    '-r', `${timing.num}/${timing.den}`,
  );
  if (audio) args.push(...(audio.codec_name === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k']));
  args.push('-movflags', '+faststart', proxyOut);
  const started = Date.now();
  await run(FFMPEG, args, {
    signal,
    onProgress: onProgress && timing.duration
      ? (secs) => onProgress(Math.min(1, Math.max(0, secs / timing.duration)))
      : undefined,
  });
  log?.(`flat preview proxy ${proxy.w}x${proxy.h}, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return { proxy: proxyOut, width: proxy.w, height: proxy.h, duration: timing.duration };
}
