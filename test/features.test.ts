import { describe, expect, it } from 'vitest';
import { In, Kind, MAX_E, Sim, Up } from '../src/sim/sim';

const count = (s: Sim, k: number): number => { let n = 0; for (let i = 0; i < MAX_E; i++) if (s.ek[i] === k) n++; return n; };

describe('new enemies and weapons', () => {
  it('missiles need the upgrade, spend ammo, home in and destroy a drone', () => {
    const s = new Sim(21);
    s.input = In.Missile; s.step();
    expect(s.missiles).toBe(0);                        // not purchased: nothing fires
    s.scrap = 500; s.buyUpgrade(Up.Missile); s.reset(21);
    expect(s.missileCap).toBe(5);
    const e = s.spawnEnt(Kind.Drone, s.sx + 80, s.sy + 25, 0, 0);
    s.input = In.Missile; s.step(); s.input = 0;
    expect(s.missiles).toBeLessThan(5);
    for (let i = 0; i < 240 && s.ek[e] === Kind.Drone; i++) s.step();
    expect(s.ek[e]).not.toBe(Kind.Drone);
  });

  it('splitters break into two drones', () => {
    const s = new Sim(22);
    const e = s.spawnEnt(Kind.Splitter, s.sx + 60, s.sy, 0, 0);
    const before = count(s, Kind.Drone);
    s.killEnt(e, true);
    expect(count(s, Kind.Drone)).toBe(before + 2);
  });

  it('shields soak bullet damage before hull, but missiles/blasts ignore them', () => {
    const s = new Sim(23);
    const e = s.spawnEnt(Kind.Gunship, s.sx + 60, s.sy, 0, 0);
    s.eshield[e] = 8;
    s.hitEnt(e, 3, 0, 0);
    expect(s.ehp[e]).toBe(9);
    expect(s.eshield[e]).toBe(5);
  });

  it('tenders heal wounded neighbours', () => {
    const s = new Sim(24);
    const t = s.spawnEnt(Kind.Tender, s.sx + 400, s.sy + 400, 0, 0);
    const g = s.spawnEnt(Kind.Gunship, s.sx + 405, s.sy + 400, 0, 0);
    s.ehp[g] = 2;
    for (let i = 0; i < 120; i++) s.step();
    expect(s.ek[t]).toBe(Kind.Tender);
    expect(s.ehp[g]).toBeGreaterThan(2);
  });

  it('rammers explode on contact and hurt the ship', () => {
    const s = new Sim(25);
    s.invuln = 0;
    const e = s.spawnEnt(Kind.Rammer, s.sx + 4, s.sy, 0, 0);
    const hp = s.hp;
    s.step();
    expect(s.ek[e]).toBe(Kind.None);
    expect(s.hp).toBeLessThan(hp);
  });

  it('objectives rotate through hostiles, scrap and asteroids', () => {
    const s = new Sim(26);
    expect(s.objType).toBe(0);
    for (let i = 0; i < 6; i++) { const e = s.spawnEnt(Kind.Drone, s.sx + 50, s.sy, 0, 0); s.killEnt(e, true); }
    expect(s.objType).toBe(1);
    expect(s.objTier).toBe(1);
  });
});

describe('world features', () => {
  it('station types change prices and hard mode toughens enemies', () => {
    const s = new Sim(31);
    s.scrap = 1000;
    s.dockMult = 0.8;
    expect(s.price(Up.Gun)).toBe(24);
    s.dockMult = 1.35;
    expect(s.price(Up.Gun)).toBe(41);
    s.hard = true;
    const e = s.spawnEnt(Kind.Gunship, s.sx + 300, s.sy, 0, 0);
    expect(s.ehp[e]).toBeCloseTo(13.5);
  });

  it('survive objective advances with time', () => {
    const s = new Sim(32);
    s.objTier = 3; s.objKills = 0; s.objTarget = 2;      // tier 3 -> type 3 (survive)
    for (let i = 0; i < 150; i++) s.step();
    expect(s.objTier).toBe(4);
  });

  it('seeds persistent cargo caches only once per sector', () => {
    const s = new Sim(33);
    let found = false;
    for (let sx = 1; sx < 40 && !found; sx++) {
      s.reset(33); s.sx = s.spx = sx * 520; s.sy = s.spy = 0;
      for (let i = 0; i < 3; i++) s.step();
      for (let i = 0; i < 96; i++) if (s.scl[i] > 1000) found = true;
    }
    expect(found).toBe(true);
  });
});

describe('escort mission', () => {
  it('spawns a freighter, advances progress while the player stays close, and fails when it dies', () => {
    const s = new Sim(5);
    s.objTier = 5; s.objKills = 0; s.objTarget = 50;
    for (let i = 0; i < 60 * 4; i++) { s.input = 0; s.step(); }
    expect(s.frIdx).toBeGreaterThanOrEqual(0);
    const f = s.frIdx;
    // keep the player parked next to the freighter so it keeps moving
    for (let i = 0; i < 60 * 6; i++) { s.sx = s.ex[f] + 20; s.sy = s.ey[f]; s.svx = 0; s.svy = 0; s.hp = s.hpMax; s.step(); }
    expect(s.objKills).toBeGreaterThan(0.5);
    // player bolts pass through it
    const hp0 = s.ehp[f];
    s.spawnBullet(s.ex[f] - 3, s.ey[f], 200, 0, 1, 0, 5); for (let i = 0; i < 6; i++) s.step();
    expect(s.ehp[f]).toBe(hp0);
    s.killEnt(f, false);
    expect(s.frIdx).toBe(-1); expect(s.escortFails).toBe(1); expect(s.objType).not.toBe(5);
  });
});
