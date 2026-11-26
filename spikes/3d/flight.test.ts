import { afterEach, describe, expect, it } from 'vitest';
import { WREN } from '../../src/sim/ships';
import { DT } from '../../src/sim/sim';
import { type Input, type ShipState, SHIP_R, newShip, stepShip } from './flight';
import { type Quat, type Vec3, addScaled, cross, dot, len, norm, qAxisAngle, qMul, qRotate, sub, v3 } from './math';
import { type Planet, altitude, atmoDensity, makePlanet, surfaceRadius } from './planet';
import { SCALE } from './scale';

const X = v3(1, 0, 0), Y = v3(0, 1, 0), Z = v3(0, 0, 1);
const DEG = Math.PI / 180;
const IDLE: Input = { mx: 0, my: 0, thrust: false, brake: false, roll: 0, strafeX: 0, strafeY: 0, boost: false, cruise: false };
const input = (o: Partial<Input> = {}): Input => ({ ...IDLE, ...o });
const ticks = (seconds: number): number => Math.round(seconds / DT);

const forward = (s: ShipState): Vec3 => qRotate(v3(), s.q, v3(0, 0, -1));
const shipUp = (s: ShipState): Vec3 => qRotate(v3(), s.q, Y);
const shipRight = (s: ShipState): Vec3 => qRotate(v3(), s.q, X);
const speed = (s: ShipState): number => len(s.vel);
const angle = (a: Vec3, b: Vec3): number => Math.atan2(len(cross(v3(), a, b)), dot(a, b));
const allFinite = (s: ShipState): boolean =>
  [s.pos, s.prevPos, s.q, s.prevQ, s.vel].flatMap(o => Object.values(o as Vec3 | Quat))
    .concat(s.boostE, s.alt, s.hits).every(Number.isFinite);

function run(s: ShipState, p: Planet, seconds: number, o: Partial<Input> = {}, each?: () => void): void {
  for (let i = 0; i < ticks(seconds); i++) { stepShip(s, input(o), p); each?.(); }
}
/** A planet too far away to pull on, level or stop anything near the origin. */
function farPlanet(): Planet { const p = makePlanet(1); p.center = v3(0, -1e7, 0); return p; }
/** On the +Z side of a planet at the origin, `alt` above the surface. The identity attitude is then nose down. */
function above(p: Planet, alt: number): ShipState {
  const s = newShip();
  s.pos.z = surfaceRadius(p, Z) + alt;
  return s;
}
/** Over the +Z side with the nose along the horizon (+Y) and planet-up overhead, then pitched up and rolled right. */
function horizontal(p: Planet, alt: number, roll = 0, pitch = 0): ShipState {
  const s = above(p, alt);
  qAxisAngle(s.q, X, 90 * DEG); // nose +Y, up +Z
  qMul(s.q, s.q, qAxisAngle({ x: 0, y: 0, z: 0, w: 1 }, X, pitch));
  qMul(s.q, s.q, qAxisAngle({ x: 0, y: 0, z: 0, w: 1 }, Z, -roll));
  return s;
}
/** How far the ship is banked from planet-up. */
function bank(s: ShipState, p: Planet): number {
  const up = norm(v3(), sub(v3(), s.pos, p.center));
  return Math.atan2(dot(up, shipRight(s)), dot(up, shipUp(s)));
}

describe('new ship', () => {
  it('starts still, full of boost, level horizon on', () => {
    const s = newShip();
    expect(speed(s)).toBe(0);
    expect(s.boostE).toBe(WREN.boostCap);
    expect(s.cruising).toBe(false);
    expect(s.level).toBe(true);
    expect(s.hits).toBe(0);
    expect(SHIP_R).toBe(5);
    expect(newShip().pos).not.toBe(s.pos);
  });

  it('keeps the pose from before the step for drawing between steps', () => {
    const s = newShip(), p = farPlanet();
    run(s, p, 1, { thrust: true, mx: 1 });
    const pos = { ...s.pos }, q = { ...s.q };
    stepShip(s, input({ thrust: true, mx: 1 }), p);
    expect(s.prevPos).toEqual(pos);
    expect(s.prevQ).toEqual(q);
    expect(s.pos).not.toEqual(pos);
  });
});

describe('steering', () => {
  const p = farPlanet();
  const after = (o: Partial<Input>): ShipState => { const s = newShip(); stepShip(s, input(o), p); return s; };

  it('pitches and yaws at the turn rate, in proportion to the reticle', () => {
    const right = after({ mx: 1 }), up = after({ my: 0.5 });
    expect(forward(right).x).toBeGreaterThan(0);
    expect(angle(forward(right), v3(0, 0, -1))).toBeCloseTo(WREN.turnRate * DT, 9);
    expect(forward(up).y).toBeGreaterThan(0);
    expect(angle(forward(up), v3(0, 0, -1))).toBeCloseTo(0.5 * WREN.turnRate * DT, 9);
  });

  it('ignores the reticle inside the 0.05 dead zone', () => {
    expect(forward(after({ mx: 0.03, my: -0.03 }))).toEqual(forward(newShip()));
    expect(forward(after({ mx: 0.06 })).x).toBeGreaterThan(0);
    expect(forward(after({ my: -0.06 })).y).toBeLessThan(0);
  });

  it('rolls at 3.5 rad/s, right wing down for positive roll', () => {
    const s = after({ roll: 1 });
    expect(shipRight(s).y).toBeLessThan(0);
    expect(angle(shipUp(s), Y)).toBeCloseTo(3.5 * DT, 9);
    expect(angle(forward(s), v3(0, 0, -1))).toBeCloseTo(0, 9);
  });
});

describe('thrust and grip', () => {
  it('settles near the soft speed cap along the nose', () => {
    const s = newShip(), p = farPlanet();
    run(s, p, 10, { thrust: true });
    expect(speed(s)).toBeGreaterThan(139); expect(speed(s)).toBeLessThan(147); // the 2D speed cap is soft: thrust settles near 143
    expect(angle(s.vel, forward(s))).toBeLessThan(0.05);
  });

  it('bends the path to a new heading after a 90 degree yaw', () => {
    const s = newShip(), p = farPlanet();
    run(s, p, 10, { thrust: true });
    const before = forward(s);
    const full = Math.PI / 2 / (WREN.turnRate * DT);
    for (let i = 0; i < Math.floor(full); i++) stepShip(s, input({ thrust: true, mx: 1 }), p);
    stepShip(s, input({ thrust: true, mx: full % 1 }), p);
    expect(angle(before, forward(s))).toBeCloseTo(Math.PI / 2, 6);
    expect(angle(s.vel, forward(s))).toBeGreaterThan(15 * DEG); // still sliding when the turn ends
    run(s, p, 4, { thrust: true });
    expect(angle(s.vel, forward(s))).toBeLessThan(15 * DEG);
  });

  it('grips both sideways axes alike and hands half of the loss to the nose', () => {
    const p = farPlanet();
    const slide = (vx: number, vy: number, thrust: boolean): ShipState => {
      const s = newShip(); s.vel.x = vx; s.vel.y = vy; stepShip(s, input({ thrust }), p); return s;
    };
    const x = slide(50, 0, false), y = slide(0, 50, false);
    expect(y.vel.y).toBeCloseTo(x.vel.x, 9);
    expect(y.vel.z).toBeCloseTo(x.vel.z, 9);
    // coasting: grip is weaker, then assist and drag act on everything
    const kept = Math.exp(-WREN.grip * 0.3125 * DT), damp = Math.exp(-(WREN.assist + 0.09) * DT);
    expect(x.vel.x).toBeCloseTo(50 * kept * damp, 9);
    expect(x.vel.z).toBeCloseTo(-50 * (1 - kept) * 0.5 * damp, 9);
    expect(slide(50, 0, true).vel.x).toBeCloseTo(50 * Math.exp(-(WREN.grip + 0.09) * DT), 9);
  });

  it('strafes right and up', () => {
    const s = newShip();
    stepShip(s, input({ strafeX: 1, strafeY: -1 }), farPlanet());
    expect(s.vel.x).toBeGreaterThan(0);
    expect(s.vel.y).toBeCloseTo(-s.vel.x, 9);
  });

  it('brakes', () => {
    const p = farPlanet(), a = newShip(), b = newShip();
    a.vel.z = b.vel.z = -100;
    run(a, p, 1); run(b, p, 1, { brake: true });
    expect(speed(b) / speed(a)).toBeCloseTo(Math.exp(-WREN.brake), 6);
  });

  it('boosts only under thrust, drains the boost store and refills it', () => {
    const p = farPlanet(), s = newShip(), plain = newShip();
    run(s, p, 1, { boost: true });
    expect(s.boostE).toBe(WREN.boostCap);
    run(s, p, 2, { thrust: true, boost: true });
    run(plain, p, 2, { thrust: true });
    expect(s.boostE).toBeCloseTo(WREN.boostCap - 2 * WREN.boostDrain, 6);
    expect(speed(s)).toBeGreaterThan(speed(plain) + 20);
    run(s, p, 1);
    expect(s.boostE).toBeCloseTo(WREN.boostCap - 2 * WREN.boostDrain + WREN.boostRegen, 6);
  });
});

describe('atmosphere', () => {
  const p = makePlanet(1);

  it('pulls toward the centre at 9.5 times the density', () => {
    const s = above(p, 300);
    const density = atmoDensity(p, s.pos);
    expect(density).toBeGreaterThan(0.1); expect(density).toBeLessThan(0.9);
    stepShip(s, input(), p);
    expect(s.vel.z).toBeCloseTo(-9.5 * density * DT, 9);
    expect(s.vel.x).toBe(0); expect(s.vel.y).toBe(0);
  });

  it('eases the roll to planet-up at 1.5 rad/s times the density', () => {
    const s = horizontal(p, 100, 1), density = atmoDensity(p, s.pos);
    expect(bank(s, p)).toBeCloseTo(-1, 9);
    stepShip(s, input(), p);
    expect(bank(s, p)).toBeCloseTo(-1 + 1.5 * density * DT, 5);
    run(s, p, 2);
    expect(bank(s, p)).toBeCloseTo(0, 3);
  });

  it('levels from upside down', () => {
    const s = horizontal(p, 150, Math.PI);
    run(s, p, 5);
    expect(allFinite(s)).toBe(true);
    expect(Math.abs(bank(s, p))).toBeLessThan(0.01);
  });

  it('leaves the roll alone with level off, while rolling, or with the nose within 10 degrees of vertical', () => {
    const off = horizontal(p, 100, 1);
    off.level = false;
    stepShip(off, input(), p);
    expect(bank(off, p)).toBeCloseTo(-1, 6);
    const rolling = horizontal(p, 100, 1);
    stepShip(rolling, input({ roll: 1 }), p);
    expect(bank(rolling, p)).toBeCloseTo(-1 - 3.5 * DT, 6);
    for (const [pitch, held] of [[81, true], [-81, true], [79, false], [-79, false]] as const) {
      const s = horizontal(p, 100, 1, pitch * DEG), before = shipRight(s);
      stepShip(s, input(), p);
      expect(angle(before, shipRight(s)) < 1e-9, `pitch ${pitch}`).toBe(held);
    }
  });

  it('flies level over the north pole without spinning', () => {
    const s = newShip(), start = 0.4; // radians short of the pole, along a meridian
    const r = p.radius + p.relief + 90;
    s.pos = v3(0, r * Math.cos(start), r * Math.sin(start));
    qAxisAngle(s.q, X, start); // nose along the horizon toward the pole, up away from the centre
    qMul(s.q, s.q, qAxisAngle({ x: 0, y: 0, z: 0, w: 1 }, Z, -0.8)); // banked, so levelling has work to do
    let maxTurn = 0, nearest = Math.PI, densityThere = 0, inAir = 0, worstBankLate = 0, i = 0;
    let prevUp = shipUp(s);
    for (; i < ticks(60); i++) {
      // hold height: push the nose down whenever it points above a shallow aim that corrects toward the start radius
      const up = norm(v3(), s.pos);
      const climb = Math.asin(dot(forward(s), up)), aim = Math.max(-0.1, Math.min(0.1, (r - len(s.pos)) / 500));
      const my = Math.abs(bank(s, p)) < 0.3 ? climb > aim + 0.003 ? -0.06 : climb < aim - 0.003 ? 0.06 : 0 : 0;
      stepShip(s, input({ thrust: true, my }), p);
      expect(allFinite(s)).toBe(true);
      const now = shipUp(s);
      maxTurn = Math.max(maxTurn, angle(prevUp, now)); prevUp = now;
      const fromPole = angle(s.pos, Y), density = atmoDensity(p, s.pos);
      if (fromPole < nearest) { nearest = fromPole; densityThere = density; }
      if (density > 0) inAir++;
      if (i > ticks(5)) worstBankLate = Math.max(worstBankLate, Math.abs(bank(s, p)));
    }
    expect(nearest).toBeLessThan(0.003); // within about 20 units of the pole itself
    expect(densityThere).toBeGreaterThan(0.2);
    expect(inAir).toBe(ticks(60));
    expect(s.pos.z).toBeLessThan(-1000); // well past it
    expect(s.hits).toBe(0);
    expect(maxTurn).toBeLessThan(0.1);
    expect(worstBankLate).toBeLessThan(0.05);
  });
});

describe('ground contact', () => {
  const p = makePlanet(1);

  it('pushes out along the radius and bounces', () => {
    const s = above(p, SHIP_R + 0.1);
    s.vel.z = -30;
    stepShip(s, input(), p);
    expect(altitude(p, s.pos)).toBeGreaterThanOrEqual(SHIP_R - 1e-6);
    expect(s.alt).toBeCloseTo(altitude(p, s.pos), 6);
    expect(s.vel.z).toBeGreaterThan(0.55 * 30); expect(s.vel.z).toBeLessThan(0.65 * 30);
    expect(s.hits).toBe(1);
  });

  it('does not count a soft touch as a hit', () => {
    const s = above(p, SHIP_R + 0.1);
    s.vel.z = -15;
    stepShip(s, input(), p);
    expect(s.vel.z).toBeGreaterThan(0);
    expect(s.hits).toBe(0);
  });

  it('survives a boost dive from altitude 2000', () => {
    const s = above(p, 2000);
    let minAlt = Infinity;
    run(s, p, 30, { thrust: true, boost: true }, () => { minAlt = Math.min(minAlt, altitude(p, s.pos)); });
    expect(minAlt).toBeGreaterThanOrEqual(SHIP_R - 0.5); expect(s.hits).toBeGreaterThan(0);
    expect(allFinite(s)).toBe(true);
  });

  it('stops one long step at boost speed at the ground and bounces within it', () => {
    const s = above(p, 30);
    s.vel.z = -WREN.maxSpeed * 190 / 118;
    stepShip(s, input({ thrust: true, boost: true }), p, 0.25);
    expect(altitude(p, s.pos)).toBeGreaterThanOrEqual(SHIP_R - 0.5);
    expect(s.hits).toBe(1);
    // contact at the first touch leaves time to rise again; one check at the end would leave the ship on the ground
    expect(altitude(p, s.pos)).toBeGreaterThan(SHIP_R + 5);
    expect(s.vel.z).toBeGreaterThan(0);
  });

  it('cannot be carried through the planet by one very long step from high up', () => {
    const s = above(p, 5000);
    s.cruising = true;
    stepShip(s, input(), p, 60); // straight-line travel would be about 93000 units, far out the other side
    expect(altitude(p, s.pos)).toBeGreaterThanOrEqual(SHIP_R - 0.5);
    expect(s.hits).toBe(1);
    expect(s.pos.z).toBeGreaterThan(p.radius);
    expect(s.cruising).toBe(false);
    expect(allFinite(s)).toBe(true);
  });
});

describe('cruise', () => {
  const saved = { ...SCALE };
  afterEach(() => { Object.assign(SCALE, saved); });
  const p = makePlanet(1);
  const cruiseSpeed = (alt: number): number => {
    const s = above(p, alt);
    stepShip(s, input({ cruise: true }), p);
    return speed(s);
  };

  it('moves along the nose at a speed set by the height above the atmosphere', () => {
    expect(cruiseSpeed(10000)).toBeCloseTo((10000 - p.atmo) * 0.35, 6);
    expect(cruiseSpeed(850)).toBeCloseTo(WREN.maxSpeed, 6);
    expect(cruiseSpeed(200000)).toBeCloseTo(20000, 6);
    Object.assign(SCALE, { cruiseGain: 0.5, cruiseMax: 3000 });
    expect(cruiseSpeed(5000)).toBeCloseTo((5000 - p.atmo) * 0.5, 6);
    expect(cruiseSpeed(200000)).toBeCloseTo(3000, 6);
  });

  it('toggles off on the second press, and speed then falls back', () => {
    const s = above(p, 50000);
    stepShip(s, input({ cruise: true }), p);
    run(s, p, 0.5);
    expect(s.cruising).toBe(true);
    stepShip(s, input({ cruise: true }), p);
    expect(s.cruising).toBe(false);
    run(s, p, 5);
    expect(speed(s)).toBeLessThan(WREN.maxSpeed);
  });

  it('will not engage below 1.5 times the atmosphere', () => {
    const s = above(p, 1.5 * p.atmo - 1);
    stepShip(s, input({ cruise: true }), p);
    expect(s.cruising).toBe(false);
    expect(speed(s)).toBeLessThan(1);
  });

  it('reaches the planet from altitude 100000, drops out, and the approach ends safely', () => {
    const s = above(p, 100000);
    let minAlt = Infinity, t = 0;
    const track = (): void => { minAlt = Math.min(minAlt, altitude(p, s.pos)); };
    stepShip(s, input({ cruise: true }), p);
    for (t = DT; altitude(p, s.pos) >= 1.5 * p.atmo && t < 60; t += DT) { stepShip(s, input(), p); track(); }
    expect(t).toBeLessThan(40); expect(s.cruising).toBe(false);
    run(s, p, 30, { thrust: true }, track);
    expect(s.hits).toBeGreaterThan(0); // flew on into the ground
    expect(minAlt).toBeGreaterThanOrEqual(SHIP_R - 0.5);
  });
});

describe('far from the origin', () => {
  it('moves a slow drift as precisely as at the origin', () => {
    const p = makePlanet(1);
    p.center = v3(0, -1e6, 0);
    const drift = (start: Vec3): number => {
      const s = newShip();
      s.level = false;
      s.pos = { ...start };
      addScaled(s.vel, s.vel, forward(s), 0.01);
      run(s, p, 1);
      return len(sub(v3(), s.pos, start));
    };
    const movedNear = drift(v3()), movedFar = drift(v3(0, 0, -250000));
    expect(movedFar).toBeCloseTo(movedNear, 6); expect(movedNear).toBeGreaterThan(0.005);
  });
});
