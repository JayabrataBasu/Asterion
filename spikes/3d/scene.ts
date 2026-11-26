/** What each scene's views fly and look at: the direction free flight starts over, the scripted path of the two
 *  reports (60 s: approach, descent, low pass, climb) and named viewpoints for stills (?look=). Without a world
 *  scene these are the default planet's, from path.ts. */
import { CHASE } from './camera';
import type { ShipState, Surroundings } from './flight';
import {
  type Quat, type Vec3, add, addScaled, cross, dot, norm, qAxisAngle, qFromBasis, qIdentity, qMul, qNorm, qRotate, scale,
  sub, v3,
} from './math';
import { PATH_SECONDS, type PathPose, type Phase, pathFocus, pose } from './path';
import { CARRY_RADII, type Moon, ORBIT_NORMAL, ORBIT_START, moonPosition } from './moon';
import { type Planet, surfaceRadius } from './planet';
import { SUN } from './shaders';
import type { World } from './world';

export interface Scene {
  readonly world: World;
  /** Free flight starts over this direction from the planet; the default scenery sits around it. */
  readonly focus: Vec3;
  pose(t: number): PathPose;
  /** A named viewpoint at `time`, or null for a name the scene does not have. */
  view(name: string, time: number): PathPose | null;
  /** What else there is to fly among. */
  readonly near?: Surroundings;
  /** Places the ship for free flight; absent: in space over `focus`, as the default planet's flight starts. */
  start?(ship: ShipState): void;
}

const PHASES: readonly Phase[] = ['approach', 'descent', 'low', 'climb'];
const PHASE_S = PATH_SECONDS / PHASES.length;
const DEG = Math.PI / 180;
const SPEED = 143;
const SPAN = 1 / 120; // half the time over which headings are measured

const L = norm(v3(), v3(...SUN));
const smooth = (t: number): number => t * t * (3 - 2 * t);
/** Cubic from y0 (slope m0) to y1 (slope m1) over u in 0..1. */
function hermite(y0: number, m0: number, y1: number, m1: number, u: number): number {
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * y0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * y1 + (u3 - u2) * m1;
}

/** The direction `fromSun` degrees away from the sun, toward the horizontal direction square to it. */
function dayside(fromSun: number): Vec3 {
  const side = norm(v3(), v3(-L.z, 0, L.x)), c = Math.cos(fromSun * DEG), s = Math.sin(fromSun * DEG);
  return norm(v3(), addScaled(v3(), scale(v3(), L, c), side, s));
}

/** A ship at `shipPos` with its nose along `forward` and `up` roughly up, then pitched (nose up positive) and banked
 *  (right wing down positive), and the camera straight behind it. */
export function lookPose(shipPos: Vec3, forward: Vec3, up: Vec3, pitch = 0, bank = 0, phase: Phase = 'low'): PathPose {
  const f = norm(v3(), forward);
  const u = norm(v3(), addScaled(v3(), up, f, -dot(up, f)));
  const shipQ: Quat = qFromBasis(cross(v3(), f, u), u, scale(v3(), f, -1));
  qMul(shipQ, shipQ, qAxisAngle(qIdentity(), v3(1, 0, 0), pitch));
  qMul(shipQ, shipQ, qAxisAngle(qIdentity(), v3(0, 0, -1), bank));
  qNorm(shipQ, shipQ);
  const camPos = add(v3(), shipPos, qRotate(v3(), shipQ, CHASE));
  return { camPos, camQ: { ...shipQ }, shipPos: { ...shipPos }, shipQ, phase };
}

// ------------------------------------------------------------------ a track round a body

/** A great circle through `focus` heading `heading` degrees north of east, passed at `speed` at `radius`, with the
 *  low phase weaving `weave` units to either side. */
interface Track {
  focus: Vec3; ahead: Vec3; right: Vec3; radius: number; weave: number;
  /** The angle travelled round the body, from the focus, at time `t`. */
  angle(t: number): number;
}

/** A steady track: SPEED at the body's radius, over the focus in the middle of the low pass. */
function steady(focus: Vec3, heading: number, radius: number, weave: number): Track {
  const east = norm(v3(), cross(v3(), v3(0, 1, 0), focus)), north = cross(v3(), focus, east);
  const ahead = norm(v3(), addScaled(v3(), scale(v3(), east, Math.cos(heading * DEG)), north, Math.sin(heading * DEG)));
  return { focus, ahead, right: cross(v3(), ahead, focus), radius, weave, angle: t => SPEED * (t - 2.5 * PHASE_S) / radius };
}

/** How far through the low pass `t` is, 0 outside it. */
const lowShare = (t: number): number => {
  const u = (t - 2 * PHASE_S) / PHASE_S;
  return u > 0 && u < 1 ? u : 0;
};
/** The weave of the low pass, -1..1, with its envelope: two swings, gentle at both ends. */
const swing = (t: number): number => {
  const u = lowShare(t);
  return Math.sin(Math.PI * u) ** 2 * Math.sin(4 * Math.PI * u);
};

/** The ground direction of the track at time `t`; the low pass is centred on the focus. */
function ground(out: Vec3, tr: Track, t: number): Vec3 {
  const a = tr.angle(t);
  scale(out, tr.focus, Math.cos(a));
  addScaled(out, out, tr.ahead, Math.sin(a));
  return norm(out, addScaled(out, out, tr.right, tr.weave * swing(t) / tr.radius));
}

/** Angle of the horizon below level, seen from `alt` above a sphere. */
const dip = (radius: number, alt: number): number => Math.acos(radius / (radius + Math.max(0, alt)));

/** The heights of a scene's path: start high, `edge` where the descent begins, `low` over the pass, `top` at the
 *  end. `sag`: how much lower the middle of the low pass is than `low`. */
interface Profile { start: number; edge: number; low: number; sag: number; end: number; top: number }

const BANK = 35 * DEG;

/** Height over the track's datum, pitch and bank at time `t`. */
function profile(tr: Track, h: Profile, t: number, phase: number): { alt: number; pitch: number; bank: number } {
  const u = (t - phase * PHASE_S) / PHASE_S;
  const bank = -BANK * swing(t);
  const sink = Math.min((h.edge - h.low) * 3 / PHASE_S, 0.2 * h.edge);
  if (phase === 0) { // in logarithm of height, so the body grows at an even pace
    const alt = Math.exp(hermite(Math.log(h.start), -0.2 * PHASE_S, Math.log(h.edge), -sink / h.edge * PHASE_S, u));
    return { alt, pitch: -dip(tr.radius, alt) + (-4 + 6 * smooth(u)) * DEG, bank };
  }
  if (phase === 1) {
    const from = -dip(tr.radius, h.edge) + 2 * DEG;
    return { alt: hermite(h.edge, -sink * PHASE_S, h.low, 0, u), pitch: from + (-5 * DEG - from) * smooth(u), bank };
  }
  if (phase === 2) {
    const at = (s: number): number => h.low - h.sag * Math.sin(Math.PI * s) ** 2 + (h.end - h.low) * smooth(s);
    const climb = (at(Math.min(1, u + 1e-4)) - at(Math.max(0, u - 1e-4))) / (2e-4 * PHASE_S);
    return { alt: at(u), pitch: -5 * DEG + 0.6 * Math.atan(climb / SPEED), bank };
  }
  return { alt: h.end + (h.top - h.end) * smooth(u), pitch: (-5 - 22 * smooth(u)) * DEG, bank };
}

/** The path round a body of centre `center`: heights are above `datum(t)`, a distance from the centre. */
function orbitPose(center: Vec3, tr: Track, h: Profile, datum: (t: number) => number, seconds: number): PathPose {
  const t = Math.min(PATH_SECONDS, Math.max(0, seconds));
  const phase = Math.min(PHASES.length - 1, Math.floor(t / PHASE_S));
  const up = ground(v3(), tr, t);
  const f = sub(v3(), ground(v3(), tr, t + SPAN), ground(v3(), tr, t - SPAN));
  const { alt, pitch, bank } = profile(tr, h, t, phase);
  const shipPos = add(v3(), center, scale(v3(), up, datum(t) + alt));
  return lookPose(shipPos, f, up, pitch, bank, PHASES[phase]);
}

// ------------------------------------------------------------------ the scenes

const GAS_HEADING = 25;

function gasScene(world: World): Scene {
  const p: Planet = world.planet, focus = dayside(52);
  const tr = steady(focus, GAS_HEADING, p.radius, 260);
  // heights above the cloud tops: the low pass dips to about 250 below them, 150 above the crush depth
  const heights: Profile = { start: 20000, edge: p.atmo, low: 150, sag: 400, end: 80, top: 1500 };
  const at = (t: number): PathPose => orbitPose(p.center, tr, heights, () => p.radius, t);
  const stills: Record<string, number> = { mid: 9, near: 22, close: 34, deep: 37.5 };
  return {
    world, focus, pose: at,
    view(name) {
      if (name === 'far') {
        const pos = add(v3(), p.center, scale(v3(), focus, p.radius + 45000));
        return lookPose(pos, scale(v3(), focus, -1), v3(0, 1, 0), 0, 0, 'approach');
      }
      return Object.hasOwn(stills, name) ? at(stills[name]) : null;
    },
  };
}

// the moon's path goes slower than the others: at the speed over the ground of a planet it would circle the moon
const MOON_SPEED = 70, RAMP = 2 * PHASE_S;
/** Seconds of full speed done by time `t`, the speed coming up smoothly from rest over the first RAMP seconds. */
const eased = (t: number): number => {
  const u = Math.min(1, Math.max(0, t / RAMP));
  return RAMP * (u * u * u - u * u * u * u / 2) + Math.max(0, t - RAMP);
};
const MOON_PASS = 2.5 * PHASE_S;
/** The sun's angle over the middle of the moon's low pass, and where free flight starts: distance from the moon's
 *  centre in moon radii and angle off the outward side. */
const PASS_SUN = 45, START_AT = CARRY_RADII - 0.04, START_OFF = 42;

/** The moon's track: square to the sun's direction, so that it stays lit from the side, over the point whose
 *  approach starts nearest the moon's outward side, with the planet behind the moon. */
function moonTrack(radius: number): Track {
  const side = norm(v3(), v3(-L.z, 0, L.x)), other = cross(v3(), L, side), c = Math.cos(PASS_SUN * DEG), r = Math.sin(PASS_SUN * DEG);
  const angle = (t: number): number => MOON_SPEED * (eased(t) - eased(MOON_PASS)) / radius;
  let best: Track | null = null, score = -Infinity;
  for (let k = 0; k < 360; k++) {
    const turn = k * DEG;
    const focus = norm(v3(), addScaled(v3(), addScaled(v3(), scale(v3(), L, c), side, r * Math.cos(turn)), other, r * Math.sin(turn)));
    for (const way of [1, -1]) {
      const ahead = norm(v3(), scale(v3(), cross(v3(), L, focus), way));
      const tr: Track = { focus, ahead, right: cross(v3(), ahead, focus), radius, weave: 150, angle };
      const s = dot(ground(v3(), tr, 0), ORBIT_START);
      if (s > score) { best = tr; score = s; }
    }
  }
  return best!;
}

function moonScene(world: World, moon: Moon): Scene {
  const p = world.planet, body = moon.body, tr = moonTrack(body.radius);
  const heights: Profile = { start: 15000, edge: 600, low: 170, sag: 60, end: 130, top: 900 };
  const centre = (t: number): Vec3 => moonPosition(v3(), p, t);
  const probe = v3();
  /** The ground's distance from the moon's centre under the track, averaged over 1.5 s to either side. */
  const datum = (t: number): number => {
    let sum = 0, weights = 0;
    for (let i = -12; i <= 12; i++) {
      const w = 13 - Math.abs(i);
      sum += w * surfaceRadius(body, ground(probe, tr, t + i / 8)); weights += w;
    }
    return sum / weights;
  };
  const on = (center: Vec3, t: number): PathPose => orbitPose(center, tr, heights, datum, t);

  // the sunward side of the moon's outward direction
  const square = norm(v3(), addScaled(v3(), L, ORBIT_START, -dot(L, ORBIT_START)));
  const startOff = norm(v3(), addScaled(v3(), scale(v3(), ORBIT_START, Math.cos(START_OFF * DEG)), square, Math.sin(START_OFF * DEG)));
  /** Looking at the moon from `radii` moon radii off it, toward `off`. */
  const toward = (time: number, off: Vec3, radii: number): PathPose => {
    const m = centre(time), pos = add(v3(), m, scale(v3(), off, radii * body.radius));
    return lookPose(pos, scale(v3(), off, -1), ORBIT_NORMAL, 0, 0, 'approach');
  };
  /** The planet's direction from the moon, as an angle from the zenith, over the sunward side. */
  const underPlanet = (time: number, zenith: number): { up: Vec3; ahead: Vec3 } => {
    const to = norm(v3(), sub(v3(), p.center, centre(time)));
    const aside = norm(v3(), addScaled(v3(), L, to, -dot(L, to)));
    const up = norm(v3(), addScaled(v3(), scale(v3(), to, Math.cos(zenith * DEG)), aside, Math.sin(zenith * DEG)));
    return { up, ahead: to };
  };
  /** From beyond the planet, with the moon half behind its edge. */
  const behind = (time: number): PathPose => {
    const m = centre(time), out = norm(v3(), sub(v3(), m, p.center)), far = 2 * p.radius;
    const limb = Math.asin(p.radius / far), pos = v3(), dir = v3(), line = v3();
    let lo = 0, hi = Math.PI / 2;
    for (let i = 0; i < 50; i++) {
      const th = (lo + hi) / 2;
      norm(dir, addScaled(dir, scale(dir, out, -Math.cos(th)), ORBIT_NORMAL, Math.sin(th)));
      addScaled(pos, p.center, dir, far);
      norm(line, sub(line, m, pos));
      if (Math.acos(Math.min(1, -dot(line, dir))) < limb) lo = th; else hi = th;
    }
    return lookPose(pos, line, ORBIT_NORMAL, 0, 0, 'approach');
  };

  return {
    world, focus: tr.focus, near: { moon },
    pose: t => on(centre(t), t),
    view(name, time) {
      if (name === 'far') return toward(time, startOff, 7);
      if (name === 'mid') return toward(time, startOff, 2.6);
      if (name === 'close') return on(centre(time), 36);
      if (name === 'near') return on(centre(time), 24);
      if (name === 'behind') return behind(time);
      if (name === 'front') { // from beyond the moon, which stands before the planet
        return toward(time, norm(v3(), addScaled(v3(), ORBIT_START, ORBIT_NORMAL, 0.2)), 4);
      }
      if (name === 'ground') {
        const { up, ahead } = underPlanet(time, 86);
        const pos = addScaled(v3(), centre(time), up, surfaceRadius(body, up) + 160);
        return lookPose(pos, addScaled(v3(), ahead, up, -dot(ahead, up)), up, -9 * DEG);
      }
      return null;
    },
    start(ship) {
      moon.place(moon.time);
      const at = toward(moon.time, startOff, START_AT);
      Object.assign(ship.pos, at.shipPos); Object.assign(ship.prevPos, at.shipPos);
      Object.assign(ship.q, at.shipQ); Object.assign(ship.prevQ, at.shipQ);
      ship.alt = START_AT * body.radius - surfaceRadius(body, startOff);
    },
  };
}

export function makeScene(world: World): Scene {
  if (world.moon) return moonScene(world, world.moon);
  if (world.scene === 'gas') return gasScene(world);
  const p = world.planet;
  return { world, focus: pathFocus(p), pose: t => pose(t, p), view: () => null };
}
