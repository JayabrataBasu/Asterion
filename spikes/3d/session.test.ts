import { describe, expect, it } from 'vitest';
import { DT } from '../../src/sim/sim';
import { Controls } from './controls';
import { SHIP_R } from './flight';
import { dot, len, norm, qRotate, sub, v3 } from './math';
import { pathFocus } from './path';
import { altitude, makePlanet } from './planet';
import { FlightSession, MAX_STEPS, START_ALT } from './session';

const planet = makePlanet(1), focus = pathFocus(planet);
const make = (): { s: FlightSession; c: Controls } => {
  const c = new Controls(); c.resume();
  return { s: new FlightSession(planet, focus), c };
};
const nose = (s: FlightSession) => qRotate(v3(), s.ship.q, v3(0, 0, -1));

describe('start', () => {
  it('is at altitude 20000 over the given ground, at rest, facing the planet', () => {
    const { s } = make();
    expect(altitude(planet, s.ship.pos)).toBeCloseTo(START_ALT, 6);
    expect(START_ALT).toBe(20000);
    const toCentre = norm(v3(), sub(v3(), planet.center, s.ship.pos));
    expect(dot(nose(s), toCentre)).toBeCloseTo(1, 9);
    expect(dot(norm(v3(), sub(v3(), s.ship.pos, planet.center)), focus)).toBeCloseTo(1, 9);
    expect(len(s.ship.vel)).toBe(0);
    expect(s.ship.level).toBe(true);
    expect(s.ship.cruising).toBe(false);
    expect(Math.hypot(s.ship.q.x, s.ship.q.y, s.ship.q.z, s.ship.q.w)).toBeCloseTo(1, 12);
    expect(s.pos).toEqual(s.ship.pos);
    expect(s.q).toEqual(s.ship.q);
  });
  it('is restored by restart, which keeps the level setting and drops the reticle and presses', () => {
    const { s, c } = make();
    const start = { ...s.ship.pos };
    s.ship.level = false;
    c.keyDown('KeyW'); c.mouseMove(80, 0);
    for (let i = 0; i < 120; i++) s.advance(DT, c);
    c.keyDown('KeyY');
    s.restart(c);
    expect(s.ship.pos).toEqual(start);
    expect(s.pos).toEqual(start);
    expect(len(s.ship.vel)).toBe(0);
    expect(s.ship.level).toBe(false);
    expect([c.mx, c.my]).toEqual([0, 0]);
    s.advance(DT, c);
    expect(s.ship.cruising).toBe(false);
  });
});

describe('fixed stepping', () => {
  it('steps once per 1/60 s of frame time and carries the rest', () => {
    const { s, c } = make();
    expect(s.advance(DT, c)).toBe(1);
    expect(s.advance(DT / 2, c)).toBe(0);
    expect(s.advance(DT / 2, c)).toBe(1);
    let n = 0;
    for (let i = 0; i < 144; i++) n += s.advance(1 / 144, c);
    expect(n).toBeGreaterThanOrEqual(59); expect(n).toBeLessThanOrEqual(60);
  });
  it('runs at most 5 steps for a long frame and forgets the rest', () => {
    const { s, c } = make();
    expect(MAX_STEPS).toBe(5);
    expect(s.advance(10, c)).toBe(5);
    expect(s.advance(0, c)).toBe(0);
    expect(s.advance(DT, c)).toBe(1);
    s.advance(DT * 0.9, c);
    expect(s.advance(1e9, c)).toBe(5);
    expect(s.advance(DT, c)).toBe(1);
  });
  it('ignores negative and non-finite frame times', () => {
    const { s, c } = make();
    expect(s.advance(-5, c)).toBe(0);
    expect(s.advance(NaN, c)).toBe(0);
    expect(s.advance(DT, c)).toBe(1);
  });
  it('does not put the ship through the ground after long frames at cruise speed', () => {
    const { s, c } = make();
    c.keyDown('KeyY'); c.keyDown('KeyW');
    let low = Infinity;
    for (let i = 0; i < 2000; i++) { s.advance(30, c); low = Math.min(low, altitude(planet, s.ship.pos)); }
    expect(low).toBeGreaterThanOrEqual(SHIP_R - 0.5);
    expect(low).toBeLessThan(100); // it did get there
  });
  it('gives a cruise press to exactly one step, also across frames with no step', () => {
    const { s, c } = make();
    c.keyDown('KeyY'); c.keyUp('KeyY');
    expect(s.advance(DT / 4, c)).toBe(0);
    expect(s.ship.cruising).toBe(false);
    expect(s.advance(DT * 5, c)).toBe(5);
    expect(s.ship.cruising).toBe(true); // toggled once, not five times
  });
});

describe('pause', () => {
  it('moves nothing, and on return the ship does not thrust or turn', () => {
    const { s, c } = make();
    c.keyDown('KeyW'); c.mouseMove(200, 0);
    for (let i = 0; i < 60; i++) s.advance(DT, c);
    c.pause();
    const pos = { ...s.pos }, ship = { ...s.ship.pos }, time = s.time, speed = len(s.ship.vel);
    for (let i = 0; i < 60; i++) expect(s.advance(1, c)).toBe(0);
    expect(s.pos).toEqual(pos); expect(s.ship.pos).toEqual(ship); expect(s.time).toBe(time);
    c.resume();
    const q = { ...s.ship.q };
    for (let i = 0; i < 60; i++) s.advance(DT, c);
    expect(len(s.ship.vel)).toBeLessThan(speed); // coasting down
    expect(s.ship.q).toEqual(q);
  });
});

describe('drawn state', () => {
  it('lies between the previous and the current step, by the unused share of a step', () => {
    const { s, c } = make();
    c.keyDown('KeyW'); c.mouseMove(250, 0);
    for (let i = 0; i < 30; i++) s.advance(DT, c);
    s.advance(DT * 1.25, c);
    const { pos, prevPos } = s.ship;
    expect(s.pos.x).toBeCloseTo(prevPos.x + (pos.x - prevPos.x) * 0.25, 6);
    expect(s.pos.y).toBeCloseTo(prevPos.y + (pos.y - prevPos.y) * 0.25, 6);
    expect(s.pos.z).toBeCloseTo(prevPos.z + (pos.z - prevPos.z) * 0.25, 6);
    expect(s.q).not.toEqual(s.ship.q);
    expect(s.q).not.toEqual(s.ship.prevQ);
  });
  it('has a time that never goes back and never jumps past the history limit', () => {
    const { s, c } = make();
    let last = s.time;
    for (const dt of [DT, DT / 3, 0.001, 0.3, DT * 0.99, DT * 1.01, 0, 0.08, DT]) {
      s.advance(dt, c);
      expect(s.time).toBeGreaterThanOrEqual(last);
      expect(s.time - last).toBeLessThanOrEqual(0.1 + 1e-9);
      last = s.time;
    }
  });
});
