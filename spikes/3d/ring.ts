/** The ring: a flat annulus round the planet, banded; close in it is rocks on a lattice in its plane, decided by
 *  position and seed alone. Here: its axes, density, rocks and collision against them; no drawing (ringLayer.ts).
 *
 *  Local axes: u and v in the plane (along e1, e2), h out of it (along n), from the planet's centre. The lattice has
 *  cells CELL x CELL x LAYER in two layers, h -50..0 and 0..50. A cell holds at most one rock, and the rock with the
 *  ship's radius round it stays inside the cell: no two overlap, a point is inside at most the rock of its own cell,
 *  and the planes between cells are always clear. The ring does not turn. */
import { type Quat, type Vec3, addScaled, cross, dot, norm, qIdentity, scale, sub, v3 } from './math';
import { hash3, noise } from './noise';
import type { Planet } from './planet';

export const INNER_RADII = 1.4, OUTER_RADII = 2.2, THICKNESS = 100;
export const CELL = 60, LAYER = THICKNESS / 2, ROCK_MIN = 2.5, ROCK_MAX = 19, KINDS = 4;
/** The largest radius a body colliding with rocks may have: the room kept round each rock in its cell. */
const ROOM = 5;
/** Share of cells with a rock at full density. */
const FILL = 0.85;
/** The longest stretch of a movement whose cells are looked through at once. */
const PIECE = 30;

/** Radial bands: the share of the width where each ends, and its density. */
export const BANDS: readonly (readonly [number, number])[] = [
  [0.10, 0.22], [0.40, 0.70], [0.46, 0.06], [0.64, 0.95], [0.68, 0.40], [0.81, 0.80], [0.84, 0.03], [0.97, 0.55], [1, 0.18],
];

export interface RingRock {
  /** Centre in the ring's axes, and radius of its collision ball. */
  u: number; v: number; h: number; r: number;
  /** Which shape, 0..KINDS - 1, and how it is turned. */
  kind: number; q: Quat;
}
export const newRingRock = (): RingRock => ({ u: 0, v: 0, h: 0, r: 0, kind: 0, q: qIdentity() });

const NORMAL = norm(v3(), v3(0.25, 0.93, -0.27));

export class Ring {
  readonly inner: number; readonly outer: number; readonly thickness = THICKNESS;
  readonly center: Vec3; readonly seed: number;
  readonly n = NORMAL; readonly e1: Vec3; readonly e2: Vec3;
  /** The rock of the last `hit`. */
  readonly met = newRingRock();
  private readonly rock = newRingRock();
  private readonly from = v3(); private readonly by = v3(); private readonly at = v3(); private readonly out = v3();

  /** `toward`: a direction whose part in the plane, turned 50 degrees, is e2 (the sun, so rocks there are lit
   *  from the side). */
  constructor(planet: Planet, toward: Vec3) {
    this.inner = INNER_RADII * planet.radius; this.outer = OUTER_RADII * planet.radius;
    this.center = planet.center; this.seed = planet.seed;
    const flat = norm(v3(), addScaled(v3(), toward, this.n, -dot(toward, this.n)));
    const quarter = cross(v3(), this.n, flat), a = 50 * Math.PI / 180;
    this.e2 = norm(v3(), addScaled(v3(), scale(v3(), flat, Math.cos(a)), quarter, Math.sin(a)));
    this.e1 = cross(v3(), this.e2, this.n);
  }

  toLocal(out: Vec3, pos: Vec3): Vec3 {
    sub(this.out, pos, this.center);
    const u = dot(this.out, this.e1), v = dot(this.out, this.e2), h = dot(this.out, this.n);
    out.x = u; out.y = v; out.z = h;
    return out;
  }

  toWorld(out: Vec3, u: number, v: number, h: number): Vec3 {
    const c = this.center, a = this.e1, b = this.e2, n = this.n;
    out.x = c.x + a.x * u + b.x * v + n.x * h;
    out.y = c.y + a.y * u + b.y * v + n.y * h;
    out.z = c.z + a.z * u + b.z * v + n.z * h;
    return out;
  }

  /** How full the ring is at `radius` from the axis, 0..1; 0 outside it. */
  density(radius: number): number {
    const share = (radius - this.inner) / (this.outer - this.inner);
    if (!(share >= 0 && share <= 1)) return 0;
    let i = 0;
    while (i < BANDS.length - 1 && share > BANDS[i][0]) i++;
    return BANDS[i][1] * (0.8 + 0.2 * noise(share * 90, 0.5, 0.5, this.seed + 77));
  }

  /** The rock of cell (i, j, k), written into `into`; false if the cell is empty. */
  rockAt(i: number, j: number, k: number, into: RingRock): boolean {
    if (k !== 0 && k !== 1) return false;
    const s = this.seed * 131, chance = hash3(i, j, k, s + 1);
    if (chance >= FILL) return false;
    const size = hash3(i, j, k, s + 2), r = ROCK_MIN + (ROCK_MAX - ROCK_MIN) * size * size, pad = r + ROOM;
    const u = i * CELL + pad + hash3(i, j, k, s + 3) * (CELL - 2 * pad);
    const v = j * CELL + pad + hash3(i, j, k, s + 4) * (CELL - 2 * pad);
    if (chance >= FILL * this.density(Math.sqrt(u * u + v * v))) return false;
    into.u = u; into.v = v; into.r = r;
    into.h = k * LAYER - LAYER + pad + hash3(i, j, k, s + 5) * (LAYER - 2 * pad);
    into.kind = Math.floor(hash3(i, j, k, s + 6) * KINDS);
    // an evenly spread turn
    const a = hash3(i, j, k, s + 7), b = 2 * Math.PI * hash3(i, j, k, s + 8), c = 2 * Math.PI * hash3(i, j, k, s + 9);
    const p = Math.sqrt(1 - a), q = Math.sqrt(a);
    into.q.x = p * Math.sin(b); into.q.y = p * Math.cos(b); into.q.z = q * Math.sin(c); into.q.w = q * Math.cos(c);
    return true;
  }

  /** When, within `t`, a ball of radius `pad` (at most 5) at `pos` moving at `vel` first meets a rock it is closing
   *  on or is already inside: that time, with the rock in `met`; Infinity if it meets none. The whole movement is
   *  tested, so no speed or step length passes through. */
  hit(pos: Vec3, vel: Vec3, t: number, pad: number): number {
    const p = this.toLocal(this.from, pos), d = this.by;
    d.x = dot(vel, this.e1) * t; d.y = dot(vel, this.e2) * t; d.z = dot(vel, this.n) * t;
    // the part of the movement, 0..1 of it, within the ring's thickness
    let first = 0, last = 1;
    if (Math.abs(d.z) < 1e-12) { if (Math.abs(p.z) > LAYER) return Infinity; } else {
      const a = (-LAYER - p.z) / d.z, b = (LAYER - p.z) / d.z;
      first = Math.max(0, Math.min(a, b)); last = Math.min(1, Math.max(a, b));
      if (first > last) return Infinity;
    }
    const length = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z), span = (last - first) * length;
    const rho = Math.hypot(p.x + d.x * first, p.y + d.y * first);
    if (rho - span > this.outer + CELL || rho + span < this.inner - CELL) return Infinity;
    const pieces = Math.max(1, Math.ceil(span / PIECE)), A = length * length;
    const rock = this.rock;
    for (let n = 0; n < pieces; n++) {
      const sa = first + (last - first) * n / pieces, sb = first + (last - first) * (n + 1) / pieces;
      const ax = p.x + d.x * sa, ay = p.y + d.y * sa, az = p.z + d.z * sa;
      const bx = p.x + d.x * sb, by = p.y + d.y * sb, bz = p.z + d.z * sb;
      const i1 = Math.floor(Math.max(ax, bx) / CELL), j1 = Math.floor(Math.max(ay, by) / CELL);
      const k0 = Math.max(0, Math.floor((Math.min(az, bz) + LAYER) / LAYER));
      const k1 = Math.min(1, Math.floor((Math.max(az, bz) + LAYER) / LAYER));
      let soonest = Infinity;
      for (let i = Math.floor(Math.min(ax, bx) / CELL); i <= i1; i++) {
        for (let j = Math.floor(Math.min(ay, by) / CELL); j <= j1; j++) {
          for (let k = k0; k <= k1; k++) {
            if (!this.rockAt(i, j, k, rock)) continue;
            const mx = p.x - rock.u, my = p.y - rock.v, mz = p.z - rock.h, R = rock.r + pad;
            const C = mx * mx + my * my + mz * mz - R * R, B = mx * d.x + my * d.y + mz * d.z;
            let s = Infinity;
            if (C < -1e-7) s = 0;
            else if (B < 0) {
              const disc = B * B - A * C;
              if (disc >= 0) s = Math.max(0, (-B - Math.sqrt(disc)) / A);
            }
            if (s <= sb && s < soonest) { soonest = s; copyRock(this.met, rock); }
          }
        }
      }
      if (soonest !== Infinity) return soonest * t;
    }
    return Infinity;
  }

  /** Moves `pos` out of a rock it is within `pad` (at most 5) of. */
  eject(pos: Vec3, pad: number): void {
    const l = this.toLocal(this.at, pos), rock = this.rock;
    if (!this.rockAt(Math.floor(l.x / CELL), Math.floor(l.y / CELL), Math.floor((l.z + LAYER) / LAYER), rock)) return;
    const dx = l.x - rock.u, dy = l.y - rock.v, dz = l.z - rock.h, d = Math.hypot(dx, dy, dz), R = rock.r + pad;
    if (d >= R) return;
    if (d > 1e-6) this.toWorld(pos, rock.u + dx * R / d, rock.v + dy * R / d, rock.h + dz * R / d);
    else this.toWorld(pos, rock.u, rock.v, rock.h + R);
  }
}

function copyRock(into: RingRock, from: RingRock): void {
  into.u = from.u; into.v = from.v; into.h = from.h; into.r = from.r; into.kind = from.kind;
  into.q.x = from.q.x; into.q.y = from.q.y; into.q.z = from.q.z; into.q.w = from.q.w;
}
