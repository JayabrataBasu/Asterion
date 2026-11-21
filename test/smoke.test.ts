import { describe, expect, it } from 'vitest';
import { DT, In, MAX_B, MAX_E, MAX_P, Sim } from '../src/sim/sim';

function finite(a: Float32Array, n = a.length): boolean { for (let i = 0; i < n; i++) if (!Number.isFinite(a[i])) return false; return true; }

describe('headless sim smoke', () => {
  it('runs 120 s of scripted play without NaNs, leaks or overflow', () => {
    const sim = new Sim(12345);
    let maxEnt = 0, maxBul = 0, maxPar = 0, deaths = 0;
    for (let t = 0; t < 120 * 60; t++) {
      const ph = t / 60;
      let m = In.Fire;
      if (Math.sin(ph * 0.7) > -0.2) m |= In.Thrust;
      if (Math.sin(ph * 1.3) > 0) m |= In.Left; else m |= In.Right;
      if (Math.sin(ph * 0.31) > 0.8) m |= In.Boost;
      if (Math.sin(ph * 0.5) < -0.9) m |= In.Brake;
      sim.input = m;
      sim.step();
      if (!sim.alive && sim.deadT > 2) { deaths++; sim.reset(777 + deaths); }
      maxEnt = Math.max(maxEnt, sim.nEnt); maxBul = Math.max(maxBul, sim.nBul); maxPar = Math.max(maxPar, sim.nPar);
      if ((t & 63) === 0) {
        expect(Number.isFinite(sim.sx + sim.sy + sim.svx + sim.svy + sim.sa + sim.hp)).toBe(true);
        expect(finite(sim.ex, MAX_E) && finite(sim.ey, MAX_E) && finite(sim.evx, MAX_E) && finite(sim.ea, MAX_E)).toBe(true);
        expect(finite(sim.px, MAX_P) && finite(sim.py, MAX_P) && finite(sim.bx, MAX_B)).toBe(true);
      }
    }
    expect(maxEnt).toBeLessThan(MAX_E);
    expect(maxBul).toBeLessThanOrEqual(MAX_B);
    expect(maxPar).toBeLessThanOrEqual(MAX_P);
    expect(sim.tick).toBeGreaterThan(0);
    expect(deaths).toBeLessThan(40);
    expect(DT).toBeCloseTo(1 / 60);
  });

  it('is deterministic for a given seed', () => {
    const run = (): number => { const s = new Sim(99); for (let i = 0; i < 1800; i++) { s.input = In.Thrust | In.Fire | (i % 120 < 60 ? In.Left : In.Right); s.step(); } return s.sx * 1000 + s.score + s.nEnt; };
    expect(run()).toBe(run());
  });

  it('steps in well under 1 ms on average', () => {
    const s = new Sim(5); s.input = In.Thrust | In.Fire | In.Left;
    for (let i = 0; i < 600; i++) s.step();
    const t0 = performance.now();
    for (let i = 0; i < 3000; i++) s.step();
    expect((performance.now() - t0) / 3000).toBeLessThan(1);
  });
});
