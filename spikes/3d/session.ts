/** A free flight without a browser: the start in space, fixed 60 Hz stepping and the state to draw between steps. */
import { DT } from '../../src/sim/sim';
import type { Controls } from './controls';
import { type Input, type ShipState, newShip, stepShip } from './flight';
import { type Vec3, addScaled, copy, cross, dot, norm, qFromBasis, qIdentity, qSlerp, v3 } from './math';
import { type Planet, surfaceRadius } from './planet';

export const START_ALT = 20000;
/** Most steps one frame may run; time beyond that is dropped, so a stall cannot become a leap. */
export const MAX_STEPS = 5;
/** Slack for frame times that add up to a hair less than a step. */
const SLACK = 1e-9;

/** Places `ship` at rest START_ALT over the ground toward the unit direction `dir`, nose to the planet's centre. */
function placeAtStart(ship: ShipState, planet: Planet, dir: Vec3): void {
  addScaled(ship.pos, planet.center, dir, surfaceRadius(planet, dir) + START_ALT);
  // up: the planet's axis seen square to the line of sight (any other axis where that vanishes)
  const axis = Math.abs(dir.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0);
  const up = norm(v3(), addScaled(v3(), axis, dir, -dot(axis, dir)));
  const back = norm(v3(), dir); // the nose is -Z, so +Z points away from the planet
  Object.assign(ship.q, qFromBasis(cross(v3(), up, back), up, back));
  copy(ship.prevPos, ship.pos);
  Object.assign(ship.prevQ, ship.q);
  ship.alt = START_ALT;
}

export class FlightSession {
  ship = newShip();
  /** The ship as drawn: between the last two steps, by the share of a step not yet simulated. */
  readonly pos = v3(); readonly q = qIdentity();
  /** Simulated seconds at the drawn state. It never goes back. */
  time = 0;
  private acc = 0;
  private steps = 0;
  private readonly input: Input = {
    mx: 0, my: 0, thrust: false, brake: false, roll: 0, strafeX: 0, strafeY: 0, boost: false, cruise: false,
  };

  /** `dir`: the ground direction the start is over. */
  constructor(readonly planet: Planet, private readonly dir: Vec3) {
    placeAtStart(this.ship, planet, dir);
    this.blend();
  }

  /** Back to the start in space. The level-horizon setting stays; the reticle is centred. */
  restart(controls: Controls): void {
    const level = this.ship.level;
    this.ship = newShip();
    this.ship.level = level;
    placeAtStart(this.ship, this.planet, this.dir);
    controls.neutral();
    this.blend();
  }

  /** Takes in `seconds` of frame time and returns the number of steps run. Paused, nothing moves. */
  advance(seconds: number, controls: Controls): number {
    if (controls.paused || !(seconds > 0)) return 0;
    this.acc += Math.min(seconds, MAX_STEPS * DT);
    let n = 0;
    while (n < MAX_STEPS && this.acc >= DT - SLACK) {
      controls.read(this.input);
      stepShip(this.ship, this.input, this.planet);
      this.acc = Math.max(0, this.acc - DT);
      n++;
    }
    if (this.acc >= DT) this.acc %= DT;
    this.steps += n;
    this.blend();
    return n;
  }

  private blend(): void {
    const s = this.ship, a = Math.min(1, this.acc / DT);
    this.pos.x = s.prevPos.x + (s.pos.x - s.prevPos.x) * a;
    this.pos.y = s.prevPos.y + (s.pos.y - s.prevPos.y) * a;
    this.pos.z = s.prevPos.z + (s.pos.z - s.prevPos.z) * a;
    qSlerp(this.q, s.prevQ, s.q, a);
    this.time = (this.steps - 1) * DT + this.acc;
  }
}
