/** Arcade flight: the Wren's 2D handling (Sim.updateShip) in 3D, with cruise and ground contact. */
import { clamp } from '../../src/core/util';
import { FLIGHT, WREN } from '../../src/sim/ships';
import { DT } from '../../src/sim/sim';
import { CRUSH_TICK, crushRadius, cloudAltitude, cruiseDatum } from './gas';
import {
  type Quat, type Vec3, addScaled, copy, dot, len, norm, qAxisAngle, qIdentity, qMul, qNorm, qRotate, scale, sub, v3,
} from './math';
import type { Moon } from './moon';
import { type Planet, altitude, atmoDensity } from './planet';
import { SCALE } from './scale';

export const SHIP_R = 5;

const ROLL_RATE = 3.5, DEAD_ZONE = 0.05, GRAVITY = 9.5, LEVEL_RATE = 1.5;
const LEVEL_LIMIT = Math.cos(10 * Math.PI / 180); // nose closer than this to straight up or down: no auto-level
const CRUISE_EXIT = 1.5; // times the atmosphere height
const AIRLESS_EXIT = 0.5; // of the radius: without an atmosphere, cruise ends no lower than this
const WALK_BELOW = 500, WALK_STEP = 4;
const BOUNCE = 1.6, HIT_SPEED = 22;

export interface Input {
  /** Reticle, -1..1: right and nose up are positive. */
  mx: number; my: number;
  thrust: boolean; brake: boolean;
  /** -1..1: right wing down is positive. */
  roll: number;
  /** -1..1: right and up are positive. */
  strafeX: number; strafeY: number;
  boost: boolean;
  /** True only on the tick that toggles cruise. */
  cruise: boolean;
}

export interface ShipState {
  pos: Vec3; prevPos: Vec3; q: Quat; prevQ: Quat; vel: Vec3;
  boostE: number; cruising: boolean; level: boolean; hits: number;
  /** Seconds spent below a gas giant's crush depth, and the hull damage counted for them. */
  crushTime: number; crushDamage: number;
  /** Height above the surface after the last step. */
  alt: number;
}

/** A ship at rest at the origin: the caller places it before the first step. */
export function newShip(): ShipState {
  return {
    pos: v3(), prevPos: v3(), q: qIdentity(), prevQ: qIdentity(), vel: v3(),
    boostE: WREN.boostCap, cruising: false, level: true, hits: 0, crushTime: 0, crushDamage: 0, alt: 0,
  };
}

/** What else there is to fly among, in a world scene. */
export interface Surroundings { moon?: Moon }

/** Cruise ends below this height over a body. */
export function cruiseExit(body: Planet): number {
  const exit = CRUISE_EXIT * body.atmo;
  return body.atmo > 0 ? exit : Math.max(exit, AIRLESS_EXIT * body.radius);
}

// temporaries, so that stepping allocates nothing
const fwd = v3(), side = v3(), up = v3(), radial = v3(), axis = v3(), turnQ = qIdentity();
const NOSE = v3(0, 0, -1), RIGHT = v3(1, 0, 0), UP = v3(0, 1, 0);

/** Turns the ship by `rad` about an axis given in its own frame. */
function turn(s: ShipState, about: Vec3, rad: number): void {
  qNorm(s.q, qMul(s.q, s.q, qAxisAngle(turnQ, about, rad)));
}

function steer(s: ShipState, input: Input, planet: Planet, dt: number): void {
  const live = Math.hypot(input.mx, input.my) >= DEAD_ZONE ? WREN.turnRate : 0;
  axis.x = input.my * live; axis.y = -input.mx * live; axis.z = -input.roll * ROLL_RATE;
  const rate = len(axis);
  if (rate > 0) turn(s, axis, rate * dt);
  if (!s.level || input.roll !== 0) return;
  const most = LEVEL_RATE * atmoDensity(planet, s.pos) * dt;
  if (most <= 0) return;
  norm(radial, sub(radial, s.pos, planet.center));
  if (Math.abs(dot(radial, qRotate(fwd, s.q, NOSE))) > LEVEL_LIMIT) return;
  // the roll that would bring planet-up into the ship's up half-plane
  const off = Math.atan2(dot(radial, qRotate(side, s.q, RIGHT)), dot(radial, qRotate(up, s.q, UP)));
  turn(s, NOSE, clamp(off, -most, most));
}

/** Everything that changes velocity outside cruise, in the order of the 2D rules. `fwd` holds the nose direction. */
function accelerate(s: ShipState, input: Input, planet: Planet, boosting: boolean, dt: number): void {
  const vel = s.vel;
  if (input.thrust) addScaled(vel, vel, fwd, WREN.thrustFwd / WREN.mass * (boosting ? WREN.boostMult : 1) * dt);
  const strafe = WREN.thrustLat / WREN.mass * dt;
  if (input.strafeX !== 0) addScaled(vel, vel, qRotate(side, s.q, RIGHT), input.strafeX * strafe);
  if (input.strafeY !== 0) addScaled(vel, vel, qRotate(up, s.q, UP), input.strafeY * strafe);

  // grip: bleed sideways velocity (both axes) and hand part of it to the nose, so turns bend the path
  const along = dot(vel, fwd);
  addScaled(side, vel, fwd, -along);
  const keep = Math.exp(-(input.thrust ? WREN.grip : WREN.grip * FLIGHT.GRIP_COAST_K) * dt);
  scale(vel, fwd, along + len(side) * (1 - keep) * FLIGHT.GRIP_FWD);
  addScaled(vel, vel, side, keep);

  if (!input.thrust) scale(vel, vel, Math.exp(-WREN.assist * dt));
  if (input.brake) {
    scale(vel, vel, Math.exp(-WREN.brake * dt));
    if (WREN.thrustRev > 0 && dot(vel, vel) < 16) addScaled(vel, vel, fwd, -WREN.thrustRev / WREN.mass * dt);
  }
  scale(vel, vel, Math.exp(-FLIGHT.DRAG * dt));

  const pull = GRAVITY * atmoDensity(planet, s.pos);
  if (pull > 0) addScaled(vel, vel, norm(radial, sub(radial, planet.center, s.pos)), pull * dt);

  const speed = len(vel), top = boosting ? WREN.maxSpeed * FLIGHT.BOOST_TOP_K : WREN.maxSpeed;
  // the min only matters for steps over 0.4 s, where the 2D formula would overshoot the cap
  if (speed > top) scale(vel, vel, 1 - Math.min(1, FLIGHT.SPEED_CAP_K * dt) * (1 - top / speed));
}

/** The heights over the planet and over the moon (if there is one) at the ship's place; `alt` is the lower. */
let overPlanet = 0, overMoon = Infinity;
function sense(s: ShipState, planet: Planet, near?: Surroundings): void {
  overPlanet = altitude(planet, s.pos);
  overMoon = near?.moon ? altitude(near.moon.body, s.pos) : Infinity;
  s.alt = Math.min(overPlanet, overMoon);
}

/** Moves for `dt`, near the ground in short pieces so that no speed or step length can pass through it. */
function move(s: ShipState, planet: Planet, dt: number, near?: Surroundings): void {
  let left = dt;
  while (left > 0) {
    const reach = Math.max(WALK_STEP, s.alt - WALK_BELOW), speed = len(s.vel);
    const t = speed * left > reach ? reach / speed : left;
    addScaled(s.pos, s.pos, s.vel, t);
    left -= t;
    sense(s, planet, near);
    dropOutOfCruise(s, planet, near); // checked on the way: a long step may dip below the limit and bounce back out
    if (overPlanet < SHIP_R) contact(s, planet, overPlanet);
    else if (overMoon < SHIP_R) contact(s, near!.moon!.body, overMoon);
  }
}

/** Pushes the ship, `alt` over the body's ground, out along the body's radius and bounces it. */
function contact(s: ShipState, body: Planet, alt: number): void {
  norm(radial, sub(radial, s.pos, body.center));
  addScaled(s.pos, s.pos, radial, SHIP_R - alt);
  s.alt = SHIP_R;
  const closing = -dot(s.vel, radial);
  if (closing <= 0) return;
  addScaled(s.vel, s.vel, radial, BOUNCE * closing);
  if (closing > HIT_SPEED) s.hits++;
}

function dropOutOfCruise(s: ShipState, planet: Planet, near?: Surroundings): void {
  if (overPlanet - cruiseDatum(planet) < cruiseExit(planet)) s.cruising = false;
  if (near?.moon && overMoon < cruiseExit(near.moon.body)) s.cruising = false;
}

/** Counts the time spent below a gas giant's crush depth. */
function crush(s: ShipState, planet: Planet, dt: number): void {
  if (planet.kind !== 'gas' || cloudAltitude(planet, s.pos) >= crushRadius(planet) - planet.radius) return;
  s.crushTime += dt;
  s.crushDamage = Math.floor(s.crushTime / CRUSH_TICK + 1e-6);
}

export function stepShip(s: ShipState, input: Input, planet: Planet, dt = DT, near?: Surroundings): void {
  copy(s.prevPos, s.pos);
  Object.assign(s.prevQ, s.q);
  near?.moon?.step(s.pos, dt); // first: from here the ship moves against the moon where it now is
  sense(s, planet, near);
  if (input.cruise) s.cruising = !s.cruising;
  dropOutOfCruise(s, planet, near);

  steer(s, input, planet, dt);
  qRotate(fwd, s.q, NOSE);

  const boosting = input.thrust && input.boost && !s.cruising && s.boostE > 1;
  if (boosting) s.boostE -= WREN.boostDrain * dt;
  else s.boostE = Math.min(WREN.boostCap, s.boostE + WREN.boostRegen * dt);

  if (s.cruising) {
    // the nearer body sets the pace
    const above = Math.min(overPlanet - cruiseDatum(planet) - planet.atmo, overMoon - (near?.moon?.body.atmo ?? 0));
    scale(s.vel, fwd, clamp(above * SCALE.cruiseGain, WREN.maxSpeed, SCALE.cruiseMax));
  } else accelerate(s, input, planet, boosting, dt);

  move(s, planet, dt, near);
  crush(s, planet, dt);
}
