import { describe, expect, it } from 'vitest';
import { DT, In, Kind, MAX_E, MAX_S, Sim, UP_MAX, Up, upCost } from '../src/sim/sim';

describe('progression', () => {
  it('buys upgrades with scrap, charges the right cost, and stops at max', () => {
    const s = new Sim(3);
    s.scrap = 1000;
    expect(s.buyUpgrade(Up.Hull)).toBe(true);
    expect(s.scrap).toBe(1000 - upCost(0));
    expect(s.hpMax).toBe(125);
    for (let i = 0; i < 10; i++) s.buyUpgrade(Up.Hull);
    expect(s.up[Up.Hull]).toBe(UP_MAX);
    const before = s.scrap;
    expect(s.buyUpgrade(Up.Hull)).toBe(false);
    expect(s.scrap).toBe(before);
    s.scrap = 0;
    expect(s.buyUpgrade(Up.Gun)).toBe(false);
  });

  it('upgrades survive reset(), per-run stats do not', () => {
    const s = new Sim(4);
    s.scrap = 500; s.buyUpgrade(Up.Boost); s.shots = 9;
    s.reset(5);
    expect(s.up[Up.Boost]).toBe(1);
    expect(s.shots).toBe(0);
    expect(s.boostMax).toBe(125);
    expect(s.hp).toBe(s.hpMax);
  });

  it('collects scrap that is dropped near the ship', () => {
    const s = new Sim(6);
    s.spawnScrap(s.sx + 6, s.sy, 7);
    for (let i = 0; i < 120; i++) s.step();
    expect(s.scrap).toBeGreaterThanOrEqual(7);
  });

  it('kills drop scrap and advance the objective', () => {
    const s = new Sim(8);
    const e = s.spawnEnt(Kind.Drone, s.sx + 30, s.sy, 0, 0);
    s.killEnt(e, true);
    expect(s.objKills).toBe(1);
    let any = false;
    for (let i = 0; i < MAX_S; i++) if (s.scl[i] > 0) any = true;
    expect(any).toBe(true);
  });

  it('spawns a boss on schedule', () => {
    const s = new Sim(9);
    s.nextBoss = 1;
    for (let i = 0; i < 240; i++) s.step();
    let boss = 0;
    for (let i = 0; i < MAX_E; i++) if (s.ek[i] === Kind.Boss) boss++;
    expect(boss).toBe(1);
  });

  it('dash is rate limited and grants brief invulnerability', () => {
    const s = new Sim(10);
    s.invuln = 0; s.input = In.Dodge; s.step();
    expect(s.dashCd).toBeGreaterThan(1);
    expect(s.invuln).toBeGreaterThan(0.2);
    const v = Math.hypot(s.svx, s.svy);
    s.step();
    expect(Math.hypot(s.svx, s.svy)).toBeLessThanOrEqual(v + 1e-3);
    expect(DT).toBeGreaterThan(0);
  });
});
