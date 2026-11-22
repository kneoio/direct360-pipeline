/**
 * Output formats — the shape of the final video. The camera grid's cells use
 * the same shape, so what you pick from is framed like what you'll get.
 *
 * `grid` is cols×rows. `aims` is row-major: [yaw, pitch] in degrees for a
 * camera, null for a blind cell. Blind cells stay black in the matrix video.
 * Yaw 0 / pitch 0 is the center of the equirect frame (the front lens on a
 * stitched GoPro), so yaws past ±90 look through the back lens. The angles
 * assume the default 100° field of view across the frame's long side.
 *
 * `lenses` names two blind cells that show the whole front and back lens as
 * fisheye circles, so the editor can draw each camera's share of the lens
 * on top of them.
 */
const __ = null;

export const FORMATS = {
  youtube: {
    label: 'YouTube 16:9',
    aspect: [16, 9],
    // `final` is the default download. `resolutions` are the sizes a final
    // render may ask for; 720p uses the same encode as 1080p, just fewer pixels.
    final: [1920, 1080],
    resolutions: [
      { id: '1080', label: '1080p', width: 1920, height: 1080 },
      { id: '720', label: '720p', width: 1280, height: 720 },
    ],
    preview: [480, 270],
    grid: '3x7',
    // The top row holds the two lens circles. Then 3×3 per lens, tilted up,
    // level, and down: front is cameras 1–9 (center 5), back is 10–18
    // (center 14), left to right as seen when facing that way.
    aims: [
      __,         __,         __,
      [-90, 50],  [0, 50],    [90, 50],
      [-90, 0],   [0, 0],     [90, 0],
      [-90, -50], [0, -50],   [90, -50],
      // Same spread as the front, swung around to face backward: 80° left,
      // center, 80° right. 90° would sit on the seam and count as the front.
      [100, 50],  [180, 50],  [-100, 50],
      [100, 0],   [180, 0],   [-100, 0],
      [100, -50], [180, -50], [-100, -50],
    ],
    lenses: { front: 0, back: 2 },
    // One lens, row-major. Applied on its own to the front cameras and again
    // to the back cameras: the level row starts on (cameras 4–6 in front,
    // 13–15 in back, six in all, as on TikTok), the tilted rows start off.
    lensOn: [
      0, 0, 0,
      1, 1, 1,
      0, 0, 0,
    ],
  },
  reels: {
    label: 'TikTok 9:16',
    aspect: [9, 16],
    final: [1080, 1920],
    resolutions: [
      { id: '1080', label: '1080p', width: 1080, height: 1920 },
      { id: '720', label: '720p', width: 720, height: 1280 },
    ],
    preview: [270, 480],
    grid: '3x5',
    // The top row holds the two lens circles. Then 3×2 per lens, level and
    // tilted down: front is 1–6 (center 2), back is 7–12 (center 8), left to
    // right as seen when facing that way.
    aims: [
      __,          __,         __,
      [-50, 0],    [0, 0],     [50, 0],
      [-50, -45],  [0, -45],   [50, -45],
      [130, 0],    [180, 0],   [-130, 0],
      [130, -45],  [180, -45], [-130, -45],
    ],
    lenses: { front: 0, back: 2 },
    // One lens, row-major. Applied on its own to each lens: the level row
    // (cameras 1–3 in front, 7–9 in back) starts on, the tilted row starts off.
    lensOn: [
      1, 1, 1,
      0, 0, 0,
    ],
  },
};

export function getFormat(name) {
  const format = FORMATS[name];
  if (!format) throw new Error(`unknown format "${name}" — use ${Object.keys(FORMATS).join(' or ')}`);
  return format;
}

/**
 * Pixel size for a render. Preview is the fixed scouting size. A download
 * uses `final` unless `resolution` names one of that format's `resolutions`.
 */
export function outputSize(format, { preview = false, resolution } = {}) {
  const spec = getFormat(format);
  if (preview) return { width: spec.preview[0], height: spec.preview[1] };
  if (resolution == null) return { width: spec.final[0], height: spec.final[1] };
  const match = spec.resolutions.find((r) => r.id === resolution);
  if (!match) {
    const ids = spec.resolutions.map((r) => r.id).join(', ');
    throw new Error(`unknown resolution "${resolution}" for ${format} — use ${ids}`);
  }
  return { width: match.width, height: match.height };
}

/** Per-camera roll (degrees) and zoom (field of view across the frame's long side). */
export const ROLL_LIMIT = 180;
export const FOV_MIN = 30;
export const FOV_MAX = 150;
export const FOV_DEFAULT = 100;

/**
 * Per-camera projection: how the camera's view is drawn from the sphere. `flat`
 * is the ordinary rectilinear view; the others are v360 outputs. Each has its
 * own range of zoom, and a camera's fov is always held inside its projection's.
 */
export const PROJECTIONS = ['flat', 'fisheye', 'planet', 'pannini'];
export const PROJECTION_DEFAULT = 'flat';
export const PROJECTION_V360 = { flat: 'flat', fisheye: 'fisheye', planet: 'sg', pannini: 'pannini' };
export const FOV_RANGES = {
  flat: { min: FOV_MIN, max: FOV_MAX, default: FOV_DEFAULT },
  fisheye: { min: 60, max: 280, default: 160 },
  planet: { min: 60, max: 340, default: 260 },
  pannini: { min: 120, max: 170, default: 140 },
};

/** A stored projection name, or "flat" for a missing or unknown one. */
export function projectionOf(value) {
  return PROJECTIONS.includes(value) ? value : PROJECTION_DEFAULT;
}

/** `fov` held inside the range of `projection`. */
export function clampFov(projection, fov) {
  const { min, max } = FOV_RANGES[projectionOf(projection)];
  return Math.min(max, Math.max(min, fov));
}

/**
 * Horizontal/vertical field of view for a flat frame: `fov` degrees across its
 * long side, the short side scaled to match — so a portrait frame gets the
 * same zoom as a landscape one, turned on its side.
 */
export function fieldOfView(width, height, fov = 100) {
  return width >= height
    ? { hfov: fov, vfov: Math.round((fov * height) / width) }
    : { hfov: Math.round((fov * width) / height), vfov: fov };
}

/**
 * v360's pannini output ignores h_fov and v_fov: it always draws about ±84°
 * across a square field, x growing with sin(longitude). Its zoom is made by
 * rendering a larger square and cropping the frame from the middle of it.
 */
const PANNINI_EDGE = Math.sin((84 * Math.PI) / 180);
export const PANNINI_FOV = 150;

/**
 * The square v360 renders for a pannini frame at `fov` degrees across its long side, as every other projection
 * measures it; the frame is cropped from its middle. (Across the width, a tall 9:16 frame never needed a square
 * larger than its height, so its zoom changed nothing.)
 */
export function panniniSide(width, height, fov) {
  const wanted = (Math.max(width, height) * PANNINI_EDGE) / Math.sin((Math.min(fov, 170) * Math.PI) / 360);
  return Math.ceil(Math.max(wanted, width, height) / 2) * 2;
}

/**
 * `fieldOfView` for a projection. Flat keeps today's maths. Fisheye is
 * equidistant, so the angle splits by the plain ratio of the sides. Planet
 * (stereographic) puts the edge at tan(fov / 4), so the short side takes the
 * same share of that tangent. Pannini has no fov in v360: it gets the fixed
 * PANNINI_FOV and `panniniSide` does the zoom.
 */
export function projectedFieldOfView(width, height, fov, projection = PROJECTION_DEFAULT, bulge = null) {
  const kind = projectionOf(projection);
  if (kind === 'pannini') return fieldOfView(width, height, PANNINI_FOV);
  let view;
  if (kind === 'flat' || kind === 'fisheye') {
    view = fieldOfView(width, height, fov);
  } else {
    const long = Math.max(width, height);
    const short = Math.min(width, height);
    const across = Math.round((4 * Math.atan((short / long) * Math.tan((fov * Math.PI) / 720)) * 180) / Math.PI);
    view = width >= height ? { hfov: fov, vfov: across } : { hfov: across, vfov: fov };
  }
  if (!hasBulge(bulge)) return view;
  // A bowed frame is drawn wider (see projectionStage), so the view widens with it.
  const { ex, ey } = bulgeCanvas(width, height, bulge, kind, fov);
  return { hfov: widenFov(kind, view.hfov, ex), vfov: widenFov(kind, view.vfov, ey) };
}

/**
 * The pieces of a v360 view in `projection`: the `output` name, the `w` and
 * `h` v360 renders, the `crop` filter that follows when that is larger than
 * the frame (pannini only; empty otherwise), and `post`, the text to put
 * straight after the v360 filter (the crop, or for a bowed frame the warp
 * back to `width`×`height`; empty when there is nothing). A bowed frame
 * (`bulge`) is drawn larger and warped by `bulgeWarp` with remap; `tag`
 * keeps the warp's filter labels apart when one graph holds several.
 */
export function projectionStage(projection, width, height, fov, bulge = null, tag = 'w') {
  const kind = projectionOf(projection);
  if (!hasBulge(bulge)) {
    if (kind !== 'pannini') return { output: PROJECTION_V360[kind], w: width, h: height, crop: '', post: '' };
    const side = panniniSide(width, height, fov);
    return { output: 'pannini', w: side, h: side, crop: `crop=${width}:${height}`, post: `,crop=${width}:${height}` };
  }
  const q = BULGE_SUPERSAMPLE;
  let w;
  let h;
  let halfW;
  let halfH;
  if (kind === 'pannini') {
    // Pannini has no fov to widen: the square already holds all it can draw
    // (about ±84° across). The frame sits in its middle; a side bowed past
    // that square takes the square's edge.
    const side = panniniSide(width, height, fov);
    w = even(side * q);
    h = w;
    halfW = (width * w) / (2 * side);
    halfH = (height * w) / (2 * side);
  } else {
    ({ w, h } = bulgeCanvas(width, height, bulge, kind, fov));
    halfW = (width * q) / 2;
    halfH = (height * q) / 2;
  }
  return {
    output: PROJECTION_V360[kind], w, h, crop: '',
    post: bulgeRemap(bulge, { srcW: w, srcH: h, halfW, halfH, outW: width * q, outH: height * q, width, height, tag, projection: kind, fov }),
  };
}

/**
 * The remap that warps a larger v360 view (srcW×srcH, the straight frame's
 * half-size halfW×halfH pixels round its middle) into the bowed frame at
 * outW×outH, then scales it to width×height. The two maps are one frame
 * each, made by geq; remap holds them for every frame. They sit far before
 * any video time so a part that starts late still has them.
 */
function bulgeRemap(bulge, { srcW, srcH, halfW, halfH, outW, outH, width, height, tag, projection = PROJECTION_DEFAULT, fov = FOV_DEFAULT }) {
  const n = (v) => +Number(v).toFixed(6);
  const k = (side) => n(BULGE_REACH * (Number(bulge?.[side]) || 0));
  // u right, v up, both -1..1 over the output's pixel centres.
  const u = `((2*X+1)/W-1)`;
  const v = `(1-(2*Y+1)/H)`;
  let su = `${u}*(1+if(gte(${u},0),${k('right')},${k('left')})*(1-${v}*${v}))`;
  let sv = `${v}*(1+if(gte(${v},0),${k('top')},${k('bottom')})*(1-${u}*${u}))`;
  const suBows = su;
  const svBows = sv;
  // Corner moves, each fading to nothing at the other three corners.
  (bulge?.corners ?? []).forEach((c, i) => {
    const [cu, cv] = BULGE_CORNERS[i] ?? [];
    if (cu == null) return;
    const w = `(1+(${cu})*${u})*(1+(${cv})*${v})/4`;
    if (Number(c?.[0])) su += `+(${n(c[0])})*${w}`;
    if (Number(c?.[1])) sv += `+(${n(c[1])})*${w}`;
  });
  // Side middles slid along their sides.
  const s = bulge?.shift;
  if (s) {
    const along = (pos, neg, a, b) => {
      const parts = [];
      if (Number(a)) parts.push(`max(${pos},0)*(${n(a)})`);
      if (Number(b)) parts.push(`max(-${pos},0)*(${n(b)})`);
      return parts.length ? `+(1-${neg}*${neg})*(${parts.join('+')})` : '';
    };
    su += along(v, u, s.top, s.bottom);
    sv += along(u, v, s.right, s.left);
  }
  // A bows-only shape keeps its old expression; with added terms the sum is bracketed.
  const group = (e, plain) => (e === plain ? e : `(${e})`);
  // A wide projection bent looser or stronger: the shaped point moves to where the standard picture has its direction.
  const bent = strengthExpressions(projection, width, height, fov, strengthOf(bulge), group(su, suBows), group(sv, svBows));
  const fu = bent ? `(${bent[0]})` : group(su, suBows);
  const fv = bent ? `(${bent[1]})` : group(sv, svBows);
  const xmap = `clip(floor(${n(srcW / 2)}+${fu}*${n(halfW)}),0,${srcW - 1})`;
  const ymap = `clip(floor(${n(srcH / 2)}-${fv}*${n(halfH)}),0,${srcH - 1})`;
  const map = (expr) => `nullsrc=s=${outW}x${outH}:d=1,format=gray16le,geq=lum='${expr}',trim=end_frame=1,setpts=PTS-1000000/TB`;
  return `[${tag}v];${map(xmap)}[${tag}x];${map(ymap)}[${tag}y];`
    + `[${tag}v][${tag}x][${tag}y]remap=fill=black,scale=${width}:${height}:flags=area`;
}
/**
 * Per-camera shape: each side of the frame can bow out or in. A value per
 * side, -1..1, 0 is today's straight side. At 1 the middle of that side sits
 * BULGE_REACH of the frame's half-size further out (the camera sees more
 * there, squeezed into the same rectangle); at -1 that far in (it sees less,
 * stretched). The corners never move. The output is still a rectangle: the
 * picture is warped, not masked. `bulgeWarp` is the one mapping the editor
 * draws with and the render samples with.
 */
export const BULGE_SIDES = ['top', 'right', 'bottom', 'left'];
export const BULGE_REACH = 0.5;
/** A bowed view is drawn this many times larger, warped, then scaled down, so its edges stay smooth. */
export const BULGE_SUPERSAMPLE = 2;

/**
 * The frame's corners and side middles can also be moved (as the web editor's
 * lens.js does). `corners` moves each corner (top-left, top-right,
 * bottom-right, bottom-left) by [du, dv] in frame units (1 is half the frame,
 * u right, v up); `shift` slides each side's middle along its side (top and
 * bottom: + is right; left and right: + is up). Each number is held within
 * ±BULGE_PIN_MAX, three decimals.
 */
export const BULGE_CORNERS = [[-1, 1], [1, 1], [1, -1], [-1, -1]];
export const BULGE_PIN_MAX = 0.75;

const pin = (raw) => {
  const v = Number(raw);
  return Number.isFinite(v) ? Math.round(Math.min(BULGE_PIN_MAX, Math.max(-BULGE_PIN_MAX, v)) * 1000) / 1000 || 0 : 0;
};

/**
 * A stored shape with every side a number in -1..1 (two decimals); a missing
 * or broken side is 0. `shift` and `corners` are kept only when something in
 * them is not 0.
 */
export function bulgeOf(value) {
  const out = {};
  for (const side of BULGE_SIDES) {
    const v = Number(value?.[side]);
    out[side] = Number.isFinite(v) ? Math.round(Math.min(1, Math.max(-1, v)) * 100) / 100 || 0 : 0;
  }
  const shift = Object.fromEntries(BULGE_SIDES.map((side) => [side, pin(value?.shift?.[side])]));
  if (BULGE_SIDES.some((side) => shift[side])) out.shift = shift;
  const corners = BULGE_CORNERS.map((_, k) => [pin(value?.corners?.[k]?.[0]), pin(value?.corners?.[k]?.[1])]);
  if (corners.some(([a, b]) => a || b)) out.corners = corners;
  const strength = Number(value?.strength);
  const held = Number.isFinite(strength) ? Math.round(Math.min(1, Math.max(-1, strength)) * 100) / 100 || 0 : 0;
  if (held) out.strength = held;
  return out;
}

/**
 * True when the frame needs the warp: some side bows, some corner or side middle moves, or a wide projection bends
 * looser or stronger than its standard (`strength`, see strengthWarp; a flat camera ignores it).
 */
export function hasBulge(bulge) {
  const b = bulgeOf(bulge);
  return BULGE_SIDES.some((side) => Boolean(b[side])) || !!b.shift || !!b.corners || !!b.strength;
}

/**
 * How strongly a wide projection bends, -1 … 1 (`strength` in the shape; 0 is the projection's standard look, which is
 * what v360 draws). Each projection is a curve of one family, `radial(k, angle)`: k > 0 bends like tan (towards a
 * normal lens), k < 0 like sin (towards a ball), 0 is the plain angle. Fisheye's standard is k 0 (equidistant),
 * planet's k ½ (stereographic), pannini's k -1 across (sine of longitude) and 1 up and down (tangent of latitude).
 * The web editor's lens.js has the same curves, so the render is what the editor shows.
 */
export const radial = (k, t) => (k > 1e-4 ? Math.tan(k * t) / k : k < -1e-4 ? Math.sin(-k * t) / -k : t);
export const radialInverse = (k, x) => (k > 1e-4 ? Math.atan(k * x) / k : k < -1e-4 ? Math.asin(Math.min(1, Math.max(-1, -k * x))) / -k : x);
/** The pannini square's edge as a longitude (v360 draws about ±84°). */
const PANNINI_EDGE_LON = (84 * Math.PI) / 180;
/** The curves of `projection` at `strength` and zoom `fov`: [k, kv] (kv only for pannini's up and down). */
export function strengthCurves(projection, strength = 0, fov = FOV_RANGES[projectionOf(projection)].default) {
  const s = Math.min(1, Math.max(-1, Number(strength) || 0));
  // The largest |k| whose curve still holds the frame's widest angle (half the fov) before tan or sin turns.
  const fits = (0.98 * 90) / (fov / 2);
  if (projection === 'fisheye') return [s < 0 ? -s * Math.min(1, fits) : -s * Math.min(0.9, fits), 0];
  if (projection === 'planet') return [s >= 0 ? 0.5 + s * Math.max(0, Math.min(0.75, fits - 0.06) - 0.5) : 0.5 + s * (0.5 + fits), 0];
  if (projection === 'pannini') return [s < 0 ? -1 - 1.6 * s : -1 - 0.06 * s, s > 0 ? 1 - 1.6 * s : 1];
  return [0, 0];
}
/** A shape's strength (0 when it has none). */
export const strengthOf = (bulge) => Number(bulgeOf(bulge).strength) || 0;

/** The frame's axes as the editor measures them (from the fov at 100°): x across, y up, the short one shrunk. */
function frameAxes(width, height) {
  const base = fieldOfView(width, height, 100);
  const wide = base.hfov >= base.vfov;
  const s = wide ? base.vfov / base.hfov : base.hfov / base.vfov;
  return wide ? [1, s] : [s, 1];
}

/**
 * The point (u, v) of a camera's frame drawn at `strength`, as the point of the same direction in the projection's
 * standard frame (where v360 draws it). Flat, or strength 0, leaves it where it is.
 */
export function strengthWarp(projection, width, height, fov, strength, u, v) {
  const kind = projectionOf(projection);
  const s = Number(strength) || 0;
  if (kind === 'flat' || !s) return [u, v];
  const [k, kv] = strengthCurves(kind, s, fov);
  const [k0, kv0] = strengthCurves(kind, 0, fov);
  if (kind === 'pannini') {
    const side = panniniSide(width, height, fov);
    const r = side / width;
    const rq = side / height;
    const lon = radialInverse(k, (Math.min(r, Math.max(-r, u)) / r) * radial(k, PANNINI_EDGE_LON));
    const lat = radialInverse(kv, Math.min(rq, Math.max(-rq, v)) / rq);
    return [(r * radial(k0, lon)) / radial(k0, PANNINI_EDGE_LON), rq * radial(kv0, lat)];
  }
  const [a, b] = frameAxes(width, height);
  const rho = Math.hypot(u * a, v * b);
  if (rho < 1e-9) return [u, v];
  const edge = ((fov / 2) * Math.PI) / 180;
  const off = radialInverse(k, rho * radial(k, edge));
  const f = radial(k0, off) / radial(k0, edge) / rho;
  return [u * f, v * f];
}

/** strengthWarp as geq expressions of the frame point expressions `u` and `v`: [u, v], or null when it changes nothing. */
function strengthExpressions(projection, width, height, fov, strength, u, v) {
  const kind = projectionOf(projection);
  const s = Number(strength) || 0;
  if (kind === 'flat' || !s) return null;
  const n = (x) => +Number(x).toFixed(9);
  const curve = (k, t) => (k > 1e-4 ? `tan(${n(k)}*${t})/${n(k)}` : k < -1e-4 ? `sin(${n(-k)}*${t})/${n(-k)}` : t);
  const inverse = (k, x) => (k > 1e-4 ? `atan(${n(k)}*${x})/${n(k)}` : k < -1e-4 ? `asin(clip(${n(-k)}*${x},-1,1))/${n(-k)}` : x);
  const [k, kv] = strengthCurves(kind, s, fov);
  const [k0, kv0] = strengthCurves(kind, 0, fov);
  if (kind === 'pannini') {
    const side = panniniSide(width, height, fov);
    const r = side / width;
    const rq = side / height;
    const lon = inverse(k, `clip(${u},${n(-r)},${n(r)})*${n(radial(k, PANNINI_EDGE_LON) / r)}`);
    const lat = inverse(kv, `clip(${v},${n(-rq)},${n(rq)})*${n(1 / rq)}`);
    return [`${n(r / radial(k0, PANNINI_EDGE_LON))}*${curve(k0, `(${lon})`)}`, `${n(rq)}*${curve(kv0, `(${lat})`)}`];
  }
  const [a, b] = frameAxes(width, height);
  const edge = ((fov / 2) * Math.PI) / 180;
  // ld(0), ld(1): the frame point; ld(2) its distance from the middle; ld(3) the angle there; ld(4) the scale.
  const scale = `st(0,${u});st(1,${v});st(2,hypot(ld(0)*${n(a)},ld(1)*${n(b)}));`
    + `st(3,${inverse(k, `ld(2)*${n(radial(k, edge))}`)});`
    + `st(4,if(gt(ld(2),0.000000001),(${curve(k0, 'ld(3)')})*${n(1 / radial(k0, edge))}/ld(2),1));`;
  return [`${scale}ld(0)*ld(4)`, `${scale}ld(1)*ld(4)`];
}

/** The whole warp of a camera's frame: its shape, then its strength. */
export function frameWarp(projection, width, height, fov, bulge, u, v) {
  const [x, y] = bulgeWarp(bulge, u, v);
  return strengthWarp(projection, width, height, fov, strengthOf(bulge), x, y);
}

/** True when two shapes are the same (anything missing is 0). */
export function sameBulge(a, b) {
  return JSON.stringify(bulgeOf(a)) === JSON.stringify(bulgeOf(b));
}

/**
 * The point of the straight frame that the shaped frame shows at (u, v):
 * both -1..1 across the frame, v up. The bows push each side's middle out or
 * in (the top side lands on v = 1 + BULGE_REACH * top * (1 - u²), and so on
 * round); each corner's move spreads over the frame, fading to nothing at the
 * other corners; a side's shift slides its middle along it, fading to nothing
 * at its corners and at the frame's middle line.
 */
export function bulgeWarp(bulge, u, v) {
  const kx = BULGE_REACH * (Number(u >= 0 ? bulge?.right : bulge?.left) || 0);
  const ky = BULGE_REACH * (Number(v >= 0 ? bulge?.top : bulge?.bottom) || 0);
  let x = u * (1 + kx * (1 - v * v));
  let y = v * (1 + ky * (1 - u * u));
  if (bulge?.corners) {
    BULGE_CORNERS.forEach(([cu, cv], k) => {
      const w = ((1 + u * cu) * (1 + v * cv)) / 4;
      x += (Number(bulge.corners[k]?.[0]) || 0) * w;
      y += (Number(bulge.corners[k]?.[1]) || 0) * w;
    });
  }
  const s = bulge?.shift;
  if (s) {
    x += (1 - u * u) * (Math.max(v, 0) * (Number(s.top) || 0) + Math.max(-v, 0) * (Number(s.bottom) || 0));
    y += (1 - v * v) * (Math.max(u, 0) * (Number(s.right) || 0) + Math.max(-u, 0) * (Number(s.left) || 0));
  }
  return [x, y];
}

/** Points sampled per side of the frame's edge to find how far a shape reaches. */
const REACH_SAMPLES = 64;

/**
 * A strength reaching further than this many frame halves (a much looser tiny planet's far corners) is drawn to that
 * edge: the view v360 would need grows without bound there.
 */
export const STRENGTH_REACH_MAX = 2.5;

/**
 * How far out of the straight frame a shaped one reaches, per axis, in frame
 * halves (1 = no further): the furthest |x| and |y| the frame's edge warps to.
 * With `view` ({ projection, width, height, fov }) the strength counts too.
 */
export function bulgeReach(bulge, view = null) {
  const warp = view
    ? (u, v) => frameWarp(view.projection, view.width, view.height, view.fov, bulge, u, v)
    : (u, v) => bulgeWarp(bulge, u, v);
  let x = 1;
  let y = 1;
  for (let i = 0; i <= REACH_SAMPLES; i += 1) {
    const t = -1 + (2 * i) / REACH_SAMPLES;
    for (const [u, v] of [[t, 1], [t, -1], [1, t], [-1, t]]) {
      const [px, py] = warp(u, v);
      x = Math.max(x, Math.abs(px));
      y = Math.max(y, Math.abs(py));
    }
  }
  return { x: Math.min(x, STRENGTH_REACH_MAX), y: Math.min(y, STRENGTH_REACH_MAX) };
}

const even = (n) => Math.ceil(n / 2) * 2;

/**
 * The size v360 draws a bowed flat, fisheye or planet frame at: the frame
 * at BULGE_SUPERSAMPLE times, widened to hold the reach. `ex` and `ey` are
 * how much wider and taller that view is than the straight frame (after
 * rounding to even pixels), which is what the field of view grows by.
 */
function bulgeCanvas(width, height, bulge, projection = PROJECTION_DEFAULT, fov = FOV_DEFAULT) {
  const q = BULGE_SUPERSAMPLE;
  const reach = bulgeReach(bulge, { projection, width, height, fov });
  const w = even(width * q * reach.x);
  const h = even(height * q * reach.y);
  return { w, h, ex: w / (width * q), ey: h / (height * q) };
}

/** A field of `fov` degrees whose edge moves `k` times further out in the image plane of `kind` (flat, fisheye or planet). */
function widenFov(kind, fov, k) {
  if (k === 1) return fov;
  const r = Math.PI / 180;
  if (kind === 'flat') return (2 * Math.atan(k * Math.tan((fov * r) / 2))) / r;
  if (kind === 'fisheye') return Math.min(360, fov * k);
  return Math.min(359, (4 * Math.atan(k * Math.tan((Math.min(fov, 359) * r) / 4))) / r);
}
