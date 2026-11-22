import { describe, expect, it } from 'vitest';
import { In, Kind, Sim } from '../src/sim/sim';

const quiet = (): Sim => { const s = new Sim(1); s.invuln = 1e9; s.hp = 1e9; s.sx = s.spx = 0; s.sy = s.spy = 0; s.svx = s.svy = 0; s.sa = 0; return s; };

describe('floating rocks are physical', () => {
  it('a player bolt damages a rock', () => {
    const s = quiet(); s.sx = s.spx = 300; const e = s.spawnEnt(Kind.Asteroid, 60, 0, 0, 0); s.er[e] = 4.3; s.ehp[e] = 5;
    s.spawnBullet(20, 0, 300, 0, 1, 0, 1); for (let t = 0; t < 30; t++) s.step();
    expect(s.ehp[e] < 5 || s.ek[e] === Kind.None).toBe(true);
  });
  it('an enemy bolt is stopped by a rock and does not hurt it', () => {
    const s = quiet(); s.sx = s.spx = 300; const e = s.spawnEnt(Kind.Asteroid, 60, 0, 0, 0); s.er[e] = 4.3; s.ehp[e] = 5;
    s.spawnBullet(20, 0, 300, 0, 1, 1, 1); for (let t = 0; t < 30; t++) s.step();
    expect(s.ehp[e]).toBe(5); expect(s.nBul).toBe(0);
  });
  it('a comet is solid: the ship cannot fly through it', () => {
    const s = quiet(); s.sx = s.spx = -400; s.sy = s.spy = 600; const c = s.spawnEnt(Kind.Comet, -280, 600, 0, 0); s.evx[c] = s.evy[c] = 0;
    let m = -1e9; for (let t = 0; t < 400; t++) { s.input = In.Thrust | In.Boost; s.sa = 0; s.step(); s.sy = s.spy = 600; s.svy = 0; m = Math.max(m, s.sx); }
    expect(m).toBeLessThan(-280);
  });
});

describe('enemy ships are solid against rocks', () => {
  it('a drone chasing the player through a rock cannot pass through it', () => {
    const s = quiet(); s.sx = s.spx = 400; s.sy = s.spy = 0;
    const r = s.spawnEnt(Kind.Asteroid, 100, 0, 0, 0); s.er[r] = 6.7; s.ehp[r] = 1e9;
    const d = s.spawnEnt(Kind.Drone, 40, 0, 60, 0);
    let minGap = 1e9;
    for (let t = 0; t < 300; t++) { s.step(); if (s.ek[d] === Kind.Drone) minGap = Math.min(minGap, Math.hypot(s.ex[d] - s.ex[r], s.ey[d] - s.ey[r])); }
    expect(minGap).toBeGreaterThan(6.7 * 1.05 + 6 - 1.5);       // rock body + drone body, with a little tolerance for the push-out tick
  });
});
