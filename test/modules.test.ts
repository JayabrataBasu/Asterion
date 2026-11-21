import { describe, expect, it } from 'vitest';
import { Sim, UP_N, Up } from '../src/sim/sim';
import { MODULES, WREN, applyModules, cloneShip } from '../src/sim/ships';

describe('modules modify the ShipDef', () => {
  it('cover every upgrade slot and the five module families', () => {
    expect(MODULES.length).toBe(UP_N);
    expect(new Set(MODULES.map(m => m.slot))).toEqual(new Set(['WEAPONS', 'HULL', 'ENGINE', 'REACTOR', 'UTILITY']));
  });
  it('apply additive and multiplicative modifiers without touching the base', () => {
    const base = cloneShip(WREN), d = cloneShip(WREN), up = new Int8Array(UP_N);
    up[Up.Hull] = 2; up[Up.Thrust] = 5; up[Up.Missile] = 1; up[Up.Tank] = 3;
    applyModules(d, base, up);
    expect(d.hullMax).toBe(150); expect(d.thrustFwd).toBeCloseTo(7800 * 1.4); expect(d.missileCap).toBe(5); expect(d.fuelMax).toBeCloseTo(160);
    expect(base.hullMax).toBe(100);
  });
  it('the sim uses them immediately after buying', () => {
    const s = new Sim(1); s.scrap = 1000; const h = s.hpMax;
    s.buyUpgrade(Up.Hull); expect(s.hpMax).toBe(h + 25);
    s.buyUpgrade(Up.Sensors); expect(s.sensorR).toBeCloseTo(WREN.sensorRange * 1.15);
    s.reset(2); expect(s.hpMax).toBe(h + 25);                       // modules persist across runs
  });
});
