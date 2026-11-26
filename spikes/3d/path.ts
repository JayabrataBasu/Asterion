/** The scripted flight: 60 seconds of approach, descent, low flight with banked turns and climb, as a pure function
 *  of time and planet, with a camera fixed straight behind the ship (the reports ease their own: see runs.ts).
 *
 *  Altitudes are above surfaceRadius, averaged along the track over RELIEF_WINDOW seconds either side: following
 *  every bump exactly would bob the camera, and the flicker measure would then count the bobbing. */
import { CHASE } from './camera';
import {
  type Quat, type Vec3, add, addScaled, cross, dot, norm, qAxisAngle, qFromBasis, qIdentity, qMul, qNorm, qRotate, scale,
  v3,
} from './math';
import { type Planet, height, surfaceRadius } from './planet';
import { SUN } from './shaders';

export const PATH_SECONDS = 60;
export type Phase = 'approach' | 'descent' | 'low' | 'climb';
export interface PathPose { camPos: Vec3; camQ: Quat; shipPos: Vec3; shipQ: Quat; phase: Phase }

const PHASES: readonly Phase[] = ['approach', 'descent', 'low', 'climb'];
const PHASE_S = 15;
const LOW_START = 2 * PHASE_S;
const START_ALT = 60000, LOW_ALT = 150, TOP_ALT = 2000;
const SPEED = 143;
const DIVE = 50;                  // sink rate entering the atmosphere, units a second
const TURN_RATE = 0.35, TURN_S = 7.5, BANK = 35 * Math.PI / 180; // low phase: right, left, right, left
const RELIEF_WINDOW = 1.5, RELIEF_SAMPLES = 12;
const DEG = Math.PI / 180;

const L = norm(v3(), v3(...SUN));
const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Cubic from y0 (slope m0) to y1 (slope m1) over u in 0..1. */
function hermite(y0: number, m0: number, y1: number, m1: number, u: number): number {
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * y0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * y1 + (u3 - u2) * m1;
}

// ------------------------------------------------------------------ the ground track

/** Heading at the ground point `s`: the sun's direction along the ground turned 70 degrees, so slopes are lit
 *  from the side. */
function heading(s: Vec3): Vec3 {
  const lt = norm(v3(), addScaled(v3(), L, s, -dot(L, s)));
  const turn = 70 * DEG;
  return norm(v3(), addScaled(v3(), scale(v3(), lt, Math.cos(turn)), cross(v3(), s, lt), Math.sin(turn)));
}

/** Turn rate of the low phase, radians a second, right positive; starts and ends gently. */
function turnRate(t: number): number {
  const tau = t - LOW_START;
  if (tau <= 0 || tau >= PHASE_S) return 0;
  return TURN_RATE * Math.sin(2 * Math.PI * tau / TURN_S) ** 3;
}

/** Turns the heading `f` at the ground direction `s` to the right by `a` radians. */
function steer(s: Vec3, f: Vec3, a: number): void {
  const right = cross(v3(), f, s);
  norm(f, addScaled(f, scale(f, f, Math.cos(a)), right, Math.sin(a)));
}

/** Flies `dt` seconds of track (back for dt < 0), passing time `mid` half way: turn, move, turn. */
function fly(p: Planet, s: Vec3, f: Vec3, mid: number, dt: number): void {
  const half = turnRate(mid) * dt / 2, a = SPEED * dt / (surfaceRadius(p, s) + LOW_ALT);
  steer(s, f, half);
  const old = { ...s };
  norm(s, addScaled(s, scale(s, s, Math.cos(a)), f, Math.sin(a)));
  norm(f, addScaled(f, scale(f, f, Math.cos(a)), old, -Math.sin(a)));
  norm(f, addScaled(f, f, s, -dot(f, s)));
  steer(s, f, half);
}

/** Share of land among points beside and ahead of the low flight that starts at `start`. */
function landShare(p: Planet, start: Vec3): number {
  const s = { ...start }, f = heading(start), q = v3();
  let land = 0, n = 0;
  for (let t = 0; t <= PHASE_S; t++) {
    const right = cross(v3(), f, s);
    for (const ahead of [0, 250, 500, 900]) {
      for (const aside of [-250, 0, 250]) {
        addScaled(q, addScaled(q, s, f, ahead / p.radius), right, aside / p.radius);
        if (height(p, norm(q, q)) > 0) land++;
        n++;
      }
    }
    fly(p, s, f, LOW_START + t + 0.5, 1);
  }
  return land / n;
}

/** Where the low flight starts: of the land points 54 to 70 degrees from the sun (sun 20 to 36 degrees up, so
 *  relief shows) away from the ice, the one whose low flight has the most land around and ahead of it. */
function findStart(p: Planet): Vec3 {
  const a = norm(v3(), v3(-L.z, 0, L.x)), b = cross(v3(), L, a), d = v3();
  let best = norm(v3(), addScaled(v3(), scale(v3(), L, Math.cos(62 * DEG)), a, Math.sin(62 * DEG))), bestShare = -1;
  for (const fromSun of [62, 58, 66, 54, 70]) {
    const c = Math.cos(fromSun * DEG), r = Math.sin(fromSun * DEG);
    for (let k = 0; k < 180; k++) {
      const ang = k / 180 * Math.PI * 2;
      norm(d, addScaled(d, addScaled(d, scale(d, L, c), a, r * Math.cos(ang)), b, r * Math.sin(ang)));
      const h = height(p, d);
      if (Math.abs(d.y) > 0.75 || h < 0.05 * p.relief || h > 0.35 * p.relief) continue;
      const share = landShare(p, d);
      if (share > bestShare) { best = { ...d }; bestShare = share; }
    }
  }
  return best;
}

const HZ = 120, T_MIN = -2, T_MAX = PATH_SECONDS + 2;
const SAMPLES = (T_MAX - T_MIN) * HZ + 1;
/** Ground direction and heading (unit, along the ground) every 1/HZ seconds, six numbers each. */
interface Track { key: string; data: Float64Array; start: Vec3 }
let cached: Track | null = null;

/** The track of a planet, built once and kept until another planet is asked for. It runs both ways from the start of
 *  the low flight at a steady angle per second (SPEED at low altitude), straight except for the low-phase turns. */
function track(p: Planet): Track {
  const key = [p.seed, p.radius, p.relief].join('|');
  if (cached?.key === key) return cached;
  const data = new Float64Array(SAMPLES * 6);
  const start = findStart(p);
  const first = (LOW_START - T_MIN) * HZ;
  const s = v3(), f = v3();
  const store = (i: number): void => { data.set([s.x, s.y, s.z, f.x, f.y, f.z], i * 6); };
  for (const dir of [1, -1]) {
    Object.assign(s, start); Object.assign(f, heading(start));
    store(first);
    for (let i = first + dir; i >= 0 && i < SAMPLES; i += dir) {
      fly(p, s, f, T_MIN + (i - dir / 2) / HZ, dir / HZ);
      store(i);
    }
  }
  cached = { key, data, start };
  return cached;
}

/** The track at time `t`: ground direction into `s`, heading into `f`. */
function sample(tr: Track, t: number, s: Vec3, f: Vec3): void {
  const x = (Math.min(T_MAX, Math.max(T_MIN, t)) - T_MIN) * HZ;
  const i = Math.min(SAMPLES - 2, Math.floor(x)), k = x - i, d = tr.data, a = i * 6, b = a + 6;
  const lerp = (j: number): number => d[a + j] + (d[b + j] - d[a + j]) * k;
  norm(s, v3(lerp(0), lerp(1), lerp(2)));
  const g = v3(lerp(3), lerp(4), lerp(5));
  norm(f, addScaled(g, g, s, -dot(g, s)));
}

/** Surface distance from the centre under the track around time `t`: a triangle-weighted average. */
function groundRadius(p: Planet, tr: Track, t: number): number {
  const s = v3(), f = v3();
  let sum = 0, weights = 0;
  for (let i = -RELIEF_SAMPLES; i <= RELIEF_SAMPLES; i++) {
    const w = RELIEF_SAMPLES + 1 - Math.abs(i);
    sample(tr, t + i / RELIEF_SAMPLES * RELIEF_WINDOW, s, f);
    sum += w * surfaceRadius(p, s); weights += w;
  }
  return sum / weights;
}

// ------------------------------------------------------------------ the profile

/** Angle of the horizon below level, seen from `alt` above the sphere. */
function dip(p: Planet, alt: number): number { return Math.acos(p.radius / (p.radius + alt)); }

/** Altitude and nose pitch (radians, up positive) at time `t` in 0..PATH_SECONDS. */
function profile(p: Planet, t: number, phase: number): { alt: number; pitch: number } {
  const u = (t - phase * PHASE_S) / PHASE_S, atmo = p.atmo;
  // the sink rate where the first two phases meet, small enough that the descent never overshoots
  const sink = Math.min(DIVE, Math.max(0, atmo - LOW_ALT) * 3 / PHASE_S);
  if (phase === 0) { // in logarithm of altitude, so the planet grows at an even pace
    const alt = Math.exp(hermite(Math.log(START_ALT), -0.2 * PHASE_S, Math.log(atmo), -sink / atmo * PHASE_S, u));
    return { alt, pitch: -dip(p, alt) + (-4 + 6 * smooth(u)) * DEG }; // keeps the horizon near mid screen
  }
  if (phase === 1) {
    const from = -dip(p, atmo) + 2 * DEG;
    return { alt: hermite(atmo, -sink * PHASE_S, LOW_ALT, 0, u), pitch: from + (-8 * DEG - from) * smooth(u) };
  }
  if (phase === 2) return { alt: LOW_ALT, pitch: -8 * DEG };
  // climbing, the horizon sinks: the nose comes down with it so the ground stays in view
  return { alt: LOW_ALT + (TOP_ALT - LOW_ALT) * smooth(u), pitch: (-8 - 24 * smooth(u)) * DEG };
}

// ------------------------------------------------------------------ public

/** The ground direction under the start of the low flight: where scenery goes. */
export function pathFocus(p: Planet): Vec3 { return { ...track(p).start }; }

/** Ship, and the camera straight behind it, `t` seconds along the path (clamped to it). Returns new objects. */
export function pose(t: number, p: Planet): PathPose {
  const time = Math.min(PATH_SECONDS, Math.max(0, t));
  const phase = Math.min(PHASES.length - 1, Math.floor(time / PHASE_S));
  const tr = track(p), s = v3(), f = v3();
  sample(tr, time, s, f);
  const { alt, pitch } = profile(p, time, phase);
  const shipPos = add(v3(), p.center, scale(v3(), s, groundRadius(p, tr, time) + alt));

  // level flight along the heading, then pitch, then roll about the nose into the turn
  const right = cross(v3(), f, s);
  const shipQ = qFromBasis(right, s, scale(v3(), f, -1));
  qMul(shipQ, shipQ, qAxisAngle(qIdentity(), v3(1, 0, 0), pitch));
  qMul(shipQ, shipQ, qAxisAngle(qIdentity(), v3(0, 0, -1), BANK * turnRate(time) / TURN_RATE));
  qNorm(shipQ, shipQ);

  const camPos = add(v3(), shipPos, qRotate(v3(), shipQ, CHASE));
  return { camPos, camQ: { ...shipQ }, shipPos, shipQ, phase: PHASES[phase] };
}
