import { describe, expect, it } from 'vitest';
import { In, MAX_E, Sim } from '../src/sim/sim';

/** Many seeds x varied inputs. Asserts the invariants that previously broke (hash chain cycles, NaNs, runaway counts). */
describe('soak', () => {
  it('survives 12 seeds x 3 simulated minutes with bounded counts, finite state and sane step time', () => {
    let worst = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const sim = new Sim(seed * 7919);
      sim.scrap = 300; sim.buyUpgrade(seed % 6);
      let r = seed * 2654435761 >>> 0;
      let input = 0, deaths = 0;
      for (let t = 0; t < 3 * 60 * 60; t++) {
        if ((t % 20) === 0) { r = (Math.imul(r, 1664525) + 1013904223) >>> 0; input = r & 255; if (seed % 3 === 0) input |= In.Fire; }
        sim.input = input;
        sim.aimOn = seed % 4 === 0; sim.aimAng = (t / 50) % 6.28;
        sim.assist = seed % 2 === 0;
        const t0 = performance.now();
        sim.step();
        worst = Math.max(worst, performance.now() - t0);
        if (!sim.alive && sim.deadT > 1.5) { deaths++; sim.reset(seed + deaths); }
        if ((t & 127) === 0) {
          expect(Number.isFinite(sim.sx + sim.sy + sim.svx + sim.svy + sim.hp + sim.scrap)).toBe(true);
          expect(sim.nEnt).toBeLessThanOrEqual(MAX_E);
          expect(sim.hash_maxChain()).toBeLessThan(MAX_E);     // a cyclic chain would exceed capacity
        }
      }
    }
    expect(worst).toBeLessThan(50);        // watchdog: no single step may hang
  }, 120000);
});
