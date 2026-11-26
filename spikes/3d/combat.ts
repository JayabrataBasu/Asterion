/** The combat load test without a browser: its URL parameters, and where the other ships, bolts and particles are.
 *
 *  Motion is a pure function of the seed, the time, the player's position and attitude and the planet (and of the
 *  heading, once one is fixed): nothing is carried from one frame to the next. Everything is placed in a frame that
 *  goes with the player. By default it turns with the nose (yaw and pitch), and not with the roll except when looking
 *  steeply up or down, so that most of it stays ahead: the reports and the still view use this. After `fixHeading`
 *  (free flight) it is level over the ground and keeps its bearing, whichever way the ship turns; only the player's
 *  own bolts still leave from the ship as it points. All arrays are made once; `update` allocates nothing. */
import { type Quat, type Vec3, addScaled, dot, len, norm, qRotate, sub, v3 } from './math';
import { type Planet, surfaceRadius } from './planet';

export interface Capacity { ships: number; bolts: number; particles: number }
export interface CombatConfig extends Capacity { scene: string }

export const LIMITS: Capacity = { ships: 1024, bolts: 640, particles: 8192 };
/** `heavy` is the 2D game's caps. */
export const SCENES: Record<string, Capacity> = {
  combat: { ships: 14, bolts: 200, particles: 2000 },
  heavy: { ships: 320, bolts: 640, particles: 8192 },
};
const KINDS = ['ships', 'bolts', 'particles'] as const;

/** ?scene=combat|heavy and ?ships= ?bolts= ?particles=; null when none of them says anything (a value outside its
 *  range, or an unknown scene, says nothing). */
export function parseCombat(params: URLSearchParams): CombatConfig | null {
  const name = params.get('scene') ?? '';
  const base = Object.hasOwn(SCENES, name) ? SCENES[name] : null;
  const own: Partial<Capacity> = {};
  for (const key of KINDS) {
    const raw = params.get(key)?.trim(); // Number('') is 0, so blanks are skipped first
    if (!raw) continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0 && n <= LIMITS[key]) own[key] = n;
  }
  const overridden = Object.keys(own).length > 0;
  if (!base && !overridden) return null;
  return {
    scene: !base ? 'custom' : overridden ? `${name} (overridden)` : name,
    ...(base ?? { ships: 0, bolts: 0, particles: 0 }), ...own,
  };
}

export function sceneLine(c: CombatConfig): string {
  return `scene ${c.scene}: ${c.ships} other ships, ${c.bolts} bolts, ${c.particles} particles`;
}

/** What there is to draw besides the world and the player: world positions, in arrays made once. */
export interface Swarm extends Capacity {
  /** Three per ship. */
  shipPos: Float64Array;
  /** Nine per ship: its right, up and back axes (the columns of its rotation). */
  shipRot: Float32Array;
  /** Three per bolt: its two ends. */
  boltHead: Float64Array; boltTail: Float64Array;
  /** 1 for the player's side. */
  boltFriendly: Uint8Array;
  partPos: Float64Array;
  /** 0 new to 1 gone. */
  partAge: Float32Array;
}

export function newSwarm(c: Capacity): Swarm {
  return {
    ships: c.ships, bolts: c.bolts, particles: c.particles,
    shipPos: new Float64Array(c.ships * 3), shipRot: new Float32Array(c.ships * 9),
    boltHead: new Float64Array(c.bolts * 3), boltTail: new Float64Array(c.bolts * 3), boltFriendly: new Uint8Array(c.bolts),
    partPos: new Float64Array(c.particles * 3), partAge: new Float32Array(c.particles),
  };
}

/** Distances from the player. */
export const NEAR_RANGE = 40, FAR_RANGE = 800;
/** The lowest a ship's centre comes over the ground (half the wing span is 13). */
export const SHIP_CLEAR = 18;
export const BOLT_LENGTH = 10;

const BURST = 64;             // particles in one burst
const BURST_CLEAR = 6;        // a burst's centre over the ground: much of a low burst goes into it
const MIN_ANCHORS = 16;       // places bolts fly between when there are fewer than two ships
const PLAYER_BOLTS = 8;       // one bolt in this many is the player's
const AT_PLAYER = 0.3;        // share of the others aimed close past the player
const DEG = Math.PI / 180;
const SHIP_PARAMS = 12;       // az, el, distance: base, then amplitude, rate and phase of each

function rand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer hash of three numbers -> [0,1). */
function hash(a: number, b: number, c: number): number {
  let h = Math.imul(a ^ 0x5bd1e995, 0x27d4eb2d) ^ Math.imul(b + 0x2545f491, 0x165667b1) ^ Math.imul(c ^ 0x68bc21eb, 0x1b873593);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Not Math.hypot: the browser allocates inside it, and this runs for every ship, bolt and particle of every frame. */
const length = (x: number, y: number, z: number): number => Math.sqrt(x * x + y * y + z * z);

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const AXIS_F = v3(0, 0, -1), AXIS_U = v3(0, 1, 0);
/** Where the player's bolts start: this far to either side, below and ahead. */
const MUZZLE_SIDE = 12, MUZZLE_DOWN = 2, MUZZLE_AHEAD = NEAR_RANGE + 2;

export class CombatField {
  readonly swarm: Swarm;
  private readonly anchors: number;
  private readonly ship: Float64Array;       // SHIP_PARAMS per anchor
  private readonly anchorPos: Float64Array;  // world positions of this update
  private readonly boltLife: Float64Array;   // life and phase
  private readonly burst: Float64Array;      // period, phase, radius per group
  private readonly burstPos: Float64Array;
  private readonly part: Float32Array;       // direction, speed share, age factor
  private readonly seed: number;

  // the player's frame of this update, and scratch
  private readonly f = v3(); private readonly u = v3(); private readonly r = v3(); private readonly up = v3();
  private readonly p = v3(); private readonly dir = v3(); private readonly local = v3(); private readonly vel = v3();
  private player: Vec3 = v3(); private playerQ!: Quat; private planet!: Planet;
  // the fixed heading, if one is: the vertical where it was fixed, and the way along the ground there
  private held = false; private readonly from = v3(); private readonly heading = v3(); private readonly muzzle = v3();

  constructor(counts: Capacity, seed = 1) {
    this.seed = seed;
    this.swarm = newSwarm(counts);
    this.anchors = counts.ships >= 2 ? counts.ships : MIN_ANCHORS;
    const n = Math.max(this.anchors, counts.ships);
    const r = rand(seed * 7919 + 101);
    this.ship = new Float64Array(n * SHIP_PARAMS);
    this.anchorPos = new Float64Array(n * 3);
    const shift = r();
    for (let i = 0; i < n; i++) {
      const o = i * SHIP_PARAMS, s = this.ship;
      const ahead = r() < 0.75;
      const az = ahead ? (r() * 100 - 50) * DEG : (r() * 360 - 180) * DEG;
      const el = ahead ? (r() * 43 - 18) * DEG : (r() * 70 - 35) * DEG;
      // spread evenly by index, so that a few ships also cover the whole range
      const share = (i * 0.6180339887498949 + shift) % 1;
      const d = 60 + 720 * share ** 0.6;
      s[o] = az; s[o + 1] = el; s[o + 2] = d;
      s[o + 3] = (5 + 15 * r()) * DEG; s[o + 4] = 0.25 + 0.65 * r(); s[o + 5] = r() * 2 * Math.PI;
      s[o + 6] = (2 + 6 * r()) * DEG; s[o + 7] = 0.25 + 0.65 * r(); s[o + 8] = r() * 2 * Math.PI;
      s[o + 9] = Math.min(50 * r() + 5, d - 55, 785 - d); s[o + 10] = 0.2 + 0.5 * r(); s[o + 11] = r() * 2 * Math.PI;
    }
    this.boltLife = new Float64Array(counts.bolts * 2);
    for (let i = 0; i < counts.bolts; i++) { const life = 0.5 + 0.7 * r(); this.boltLife[i * 2] = life; this.boltLife[i * 2 + 1] = r() * life; }
    const groups = Math.ceil(counts.particles / BURST);
    this.burst = new Float64Array(groups * 3);
    this.burstPos = new Float64Array(groups * 3);
    for (let g = 0; g < groups; g++) {
      const period = 0.8 + 1.4 * r();
      this.burst[g * 3] = period; this.burst[g * 3 + 1] = r() * period; this.burst[g * 3 + 2] = 10 + 30 * r();
    }
    this.part = new Float32Array(counts.particles * 5);
    for (let i = 0; i < counts.particles; i++) {
      const z = 2 * r() - 1, a = r() * 2 * Math.PI, w = Math.sqrt(1 - z * z);
      this.part.set([w * Math.cos(a), w * Math.sin(a), z, 0.3 + 0.7 * r(), 0.8 + 0.45 * r()], i * 5);
    }
  }

  /** From now on the frame's heading is the one the ship has here, carried along the ground as the player moves.
   *  Looking straight down it is the screen's up (the way out of the dive); looking straight up, the screen's down. */
  fixHeading(playerPos: Vec3, playerQ: Quat, planet: Planet): void {
    const n = norm(this.from, sub(this.from, playerPos, planet.center));
    const f = qRotate(v3(), playerQ, AXIS_F), u = qRotate(v3(), playerQ, AXIS_U), steep = dot(f, n);
    addScaled(f, f, n, -steep);
    addScaled(u, u, n, -dot(u, n));
    const h = addScaled(this.heading, f, u, -steep);
    if (len(h) < 1e-6) { // no way is the nose's: any level one
      const axis = Math.abs(n.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0);
      addScaled(h, axis, n, -dot(axis, n));
    }
    norm(h, h);
    this.held = true;
  }

  /** Writes the places at time `t` (seconds) around the player into `swarm`. */
  update(t: number, playerPos: Vec3, playerQ: Quat, planet: Planet): void {
    this.player = playerPos; this.playerQ = playerQ; this.planet = planet;
    if (this.held) this.levelFrame();
    else this.makeFrame(playerQ);
    this.moveShips(t);
    this.moveBolts(t);
    this.moveParticles(t);
  }

  /** Forward is the nose; up is away from the planet, handing over to the ship's up as the nose nears the vertical. */
  private makeFrame(q: Quat): void {
    const { f, u, r, up } = this, c = this.planet.center, p = this.player;
    qRotate(f, q, AXIS_F);
    qRotate(up, q, AXIS_U);
    let rx = p.x - c.x, ry = p.y - c.y, rz = p.z - c.z;
    const rl = length(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    const k = smooth(0.7, 0.95, Math.abs(rx * f.x + ry * f.y + rz * f.z));
    let hx = rx + (up.x - rx) * k, hy = ry + (up.y - ry) * k, hz = rz + (up.z - rz) * k;
    let d = hx * f.x + hy * f.y + hz * f.z;
    hx -= f.x * d; hy -= f.y * d; hz -= f.z * d;
    let l = length(hx, hy, hz);
    if (l < 0.05) {
      d = up.x * f.x + up.y * f.y + up.z * f.z;
      hx = up.x - f.x * d; hy = up.y - f.y * d; hz = up.z - f.z * d;
      l = length(hx, hy, hz) || 1;
    }
    u.x = hx / l; u.y = hy / l; u.z = hz / l;
    r.x = f.y * u.z - f.z * u.y; r.y = f.z * u.x - f.x * u.z; r.z = f.x * u.y - f.y * u.x;
  }

  /** Up is away from the planet; forward is the fixed heading, turned by the least that takes the vertical where it
   *  was fixed to the vertical here. */
  private levelFrame(): void {
    const { f, u, r, from: a, heading: h } = this, c = this.planet.center, p = this.player;
    let x = p.x - c.x, y = p.y - c.y, z = p.z - c.z;
    const d = length(x, y, z) || 1;
    x /= d; y /= d; z /= d;
    u.x = x; u.y = y; u.z = z;
    const across = 1 + a.x * x + a.y * y + a.z * z; // 0 on the far side of the planet, where any way round will do
    const k = across > 1e-9 ? (h.x * x + h.y * y + h.z * z) / across : 0;
    let fx = h.x - (a.x + x) * k, fy = h.y - (a.y + y) * k, fz = h.z - (a.z + z) * k;
    const v = fx * x + fy * y + fz * z; // rounding, and the far side
    fx -= x * v; fy -= y * v; fz -= z * v;
    const l = length(fx, fy, fz) || 1;
    f.x = fx / l; f.y = fy / l; f.z = fz / l;
    r.x = f.y * u.z - f.z * u.y; r.y = f.z * u.x - f.x * u.z; r.z = f.x * u.y - f.y * u.x;
  }

  /** `p` = where a bolt of the player's starts, at the wing tip on `side` (-1 or 1). */
  private placeMuzzle(side: number): void {
    if (!this.held) { this.place(side * MUZZLE_SIDE, -MUZZLE_DOWN, MUZZLE_AHEAD); return; }
    const { p, muzzle: m } = this, o = this.player;
    m.x = side * MUZZLE_SIDE; m.y = -MUZZLE_DOWN; m.z = -MUZZLE_AHEAD; // the ship's own axes: its nose is -Z
    qRotate(p, this.playerQ, m);
    p.x += o.x; p.y += o.y; p.z += o.z;
  }

  /** `p` = the world point at (x right, y up, z ahead) from the player. */
  private place(x: number, y: number, z: number): void {
    const { p, r, u, f } = this, o = this.player;
    p.x = o.x + r.x * x + u.x * y + f.x * z;
    p.y = o.y + r.y * x + u.y * y + f.y * z;
    p.z = o.z + r.z * x + u.z * y + f.z * z;
  }

  /** `p` = the point at azimuth, elevation (radians) and distance in the player's frame. */
  private placeAt(az: number, el: number, d: number): void {
    const c = Math.cos(el);
    this.place(d * c * Math.sin(az), d * Math.sin(el), d * c * Math.cos(az));
  }

  /** Raises `p` to `clear` over the ground if it is lower: the deeper, the higher it comes out, up to 60 more. */
  private lift(clear: number): void {
    const { p, dir, planet } = this, c = planet.center;
    const x = p.x - c.x, y = p.y - c.y, z = p.z - c.z, d = length(x, y, z);
    if (d > planet.radius + planet.relief + clear) return;
    dir.x = x / d; dir.y = y / d; dir.z = z / d;
    const ground = surfaceRadius(planet, dir), alt = d - ground;
    if (alt >= clear) return;
    const h = ground + clear + Math.min(60, (clear - alt) * 0.35);
    p.x = c.x + dir.x * h; p.y = c.y + dir.y * h; p.z = c.z + dir.z * h;
  }

  /** Brings `p` into NEAR_RANGE..FAR_RANGE from the player along the line to it. */
  private clampRange(): void {
    const { p } = this, o = this.player;
    const x = p.x - o.x, y = p.y - o.y, z = p.z - o.z, d2 = x * x + y * y + z * z;
    if (d2 >= NEAR_RANGE * NEAR_RANGE && d2 <= FAR_RANGE * FAR_RANGE) return;
    const d = Math.sqrt(d2), to = d < NEAR_RANGE ? NEAR_RANGE + 1e-4 : FAR_RANGE - 1e-4;
    if (d < 1e-6) { this.place(0, 0, to); return; }
    const k = to / d;
    p.x = o.x + x * k; p.y = o.y + y * k; p.z = o.z + z * k;
  }

  /** As clampRange, but moving along the ground (square to the player's vertical), which keeps the height. */
  private slideIntoRange(): void {
    const { p, f } = this, o = this.player, c = this.planet.center;
    const x = p.x - o.x, y = p.y - o.y, z = p.z - o.z, d = length(x, y, z);
    if (d >= NEAR_RANGE && d <= FAR_RANGE) return;
    const to = d < NEAR_RANGE ? NEAR_RANGE : FAR_RANGE;
    let ux = o.x - c.x, uy = o.y - c.y, uz = o.z - c.z;
    const ul = length(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const v = x * ux + y * uy + z * uz;
    if (Math.abs(v) >= to) { this.clampRange(); return; }
    let tx = x - ux * v, ty = y - uy * v, tz = z - uz * v, tl = length(tx, ty, tz);
    if (tl < 1e-3) { // straight above or below: go ahead
      const a = f.x * ux + f.y * uy + f.z * uz;
      tx = f.x - ux * a; ty = f.y - uy * a; tz = f.z - uz * a; tl = length(tx, ty, tz) || 1;
    }
    const k = Math.sqrt(to * to - v * v) / tl;
    p.x = o.x + ux * v + tx * k; p.y = o.y + uy * v + ty * k; p.z = o.z + uz * v + tz * k;
  }

  private moveShips(t: number): void {
    const { ship: s, swarm, local, vel, p, r, u, f } = this, out = this.anchorPos;
    const n = out.length / 3;
    for (let i = 0; i < n; i++) {
      const o = i * SHIP_PARAMS;
      const wa = s[o + 4], pa = wa * t + s[o + 5], we = s[o + 7], pe = we * t + s[o + 8], wd = s[o + 10], pd = wd * t + s[o + 11];
      const az = s[o] + s[o + 3] * Math.sin(pa), el = s[o + 1] + s[o + 6] * Math.sin(pe), d = s[o + 2] + s[o + 9] * Math.sin(pd);
      const sa = Math.sin(az), ca = Math.cos(az), se = Math.sin(el), ce = Math.cos(el);
      local.x = d * ce * sa; local.y = d * se; local.z = d * ce * ca;
      this.place(local.x, local.y, local.z);
      this.lift(SHIP_CLEAR);
      this.slideIntoRange();
      this.lift(SHIP_CLEAR);
      out[i * 3] = p.x; out[i * 3 + 1] = p.y; out[i * 3 + 2] = p.z;
      if (i >= swarm.ships) continue;
      swarm.shipPos[i * 3] = p.x; swarm.shipPos[i * 3 + 1] = p.y; swarm.shipPos[i * 3 + 2] = p.z;

      // the nose goes where the ship is going: the rate of change of the three coordinates
      const dd = s[o + 9] * wd * Math.cos(pd), de = s[o + 6] * we * Math.cos(pe), da = s[o + 3] * wa * Math.cos(pa);
      const vx = dd * ce * sa - d * se * sa * de + d * ce * ca * da;
      const vy = dd * se + d * ce * de;
      const vz = dd * ce * ca - d * se * ca * de - d * ce * sa * da;
      vel.x = r.x * vx + u.x * vy + f.x * vz;
      vel.y = r.y * vx + u.y * vy + f.y * vz;
      vel.z = r.z * vx + u.z * vy + f.z * vz;
      this.orient(i);
    }
  }

  /** The ship's axes from its velocity, with its up as near the frame's as that allows. */
  private orient(i: number): void {
    const { vel, u, f } = this, rot = this.swarm.shipRot;
    let l = length(vel.x, vel.y, vel.z);
    const bx = l > 1e-6 ? -vel.x / l : -f.x, by = l > 1e-6 ? -vel.y / l : -f.y, bz = l > 1e-6 ? -vel.z / l : -f.z;
    let hx = u.x, hy = u.y, hz = u.z;
    if (Math.abs(bx * hx + by * hy + bz * hz) > 0.98) { hx = f.x; hy = f.y; hz = f.z; }
    let rx = hy * bz - hz * by, ry = hz * bx - hx * bz, rz = hx * by - hy * bx;
    l = length(rx, ry, rz) || 1;
    rx /= l; ry /= l; rz /= l;
    const o = i * 9;
    rot[o] = rx; rot[o + 1] = ry; rot[o + 2] = rz;
    rot[o + 3] = by * rz - bz * ry; rot[o + 4] = bz * rx - bx * rz; rot[o + 5] = bx * ry - by * rx;
    rot[o + 6] = bx; rot[o + 7] = by; rot[o + 8] = bz;
  }

  private moveBolts(t: number): void {
    const { swarm, p, anchors, seed } = this, a = this.anchorPos, head = swarm.boltHead, tail = swarm.boltTail;
    for (let i = 0; i < swarm.bolts; i++) {
      const life = this.boltLife[i * 2], at = (t + this.boltLife[i * 2 + 1]) / life, k = Math.floor(at), age = at - k;
      const id = seed * 4099 + i;
      const from = Math.floor(hash(id, k, 1) * anchors);
      const to = (from + 1 + Math.floor(hash(id, k, 2) * (anchors - 1))) % anchors;
      const mine = i % PLAYER_BOLTS === 0;
      let ox = a[from * 3], oy = a[from * 3 + 1], oz = a[from * 3 + 2];
      let tx = a[to * 3], ty = a[to * 3 + 1], tz = a[to * 3 + 2];
      if (mine) { // from just ahead of a wing tip
        this.placeMuzzle(hash(id, k, 3) < 0.5 ? -1 : 1);
        ox = p.x; oy = p.y; oz = p.z;
      } else if (hash(id, k, 4) < AT_PLAYER) { // past the player
        this.place((hash(id, k, 5) - 0.5) * 60, (hash(id, k, 6) - 0.5) * 36, NEAR_RANGE + 4 + 20 * hash(id, k, 7));
        tx = p.x; ty = p.y; tz = p.z;
      }
      let dx = tx - ox, dy = ty - oy, dz = tz - oz;
      const l = length(dx, dy, dz) || 1;
      dx /= l; dy /= l; dz /= l;
      p.x = ox + dx * l * age; p.y = oy + dy * l * age; p.z = oz + dz * l * age;
      this.clampRange();
      head[i * 3] = p.x; head[i * 3 + 1] = p.y; head[i * 3 + 2] = p.z;
      tail[i * 3] = p.x - dx * BOLT_LENGTH; tail[i * 3 + 1] = p.y - dy * BOLT_LENGTH; tail[i * 3 + 2] = p.z - dz * BOLT_LENGTH;
      swarm.boltFriendly[i] = mine ? 1 : 0;
    }
  }

  private moveParticles(t: number): void {
    const { swarm, p, burst, seed, part } = this, centre = this.burstPos;
    const groups = burst.length / 3;
    for (let g = 0; g < groups; g++) {
      const k = Math.floor((t + burst[g * 3 + 1]) / burst[g * 3]), id = seed * 8191 + g;
      const ahead = hash(id, k, 1) < 0.75, h2 = hash(id, k, 2), h3 = hash(id, k, 3);
      this.placeAt(
        ahead ? (h2 * 100 - 50) * DEG : (h2 * 360 - 180) * DEG,
        ahead ? (h3 * 40 - 18) * DEG : (h3 * 70 - 35) * DEG,
        90 + 650 * hash(id, k, 4) ** 0.7);
      this.lift(BURST_CLEAR);
      centre[g * 3] = p.x; centre[g * 3 + 1] = p.y; centre[g * 3 + 2] = p.z;
    }
    const pos = swarm.partPos;
    for (let i = 0; i < swarm.particles; i++) {
      const g = (i / BURST) | 0, at = (t + burst[g * 3 + 1]) / burst[g * 3], a = at - Math.floor(at);
      const o = i * 5, reach = burst[g * 3 + 2] * part[o + 3] * a * (2 - a);
      p.x = centre[g * 3] + part[o] * reach;
      p.y = centre[g * 3 + 1] + part[o + 1] * reach;
      p.z = centre[g * 3 + 2] + part[o + 2] * reach;
      this.clampRange();
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      swarm.partAge[i] = Math.min(1, a * part[o + 4]);
    }
  }
}
