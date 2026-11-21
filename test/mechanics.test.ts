import { describe, expect, it } from 'vitest';
import { Dmg, In, Kind, MAX_E, Sim } from '../src/sim/sim';
import { ANVIL, HIVE, MULE, SHADE, WREN, cloneShip } from '../src/sim/ships';
import { defaults, migrate } from '../src/core/save';
import { UNLOCKS } from '../src/sim/unlocks';
import { planetsNear } from '../src/sim/world';

function emptySpace(): [number, number] {
  const out = new Float32Array(64);
  for (let i = 1; i < 200; i++) if (planetsNear(i * 520, 0, 380, out) === 0) return [i * 520, 0];
  throw new Error('no empty space');
}
function quiet(ship = WREN): Sim {
  const s = new Sim(9); s.setShip(ship); s.reset(9); s.invuln = 0;
  const [x, y] = emptySpace(); s.sx = s.spx = x; s.sy = s.spy = y; s.svx = s.svy = 0;
  for (let e = 0; e < MAX_E; e++) s.ek[e] = Kind.None;
  return s;
}
const clear = (s: Sim): void => { for (let e = 0; e < MAX_E; e++) if (s.ek[e] !== Kind.Wing) s.ek[e] = Kind.None; };

describe('defence pipeline', () => {
  it('shields absorb before hull and regen after the delay', () => {
    const s = quiet(); expect(s.shield).toBe(20);
    s.damageShip(15, 1, 0); expect(s.shield).toBe(5); expect(s.hp).toBe(100);
    s.damageShip(15, 1, 0); expect(s.shield).toBe(0); expect(s.hp).toBe(90);
    for (let i = 0; i < 60 * 2; i++) { s.input = 0; s.step(); clear(s); }
    expect(s.shield).toBe(0);
    for (let i = 0; i < 60 * 3; i++) { s.input = 0; s.step(); clear(s); }
    expect(s.shield).toBeGreaterThan(5);
  });
  it('resists cut damage by type and armour is flat but never below 25%', () => {
    const s = quiet(ANVIL); s.shield = 0; const h0 = s.hp;
    s.damageShip(10, 1, 0, Dmg.Kinetic); expect(h0 - s.hp).toBeCloseTo(10 * 0.75 - 1.5);
    const h1 = s.hp; s.damageShip(10, 1, 0, Dmg.Em); expect(h1 - s.hp).toBeCloseTo(10 - 1.5);
    const h2 = s.hp; s.damageShip(1, 1, 0, Dmg.Em); expect(h2 - s.hp).toBeCloseTo(0.25);
  });
  it('ion storms knock shields out', () => {
    const s = quiet(); s.triggerEvent(4); for (let i = 0; i < 60 * 7; i++) { s.input = 0; s.step(); clear(s); }
    expect(s.storm).toBeGreaterThan(0.3); expect(s.shield).toBe(0);
  });
  it('mule cargo soaks damage and is lost doing it', () => {
    const s = quiet(MULE); s.shield = 0; s.cargoUsed = 20; const h = s.hp;
    s.damageShip(20, 1, 0); expect(h - s.hp).toBeLessThan(20 * (1 - 0.1) - 1 + 1e-6); expect(s.cargoUsed).toBeLessThan(20);
  });
});

describe('power and heat', () => {
  it('firing spends energy and stops when it runs out', () => {
    const d = cloneShip(WREN); d.energyRegen = 1; const s = quiet(d);
    for (let i = 0; i < 60 * 15; i++) { s.input = In.Fire; s.step(); }
    expect(s.energy).toBeLessThan(2);
  });
  it('overheating locks weapons until heat halves', () => {
    const s = quiet(); s.heat = s.ship.heatMax + 1; s.step();
    expect(s.overheat).toBe(true);
    const shots = s.shots; s.input = In.Fire; s.step(); expect(s.shots).toBe(shots);
    for (let i = 0; i < 60 * 8; i++) { s.input = 0; s.step(); }
    expect(s.overheat).toBe(false);
  });
  it('wren can fire and boost continuously without overheating', () => {
    const s = quiet();
    for (let i = 0; i < 60 * 20; i++) { s.input = In.Fire | In.Thrust | (i % 600 < 200 ? In.Boost : 0) | In.Left; s.step(); clear(s); }
    expect(s.overheat).toBe(false);
  });
});

describe('signature', () => {
  it('a dark shade is noticed much later than a boosting wren', () => {
    const reach = (ship: typeof WREN, inp: number): number => {
      for (let d = 260; d > 10; d -= 10) {
        const s = quiet(ship); s.input = inp; s.step(); s.step();
        const e = s.spawnEnt(Kind.Drone, s.sx + d, s.sy, 0, 0); s.input = inp; s.step();
        if (s.es[e] !== 0) return d;
      }
      return 0;
    };
    expect(reach(SHADE, 0)).toBeLessThan(reach(WREN, In.Thrust | In.Boost) * 0.5);
  });
});

describe('quirks', () => {
  it('anvil rams for heavy damage', () => {
    const hit = (ship: typeof WREN): number => {
      const s = quiet(ship); const e = s.spawnEnt(Kind.Gunship, s.sx + 6, s.sy, 0, 0); s.ehp[e] = 100; s.svx = 60; s.step(); return 100 - s.ehp[e];
    };
    expect(hit(ANVIL)).toBeGreaterThan(hit(WREN) * 3);
  });
  it('hive launches wingmen that fight', () => {
    const s = quiet(HIVE); s.hp = 1e6;
    const e = s.spawnEnt(Kind.Gunship, s.sx + 90, s.sy, 0, 0); s.ehp[e] = 30;
    let launched = 0;
    for (let i = 0; i < 60 * 12; i++) { s.input = 0; s.step(); launched = Math.max(launched, s.nWing); }
    expect(launched).toBeGreaterThanOrEqual(1);
    expect(s.ek[e] === Kind.None || s.ehp[e] < 30).toBe(true);
  });
  it('wingmen are never targets for the player', () => {
    const s = quiet(HIVE); const w = s.spawnEnt(Kind.Wing, s.sx + 20, s.sy, 0, 0); s.et[w] = 20;
    s.sa = 0; for (let i = 0; i < 30; i++) { s.input = In.Fire; s.step(); }
    expect(s.hits).toBe(0); expect(s.nEnemy).toBe(0);
  });
});

describe('save v2', () => {
  it('migrates a v1 save into the wren slot', () => {
    const d = migrate({ v: 1, hi: 4200, up: [1, 2, 3, 0, 0, 1, 2], scrap: 77, assist: true, aimAssist: 3, binds: { thrust: 'KeyI' } });
    expect(d.v).toBe(2); expect(d.ship).toBe('wren'); expect(d.upBy.wren.slice(0, 7)).toEqual([1, 2, 3, 0, 0, 1, 2]);
    expect(d.hiBy.wren).toBe(4200); expect(d.scrap).toBe(77); expect(d.aimAssist).toBe(3); expect(d.binds.thrust).toBe('KeyI'); expect(d.binds.scan).toBe('KeyQ');
  });
  it('rejects junk and unknown versions', () => {
    expect(migrate({ v: 9 })).toEqual(defaults());
    const d = migrate({ v: 2, ship: 'needle', unlocked: ['needle', 'x<y', 42], upBy: { needle: [9, -1, 'a'] }, stats: { kills: 'lots', bosses: 3 } });
    expect(d.unlocked).toEqual(['wren', 'needle']); expect(d.ship).toBe('needle');
    expect(d.upBy.needle.slice(0, 3)).toEqual([5, 0, 0]); expect(d.stats.kills).toBe(0); expect(d.stats.bosses).toBe(3);
    expect(migrate({ v: 2, ship: 'hive' }).ship).toBe('wren');                // not unlocked
  });
  it('unlock rules cover the roster and hive is late', () => {
    expect(UNLOCKS.length).toBe(8);
    const st = defaults().stats;
    expect(UNLOCKS.filter(u => u.ok(st)).map(u => u.id)).toEqual(['wren']);
    expect(UNLOCKS.find(u => u.id === 'hive')!.ok({ ...st, bosses: 5, systems: 2 })).toBe(false);
  });
});
