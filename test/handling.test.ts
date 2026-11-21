import { describe, expect, it } from 'vitest';
import { In, Sim } from '../src/sim/sim';
import { defaults } from '../src/core/save';
import { planetsNear } from '../src/sim/world';

const DT = 1 / 60;
const run = (s: Sim, inp: number, n: number): void => { for (let i = 0; i < n; i++) { s.input = inp; s.step(); } };
/** A spot with no planet in gravity range, so only handling acts on the ship. */
function emptySpace(): [number, number] {
  const out = new Float32Array(64);
  for (let i = 1; i < 200; i++) if (planetsNear(i * 520, 0, 380, out) === 0) return [i * 520, 0];
  throw new Error('no empty space found');
}
const angDiff = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

describe('ship handling', () => {
  it('turn ramps up instead of snapping', () => {
    const s = new Sim(1); const a0 = s.sa;
    run(s, In.Left, 6);
    expect(s.sw).toBeGreaterThan(0);
    expect(s.sw).toBeLessThan(2.6);
    expect(s.sa - a0).toBeLessThan(3.7 * 0.1);
  });

  it('turn reaches its cap and settles after release', () => {
    const s = new Sim(1);
    run(s, In.Left, 90);
    expect(Math.abs(s.sw - 2.6)).toBeLessThan(0.01);
    run(s, 0, 60);
    expect(Math.abs(s.sw)).toBeLessThan(0.01);
  });

  it('both turn keys cancel', () => {
    const s = new Sim(1);
    run(s, In.Left | In.Right, 30);
    expect(s.sw).toBe(0);
  });

  it('grip bends the path toward the nose', () => {
    const s = new Sim(1);
    const [ex, ey] = emptySpace(); s.sx = s.spx = ex; s.sy = s.spy = ey;
    s.assist = false; s.sa = Math.PI / 2; s.svx = 80; s.svy = 0;
    const before = angDiff(Math.atan2(s.svy, s.svx), s.sa);
    run(s, 0, 60);
    const after = angDiff(Math.atan2(s.svy, s.svx), s.sa);
    expect(after).toBeLessThan(before);
    expect(Number.isFinite(s.svx) && Number.isFinite(s.svy)).toBe(true);
    expect(Math.hypot(s.svx, s.svy)).toBeGreaterThan(0);
  });

  it('zero velocity stays finite', () => {
    const s = new Sim(1);
    s.svx = 0; s.svy = 0;
    run(s, 0, 10);
    expect(Number.isFinite(s.svx) && Number.isFinite(s.svy)).toBe(true);
  });

  it('reset clears turn velocity', () => {
    const s = new Sim(1);
    s.sw = 2; s.reset(1);
    expect(s.sw).toBe(0);
  });

  it('mouse aim keeps the old turn rate and ignores sw', () => {
    const s = new Sim(1);
    s.aimOn = true; s.aimAng = 1; s.sw = 2;
    const a0 = s.sa; run(s, 0, 1);
    expect(Math.abs(s.sa - a0)).toBeLessThanOrEqual(3.7 * 1.15 * DT + 1e-9);
  });

  it('new saves default flight assist on', () => {
    expect(defaults().assist).toBe(true);
  });

  it('a coasting flip keeps most of the drift speed', () => {
    const s = new Sim(1);
    const [ex, ey] = emptySpace(); s.sx = s.spx = ex; s.sy = s.spy = ey;
    s.assist = false; s.sa = 0; s.svx = 100; s.svy = 0;
    run(s, In.Left, 72);                       // ~180 degrees of keyboard turn while coasting
    expect(Math.hypot(s.svx, s.svy)).toBeGreaterThan(75);
  });

  it('releasing a full-rate turn overshoots by under 0.25 rad', () => {
    const s = new Sim(1);
    run(s, In.Left, 90);
    const a = s.sa; run(s, 0, 90);
    expect(s.sa - a).toBeLessThan(0.25);
  });
});
