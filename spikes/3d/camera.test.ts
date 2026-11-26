import { describe, expect, it } from 'vitest';
import { CHASE, ChaseCamera, EASE, MIN_ALT } from './camera';
import { type Quat, addScaled, len, norm, qAxisAngle, qIdentity, qRotate, sub, v3 } from './math';
import { altitude, makePlanet, surfaceRadius } from './planet';

const planet = makePlanet(1);
const far = v3(0, 0, 1e6);
const DT = 1 / 60;
const yaw = (rad: number): Quat => qAxisAngle(qIdentity(), v3(0, 1, 0), rad);
/** Angle between two orientations. */
const between = (a: Quat, b: Quat): number => 2 * Math.acos(Math.min(1, Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w)));

describe('ChaseCamera', () => {
  it('sits 40 back and 10 up in the ship frame', () => {
    expect(CHASE).toEqual(v3(0, 10, 40));
    const c = new ChaseCamera(), q = yaw(Math.PI / 2);
    c.snap(far, q, planet);
    const off = sub(v3(), c.pos, far);
    expect(off.x).toBeCloseTo(40, 6); expect(off.y).toBeCloseTo(10, 6); expect(off.z).toBeCloseTo(0, 6);
    expect(c.q).toEqual(q);
  });
  it('eases its orientation at rate 8', () => {
    expect(EASE).toBe(8);
    const c = new ChaseCamera(), to = yaw(1);
    c.snap(far, qIdentity(), planet);
    c.update(far, to, planet, 0.1);
    expect(between(c.q, to)).toBeCloseTo(Math.exp(-0.8), 6);
    for (let i = 0; i < 300; i++) c.update(far, to, planet, DT);
    expect(between(c.q, to)).toBeLessThan(1e-3);
  });
  it('keeps its distance while turning: no zoom', () => {
    const c = new ChaseCamera(), to = yaw(2.5);
    c.snap(far, qIdentity(), planet);
    for (let i = 0; i < 60; i++) {
      c.update(far, to, planet, DT);
      expect(len(sub(v3(), c.pos, far))).toBeCloseTo(Math.hypot(10, 40), 6);
    }
  });
  it('does not trail behind at cruise speed: the offset is eased relative to the ship', () => {
    const c = new ChaseCamera(), q = qIdentity(), ship = { ...far };
    c.snap(ship, q, planet);
    for (let i = 0; i < 120; i++) { ship.z -= 20000 * DT; c.update(ship, q, planet, DT); }
    const off = sub(v3(), c.pos, ship);
    expect(off.z).toBeCloseTo(40, 6); expect(off.y).toBeCloseTo(10, 6);
  });
  it('does not move on a frame with no time passed (paused)', () => {
    const c = new ChaseCamera();
    c.snap(far, qIdentity(), planet);
    const pos = { ...c.pos };
    c.update(far, yaw(1), planet, 0);
    expect(c.q).toEqual(qIdentity());
    expect(c.pos).toEqual(pos);
  });
  it('stays at least 6 units above the ground', () => {
    expect(MIN_ALT).toBe(6);
    const dir = norm(v3(), v3(0.3, 0.2, 0.9));
    const ship = addScaled(v3(), v3(), dir, surfaceRadius(planet, dir) + 8);
    // nose straight up: "back" is straight down, into the ground
    const q = qIdentity(), axis = v3(dir.y, -dir.x, 0);
    qAxisAngle(q, axis, Math.acos(-dir.z)); // turns -Z onto dir
    const nose = qRotate(v3(), q, v3(0, 0, -1));
    expect(nose.x * dir.x + nose.y * dir.y + nose.z * dir.z).toBeGreaterThan(0.99);
    const c = new ChaseCamera();
    c.snap(ship, q, planet);
    expect(altitude(planet, c.pos)).toBeGreaterThanOrEqual(MIN_ALT - 1e-6);
    c.update(ship, q, planet, DT);
    expect(altitude(planet, c.pos)).toBeGreaterThanOrEqual(MIN_ALT - 1e-6);
    expect(between(c.q, q)).toBeLessThan(1e-6); // lifting the camera does not turn it
  });
});
