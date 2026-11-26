import assert from 'node:assert/strict';
import test from 'node:test';
import * as edl from '../src/edl.js';

test('a tilt pan moves its pitch on every frame (no frame shows the tilt of the one before)', () => {
  assert.equal(typeof edl.pitchPanCommands, 'function', 'pitchPanCommands is exported');
  const frames = 9;
  const poseAt = (n) => ({ unwrapped: 10 + n, pitch: n * 2, roll: 0 });
  const lines = edl.pitchPanCommands(poseAt, () => null, frames, { num: 30, den: 1, pitchMoves: true, rollMoves: false, fovMoves: false }).trim().split('\n');
  assert.equal(lines.length, frames);
  lines.forEach((line, n) => {
    assert.match(line, new RegExp(`v360 pitch ${(n * 2).toFixed(6)}`), line);
    if (n < frames - 1) assert.match(line, /^\S+ scroll horizontal 0\.00277778, v360 pitch/, line);
    else assert.doesNotMatch(line, /scroll/);
  });
});

test('a tilt pan sends only what moves: roll and the zoom when they change', () => {
  const poseAt = (n) => ({ unwrapped: 0, pitch: n, roll: n * 3, p: n / 4 });
  const viewAt = (pose) => ({ hfov: 90 + pose.p * 10, vfov: 50 + pose.p * 10 });
  const only = edl.pitchPanCommands(poseAt, viewAt, 5, { num: 30, den: 1, pitchMoves: true, rollMoves: false, fovMoves: false });
  assert.doesNotMatch(only, /v360 roll|h_fov/);
  const all = edl.pitchPanCommands(poseAt, viewAt, 5, { num: 30, den: 1, pitchMoves: true, rollMoves: true, fovMoves: true }).trim().split('\n');
  assert.match(all[3], /v360 pitch 3\.000000, v360 roll 9\.000000, v360 h_fov 97\.500000, v360 v_fov 57\.500000;$/);
});
