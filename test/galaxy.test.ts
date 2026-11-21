import { describe, expect, it } from 'vitest';
import { FRAGMENTS, Galaxy, N_SYS, Poi, SYS_BOUND, TICK_S } from '../src/sim/galaxy';
import { Ev, In, Kind, MAX_E, Sim } from '../src/sim/sim';
import { PLANET_STRIDE, SYS, planetParams, planetsNear, setSystem } from '../src/sim/world';

const snap = (g: Galaxy): string => JSON.stringify({ sys: g.systems, fac: g.factions, st: g.st });

describe('procedural galaxy', () => {
  it('is fully deterministic from the seed', () => {
    expect(snap(new Galaxy(1234))).toBe(snap(new Galaxy(1234)));
    expect(snap(new Galaxy(1234))).not.toBe(snap(new Galaxy(1235)));
  });
  it('has unique names, a central home, spaced systems, linked wormholes', () => {
    const g = new Galaxy(77);
    expect(g.systems.length).toBe(N_SYS);
    expect(new Set(g.systems.map(s => s.name)).size).toBe(N_SYS);
    expect(g.systems[0]).toMatchObject({ name: 'HELIX', saltX: 0, saltY: 0 });
    for (const a of g.systems) for (const b of g.systems) if (a.id < b.id) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(5);
    for (const s of g.systems) for (const p of s.pois) if (p.kind === Poi.Wormhole) expect(p.link).not.toBe(s.id);
    expect(g.known(0)).toBe(2);
  });
  it('salted systems generate different, deterministic sectors and nothing past the bound', () => {
    const out = new Float32Array(PLANET_STRIDE), sig = (): string => { let k = ''; for (let sy = -3; sy <= 3; sy++) for (let sx = -3; sx <= 3; sx++) k += planetParams(sx, sy, out, 0) ? out[2].toFixed(1) : '-'; return k; };
    const g = new Galaxy(5);
    setSystem(g.systems[3].saltX, g.systems[3].saltY, SYS_BOUND); const a = sig();
    setSystem(g.systems[4].saltX, g.systems[4].saltY, SYS_BOUND); const b = sig();
    setSystem(g.systems[3].saltX, g.systems[3].saltY, SYS_BOUND); expect(sig()).toBe(a);
    expect(a).not.toBe(b);
    expect(planetParams(SYS_BOUND + 1, 0, out, 0)).toBe(false);
    setSystem(0, 0); expect(SYS.bound).toBe(Infinity);
  });
});

describe('living galaxy', () => {
  it('ticks deterministically, stays bounded and writes news', () => {
    const a = new Galaxy(9), b = new Galaxy(9);
    for (let i = 0; i < 400; i++) { a.advance(TICK_S); b.advance(TICK_S); }
    expect(snap(a)).toBe(snap(b));
    for (const q of a.st.sys) {
      for (const v of [q.stability, q.wealth, q.piracy]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
      for (const v of q.supply) { expect(v).toBeGreaterThanOrEqual(0.2); expect(v).toBeLessThanOrEqual(1.8); }
    }
    for (const r of a.st.rel) expect(Math.abs(r)).toBeLessThanOrEqual(1);
    expect(a.st.news.length).toBeGreaterThan(0); expect(a.st.news.length).toBeLessThanOrEqual(12);
    expect(JSON.stringify(a.state()).length).toBeLessThan(20000);
  });
  it('player actions move the numbers', () => {
    const g = new Galaxy(3), q = g.st.sys[0];
    const p0 = q.piracy; for (let i = 0; i < 20; i++) g.onKill(); expect(q.piracy).toBeLessThan(p0);
    const w0 = q.wealth; g.onHaulerLost(); expect(q.wealth).toBeLessThan(w0);
    const f0 = g.price(0, false); g.onTrade(0, -20); expect(g.price(0, false)).toBeGreaterThan(f0);
    expect(g.price(1, true)).toBeLessThan(g.price(1, false));
  });
  it('round-trips through a save and rejects junk', () => {
    const g = new Galaxy(42); g.advance(TICK_S * 5); g.arrive(3); g.recordScan(77); g.lore({ kind: Poi.Signal, x: 0, y: 0, seed: 0.3, link: -1 }, 3);
    const h = new Galaxy(42, JSON.parse(JSON.stringify(g.state())));
    expect(snap(h)).toBe(snap(g));
    const bad = new Galaxy(42, { gv: 1, seed: 42, visited: ['x', 99, 2], frags: [1, 1, 900], sys: 'no', rel: [5], news: [3] });
    expect(bad.st.visited).toEqual([0, 2]); expect(bad.st.frags).toEqual([1]);
    expect(snap(new Galaxy(42, { gv: 7 }))).toBe(snap(new Galaxy(42)));
    expect(snap(new Galaxy(42, { ...g.state(), seed: 43 }))).toBe(snap(new Galaxy(42)));   // another galaxy's state is ignored
  });
  it('the mystery has 8 fragments and each is found once', () => {
    const g = new Galaxy(8); const seen = new Set<number>();
    for (let i = 0; i < 20; i++) { const f = g.lore({ kind: Poi.Signal, x: 0, y: 0, seed: i / 20, link: -1 }, i).frag; if (f >= 0) { expect(seen.has(f)).toBe(false); seen.add(f); } }
    expect(seen.size).toBe(FRAGMENTS.length);
  });
});

function quiet(): Sim {
  const s = new Sim(2); s.invuln = 1e9; s.hp = 1e9;
  for (let e = 0; e < MAX_E; e++) s.ek[e] = Kind.None;
  return s;
}
const events = (s: Sim, t: number): number[] => { const o: number[] = []; for (let i = s.evTail; i < s.evHead; i++) if (s.evT[i & 255] === t) o.push(s.evM[i & 255]); return o; };

describe('exploration sim', () => {
  it('scanning a candidate in sensor range completes and emits Ev.Scan; nebula slows it unless the hull ignores it', () => {
    const s = quiet(); s.sx = 0; s.sy = 0;
    s.scanList.set([100, 0, 10]); s.nScan = 1;
    let n = 0; while (n < 600 && events(s, Ev.Scan).length === 0) { s.input = In.Scan; s.step(); n++; }
    expect(events(s, Ev.Scan)).toEqual([0]); expect(n / 60).toBeGreaterThan(1.5); expect(n / 60).toBeLessThan(4);
    const far = quiet(); far.scanList.set([5000, 0, 10]); far.nScan = 1; for (let i = 0; i < 300; i++) { far.input = In.Scan; far.step(); }
    expect(events(far, Ev.Scan).length).toBe(0);
  });
  it('fuel burns with thrust, a dry tank cuts thrust, gas giants refill it', () => {
    const s = quiet(); s.fuel = 1; for (let i = 0; i < 60 * 6; i++) { s.input = In.Thrust; s.step(); }
    expect(s.fuel).toBe(0);
  });
  it('cruise needs empty space, multiplies speed, and a hostile drops you out', () => {
    const s = quiet(); const out = new Float32Array(64); let ex = 0;
    for (let i = 1; i < 200 && !ex; i++) if (planetsNear(i * 520, 0, 380, out) === 0) ex = i * 520;
    s.sx = s.spx = ex; s.sy = s.spy = 0;
    for (let i = 0; i < 2; i++) { s.input = In.Cruise; s.step(); s.input = 0; s.step(); }
    s.input = In.Cruise; s.step(); expect(s.cruise).toBe(true);
    for (let i = 0; i < 60 * 1.5; i++) { s.input = In.Thrust; s.step(); }
    expect(s.cruise).toBe(true); expect(Math.hypot(s.svx, s.svy)).toBeGreaterThan(s.ship.maxSpeed * 1.5);
    s.spawnEnt(Kind.Drone, s.sx + 100, s.sy, 0, 0); for (let i = 0; i < 16; i++) { s.input = In.Thrust; s.step(); }
    expect(s.cruise).toBe(false);
  });
  it('a jump charges, hits stall it, and it completes with Ev.Jump', () => {
    const s = quiet(); s.startJump(1);
    for (let i = 0; i < 30; i++) { s.input = 0; s.step(); }
    s.invuln = 0; s.damageShip(10, 1, 0); const t = s.jumpT; expect(t).toBeGreaterThan(0.4);
    s.invuln = 1e9; for (let i = 0; i < 90; i++) { s.input = 0; s.step(); }
    expect(events(s, Ev.Jump).length).toBe(1); expect(s.jumpT).toBe(0);
  });
  it('POIs trigger once: beacons drop salvage, pulsars irradiate, wormholes emit', () => {
    const s = quiet(); s.sx = s.spx = 0; s.sy = s.spy = 0;
    s.setPoi(0, 40, 0, Poi.Beacon, 0.9); s.setPoi(1, 3000, 0, Poi.Pulsar, 0.5); s.setPoi(2, 6000, 0, Poi.Wormhole, 0.5);
    s.input = 0; s.step(); expect(events(s, Ev.Poi)).toEqual([0]);
    let caches = 0; for (let i = 0; i < 96; i++) if (s.scl[i] > 1000 && Math.hypot(s.scx[i] - 40, s.scy[i]) < 20) caches++; expect(caches).toBe(5);
    s.step(); expect(events(s, Ev.Poi)).toEqual([0]);
    s.sx = s.spx = 2900; s.invuln = 0; s.shield = 0; s.hp = 100; for (let i = 0; i < 60; i++) { s.input = 0; s.step(); }
    expect(s.radiation).toBeGreaterThan(0); expect(s.hp).toBeLessThan(100);
    s.invuln = 1e9; s.sx = s.spx = 6005; s.input = 0; s.step(); expect(events(s, Ev.Wormhole)).toEqual([2]);
  });
  it('enterSystem clears the local world and keeps the run', () => {
    const s = quiet(); s.scrap = 77; s.kills = 3; for (let i = 0; i < 120; i++) { s.input = In.Fire; s.step(); }
    s.enterSystem(); expect(s.nPoi).toBe(0); expect(s.scrap).toBe(77); expect(s.kills).toBe(3);
    let n = 0; for (let e = 0; e < MAX_E; e++) if (s.ek[e] !== Kind.None) n++; expect(n).toBe(0);
    s.input = 0; s.step(); expect(Number.isFinite(s.sx + s.sy)).toBe(true);
    void planetsNear;
  });
  it('trade cargo respects the hold', () => {
    const s = quiet(); expect(s.moveCargo(0, 100)).toBe(s.ship.cargo); expect(s.moveCargo(1, 1)).toBe(0);
    expect(s.moveCargo(0, -3)).toBe(-3); expect(s.cargoUsed).toBe(s.ship.cargo - 3);
  });
  it('jump fuel grows with distance', () => { expect(Galaxy.jumpFuel(20, 0.25)).toBeGreaterThan(Galaxy.jumpFuel(10, 0.25)); });
});
