import { describe, expect, it } from 'vitest';
import REF from './fixtures/wren-trace.json';
import { In, Sim } from '../src/sim/sim';

/**
 * Wren regression: the ShipDef refactor must leave the original ship's handling bit-for-bit identical.
 * M1 proved the ShipDef refactor bit-identical against a trace recorded from the pre-refactor sim (commit 4098ecb).
 * M2 deliberately re-baselined it after Wren gained shields, energy, heat and signature; from then on it guards against
 * unintended handling changes. Regenerate only on purpose: `VITE_DUMP_TRACE=1 npx vitest run test/wren.test.ts -t dump --reporter=verbose`, paste the TRACE line into the fixture.
 */
export function trace(): number[][] {
  const out: number[][] = [];
  const cases = [
    { seed: 11, up: [0, 0, 0, 0, 0, 0, 0], assist: true, aim: 0, aimAssist: 2 },
    { seed: 23, up: [3, 2, 4, 5, 1, 2, 3], assist: false, aim: 0, aimAssist: 0 },
    { seed: 47, up: [5, 5, 5, 5, 5, 5, 5], assist: true, aim: 1, aimAssist: 3 },
    { seed: 91, up: [1, 0, 2, 0, 3, 0, 1], assist: false, aim: 0, aimAssist: 1 },
  ];
  for (const c of cases) {
    const s = new Sim(1);
    for (let i = 0; i < 7; i++) s.up[i] = c.up[i];
    s.reset(c.seed); s.assist = c.assist; s.aimAssist = c.aimAssist;
    let r = c.seed * 2654435761 >>> 0, input = 0;
    for (let t = 0; t < 60 * 50; t++) {
      if (t % 17 === 0) { r = (Math.imul(r, 1664525) + 1013904223) >>> 0; input = r & 255; }
      s.input = input; s.aimOn = c.aim === 1 && (t % 400) < 200; s.aimAng = t * 0.01;
      s.step();
      if (!s.alive && s.deadT > 1) s.reset(c.seed + t);
      if (t % 60 === 0) out.push([s.sx, s.sy, s.svx, s.svy, s.sa, s.sw, s.hp, s.boostE, s.score, s.nEnt, s.scrap, s.missiles, s.dashCd, s.cool, s.invuln].map(v => Math.fround(v)));
    }
  }
  return out;
}

describe('Wren regression', () => {
  it('matches the pre-refactor flight trace exactly', () => {
    const t = trace();
    const ref = REF as number[][];
    expect(t.length).toBe(ref.length);
    for (let i = 0; i < t.length; i++) expect(t[i]).toEqual(ref[i]);
  }, 60000);

  it.runIf(!!(import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_DUMP_TRACE)('dump', () => { console.log('TRACE' + JSON.stringify(trace())); });

  it('trace exercises every input', () => { expect(In.Missile | In.Thrust | In.Left | In.Right | In.Brake | In.Fire | In.Boost | In.Dodge).toBe(255); });
});
