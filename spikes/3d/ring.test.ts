import { describe, expect, it } from 'vitest';
import { WREN } from '../../src/sim/ships';
import { DT } from '../../src/sim/sim';
import { ChaseCamera } from './camera';
import { Controls } from './controls';
import { type Input, type ShipState, SHIP_R, newShip, stepShip } from './flight';
import { type Vec3, add, addScaled, cross, dot, len, norm, qFromBasis, scale, sub, v3 } from './math';
import { altitude, makePlanet } from './planet';
import { CELL, LAYER, Ring, ROCK_MAX, ROCK_MIN, type RingRock, newRingRock } from './ring';
import { FlightSession } from './session';
import { makeWorld } from './world';

const IDLE: Input = { mx: 0, my: 0, thrust: false, brake: false, roll: 0, strafeX: 0, strafeY: 0, boost: false, cruise: false };
const input = (o: Partial<Input> = {}): Input => ({ ...IDLE, ...o });
const BOOST_TOP = WREN.maxSpeed * 190 / 118;

const world = makeWorld('ring'), planet = world.planet, ring = world.ring!;

/** A fixed sequence in [0,1). */
function seq(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** The first `n` rocks found along the u axis near the middle of the ring. */
function someRocks(n: number, r = ring): { rock: RingRock; at: Vec3 }[] {
  const out: { rock: RingRock; at: Vec3 }[] = [];
  for (let i = 0; out.length < n && i < 4000; i++) {
    for (let k = 0; k < 2 && out.length < n; k++) {
      const rock = newRingRock();
      if (r.rockAt(i - 20, 200 + (i % 7), k, rock)) out.push({ rock, at: r.toWorld(v3(), rock.u, rock.v, rock.h) });
    }
  }
  return out;
}

/** The distance from `pos` to the nearest rock's surface, looking at the cells around it. */
function clearance(pos: Vec3, r = ring): number {
  const l = r.toLocal(v3(), pos), rock = newRingRock();
  let best = Infinity;
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      for (let k = 0; k < 2; k++) {
        if (!r.rockAt(Math.floor(l.x / CELL) + i, Math.floor(l.y / CELL) + j, k, rock)) continue;
        best = Math.min(best, Math.hypot(l.x - rock.u, l.y - rock.v, l.z - rock.h) - rock.r);
      }
    }
  }
  return best;
}

/** A ship at `pos` with its nose along `forward`, moving at `speed`. */
function shipAt(pos: Vec3, forward: Vec3, speed: number): ShipState {
  const s = newShip(), f = norm(v3(), forward);
  const up = norm(v3(), cross(v3(), f, Math.abs(f.x) < 0.9 ? v3(1, 0, 0) : v3(0, 1, 0)));
  Object.assign(s.pos, pos);
  Object.assign(s.q, qFromBasis(cross(v3(), f, up), up, scale(v3(), f, -1)));
  scale(s.vel, f, speed);
  return s;
}

describe('the ring', () => {
  it('runs from 1.4 to 2.2 planet radii, 100 units thick, round the default planet', () => {
    expect(planet).toEqual(makePlanet(1));
    expect([ring.inner, ring.outer, ring.thickness]).toEqual([1.4 * planet.radius, 2.2 * planet.radius, 100]);
    expect(len(ring.n)).toBeCloseTo(1, 12);
    expect(Math.abs(dot(ring.e1, ring.n)) + Math.abs(dot(ring.e2, ring.n)) + Math.abs(dot(ring.e1, ring.e2))).toBeLessThan(1e-12);
    expect(len(sub(v3(), cross(v3(), ring.e1, ring.e2), ring.n))).toBeLessThan(1e-12);
    expect(makeWorld(null).ring).toBeUndefined();
  });

  it('converts to its own axes and back', () => {
    const r = seq(5);
    for (let i = 0; i < 50; i++) {
      const p = v3(r() * 3e4 - 15000, r() * 3e4 - 15000, r() * 3e4 - 15000), l = ring.toLocal(v3(), p);
      expect(len(sub(v3(), ring.toWorld(v3(), l.x, l.y, l.z), p))).toBeLessThan(1e-8);
      expect(l.z).toBeCloseTo(dot(sub(v3(), p, planet.center), ring.n), 8);
    }
  });

  it('is banded: dense bands, gaps, nothing outside', () => {
    const at = Array.from({ length: 2000 }, (_, i) => ring.density(ring.inner + (ring.outer - ring.inner) * (i + 0.5) / 2000));
    for (const d of at) { expect(d).toBeGreaterThanOrEqual(0); expect(d).toBeLessThanOrEqual(1); }
    expect(Math.max(...at)).toBeGreaterThan(0.8);
    expect(at.slice(100, 1900).filter(d => d < 0.12).length).toBeGreaterThan(60);
    for (const r of [0, planet.radius, ring.inner - 1, ring.outer + 1, 1e6]) expect(ring.density(r)).toBe(0);
  });
});

describe('the ring\'s rocks', () => {
  it('come from the position and seed alone', () => {
    const again = makeWorld('ring').ring!, other = makeWorld('ring', 2).ring!;
    const a = newRingRock(), b = newRingRock();
    let same = 0, n = 0;
    for (const { rock } of someRocks(60)) {
      const i = Math.floor(rock.u / CELL), j = Math.floor(rock.v / CELL), k = rock.h < 0 ? 0 : 1;
      ring.rockAt(i + 1, j, k, a); // another cell in between: nothing carries over
      expect(again.rockAt(i, j, k, b)).toBe(true);
      expect(b).toEqual(rock);
      n++;
      if (other.rockAt(i, j, k, b) && b.u === rock.u && b.v === rock.v) same++;
    }
    expect(n).toBe(60);
    expect(same).toBe(0);
  });

  it('keep each its own cell, with room for the ship, so none overlap and none leave the ring\'s thickness', () => {
    const rock = newRingRock(), sizes: number[] = [], kinds = new Set<number>();
    for (let i = -60; i < 60; i++) {
      for (let j = 170; j < 230; j++) {
        for (const k of [-1, 0, 1, 2]) {
          if (!ring.rockAt(i, j, k, rock)) continue;
          expect(k === 0 || k === 1).toBe(true);
          const pad = rock.r + SHIP_R - 1e-9;
          expect(rock.u - pad).toBeGreaterThanOrEqual(i * CELL);
          expect(rock.u + pad).toBeLessThanOrEqual((i + 1) * CELL);
          expect(rock.v - pad).toBeGreaterThanOrEqual(j * CELL);
          expect(rock.v + pad).toBeLessThanOrEqual((j + 1) * CELL);
          expect(rock.h - pad).toBeGreaterThanOrEqual(k * LAYER - 50);
          expect(rock.h + pad).toBeLessThanOrEqual((k + 1) * LAYER - 50);
          const q = rock.q;
          expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 6);
          sizes.push(rock.r); kinds.add(rock.kind);
        }
      }
    }
    expect(sizes.length).toBeGreaterThan(1000);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(ROCK_MIN);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(ROCK_MAX);
    expect(sizes.filter(r => r < 8).length).toBeGreaterThan(sizes.length / 2);
    expect(kinds.size).toBe(4);
    expect([CELL, LAYER, ROCK_MAX]).toEqual([60, 50, 19]);
  });

  it('are as many as the band is dense, and there are none outside the ring', () => {
    const rock = newRingRock();
    const share = (radius: number): number => { // along 1200 units of a row of cells, where the radius is about `radius`
      let n = 0;
      const j = Math.floor(radius / CELL);
      for (let i = -10; i < 10; i++) for (let k = 0; k < 2; k++) if (ring.rockAt(i, j, k, rock)) n++;
      return n / 40;
    };
    const width = ring.outer - ring.inner;
    const dense = ring.inner + 0.55 * width, gap = ring.inner + 0.82 * width; // the middle of a band and of a gap
    expect(share(dense)).toBeGreaterThan(0.3);
    expect(share(gap)).toBeLessThan(0.12);
    expect(share(ring.inner - 300)).toBe(0);
    expect(share(ring.outer + 300)).toBe(0);
    for (let i = -300; i < 300; i += 3) {
      for (let j = -300; j < 300; j += 7) {
        if (!ring.rockAt(i, j, 0, rock)) continue;
        const rho = Math.hypot(rock.u, rock.v);
        expect(rho).toBeGreaterThanOrEqual(ring.inner);
        expect(rho).toBeLessThanOrEqual(ring.outer);
      }
    }
  });
});

describe('flying into a ring rock', () => {
  const rocks = someRocks(40);
  const dirs = [v3(1, 0, 0), v3(0, -1, 0), norm(v3(), v3(0.4, 0.5, -0.77)), v3(0, 0, 1)];

  it('does not pass through it in one 0.25 s step at boost speed; the ship is pushed out and a chip counted', () => {
    let tested = 0;
    for (let n = 0; n < rocks.length; n++) {
      const { rock, at } = rocks[n], d = dirs[n % dirs.length], gap = rock.r + SHIP_R + 12;
      const s = shipAt(addScaled(v3(), at, d, -gap), d, BOOST_TOP);
      // boxed in by neighbours: start clear
      if (clearance(s.pos) < SHIP_R) continue;
      stepShip(s, input({ thrust: true, boost: true }), planet, 0.25, { ring });
      expect(clearance(s.pos)).toBeGreaterThanOrEqual(SHIP_R - 1e-6);
      expect(dot(sub(v3(), s.pos, at), d)).toBeLessThan(0);
      expect(s.chips).toBeGreaterThanOrEqual(1);
      expect(dot(s.vel, d)).toBeLessThan(0);
      tested++;
    }
    expect(tested).toBeGreaterThanOrEqual(36); // 40 when written: a skip must not let this pass empty
  });

  it('does not pass through it at any speed, grazing included', () => {
    let tested = 0;
    for (const speed of [300, 3000, 30000, 1e6]) {
      for (let n = 0; n < rocks.length; n += 3) {
        const { rock, at } = rocks[n], d = dirs[n % dirs.length], pad = rock.r + SHIP_R;
        const aside = norm(v3(), cross(v3(), d, v3(0.3, 0.9, 0.1)));
        for (const off of [0, pad - 0.2]) {
          const from = addScaled(v3(), addScaled(v3(), at, d, -(pad + 2)), aside, off);
          if (clearance(from) < SHIP_R) continue;
          const s = shipAt(from, d, speed);
          stepShip(s, input(), planet, 0.25, { ring });
          expect(s.chips).toBeGreaterThanOrEqual(1);
          expect(clearance(s.pos)).toBeGreaterThanOrEqual(SHIP_R - 1e-6);
          tested++;
        }
      }
    }
    expect(tested).toBeGreaterThanOrEqual(100); // 112 when written
  });

  it('is never inside any rock, whatever the heading and speed', () => {
    const r = seq(11);
    const s = shipAt(ring.toWorld(v3(), 0, 12600, 20), ring.e1, 0);
    let chips = 0;
    for (let i = 0; i < 3000; i++) {
      if (i % 20 === 0) {
        // new heading, mostly in the plane, toward a height of 20 above or below it; speed up to 2000
        const f = add(v3(), scale(v3(), ring.e1, r() - 0.5), scale(v3(), ring.e2, r() - 0.5));
        const l = ring.toLocal(v3(), s.pos);
        addScaled(f, f, ring.n, ((i % 40 ? 20 : -20) - l.z) / 200);
        Object.assign(s.vel, scale(v3(), norm(f, f), 100 + 1900 * r() * r()));
      }
      stepShip(s, input(), planet, i % 3 ? DT : 0.25, { ring });
      expect(clearance(s.pos)).toBeGreaterThanOrEqual(SHIP_R - 1e-6);
      chips = s.chips;
    }
    expect(chips).toBeGreaterThan(20);
  });

  it('counts one chip for one hit, and none for a touch at a crawl', () => {
    const { rock, at } = rocks[1], d = v3(0, 1, 0);
    const hard = shipAt(addScaled(v3(), at, d, -(rock.r + SHIP_R + 1)), d, 100);
    for (let i = 0; i < 30; i++) stepShip(hard, input(), planet, DT, { ring });
    expect(hard.chips).toBe(1);
    const soft = shipAt(addScaled(v3(), at, d, -(rock.r + SHIP_R + 0.02)), d, 3);
    for (let i = 0; i < 30; i++) stepShip(soft, input(), planet, DT, { ring });
    expect(soft.chips).toBe(0);
    expect(clearance(soft.pos)).toBeGreaterThanOrEqual(SHIP_R - 1e-6);
  });

  it('ends cruise', () => {
    const { rock, at } = rocks[2], d = v3(1, 0, 0);
    const s = shipAt(addScaled(v3(), at, d, -(rock.r + SHIP_R + 4)), d, 0);
    s.cruising = true;
    stepShip(s, input(), planet, DT, { ring });
    expect(s.cruising).toBe(false);
    expect(s.chips).toBe(1);
  });

  it('hits rocks on a fast crossing from far above the ring', () => {
    let hit = 0;
    for (const { rock, at } of rocks) {
      const s = shipAt(addScaled(v3(), at, ring.n, 300), scale(v3(), ring.n, -1), 8000);
      stepShip(s, input(), planet, 0.25, { ring });
      if (s.chips > 0) hit++;
      expect(clearance(s.pos)).toBeGreaterThanOrEqual(Math.min(rock.r, SHIP_R) - 1e-6);
    }
    expect(hit).toBe(rocks.length);
  });

  it('keeps the camera out of rocks', () => {
    const cam = new ChaseCamera();
    for (const { rock, at } of rocks.slice(0, 10)) {
      const s = shipAt(add(v3(), at, v3(0, 0, 0)), v3(1, 0, 0), 0);
      // a ship placed so that the chase camera would sit in the rock's middle
      cam.snap(s.pos, s.q, planet, undefined, ring);
      addScaled(s.pos, s.pos, sub(v3(), at, cam.pos), 1);
      cam.snap(s.pos, s.q, planet, undefined, ring);
      expect(len(sub(v3(), cam.pos, at))).toBeGreaterThanOrEqual(rock.r + 1);
    }
  });

  it('works in a free flight, and a restart clears the chips', () => {
    const { rock, at } = rocks[3];
    const session = new FlightSession(planet, v3(0, 0, 1), {
      near: { ring }, start: s => Object.assign(s.pos, addScaled(v3(), at, ring.e1, -(rock.r + SHIP_R + 8))),
    });
    const c = new Controls();
    c.resume();
    scale(session.ship.vel, ring.e1, 90);
    for (let i = 0; i < 30; i++) session.advance(DT, c);
    expect(session.ship.chips).toBe(1);
    session.restart(c);
    expect(session.ship.chips).toBe(0);
  });
});

describe('flying over the planet\'s poles with the ring about', () => {
  it('stays finite over both, and through the ring\'s middle', () => {
    for (const pole of [1, -1]) {
      const s = newShip(), cam = new ChaseCamera();
      s.pos.x = -150; s.pos.y = pole * (planet.radius + planet.relief + 60);
      Object.assign(s.q, qFromBasis(v3(0, 0, pole), v3(0, pole, 0), v3(-1, 0, 0)));
      cam.snap(s.pos, s.q, planet, undefined, ring);
      for (let i = 0; i < 180; i++) {
        stepShip(s, input({ thrust: true }), planet, DT, { ring });
        cam.update(s.pos, s.q, planet, DT, undefined, ring);
        for (const o of [s.pos, s.vel, s.q, cam.pos]) expect(Object.values(o).every(Number.isFinite)).toBe(true);
      }
      expect(altitude(planet, s.pos)).toBeGreaterThanOrEqual(SHIP_R - 1e-6);
    }
    const s = shipAt(ring.toWorld(v3(), 0, 12000, 300), scale(v3(), ring.n, -1), 190);
    for (let i = 0; i < 300; i++) stepShip(s, input({ thrust: true }), planet, DT, { ring });
    expect(Object.values(s.pos).every(Number.isFinite)).toBe(true);
    expect(ring).toBeInstanceOf(Ring);
  });
});
