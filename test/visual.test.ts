import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/sim';
import { designation } from '../src/sim/world';

describe('scale set pieces', () => {
  it('eclipse and megastructure run their full envelopes and end', () => {
    for (const [ty, len] of [[5, 45], [6, 90]] as const) {
      const s = new Sim(4); s.invuln = 1e9; s.hp = 1e9;
      s.triggerEvent(ty); let peak = 0;
      for (let i = 0; i < 60 * (len + 8); i++) { s.input = 0; s.step(); peak = Math.max(peak, ty === 5 ? s.ecl : s.mega); }
      expect(peak).toBeGreaterThan(0.95); expect(ty === 5 ? s.ecl : s.mega).toBe(0);
    }
  });
  it('the random scheduler eventually picks a rare set piece', () => {
    const s = new Sim(31); s.invuln = 1e9; s.hp = 1e9; let seen = false;
    for (let i = 0; i < 60 * 60 * 25 && !seen; i++) { s.input = 0; s.step(); if (s.warn >= 5) seen = true; }
    expect(seen).toBe(true);
  }, 60000);
});

describe('catalogue designations', () => {
  it('are deterministic, short and distinguish moons', () => {
    expect(designation(190, -60, 46)).toBe(designation(190, -60, 46));
    expect(designation(190, -60, 46)).not.toBe(designation(560, -53, 46));
    expect(designation(10, 10, 6)).toContain('MOON');
    expect(designation(1234, -999, 40).length).toBeLessThan(20);
  });
});
