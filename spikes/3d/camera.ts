/** The chase camera: behind and above the ship, its orientation easing toward the ship's. The offset turns with the
 *  eased orientation, so it is eased relative to the ship (cruise speed cannot leave the camera behind) and keeps its
 *  length (no zoom). */
import { type Quat, type Vec3, add, addScaled, norm, qIdentity, qRotate, qSlerp, sub, v3 } from './math';
import { type Planet, altitude } from './planet';

/** In the camera's frame: up and back. */
export const CHASE = v3(0, 10, 40);
export const EASE = 8;
export const MIN_ALT = 6;

const radial = v3();

export class ChaseCamera {
  readonly pos = v3();
  readonly q = qIdentity();

  /** Puts the camera straight behind the ship. */
  snap(ship: Vec3, shipQ: Quat, planet: Planet): void {
    Object.assign(this.q, shipQ);
    this.place(ship, planet);
  }

  /** `dt` is the time the ship has moved by; 0 leaves the camera where it is. */
  update(ship: Vec3, shipQ: Quat, planet: Planet, dt: number): void {
    if (!(dt > 0)) return;
    qSlerp(this.q, this.q, shipQ, 1 - Math.exp(-EASE * dt));
    this.place(ship, planet);
  }

  private place(ship: Vec3, planet: Planet): void {
    add(this.pos, ship, qRotate(this.pos, this.q, CHASE));
    const low = MIN_ALT - altitude(planet, this.pos);
    if (low > 0) addScaled(this.pos, this.pos, norm(radial, sub(radial, this.pos, planet.center)), low);
  }
}
