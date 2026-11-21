import { describe, expect, it } from 'vitest';
import { PLANET_STRIDE, SECTOR, planetParams } from '../src/sim/world';

const out = new Float32Array(PLANET_STRIDE);
const RANGE = 30;
function planets(): { sx: number; sy: number; x: number; y: number; r: number }[] {
  const list = [];
  for (let sy = -RANGE; sy <= RANGE; sy++) for (let sx = -RANGE; sx <= RANGE; sx++) {
    if (planetParams(sx, sy, out, 0)) list.push({ sx, sy, x: out[0], y: out[1], r: out[2] });
  }
  return list;
}

describe('planet sizes and placement', () => {
  it('radius tiers: within range and a minority are giants', () => {
    const ps = planets().filter(p => !(p.sx === 0 && p.sy === 0));
    expect(ps.length).toBeGreaterThan(300);
    for (const p of ps) { expect(p.r).toBeGreaterThanOrEqual(17); expect(p.r).toBeLessThanOrEqual(90); }
    const giants = ps.filter(p => p.r > 55).length / ps.length;
    expect(giants).toBeGreaterThan(0.05); expect(giants).toBeLessThan(0.30);
  });

  it('every planet fits inside its sector with 20 units spare', () => {
    for (const p of planets()) {
      if (p.sx === 0 && p.sy === 0) continue;
      expect(Math.abs(p.x - p.sx * SECTOR) + p.r).toBeLessThanOrEqual(SECTOR / 2 - 20 + 1e-3);
      expect(Math.abs(p.y - p.sy * SECTOR) + p.r).toBeLessThanOrEqual(SECTOR / 2 - 20 + 1e-3);
    }
  });

  it('adjacent planets never overlap', () => {
    const byKey = new Map(planets().map(p => [p.sx + ',' + p.sy, p]));
    for (const p of byKey.values()) for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      const q = byKey.get((p.sx + dx) + ',' + (p.sy + dy));
      if (q) expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThanOrEqual(p.r + q.r);
    }
  });

  it('home planet is radius 46 at (190,-60), well clear of the origin', () => {
    expect(planetParams(0, 0, out, 0)).toBe(true);
    expect([out[0], out[1], out[2]]).toEqual([190, -60, 46]);
    expect(Math.hypot(190, -60) - 46).toBeGreaterThanOrEqual(100);
  });
});

import { Sim } from '../src/sim/sim';

describe('planet gravity is decoupled from size', () => {
  const home = { x: 190, y: -60, r: 46 };
  const pullAt = (gap: number): number => {   // speed gained in one tick by a still ship `gap` units above the home planet's west surface
    const s = new Sim(1);
    s.sx = s.spx = home.x - home.r - gap; s.sy = s.spy = home.y; s.svx = 0; s.svy = 0; s.assist = false;
    s.step();
    return Math.hypot(s.svx, s.svy) / (1 / 60);
  };
  it('is zero beyond r+130 and ~GRAV_K*fall inside', () => {
    expect(pullAt(131)).toBeLessThan(0.05);
    const g = pullAt(20);
    expect(Math.abs(g - 9.5 * (1 - 20 / 130))).toBeLessThan(9.5 * 0.846 * 0.05);
  });
  it('a giant pulls no harder than a medium planet at the same surface gap', () => {
    // pull depends only on the gap above the surface, never on radius
    const expected = (gap: number): number => 9.5 * (1 - gap / 130);
    expect(expected(40)).toBeCloseTo(9.5 * (1 - 40 / 130), 6);
    expect(Math.abs(pullAt(40) - expected(40))).toBeLessThan(expected(40) * 0.05);
  });
});

import { Kind, MAX_E } from '../src/sim/sim';
import { hash2 } from '../src/core/util';

function visit(s: Sim, sx: number, sy: number): void {
  s.sx = s.spx = sx * SECTOR; s.sy = s.spy = sy * SECTOR; s.svx = 0; s.svy = 0; s.hp = s.hpMax;
  for (let i = 0; i < 3; i++) s.step();
}
const decode = (key: number): [number, number] => [(key >> 16), (key << 16) >> 16];

describe('content stays clear of big planets', () => {
  it('stations never sit inside a planet (within r+25)', () => {
    const s = new Sim(3); const p = new Float32Array(PLANET_STRIDE); let seen = 0;
    for (let sy = -8; sy <= 8; sy++) for (let sx = -8; sx <= 8; sx++) {
      visit(s, sx, sy);
      for (let e = 0; e < MAX_E; e++) {
        if (s.ek[e] !== Kind.Station) continue;
        const [ksx, ksy] = decode(s.esec[e]);
        if (!planetParams(ksx, ksy, p, 0)) continue;
        seen++;
        expect(Math.hypot(s.ex[e] - p[0], s.ey[e] - p[1])).toBeGreaterThanOrEqual(p[2] + 25);
      }
    }
    expect(seen).toBeGreaterThan(10);
  });

  it('derelict caches never sit inside a planet', () => {
    const s = new Sim(3); const p = new Float32Array(PLANET_STRIDE); let seen = 0;
    for (let sy = -8; sy <= 8; sy++) for (let sx = -8; sx <= 8; sx++) {
      visit(s, sx, sy);
      for (let i = 0; i < 96; i++) {
        if (s.scl[i] < 1e5) continue;
        const ssx = Math.round(s.scx[i] / SECTOR), ssy = Math.round(s.scy[i] / SECTOR);
        if (!planetParams(ssx, ssy, p, 0)) continue;
        seen++;
        expect(Math.hypot(s.scx[i] - p[0], s.scy[i] - p[1])).toBeGreaterThanOrEqual(p[2] + 10);
      }
    }
    expect(seen).toBeGreaterThan(3);
  });

  it('a belt around a big planet has enough rocks to look like a belt', () => {
    const p = new Float32Array(PLANET_STRIDE);
    let found: [number, number] | null = null;
    for (let sy = -30; sy <= 30 && !found; sy++) for (let sx = -30; sx <= 30 && !found; sx++) {
      if (!planetParams(sx, sy, p, 0) || p[2] < 70) continue;
      if (hash2(sx * 3 + 5, sy * 7 + 2) < 0.5 && !(hash2(sx * 5 + 1, sy * 11 + 3) < 0.42)) found = [sx, sy];
    }
    expect(found).not.toBeNull();
    const [bx, by] = found!; planetParams(bx, by, p, 0);
    const s = new Sim(3); visit(s, bx, by);
    let n = 0;
    for (let e = 0; e < MAX_E; e++) {
      if (s.ek[e] !== Kind.Asteroid) continue;
      if (Math.abs(Math.hypot(s.ex[e] - p[0], s.ey[e] - p[1]) - (p[2] + 20)) <= 6) n++;
    }
    expect(n).toBeGreaterThanOrEqual(28);
  });
});

import { gravReach, moonOrbit, hasMoon } from '../src/sim/world';

describe('moons and gravity reach stay inside their own sector', () => {
  it('every moon orbit fits its sector and clears its planet', () => {
    let moons = 0;
    for (const p of planets()) {
      if (p.sx === 0 && p.sy === 0) continue;
      const ox = p.x - p.sx * SECTOR, oy = p.y - p.sy * SECTOR, mr = 3.2 + p.r * 0.1;
      const orbit = moonOrbit(p.sx, p.sy, p.r, ox, oy);
      if (orbit <= 0) continue;
      moons++;
      expect(Math.abs(ox) + orbit + mr).toBeLessThanOrEqual(SECTOR / 2 - 5);
      expect(Math.abs(oy) + 0.8 * orbit + mr).toBeLessThanOrEqual(SECTOR / 2 - 5);
      expect(0.8 * orbit).toBeGreaterThanOrEqual(p.r + mr + 8);
    }
    expect(moons).toBeGreaterThan(40);
  });

  it('the home moon never reaches the neighbouring sectors planets', () => {
    expect(hasMoon(0, 0)).toBe(true);
    const o = moonOrbit(0, 0, 46, 190, -60);
    expect(o).toBeGreaterThan(0);
    const q = new Float32Array(PLANET_STRIDE);
    for (const [dx, dy] of [[1, 0], [1, 1], [1, -1], [0, 1], [0, -1], [-1, 0], [-1, 1], [-1, -1]]) {
      if (!planetParams(dx, dy, q, 0)) continue;
      expect(Math.hypot(q[0] - 190, q[1] + 60)).toBeGreaterThanOrEqual(o + 3.2 + 4.6 + q[2]);
    }
  });

  it('gravity reach is min(130, 6.5r), which the HUD warning shares', () => {
    expect(gravReach(90)).toBe(130);
    expect(gravReach(17.6)).toBeCloseTo(114.4, 1);
    expect(gravReach(8)).toBeCloseTo(52, 6);
  });
});
