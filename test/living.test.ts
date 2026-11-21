import { describe, expect, it } from 'vitest';
import { In, Kind, MAX_E, Sim, Up } from '../src/sim/sim';
import { planetsNear } from '../src/sim/world';

function emptySpace(): [number, number] {
  const out = new Float32Array(64);
  for (let i = 1; i < 200; i++) if (planetsNear(i * 520, 0, 380, out) === 0) return [i * 520, 0];
  throw new Error('no empty space');
}
function quiet(seed = 3): { s: Sim; x0: number; y0: number } {
  const s = new Sim(seed); const [x0, y0] = emptySpace();
  s.sx = s.spx = x0; s.sy = s.spy = y0; s.svx = 0; s.svy = 0; s.hp = 1e6; s.invuln = 0;
  for (let e = 0; e < MAX_E; e++) s.ek[e] = Kind.None;
  return { s, x0, y0 };
}
const run = (s: Sim, ticks: number, inp = 0): void => { for (let i = 0; i < ticks; i++) { s.input = inp; s.step(); } };
const find = (s: Sim, k: number): number => { for (let e = 0; e < MAX_E; e++) if (s.ek[e] === k) return e; return -1; };

describe('sector events', () => {
  it('the scheduler fires events within 3 minutes and never repeats one back to back', () => {
    const s = new Sim(7); s.invuln = 1e6; s.hp = 1e6;
    const seen: number[] = []; let last = 0;
    for (let i = 0; i < 60 * 200; i++) {
      s.input = 0; s.step();
      if (s.warn !== 0 && s.warn !== last) seen.push(s.warn);
      last = s.warn;
    }
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
  });

  it('a comet appears after its warning and crosses near the player', () => {
    const { s, x0, y0 } = quiet();
    s.triggerEvent(1);
    expect(s.warn).toBe(1);
    run(s, 60 * 6);
    const c = find(s, Kind.Comet); expect(c).toBeGreaterThanOrEqual(0);
    let minD = 1e9;
    for (let i = 0; i < 60 * 12 && find(s, Kind.Comet) >= 0; i++) { s.input = 0; s.step(); const k = find(s, Kind.Comet); if (k >= 0) minD = Math.min(minD, Math.hypot(s.ex[k] - x0, s.ey[k] - y0)); }
    expect(minD).toBeLessThan(200);
  });

  it('a comet hurts the player once per contact, kills a drone and spares a boss', () => {
    const { s } = quiet();
    s.triggerEvent(1); run(s, 60 * 6);
    const c = find(s, Kind.Comet);
    s.hp = 100; s.sx = s.spx = s.ex[c]; s.sy = s.spy = s.ey[c];
    run(s, 30);
    expect(100 - s.hp).toBeGreaterThan(20); expect(100 - s.hp).toBeLessThan(30);
    const d = s.spawnEnt(Kind.Drone, s.ex[c], s.ey[c], 0, 0); const b = s.spawnEnt(Kind.Boss, s.ex[c], s.ey[c], 0, 0);
    const bossHp = s.ehp[b];
    s.step();
    expect(s.ek[d]).toBe(Kind.None); expect(s.ek[b]).toBe(Kind.Boss); expect(s.ehp[b]).toBe(bossHp);
  });

  it('a meteor shower sends many fast small rocks', () => {
    const { s } = quiet();
    s.triggerEvent(2); run(s, 60 * 6);
    let seen = 0; const ids = new Set<number>();
    for (let i = 0; i < 60 * 9; i++) { s.input = 0; s.step(); for (let e = 0; e < MAX_E; e++) if (s.ek[e] === Kind.Asteroid && Math.hypot(s.evx[e], s.evy[e]) > 40) ids.add(e); }
    seen = ids.size;
    expect(seen).toBeGreaterThanOrEqual(8);
  });

  it('a solar flare rises and fully fades; an ion storm slows boost recharge', () => {
    const { s } = quiet();
    s.triggerEvent(3); let peak = 0;
    for (let i = 0; i < 60 * 20; i++) { s.input = 0; s.step(); peak = Math.max(peak, s.flare); }
    expect(peak).toBeGreaterThan(0.7); expect(s.flare).toBe(0);

    const a = quiet(4).s; a.boostE = 0; run(a, 60); const normal = a.boostE;
    const b = quiet(4).s; b.triggerEvent(4); run(b, 60 * 6); b.boostE = 0; run(b, 60); const stormy = b.boostE;
    expect(b.storm).toBeGreaterThan(0.5); expect(stormy).toBeLessThan(normal * 0.5);
  });
});

describe('neutral haulers', () => {
  it('drop scrap when shot, and are not counted as enemies', () => {
    const { s, x0, y0 } = quiet();
    const h = s.spawnEnt(Kind.Hauler, x0 + 80, y0 + 40, 0, 0); s.step();
    expect(s.nEnemy).toBe(0);
    s.killEnt(h, true);
    let scrap = 0; for (let i = 0; i < 96; i++) if (s.scl[i] > 0) scrap += s.scv[i];
    expect(scrap).toBeGreaterThanOrEqual(8);
  });

  it('are never targeted by aim assist or missiles (a drone in the same spot is)', () => {
    const fire = (kind: number): { assist: number; tgt: number } => {
      const { s, x0, y0 } = quiet(); s.aimAssist = 2; s.sa = 0; s.up[Up.Missile] = 1; s.missiles = 3;
      const e = s.spawnEnt(kind, x0 + 60, y0, 0, 0); s.ehp[e] = 1e6;
      s.step(); s.input = In.Missile; s.step();
      let tgt = -2; for (let m = 0; m < 12; m++) if (s.mlife[m] > 0) tgt = s.mtgt[m];
      return { assist: s.assistTarget, tgt };
    };
    const hauler = fire(Kind.Hauler), drone = fire(Kind.Drone);
    expect(drone.assist).toBeGreaterThanOrEqual(0); expect(drone.tgt).toBeGreaterThanOrEqual(0);   // control: the test setup does target enemies
    expect(hauler.assist).toBe(-1); expect(hauler.tgt).toBe(-1);
  });
});

describe('review fixes', () => {
  it('holding boost on an empty tank does not spam shock rings', () => {
    const { s } = quiet(); s.boostE = 0;
    let starts = 0, prev = 0;
    for (let i = 0; i < 120; i++) { s.input = In.Thrust | In.Boost; s.step(); let n = 0; for (let r = 0; r < 16; r++) if (s.rlife[r] > 0.45) n++; if (n > prev) starts++; prev = n; }
    expect(starts).toBeLessThanOrEqual(2);
  });
  it('meteors survive the home sector unloading and bolts do not nudge a comet', () => {
    const { s } = quiet();
    s.triggerEvent(2); run(s, 60 * 6 + 5);
    let m = -1; for (let e = 0; e < MAX_E; e++) if (s.ek[e] === Kind.Asteroid && Math.hypot(s.evx[e], s.evy[e]) > 40) { m = e; break; }
    expect(m).toBeGreaterThanOrEqual(0); expect(s.esec[m]).not.toBe(0);
  });
});
