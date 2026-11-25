/**
 * The transitions both the web editor and the render are measured on: every pair of the six camera kinds each way
 * with each transition it offers, in a landscape and a portrait frame, plus cameras aimed the same way. `lens` and
 * `plan` are the web editor's modules (src/editor/lens.js, plan.js); the result is what its live view draws: each
 * picture's frame zoom and the new picture's weight at a few points of the move, and how long the move lasts.
 */
export const FRAMES = { landscape: { hfov: 100, vfov: 56 }, portrait: { hfov: 56, vfov: 100 } };
/** [projection, fov, yaw, pitch, shape]; a tiny planet looks straight down. */
export const CAMERAS = {
  flat: ['flat', 100, 0, 0, {}],
  fisheye: ['fisheye', 160, 60, 0, {}],
  planet: ['planet', 260, 120, -90, {}],
  pannini: ['pannini', 140, 200, 0, {}],
  'bent fisheye': ['fisheye', 180, 250, 0, { strength: 0.5 }],
  'bent planet': ['planet', 260, 300, -90, { strength: 0.6 }],
};
export const SAME_AIM = [['flat', 'pannini'], ['fisheye', 'planet'], ['flat', 'fisheye'], ['planet', 'pannini']];
export const PS = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];

const cfgOf = (cams) => ({
  mode: '360',
  yaws: cams.map((c) => c[2]),
  pitches: cams.map((c) => c[3]),
  fovs: cams.map((c) => c[1]),
  projections: cams.map((c) => c[0]),
  bulges: cams.map((c) => c[4]),
});

export function transitionCases(lens, plan) {
  const names = Object.keys(CAMERAS);
  const cfg = cfgOf(names.map((n) => CAMERAS[n]));
  const moves = [];
  const edlOf = (a, b, kind) => [{ t: 0, camera: a }, { t: 30, camera: b, panSpeed: 30, panKind: kind }];
  for (let a = 1; a <= names.length; a++) {
    for (let b = 1; b <= names.length; b++) {
      if (a === b) continue;
      for (const kind of plan.transitionKinds(plan.pictureOf(cfg, a), plan.pictureOf(cfg, b))) {
        const pan = plan.cutMotion(edlOf(a, b, kind), cfg, 60).find((s) => s.type === 'pan');
        const from = plan.pictureOf(cfg, a);
        const to = plan.pictureOf(cfg, b);
        const frames = {};
        for (const [frameName, base] of Object.entries(FRAMES)) {
          frames[frameName] = PS.map((p) => {
            const layers = lens.transitionLayers({ ...from, mix: { ...to, p } }, base);
            return layers.map((l) => l.zoom);
          });
        }
        moves.push({ from: names[a - 1], to: names[b - 1], kind, len: pan.end - pan.start, weights: PS.map((p) => plan.transitionWeight(kind, from.projection, p)), frames });
      }
    }
  }
  const same = [];
  for (const [pa, pb] of SAME_AIM) {
    const c = cfgOf([[pa, 150, 30, 0, {}], [pb, 150, 30, 0, {}]]);
    for (const kind of plan.transitionKinds(plan.pictureOf(c, 1), plan.pictureOf(c, 2))) {
      const pan = plan.cutMotion(edlOf(1, 2, kind), c, 60).find((s) => s.type === 'pan');
      same.push({ from: pa, to: pb, kind, len: pan ? pan.end - pan.start : 0 });
    }
  }
  return { moves, same };
}
