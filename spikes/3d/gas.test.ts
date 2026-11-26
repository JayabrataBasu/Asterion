import { describe, expect, it } from 'vitest';
import { WREN } from '../../src/sim/ships';
import { DT } from '../../src/sim/sim';
import { ChaseCamera, MIN_ALT } from './camera';
import { type Input, type ShipState, SHIP_R, newShip, stepShip } from './flight';
import { CRUSH_TICK, cloudAltitude, crushRadius, floorRadius } from './gas';
import { type Vec3, addScaled, len, norm, qAxisAngle, qFromBasis, scale, v3 } from './math';
import { type Planet, altitude, atmoDensity, surfaceRadius } from './planet';
import { SCALE } from './scale';
import { makeWorld } from './world';

const gas = (): Planet => makeWorld('gas').planet;
const IDLE: Input = { mx: 0, my: 0, thrust: false, brake: false, roll: 0, strafeX: 0, strafeY: 0, boost: false, cruise: false };
const input = (o: Partial<Input> = {}): Input => ({ ...IDLE, ...o });
const Z = v3(0, 0, 1);
const BOOST_TOP = WREN.maxSpeed * 190 / 118;

/** On the +Z side, `h` above the cloud tops (negative: below them), nose straight down (the identity attitude). */
function over(p: Planet, h: number, speed = 0): ShipState {
  const s = newShip();
  s.pos.z = p.radius + h;
  s.vel.z = -speed;
  return s;
}
const radius = (s: ShipState): number => len(s.pos);
const finite = (s: ShipState): boolean =>
  [s.pos, s.vel, s.q].flatMap(o => Object.values(o as Vec3)).concat(s.alt, s.hits, s.crushTime, s.crushDamage).every(Number.isFinite);

describe('gas giant', () => {
  it('is radius 13500 with no ground, atmosphere 8% of it', () => {
    const p = gas();
    expect(p.radius).toBe(13500);
    expect(p.relief).toBe(0);
    expect(p.kind).toBe('gas');
    expect(p.atmo).toBeCloseTo(13500 * 0.08);
  });

  it('has its crush depth 3% and its floor 6% of the radius below the cloud tops', () => {
    const p = gas();
    expect(crushRadius(p)).toBeCloseTo(13500 - 405);
    expect(floorRadius(p)).toBeCloseTo(13500 - 810);
    expect(surfaceRadius(p, Z)).toBe(floorRadius(p));
  });

  it('measures what you can hit from the floor and depth from the cloud tops', () => {
    const p = gas(), pos = v3(0, 0, 13500 - 100);
    expect(altitude(p, pos)).toBeCloseTo(710);
    expect(cloudAltitude(p, pos)).toBeCloseTo(-100);
    expect(atmoDensity(p, pos)).toBe(1);
  });
});

describe('crush depth', () => {
  it('counts nothing above it', () => {
    const p = gas(), s = over(p, -400);
    for (let i = 0; i < 30; i++) stepShip(s, input({ brake: true }), p);
    expect(cloudAltitude(p, s.pos)).toBeGreaterThan(-405);
    expect(s.crushTime).toBe(0);
    expect(s.crushDamage).toBe(0);
  });

  it('counts one hull damage for every half second spent below it, and keeps the count after climbing out', () => {
    const p = gas(), s = over(p, -600);
    expect(CRUSH_TICK).toBe(0.5);
    for (let i = 0; i < Math.round(2.01 / DT); i++) stepShip(s, input(), p);
    expect(cloudAltitude(p, s.pos)).toBeLessThan(-405);
    expect(s.crushTime).toBeCloseTo(2.01, 1);
    expect(s.crushDamage).toBe(4);
    s.pos.z = p.radius + 100;
    for (let i = 0; i < 120; i++) stepShip(s, input(), p);
    expect(s.crushDamage).toBe(4);
  });

  it('is not part of the default planet', () => {
    const p = makeWorld(null).planet, s = over(p, 1000);
    for (let i = 0; i < 60; i++) stepShip(s, input(), p);
    expect(s.crushTime).toBe(0);
  });
});

describe('the hard floor', () => {
  it('is not passed in one 0.25 s step at boost speed', () => {
    const p = gas(), s = over(p, -810 + 10, BOOST_TOP);
    stepShip(s, input({ thrust: true, boost: true }), p, 0.25);
    expect(radius(s)).toBeGreaterThanOrEqual(floorRadius(p) + SHIP_R - 1e-6);
    expect(s.pos.z).toBeGreaterThan(0); // not out of the other side
    expect(s.hits).toBe(1);
  });

  it('is not passed at any speed or step length', () => {
    for (const [h, speed, dt] of [[-700, 1000, 0.25], [0, 20000, 0.25], [5000, 20000, 2], [-790, 1e5, DT]] as const) {
      const p = gas(), s = over(p, h, speed);
      stepShip(s, input(), p, dt);
      expect(radius(s)).toBeGreaterThanOrEqual(floorRadius(p) + SHIP_R - 1e-6);
      expect(s.pos.z).toBeGreaterThan(0);
      expect(finite(s)).toBe(true);
    }
  });

  it('holds against full boost for a long time', () => {
    const p = gas(), s = over(p, -500);
    let lowest = Infinity;
    for (let i = 0; i < 60 * 20; i++) { stepShip(s, input({ thrust: true, boost: i % 600 < 300 }), p); lowest = Math.min(lowest, radius(s)); }
    expect(lowest).toBeGreaterThanOrEqual(floorRadius(p) + SHIP_R - 1e-6);
  });

  it('keeps the camera above it', () => {
    const p = gas(), s = over(p, -804), cam = new ChaseCamera();
    qAxisAngle(s.q, v3(1, 0, 0), Math.PI); // nose straight up: the camera would hang below
    cam.snap(s.pos, s.q, p);
    expect(altitude(p, cam.pos)).toBeGreaterThanOrEqual(MIN_ALT - 1e-6);
  });
});

describe('cruise over a gas giant', () => {
  it('drops out 1.5 atmosphere depths above the cloud tops', () => {
    const p = gas(), s = over(p, 10000);
    stepShip(s, input({ cruise: true }), p);
    expect(s.cruising).toBe(true);
    let last = 0;
    for (let i = 0; i < 60 * 120 && s.cruising; i++) { last = cloudAltitude(p, s.pos); stepShip(s, input(), p); }
    expect(s.cruising).toBe(false);
    expect(cloudAltitude(p, s.pos)).toBeLessThan(1.5 * p.atmo);
    expect(last).toBeGreaterThanOrEqual(1.5 * p.atmo);
    expect(cloudAltitude(p, s.pos)).toBeGreaterThan(1.5 * p.atmo - 100);
  });

  it('goes at a speed set by the height above the cloud tops', () => {
    const p = gas(), s = over(p, 10000);
    stepShip(s, input({ cruise: true }), p);
    expect(len(s.vel)).toBeCloseTo((10000 - p.atmo) * SCALE.cruiseGain, 6);
  });
});

describe('flying over the poles of a gas giant', () => {
  it('stays finite', () => {
    for (const pole of [1, -1]) {
      const p = gas(), s = newShip();
      scale(s.pos, v3(0, pole, 0), p.radius + 50);
      addScaled(s.pos, s.pos, v3(1, 0, 0), -150);
      // level flight toward +X, planet-up overhead
      const up = norm(v3(), v3(0, pole, 0));
      Object.assign(s.q, qFromBasis(v3(0, 0, pole), up, v3(-1, 0, 0)));
      const cam = new ChaseCamera();
      cam.snap(s.pos, s.q, p);
      for (let i = 0; i < 180; i++) {
        stepShip(s, input({ thrust: true }), p);
        cam.update(s.pos, s.q, p, DT);
        expect(finite(s)).toBe(true);
        expect(Object.values(cam.pos).every(Number.isFinite)).toBe(true);
      }
      expect(s.pos.x).toBeGreaterThan(0); // went over
    }
  });
});
