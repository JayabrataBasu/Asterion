import { describe, expect, it } from 'vitest';
import { In, Kind, Sim, Up } from '../src/sim/sim';
import { planetsNear } from '../src/sim/world';

function emptySpace(): [number, number] {
  const out = new Float32Array(64);
  for (let i = 1; i < 200; i++) if (planetsNear(i * 520, 0, 380, out) === 0) return [i * 520, 0];
  throw new Error('no empty space');
}
const DEG = Math.PI / 180;

function ship(mode: number): { s: Sim; x0: number; y0: number } {
  const s = new Sim(3); const [x0, y0] = emptySpace();
  s.sx = s.spx = x0; s.sy = s.spy = y0; s.svx = 0; s.svy = 0; s.hp = 1e6; s.invuln = 1e6; s.aimAssist = mode;
  for (let e = 0; e < 320; e++) s.ek[e] = Kind.None;
  return { s, x0, y0 };
}

/** Drone crossing at 40 u/s, 120 units ahead; ship aimed `errDeg` off the true lead point (or off the drone's own bearing when leadAim is false). Returns bolt hits after 90 ticks. */
function crossing(mode: number, errDeg: number, leadAim = true): number {
  const { s, x0, y0 } = ship(mode);
  const dist = 120, t0 = dist / 215;
  const d = s.spawnEnt(Kind.Drone, x0 + dist, y0, 0, 40);
  s.ehp[d] = 1e6;
  s.sa = (leadAim ? Math.atan2(40 * t0, dist) : 0) + errDeg * DEG;   // leadAim=false: player points at the enemy itself, without leading it
  let step = 0;
  for (let i = 0; i < 90; i++) {
    s.ex[d] = x0 + dist; s.ey[d] = y0 + 40 * (step / 60); s.evx[d] = 0; s.evy[d] = 40; s.ehp[d] = 1e6;
    s.input = i === 0 ? In.Fire : 0;
    s.step(); step++;
  }
  return s.hits;
}

describe('aim assist modes', () => {
  it('scenario sanity: perfect aim hits even with assist off', () => { expect(crossing(0, 0)).toBeGreaterThan(0); });
  it('off misses when pointing at a crossing enemy without leading it', () => { expect(crossing(0, 3, false)).toBe(0); });
  it('wide widens the hit radius: a bolt passing 3 units from a drone misses with assist off and hits with wide', () => {
    const run = (mode: number): number => {
      const { s, x0, y0 } = ship(mode);
      const d = s.spawnEnt(Kind.Drone, x0 + 60, y0, 0, 0); s.ehp[d] = 1e6;
      s.spawnBullet(x0 + 30, y0 + 3.0, 200, 0, 1, 0, 1);
      for (let i = 0; i < 30; i++) { s.ex[d] = x0 + 60; s.ey[d] = y0; s.evx[d] = 0; s.evy[d] = 0; s.step(); }
      return s.hits;
    };
    expect(run(0)).toBe(0); expect(run(1)).toBeGreaterThan(0);
  });
  it('lead hits a crossing enemy the player pointed at without leading', () => { expect(crossing(2, 3, false)).toBeGreaterThan(0); });
  it('homing hits a crossing enemy the player pointed at without leading', () => { expect(crossing(3, 3, false)).toBeGreaterThan(0); });

  it('asteroid in the cone is not a target', () => {
    const { s, x0, y0 } = ship(2);
    const a = s.spawnEnt(Kind.Asteroid, x0 + 100, y0, 0, 0); s.er[a] = 4;
    s.sa = 0; s.step();
    expect(s.assistTarget).toBe(-1);
  });

  it('freighter and station are not targets', () => {
    const { s, x0, y0 } = ship(2);
    s.spawnEnt(Kind.Freighter, x0 + 80, y0, 0, 0); s.spawnEnt(Kind.Station, x0 + 150, y0, 0, 0);
    s.sa = 0; s.step();
    expect(s.assistTarget).toBe(-1);
  });

  it('no targets leaves the bolt on the nose and stays finite', () => {
    const { s } = ship(2);
    s.sa = 0.3; s.input = In.Fire; s.step();
    let found = false;
    for (let i = 0; i < 640; i++) {
      if (s.blife[i] > 0 && s.bown[i] === 0) { found = true; expect(Math.abs(Math.atan2(s.bvy[i], s.bvx[i]) - 0.3)).toBeLessThan(0.05); expect(Number.isFinite(s.bvx[i])).toBe(true); }
    }
    expect(found).toBe(true);
  });

  it('enemy bolts never home', () => {
    const { s, x0, y0 } = ship(3);
    const d = s.spawnEnt(Kind.Drone, x0 + 60, y0 + 30, 0, 0); s.ehp[d] = 1e6;
    s.spawnBullet(x0 + 30, y0, 100, 0, 2, 1, 1);
    let idx = -1; for (let i = 0; i < 640; i++) if (s.blife[i] > 0 && s.bown[i] === 1) idx = i;
    for (let i = 0; i < 20; i++) { s.ex[d] = x0 + 60; s.ey[d] = y0 + 30; s.step(); }
    expect(s.bvy[idx]).toBe(0);
  });

  it('picks the target nearest the nose line', () => {
    const { s, x0, y0 } = ship(2);
    const far = s.spawnEnt(Kind.Drone, x0 + 120, y0 + 12, 0, 0);
    const near = s.spawnEnt(Kind.Drone, x0 + 110, y0 + 3, 0, 0);
    s.sa = 0; s.step();
    expect(s.assistTarget).toBe(near); expect(far).not.toBe(near);
  });
});

/** Player bolts currently alive: angle and speed of each. */
function playerBolts(s: Sim): { ang: number; spd: number }[] {
  const r: { ang: number; spd: number }[] = [];
  for (let i = 0; i < 640; i++) if (s.blife[i] > 0 && s.bown[i] === 0) r.push({ ang: Math.atan2(s.bvy[i], s.bvx[i]), spd: Math.hypot(s.bvx[i], s.bvy[i]) });
  return r;
}

describe('aim assist review hardening', () => {
  it('lead correction is capped at the cone: a fast crossing target never drags the bolt past 8 degrees', () => {
    const { s, x0, y0 } = ship(2);
    const d = s.spawnEnt(Kind.Rammer, x0 + 50, y0 + 1.75, 0, 150); s.ehp[d] = 1e6;   // 2 degrees off the nose, lead point ~35 degrees away
    s.sa = 0; s.input = In.Fire; s.step();
    const b = playerBolts(s); expect(b.length).toBe(1);
    expect(Math.abs(b[0].ang)).toBeLessThan(9.5 * DEG);
  });

  it('enemy bolts do not home even with an enemy inside the cone of their heading', () => {
    const { s, x0, y0 } = ship(3);
    const d = s.spawnEnt(Kind.Drone, x0 + 100, y0 + 17, 0, 0); s.ehp[d] = 1e6;       // ~10 degrees off the bolt's heading
    s.spawnBullet(x0 + 30, y0, 100, 0, 2, 1, 1);
    let idx = -1; for (let i = 0; i < 640; i++) if (s.blife[i] > 0 && s.bown[i] === 1) idx = i;
    for (let i = 0; i < 10; i++) { s.ex[d] = x0 + 100; s.ey[d] = y0 + 17; s.step(); }
    expect(s.bvy[idx]).toBe(0);
  });

  it('target choice is by angle from the nose, not distance', () => {
    const { s, x0, y0 } = ship(2);
    const closeButOff = s.spawnEnt(Kind.Drone, x0 + 60, y0 + 5, 0, 0);      // ~4.8 degrees, 60 units
    const farButOnAxis = s.spawnEnt(Kind.Drone, x0 + 200, y0 + 4, 0, 0);    // ~1.1 degrees, 200 units
    s.sa = 0; s.step();
    expect(s.assistTarget).toBe(farButOnAxis); expect(closeButOff).not.toBe(farButOnAxis);
  });

  it('spread side bolts follow the corrected angle', () => {
    const { s, x0, y0 } = ship(2); s.up[Up.Spread] = 1;
    const d = s.spawnEnt(Kind.Drone, x0 + 100, y0 + 8.7, 0, 0); s.ehp[d] = 1e6;     // ~5 degrees off the nose
    s.sa = 0; s.input = In.Fire; s.step();
    const b = playerBolts(s).map(v => v.ang).sort((a, c) => a - c);
    expect(b.length).toBe(3);
    expect(Math.abs((b[0] + b[2]) / 2 - b[1])).toBeLessThan(0.02);                   // side bolts symmetric about the (corrected) centre bolt
    expect(Math.abs(b[1])).toBeGreaterThan(0.03);                                     // and the centre bolt really was corrected
  });

  it('homing keeps bolt speed', () => {
    const { s, x0, y0 } = ship(3);
    const d = s.spawnEnt(Kind.Drone, x0 + 150, y0 + 26, 0, 0); s.ehp[d] = 1e6;      // ~10 degrees off
    s.sa = 0; s.input = In.Fire; s.step();
    const v0 = playerBolts(s)[0].spd;
    s.input = 0; for (let i = 0; i < 15; i++) { s.ex[d] = x0 + 150; s.ey[d] = y0 + 26; s.step(); }
    expect(Math.abs(playerBolts(s)[0].spd - v0)).toBeLessThan(0.01);
  });

  it('lead correction fades near the cone edge', () => {
    const { s, x0, y0 } = ship(2);
    const d = s.spawnEnt(Kind.Drone, x0 + 100, y0 + 11.9, 0, 0); s.ehp[d] = 1e6;    // 7.5 degrees from the muzzle: weight ~0.1, full correction would be 0.131 rad
    s.sa = 0; s.input = In.Fire; s.step();
    expect(Math.abs(playerBolts(s)[0].ang)).toBeLessThan(0.07);
  });
});

import { defaults, loadSave } from '../src/core/save';

describe('aim assist setting persistence', () => {
  const withStore = (raw: string | null, fn: () => void): void => {
    const g = globalThis as unknown as { localStorage?: unknown };
    const old = g.localStorage;
    g.localStorage = { getItem: () => raw, setItem: () => undefined };
    try { fn(); } finally { g.localStorage = old; }
  };
  it('defaults to lead (2)', () => { expect(defaults().aimAssist).toBe(2); });
  it('a save without the field loads as 2', () => { withStore(JSON.stringify({ v: 1, hi: 5 }), () => expect(loadSave().aimAssist).toBe(2)); });
  it('stored 0 stays 0 and 3 stays 3', () => {
    withStore(JSON.stringify({ v: 1, aimAssist: 0 }), () => expect(loadSave().aimAssist).toBe(0));
    withStore(JSON.stringify({ v: 1, aimAssist: 3 }), () => expect(loadSave().aimAssist).toBe(3));
  });
  it('an invalid stored value falls back to 2', () => {
    for (const bad of [9, -1, 1.5, 'x', null]) withStore(JSON.stringify({ v: 1, aimAssist: bad }), () => expect(loadSave().aimAssist).toBe(2));
  });
});
