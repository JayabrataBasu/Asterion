import { describe, expect, it } from 'vitest';
import { In, Kind, Sim } from '../src/sim/sim';

/** A quiet sim: ship invulnerable so damage never interferes with the physics under test. */
function quiet(): Sim {
  const s = new Sim(1); s.invuln = 1e9; s.hp = 1e9;
  s.sx = s.spx = 0; s.sy = s.spy = 0; s.svx = s.svy = 0; s.sa = 0;
  return s;
}
function rock(s: Sim, x: number, y: number, R: number, vx = 0, vy = 0): number {
  const e = s.spawnEnt(Kind.Asteroid, x, y, vx, vy); s.er[e] = R; s.ehp[e] = 1e9; return e;   // asteroids spawn with 0 hp here; give it some so a ram doesn't just destroy it
}
/** Thrust at +x for `ticks` and report the closest approach to (tx, ty) over the whole run (so tunnelling would show as a tiny distance). */
function charge(s: Sim, input: number, ticks: number, e: number): number {
  let minD = 1e9;
  for (let t = 0; t < ticks; t++) { s.input = input; s.sa = 0; s.step(); minD = Math.min(minD, Math.hypot(s.sx - s.ex[e], s.sy - s.ey[e])); }
  return minD;
}

describe('physical collisions', () => {
  it('a boosting ship never gets inside a rock of any size', () => {
    for (const R of [2, 3, 5, 9]) {
      const s = quiet(), e = rock(s, 120, 0, R);
      const minD = charge(s, In.Thrust | In.Boost, 400, e);
      expect(minD, `rock R=${R}`).toBeGreaterThan(R * 1.05 + s.bodyR - 0.8);
    }
  });
  it('a very fast ship (400 u/s) does not tunnel through a small rock', () => {
    const s = quiet(); rock(s, 200, 0, 2); s.svx = 400;
    let minD = 1e9;
    for (let t = 0; t < 60; t++) { s.input = 0; s.step(); minD = Math.min(minD, Math.hypot(s.sx - 200, s.sy)); }
    expect(minD).toBeGreaterThan(2 * 1.05 + s.bodyR - 0.8);
  });
  it('the ship body is larger than its old hitbox, so it rests on the drawn surface', () => {
    const s = quiet();
    expect(s.bodyR).toBeGreaterThan(s.ship.radius);
  });
  it('weight matters: a heavy rock barely moves, a light one is thrown', () => {
    const big = quiet(), small = quiet();
    const b = rock(big, 100, 0, 9), m = rock(small, 100, 0, 2);
    charge(big, In.Thrust | In.Boost, 250, b); charge(small, In.Thrust | In.Boost, 250, m);
    const vb = Math.hypot(big.evx[b], big.evy[b]), vm = Math.hypot(small.evx[m], small.evy[m]);
    expect(vm).toBeGreaterThan(vb * 3);
  });
  it('hitting a heavy rock knocks the ship back and costs it speed', () => {
    const s = quiet(); rock(s, 90, 0, 12); s.svx = 100;
    let minVx = 1e9;
    for (let t = 0; t < 120; t++) { s.input = 0; s.step(); minVx = Math.min(minVx, s.svx); }
    expect(minVx).toBeLessThan(0);                                    // bounced backwards
  });
  it('hitting a light rock throws the rock and the ship keeps going, slower', () => {
    const s = quiet(); const r = rock(s, 90, 0, 3); s.svx = 100;
    let vAfter = 0, rockMax = 0;
    for (let t = 0; t < 100; t++) { s.input = 0; s.step(); vAfter = s.svx; rockMax = Math.max(rockMax, s.evx[r]); }
    expect(rockMax).toBeGreaterThan(20);                              // the rock was flung forward
    expect(vAfter).toBeLessThan(100);
  });
  it('a ship flying into a planet never gets inside its disc', () => {
    const s = quiet(); s.sx = s.spx = 190 - 46 - 60; s.sy = s.spy = -60; s.svx = 150;
    let minD = 1e9;
    for (let t = 0; t < 300; t++) { s.input = In.Thrust | In.Boost; s.sa = 0; s.step(); minD = Math.min(minD, Math.hypot(s.sx - 190, s.sy + 60)); }
    expect(minD).toBeGreaterThan(46 + s.bodyR - 0.8);
  });
});
