import { bulgeWarp, frameVector, panniniSideUnits, radial, radialInverse, strengthCurves, strengthOf } from './formats.js';

/**
 * A camera transition drawn as the web editor's live view draws it (direct360-web lens.js transitionDirection and
 * panoGl): one picture bent from the first camera into the second, never the two laid over each other. Each point of
 * the frame slides along the sphere, by the new camera's weight, from what the first picture shows there to what the
 * second shows there. Two pictures of different projections meet only in the middle, so laid over each other they
 * showed everything else twice; bent into one another nothing ever shows twice. ffmpeg's filters cannot bend a
 * picture by a map that changes every frame, so the frames are drawn here from the decoded equirect.
 */

const RAD = Math.PI / 180;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** The farthest a round picture of a transition reaches off its middle: just short of straight behind (lens.js). */
export const TRANSITION_REACH = 0.99 * Math.PI;

/** lens.js orient: a direction in the camera's view (x right, y up, z ahead) turned to its yaw and pitch (degrees). */
function orient(yaw, pitch, x, y, z) {
  const cp = Math.cos(pitch * RAD);
  const sp = Math.sin(pitch * RAD);
  const cy = Math.cos(yaw * RAD);
  const sy = Math.sin(yaw * RAD);
  const y2 = y * cp + z * sp;
  const z2 = -y * sp + z * cp;
  const x3 = x * cy + z2 * sy;
  const z3 = -x * sy + z2 * cy;
  const n = Math.hypot(x3, y2, z3) || 1;
  return [x3 / n, y2 / n, z3 / n];
}

/**
 * lens.js transitionPoint: the point of a transition's picture (frame zoom applied) that a point (u, v) of the frame
 * shows, held where the picture still shows something new. A round picture (fisheye, planet) zoomed out far enough
 * goes round past straight behind and shows the same world again, and a sin-like strength runs out of picture before
 * that; past either, the point stays on that edge along its line out from the middle. Pannini holds to its square in
 * frameVector. So the two pictures' points lie less than half a turn apart on the same line out, and the bend is one
 * smooth slide.
 */
export function transitionPoint(pic, u, v, base) {
  const z = pic.zoom ?? [1, 1];
  u *= z[0];
  v *= z[1];
  if (pic.projection !== 'fisheye' && pic.projection !== 'planet') return [u, v];
  const [k] = curvesOf(pic);
  const wide = base.hfov >= base.vfov;
  const s = wide ? base.vfov / base.hfov : base.hfov / base.vfov;
  const rho = Math.hypot(u * (wide ? 1 : s), v * (wide ? s : 1));
  const last = k < -1e-4 ? Math.min(TRANSITION_REACH, Math.PI / 2 / -k) : TRANSITION_REACH;
  const most = k > 1e-4 && k * last >= Math.PI / 2 ? Infinity : radial(k, last) / radial(k, (pic.fov / 2) * RAD);
  return rho > most ? [(u * most) / rho, (v * most) / rho] : [u, v];
}

/** v360's pannini square reaches this longitude at its side (formats.js). */
const PANNINI_EDGE_LON = 84 * RAD;
/** The farthest sideways and up or down a pannini carried on past its square reaches (never quite). */
const PANNINI_LON_MOST = 179 * RAD;
const PANNINI_LAT_MOST = 89 * RAD;

/** How fast radialInverse(k, x) grows with x. */
const radialInverseSlope = (k, x) => (k > 1e-4 ? 1 / (1 + k * k * x * x) : k < -1e-4 ? 1 / Math.sqrt(Math.max(1e-6, 1 - k * k * x * x)) : 1);
/** The most a pannini carried on past its square turns per frame unit as it leaves the square (radians). */
const PANNINI_PAST_SLOPE = 3;

/**
 * One axis of a pannini at `t` (frame units): inside its square (±side, reaching `edge` radians at its side) as
 * frameVector draws it with curve `k`; past it carried on, at its side's own rate (no faster than PANNINI_PAST_SLOPE),
 * easing out towards `most` radians, never reaching it: always turning on, never round past it.
 */
function panniniAngle(k, t, side, edge, most) {
  const inside = Math.min(side, Math.abs(t));
  const angle = radialInverse(k, (inside / side) * radial(k, edge));
  const past = Math.abs(t) - inside;
  if (past <= 0) return Math.sign(t) * angle;
  const room = most - angle;
  const slope = Math.min(PANNINI_PAST_SLOPE, (radialInverseSlope(k, radial(k, edge)) * radial(k, edge)) / side);
  return Math.sign(t) * (angle + room * Math.tanh((past * slope) / room));
}

/**
 * lens.js transitionVector: the direction (before the aim) a transition's picture shows at a held point. A pannini
 * zoomed out past its square carries on past it (panniniAngle: longitude towards straight sideways and behind,
 * latitude towards straight up or down) instead of repeating its edge, which showed as a smeared band down the frame's
 * side while the other picture bent in.
 */
export function transitionVector(pic, u, v, base) {
  if (pic.projection !== 'pannini') return frameVector(pic.projection, u, v, base, pic.fov, strengthOfPic(pic));
  const [k, kv] = curvesOf(pic);
  const q = base.vfov / base.hfov;
  const r = panniniSideUnits(q, pic.fov);
  const lon = panniniAngle(k, u, r, PANNINI_EDGE_LON, PANNINI_LON_MOST);
  // Up and down the square reaches ±r/q frame heights, at latitude radialInverse(kv, 1) (radial of it is 1).
  const lat = panniniAngle(kv, v, r / q, radialInverse(kv, 1), PANNINI_LAT_MOST);
  return [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
}

/** lens.js slerpDirection: the direction `w` of the way from unit direction `a` to `b` along the sphere. */
export function slerpDirection(a, b, w) {
  const angle = Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1));
  const s = Math.sin(angle);
  const ka = s < 1e-6 ? 1 - w : Math.sin((1 - w) * angle) / s;
  const kb = s < 1e-6 ? w : Math.sin(w * angle) / s;
  const d = [a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb];
  const n = Math.hypot(d[0], d[1], d[2]);
  return n > 0 ? [d[0] / n, d[1] / n, d[2] / n] : a;
}

/** What each picture of a transition is, read once: its strength, its curves and whether it has a shape. */
const prepared = new WeakMap();
function prep(pic) {
  let p = prepared.get(pic);
  if (!p) {
    const strength = strengthOf(pic.bulge);
    const b = pic.bulge;
    const shaped = Boolean(b && (b.top || b.right || b.bottom || b.left || b.corners || b.shift));
    p = { strength, curves: strengthCurves(pic.projection, strength, pic.fov), shaped };
    prepared.set(pic, p);
  }
  return p;
}
const strengthOfPic = (pic) => prep(pic).strength;
const curvesOf = (pic) => prep(pic).curves;

/** The world direction a transition picture (`pic`: projection, fov, bulge, zoom) shows at (u, v) on aim `aim` (degrees). */
function layerDirection(pic, u, v, base, aim) {
  const [bu, bv] = prep(pic).shaped ? bulgeWarp(pic.bulge, u, v) : [u, v];
  const [pu, pv] = transitionPoint(pic, bu, bv, base);
  const [x, y, z] = transitionVector(pic, pu, pv, base);
  // v360 turns the frame point by -roll before yaw and pitch (lens.js rolled).
  const r = -(aim.roll || 0) * RAD;
  return orient(aim.yaw, aim.pitch, x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r), z);
}

/**
 * The direction a transition shows at a point (u, v) of the frame (-1..1, v up): `layers` is transitionLayers' two
 * pictures, `weight` the new one's, `aim` the frame's yaw, pitch and roll (degrees, stabilization included).
 */
export function transitionDirection(layers, weight, u, v, base, aim) {
  return slerpDirection(layerDirection(layers[0], u, v, base, aim), layerDirection(layers[1], u, v, base, aim), clamp(weight, 0, 1));
}

/** Pixels between the points whose directions are worked out exactly; the ones between follow them. */
const STEP = 4;

/**
 * Draws one frame of a transition: `out` (rgb24, w×h) from `src` (rgb24 equirect, sw×sh), each pixel the direction
 * transitionDirection gives at its middle, read from the equirect between its four nearest pixels (across the seam at
 * the back). Directions are worked out every STEP pixels; between them the picture's equirect position follows
 * straight on (the bend is smooth), except in a cell round a pole or across the seam, where each pixel's direction
 * follows its corners' on the sphere and is looked up on its own.
 */
export function bendFrame(src, sw, sh, out, w, h, layers, weight, aim, base) {
  const gw = Math.ceil(w / STEP) + 1;
  const gh = Math.ceil(h / STEP) + 1;
  const dir = new Float64Array(gw * gh * 3);
  const pos = new Float64Array(gw * gh * 2);
  const TAU = 2 * Math.PI;
  for (let gy = 0; gy < gh; gy++) {
    const v = 1 - (2 * (Math.min(gy * STEP, h) + 0.5)) / h;
    for (let gx = 0; gx < gw; gx++) {
      const u = (2 * (Math.min(gx * STEP, w) + 0.5)) / w - 1;
      const d = transitionDirection(layers, weight, u, v, base, aim);
      const g = gy * gw + gx;
      dir.set(d, g * 3);
      // projection.js equirectUv: longitude across (the back at both edges), latitude down from the top.
      pos[g * 2] = (Math.atan2(d[0], d[2]) / TAU + 0.5) * sw - 0.5;
      pos[g * 2 + 1] = (0.5 - Math.asin(clamp(d[1], -1, 1)) / Math.PI) * sh - 0.5;
    }
  }
  const half = sw / 2;
  const nearPole = sh * 0.02;
  for (let gy = 0; gy < gh - 1; gy++) {
    const y0p = gy * STEP;
    const y1p = Math.min(h, y0p + STEP);
    for (let gx = 0; gx < gw - 1; gx++) {
      const x0p = gx * STEP;
      const x1p = Math.min(w, x0p + STEP);
      if (x0p >= w || y0p >= h) continue;
      const g00 = gy * gw + gx;
      const g10 = g00 + 1;
      const g01 = g00 + gw;
      const g11 = g01 + 1;
      // Each corner's longitude taken next to the first corner's (across the seam), and how far apart they lie.
      const a = pos[g00 * 2];
      const unwrap = (x) => (x - a > half ? x - sw : a - x > half ? x + sw : x);
      const b = unwrap(pos[g10 * 2]);
      const c = unwrap(pos[g01 * 2]);
      const e = unwrap(pos[g11 * 2]);
      const ya = pos[g00 * 2 + 1];
      const yb = pos[g10 * 2 + 1];
      const yc = pos[g01 * 2 + 1];
      const ye = pos[g11 * 2 + 1];
      const spread = Math.max(a, b, c, e) - Math.min(a, b, c, e);
      const polar = Math.min(ya, yb, yc, ye) < nearPole || Math.max(ya, yb, yc, ye) > sh - 1 - nearPole;
      const straight = !polar && spread < sw / 16;
      for (let y = y0p; y < y1p; y++) {
        const fy = (y - y0p) / STEP;
        for (let x = x0p; x < x1p; x++) {
          const fx = (x - x0p) / STEP;
          const k00 = (1 - fx) * (1 - fy);
          const k10 = fx * (1 - fy);
          const k01 = (1 - fx) * fy;
          const k11 = fx * fy;
          let sx;
          let sy;
          if (straight) {
            sx = a * k00 + b * k10 + c * k01 + e * k11;
            sy = ya * k00 + yb * k10 + yc * k01 + ye * k11;
          } else {
            const dx = dir[g00 * 3] * k00 + dir[g10 * 3] * k10 + dir[g01 * 3] * k01 + dir[g11 * 3] * k11;
            const dy = dir[g00 * 3 + 1] * k00 + dir[g10 * 3 + 1] * k10 + dir[g01 * 3 + 1] * k01 + dir[g11 * 3 + 1] * k11;
            const dz = dir[g00 * 3 + 2] * k00 + dir[g10 * 3 + 2] * k10 + dir[g01 * 3 + 2] * k01 + dir[g11 * 3 + 2] * k11;
            const n = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
            sx = (Math.atan2(dx, dz) / TAU + 0.5) * sw - 0.5;
            sy = (0.5 - Math.asin(clamp(dy / n, -1, 1)) / Math.PI) * sh - 0.5;
          }
          sx = ((sx % sw) + sw) % sw;
          sy = sy < 0 ? 0 : sy > sh - 1 ? sh - 1 : sy;
          const x0 = sx | 0;
          const y0 = sy | 0;
          const x1 = x0 + 1 === sw ? 0 : x0 + 1;
          const y1 = y0 + 1 < sh ? y0 + 1 : y0;
          const tx = sx - x0;
          const ty = sy - y0;
          const p00 = (y0 * sw + x0) * 3;
          const p10 = (y0 * sw + x1) * 3;
          const p01 = (y1 * sw + x0) * 3;
          const p11 = (y1 * sw + x1) * 3;
          const o = (y * w + x) * 3;
          for (let ch = 0; ch < 3; ch++) {
            const top = src[p00 + ch] + (src[p10 + ch] - src[p00 + ch]) * tx;
            const bottom = src[p01 + ch] + (src[p11 + ch] - src[p01 + ch]) * tx;
            out[o + ch] = top + (bottom - top) * ty + 0.5;
          }
        }
      }
    }
  }
  return out;
}
