/** The airless moon: its body, its orbit round the planet and the carry that keeps its ground still under a ship that
 *  is near. */
import { type Vec3, addScaled, cross, dot, len, norm, scale, sub, v3 } from './math';
import { type Planet, makePlanet } from './planet';
import { SUN } from './shaders';

export const MOON_RADIUS2D = 8, MOON_RELIEF = 110;
/** The orbit: this many planet radii from the planet's centre, once in this many seconds. */
export const ORBIT_RADII = 3, ORBIT_PERIOD = 600;
/** A ship this many moon radii or less from the moon's centre is carried with it. */
export const CARRY_RADII = 2;
/** The sun over the moon's outward side at the start: the cosine of its angle. */
const START_SUN = 0.35;

export function makeMoonBody(seed: number): Planet {
  return { ...makePlanet(seed, MOON_RADIUS2D), atmo: 0, relief: MOON_RELIEF, kind: 'moon' };
}

/** The orbit's plane: its normal, the direction at time 0 and the one a quarter of a turn on. */
export const ORBIT_NORMAL = norm(v3(), v3(0.18, 0.97, -0.16));
const sun = norm(v3(), v3(...SUN));
export const ORBIT_START = (() => {
  const inPlane = addScaled(v3(), sun, ORBIT_NORMAL, -dot(sun, ORBIT_NORMAL));
  const share = len(inPlane);
  norm(inPlane, inPlane);
  const quarter = cross(v3(), ORBIT_NORMAL, inPlane), angle = Math.acos(Math.min(1, START_SUN / share));
  return norm(v3(), addScaled(v3(), scale(v3(), inPlane, Math.cos(angle)), quarter, Math.sin(angle)));
})();
const QUARTER = cross(v3(), ORBIT_NORMAL, ORBIT_START);

/** Where the moon's centre is at time `t`. */
export function moonPosition(out: Vec3, planet: Planet, t: number): Vec3 {
  const a = 2 * Math.PI * t / ORBIT_PERIOD, r = ORBIT_RADII * planet.radius;
  scale(out, ORBIT_START, r * Math.cos(a));
  addScaled(out, out, QUARTER, r * Math.sin(a));
  return addScaled(out, out, planet.center, 1);
}

const before = v3(), shift = v3();

export class Moon {
  readonly body: Planet;
  /** The time of the flight's last step: the next one moves the moon on from here. */
  time = 0;

  constructor(readonly planet: Planet, seed: number) {
    this.body = makeMoonBody(seed);
    this.place(0);
  }

  /** Puts the body where it is at time `t`, for collision or for a picture. */
  place(t: number): void { moonPosition(this.body.center, this.planet, t); }

  carries(pos: Vec3): boolean { return len(sub(shift, pos, this.body.center)) <= CARRY_RADII * this.body.radius; }

  /** Moves the moon on by `dt`, taking `pos` along if the moon carries it. */
  step(pos: Vec3, dt: number): void {
    this.place(this.time);
    const carried = this.carries(pos);
    before.x = this.body.center.x; before.y = this.body.center.y; before.z = this.body.center.z;
    this.place(this.time += dt);
    if (carried) addScaled(pos, pos, sub(shift, this.body.center, before), 1);
  }
}
