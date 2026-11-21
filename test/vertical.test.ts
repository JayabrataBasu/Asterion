import { describe, expect, it } from 'vitest';
import { In, Kind, MAX_E, Sim, V_TOL } from '../src/sim/sim';
import { HIVE, NEEDLE, MULE, WREN } from '../src/sim/ships';
import { planetsNear } from '../src/sim/world';

function emptySpace(): [number, number] {
  const out = new Float32Array(64);
  for (let i = 1; i < 200; i++) if (planetsNear(i * 520, 0, 380, out) === 0) return [i * 520, 0];
  throw new Error('no empty space');
}
function quiet(vert = true, ship = WREN): Sim {
  const s = new Sim(5); s.setShip(ship); s.reset(5); s.vert = vert; s.invuln = 0; s.shield = 0; s.hp = 1e5;
  const [x, y] = emptySpace(); s.sx = s.spx = x; s.sy = s.spy = y; s.svx = s.svy = 0; s.sa = 0;
  for (let e = 0; e < MAX_E; e++) s.ek[e] = Kind.None;
  return s;
}
const tap = (s: Sim, bit: number): void => { s.input = bit; s.step(); s.input = 0; s.step(); };
const run = (s: Sim, n: number, inp = 0): void => { for (let i = 0; i < n; i++) { s.input = inp; s.step(); } };

describe('altitude bands', () => {
  it('climb and dive move one band per press, animated at climbRate', () => {
    const s = quiet();
    tap(s, In.Climb); expect(s.szBand).toBe(1);
    expect(s.sz).toBeGreaterThan(0); expect(s.sz).toBeLessThan(1);
    run(s, 30); expect(s.sz).toBe(1);
    tap(s, In.Climb); expect(s.szBand).toBe(1);                 // already top band
    tap(s, In.Dive); tap(s, In.Dive); run(s, 60); expect(s.sz).toBe(-1);
  });
  it('the transition takes about 0.4 s on wren, less on needle, more on mule; hive is locked', () => {
    const t = (ship: typeof WREN): number => { const s = quiet(true, ship); s.input = In.Climb; let n = 0; while (s.sz < 1 && n < 600) { s.step(); s.input = 0; n++; } return n / 60; };
    expect(t(WREN)).toBeCloseTo(0.4, 1); expect(t(NEEDLE)).toBeLessThan(t(WREN)); expect(t(MULE)).toBeGreaterThan(t(WREN));
    const h = quiet(true, HIVE); tap(h, In.Climb); run(h, 60); expect(h.sz).toBe(0);
  });
  it('vertical mode off ignores the keys entirely', () => {
    const s = quiet(false); tap(s, In.Climb); run(s, 30); expect(s.sz).toBe(0); expect(s.szBand).toBe(0);
  });
});

describe('vertical collisions', () => {
  it('a player bolt only hits an enemy on the same band', () => {
    const hits = (ez: number): number => {
      const s = quiet(); const e = s.spawnEnt(Kind.Gunship, s.sx + 30, s.sy, 0, 0); s.ez[e] = s.eband[e] = ez; s.ehp[e] = 100; s.es[e] = 0;
      run(s, 20, In.Fire); return 100 - s.ehp[e];
    };
    expect(hits(0)).toBeGreaterThan(0); expect(hits(1)).toBe(0); expect(hits(-1)).toBe(0);
  });
  it('enemy bolts on another band pass harmlessly', () => {
    const s = quiet(); s.shotZ = 1; s.spawnBullet(s.sx + 10, s.sy, -200, 0, 1, 1, 10);
    run(s, 10); expect(s.hp).toBe(1e5);
    s.shotZ = 0; s.spawnBullet(s.sx + 10, s.sy, -200, 0, 1, 1, 10); run(s, 10); expect(s.hp).toBeLessThan(1e5);
  });
  it('ramming needs a band within tolerance', () => {
    const s = quiet(); const a = s.spawnEnt(Kind.Asteroid, s.sx + 4, s.sy, 0, 0); s.er[a] = 3; s.ehp[a] = 50; s.eaux[a] = 1; s.ez[a] = 1;
    s.svx = 60; run(s, 10); expect(s.ehp[a]).toBe(50);
    expect(V_TOL).toBe(0.5);
  });
  it('high band flies over planets; mid band collides', () => {
    const pass = (band: number): boolean => {
      const s = new Sim(1); s.vert = true; s.reset(1); s.vert = true; s.invuln = 1e9; s.hp = 1e9;
      s.sx = s.spx = 190 - 46 - 30; s.sy = s.spy = -60; s.svx = 90; s.svy = 0; s.sa = 0;   // home planet r46 at (190,-60)
      if (band > 0) { s.szBand = 1; s.sz = 1; }
      for (let i = 0; i < 90; i++) { s.input = In.Thrust; s.step(); }
      return s.sx > 190;
    };
    expect(pass(1)).toBe(true); expect(pass(0)).toBe(false);
  });
  it('low band near a planet drags, heats and lowers the signature', () => {
    const s = new Sim(1); s.vert = true; s.invuln = 1e9; s.hp = 1e9; s.sx = s.spx = 190 - 46 - 8; s.sy = s.spy = -60; s.svx = 0; s.svy = 50;
    s.szBand = -1; s.sz = -1;
    const t = new Sim(1); t.vert = true; t.invuln = 1e9; t.hp = 1e9; t.sx = t.spx = 190 - 46 - 8; t.sy = t.spy = -60; t.svx = 0; t.svy = 50;
    for (let i = 0; i < 20; i++) { s.input = 0; s.step(); t.input = 0; t.step(); }
    const sig = s.sigNow, heat = s.heat;
    expect(sig).toBeLessThan(t.sigNow * 0.6); expect(heat).toBeGreaterThan(t.heat); expect(Math.abs(s.svy)).toBeLessThan(Math.abs(t.svy));
  });
  it('enemies match the player band to attack', () => {
    const s = quiet(); tap(s, In.Climb); run(s, 30);
    const e = s.spawnEnt(Kind.Drone, s.sx + 60, s.sy, 0, 0); s.ez[e] = s.eband[e] = -1;
    run(s, 120); expect(s.ek[e] === Kind.None || s.ez[e] > 0.5).toBe(true);
  });
});
