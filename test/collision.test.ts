import { describe, expect, it } from 'vitest';
import { In, Kind, Sim } from '../src/sim/sim';
import { hullShape } from '../src/sim/hulls';
import { ROSTER } from '../src/sim/ships';

/** A quiet-ish sim: ship invulnerable so damage never interferes with the physics under test. */
function quiet(ship?: (typeof ROSTER)[number]): Sim {
  const s = new Sim(1); if (ship) s.setShip(ship);
  s.invuln = 1e9; s.hp = 1e9; s.sx = s.spx = 0; s.sy = s.spy = 0; s.svx = s.svy = 0; s.sa = 0;
  return s;
}
function rock(s: Sim, x: number, y: number, R: number, vx = 0, vy = 0): number {
  const e = s.spawnEnt(Kind.Asteroid, x, y, vx, vy); s.er[e] = R; s.ehp[e] = 1e9; return e;   // asteroids spawn with 0 hp here; give it some so a ram doesn't just destroy it
}
/** Deepest overlap (positive = inside) between any hull circle and the entity's body, in world units. */
function overlap(s: Sim, e: number): number {
  const sh = hullShape(s.ship.art), ca = Math.cos(s.sa), sa = Math.sin(s.sa), body = s.er[e] * 1.05;
  let worst = -1e9;
  for (let c = 0; c < sh.c.length; c += 3) {
    const wx = s.sx + sh.c[c] * ca - sh.c[c + 1] * sa, wy = s.sy + sh.c[c] * sa + sh.c[c + 1] * ca;
    worst = Math.max(worst, body + sh.c[c + 2] - Math.hypot(wx - s.ex[e], wy - s.ey[e]));
  }
  return worst;
}
/** Thrust at +x for `ticks`; returns the worst overlap seen after any step (tunnelling or sinking in would show as a large positive number). */
function charge(s: Sim, input: number, ticks: number, e: number): number {
  let worst = -1e9;
  for (let t = 0; t < ticks; t++) { s.input = input; s.sa = 0; s.step(); worst = Math.max(worst, overlap(s, e)); }
  return worst;
}

describe('physical collisions', () => {
  it('every hull hits a rock with its drawn shape and never sinks into it', () => {
    for (const d of ROSTER) for (const R of [2.4, 4.3, 6.7]) {
      const s = quiet(d), e = rock(s, 120, 0, R);
      expect(charge(s, In.Thrust | In.Boost, 400, e), `${d.id} vs rock R=${R}`).toBeLessThan(0.7);
    }
  });
  it('a wing tip really touches: a rock beside the centreline (reachable only by the wing) is hit', () => {
    const wing = quiet(ROSTER[0]);                                    // Wren: wing tips reach about 9.8 units to each side
    const e = rock(wing, 110, 8.5, 2.4);
    charge(wing, In.Thrust | In.Boost, 300, e);
    const clear = quiet(ROSTER[0]), c = rock(clear, 110, 24, 2.4);
    charge(clear, In.Thrust | In.Boost, 300, c);
    const struck = Math.hypot(wing.evx[e], wing.evy[e]), untouched = Math.hypot(clear.evx[c], clear.evy[c]);
    expect(struck).toBeGreaterThan(8);                                // the wing struck the rock and threw it
    expect(untouched).toBeLessThan(struck * 0.3);                     // a rock well clear of the ship barely moves
  });
  it('a very fast ship (400 u/s) does not tunnel through a small rock', () => {
    const s = quiet(), e = rock(s, 200, 0, 2.4); s.svx = 400;
    let worst = -1e9;
    for (let t = 0; t < 60; t++) { s.input = 0; s.step(); worst = Math.max(worst, overlap(s, e)); }
    expect(worst).toBeLessThan(0.7);
  });
  it('hull shapes cover the drawn art: every playable hull reaches further than the old single-circle body', () => {
    for (const d of ROSTER) expect(hullShape(d.art).reach, d.id).toBeGreaterThan(d.radius * 2);
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
  it('a gentle bump does not break a rock, a hard ram does', () => {
    const soft = quiet(), hard = quiet();
    const a = rock(soft, 60, 0, 4.3), b = rock(hard, 60, 0, 4.3);
    soft.ehp[a] = 5; hard.ehp[b] = 5; soft.svx = 10; hard.svx = 160;
    for (let t = 0; t < 90; t++) { soft.input = 0; soft.step(); hard.input = 0; hard.step(); }
    expect(soft.ek[a]).toBe(Kind.Asteroid);                           // survived a nudge
    expect(hard.ek[b] === Kind.None || hard.ehp[b] < 5).toBe(true);   // took real damage
  });
  it('no part of a hull ever ends a tick inside a planet', () => {
    for (const d of ROSTER) {
      const s = quiet(d); s.sx = s.spx = 190 - 46 - 60; s.sy = s.spy = -60; s.svx = 150;
      const sh = hullShape(d.art);
      let worst = -1e9;
      for (let t = 0; t < 300; t++) {
        s.input = In.Thrust | In.Boost; s.sa = 0; s.step();
        const ca = Math.cos(s.sa), sa = Math.sin(s.sa);
        for (let c = 0; c < sh.c.length; c += 3) worst = Math.max(worst, 46 + sh.c[c + 2] - Math.hypot(s.sx + sh.c[c] * ca - sh.c[c + 1] * sa - 190, s.sy + sh.c[c] * sa + sh.c[c + 1] * ca + 60));
      }
      expect(worst, d.id).toBeLessThan(0.7);
    }
  });
});
