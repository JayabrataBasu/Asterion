import { describe, expect, it } from 'vitest';
import { In, MAX_B, MAX_E, MAX_P, Sim } from '../src/sim/sim';
import { ROSTER } from '../src/sim/ships';
import { Galaxy, MAX_SYS_STATE_BYTES, SYS_BOUND, TICK_S } from '../src/sim/galaxy';
import { setSystem } from '../src/sim/world';

function finite(a: Float32Array, n = a.length): boolean { for (let i = 0; i < n; i++) if (!Number.isFinite(a[i])) return false; return true; }

/**
 * Every hull x 2 seeds x vertical off/on, 3 simulated minutes each, hopping between galaxy systems every minute.
 * Asserts: no NaN, bounded entity / bolt / particle counts, no cyclic hash chains, bounded explosion chains per tick,
 * bounded galaxy state, and a sane average step.
 */
describe('soak: all ships, vertical on and off, galaxy hops', () => {
  for (const vert of [false, true]) it(`vert=${vert}`, () => {
    const g = new Galaxy(4242);
    let total = 0, steps = 0, worstBoom = 0;
    for (const def of ROSTER) for (const seed of [3, 11]) {
      const sim = new Sim(seed); sim.setShip(def); sim.reset(seed * 7919); sim.vert = vert;
      sim.scrap = 400; sim.buyUpgrade(seed % 10); sim.buyUpgrade((seed + 3) % 10);
      let r = (seed * 2654435761) >>> 0, input = 0;
      for (let t = 0; t < 3 * 60 * 60; t++) {
        if (t % 3600 === 1800) {                                              // jump to another system mid-run
          const sys = g.systems[(t / 3600 + seed) % g.systems.length | 0];
          setSystem(sys.saltX, sys.saltY, SYS_BOUND); sim.enterSystem();
          sys.pois.forEach((p, i) => sim.setPoi(i, p.x * 0.1, p.y * 0.1, p.kind, p.seed));
          g.arrive(sys.id); g.advance(TICK_S);
        }
        if ((t % 20) === 0) { r = (Math.imul(r, 1664525) + 1013904223) >>> 0; input = (r & 0xffff) & ~(In.Cruise); if (seed === 3) input |= In.Fire; }
        sim.input = input;
        const ev0 = sim.evHead, t0 = performance.now();
        sim.step();
        total += performance.now() - t0; steps++;
        let booms = 0; for (let i = ev0; i < sim.evHead; i++) if (sim.evT[i & 255] === 4) booms++;
        worstBoom = Math.max(worstBoom, booms);
        sim.evTail = sim.evHead;
        if (!sim.alive && sim.deadT > 1.5) sim.reset(seed + t);
        if ((t & 255) === 0) {
          expect(Number.isFinite(sim.sx + sim.sy + sim.svx + sim.svy + sim.hp + sim.sz + sim.fuel + sim.heat + sim.shield)).toBe(true);
          expect(finite(sim.ex, MAX_E) && finite(sim.ey, MAX_E) && finite(sim.ez, MAX_E) && finite(sim.bx, MAX_B) && finite(sim.px, MAX_P)).toBe(true);
          expect(sim.nEnt).toBeLessThanOrEqual(MAX_E);
          expect(sim.hash_maxChain()).toBeLessThan(MAX_E);
        }
      }
    }
    setSystem(0, 0);
    expect(worstBoom).toBeLessThan(40);                                     // no runaway mine / blast chains
    expect(total / steps).toBeLessThan(2);
    expect(JSON.stringify(g.state()).length).toBeLessThan(MAX_SYS_STATE_BYTES);
  }, 300000);
});
