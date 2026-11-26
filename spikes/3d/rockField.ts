/** Which ring rocks to draw from where, as instance records: streamed round the camera with all storage made once.
 *  Pure; ringLayer.ts draws what it lists.
 *
 *  A square window of cells follows the camera; a cell's rock is worked out when the cell enters the window and kept
 *  in the slot its place in the window wraps onto. A rock is seen from viewDistance(radius) in, growing from nothing
 *  at that distance to full size at FULL of it. */
import { clamp } from '../../src/core/util';
import { inView } from './cull';
import { type Quat, type Vec3, qRotate, v3 } from './math';
import { CELL, KINDS, LAYER, type Ring, newRingRock } from './ring';

export const LODS = 3, BUCKETS = KINDS * LODS;
/** Instances a bucket (shape and detail) has room for. */
export const CAPACITY = 512;
const NEAREST = 300, FARTHEST = 1300, FULL = 0.75;
/** Cells from the camera's to the window's edge. */
const REACH = Math.ceil(FARTHEST / CELL);
const SIDE = 2 * REACH + 1;
/** Radius on screen, in character cells, above which the finest and the middle mesh are used. */
const FINE = 2.5, MIDDLE = 1.0;

/** How far off a rock of radius `r` begins to show. */
export const viewDistance = (r: number): number => clamp(120 + 65 * r, NEAREST, FARTHEST);

const EMPTY_KEY = 0x7fffffff;

export class RockField {
  /** Records of 8 floats: centre from the camera and scale, then the turn; bucket b begins at record b * CAPACITY. */
  readonly data = new Float32Array(BUCKETS * CAPACITY * 8);
  /** Records in use in each bucket (bucket = shape * LODS + detail). */
  readonly count = new Int32Array(BUCKETS);
  total = 0; dropped = 0;
  /** Cells worked out in the last update. */
  filled = 0;

  private readonly keyI = new Int32Array(SIDE * SIDE * 2).fill(EMPTY_KEY);
  private readonly keyJ = new Int32Array(SIDE * SIDE * 2);
  /** u, v, h, radius (0: empty), shape, turn. */
  private readonly rocks = new Float64Array(SIDE * SIDE * 2 * 9);
  private readonly rock = newRingRock();
  private readonly local = v3(); private readonly rel = v3(); private readonly view = v3();

  /** `scales`: for each shape, the mesh scale per unit of collision radius. */
  constructor(private readonly ring: Ring, private readonly scales: ArrayLike<number>) {}

  /** Lists what to draw from `eye`; `cull`: only what the camera (turned back by `invQ`) can see. */
  update(eye: Vec3, invQ: Quat, tanY: number, aspect: number, cellK: number, cull: boolean): void {
    this.count.fill(0); this.total = 0; this.dropped = 0; this.filled = 0;
    const ring = this.ring, l = ring.toLocal(this.local, eye), rho = Math.hypot(l.x, l.y);
    if (Math.abs(l.z) > FARTHEST + LAYER || rho > ring.outer + FARTHEST + CELL || rho < ring.inner - FARTHEST - CELL) return;
    const ci = Math.floor(l.x / CELL), cj = Math.floor(l.y / CELL), rocks = this.rocks, rel = this.rel;
    const c = ring.center, a = ring.e1, b = ring.e2, n = ring.n;
    const widest = (FARTHEST / CELL + 1.5) ** 2;
    for (let dj = -REACH; dj <= REACH; dj++) {
      for (let di = -REACH; di <= REACH; di++) {
        if (di * di + dj * dj > widest) continue;
        const i = ci + di, j = cj + dj;
        const column = ((j % SIDE + SIDE) % SIDE * SIDE + (i % SIDE + SIDE) % SIDE) * 2;
        for (let k = 0; k < 2; k++) {
          const slot = column + k, o = slot * 9;
          if (this.keyI[slot] !== i || this.keyJ[slot] !== j) {
            this.keyI[slot] = i; this.keyJ[slot] = j; this.filled++;
            const rock = this.rock;
            if (ring.rockAt(i, j, k, rock)) {
              rocks[o] = rock.u; rocks[o + 1] = rock.v; rocks[o + 2] = rock.h; rocks[o + 3] = rock.r; rocks[o + 4] = rock.kind;
              rocks[o + 5] = rock.q.x; rocks[o + 6] = rock.q.y; rocks[o + 7] = rock.q.z; rocks[o + 8] = rock.q.w;
            } else rocks[o + 3] = 0;
          }
          const r = rocks[o + 3];
          if (r === 0) continue;
          const du = rocks[o] - l.x, dv = rocks[o + 1] - l.y, dh = rocks[o + 2] - l.z, far = viewDistance(r);
          const d2 = du * du + dv * dv + dh * dh;
          if (d2 >= far * far) continue;
          const d = Math.sqrt(d2);
          const grown = Math.min(1, (far - d) / ((1 - FULL) * far)), size = r * grown * grown * (3 - 2 * grown);
          rel.x = c.x - eye.x + a.x * rocks[o] + b.x * rocks[o + 1] + n.x * rocks[o + 2];
          rel.y = c.y - eye.y + a.y * rocks[o] + b.y * rocks[o + 1] + n.y * rocks[o + 2];
          rel.z = c.z - eye.z + a.z * rocks[o] + b.z * rocks[o + 1] + n.z * rocks[o + 2];
          if (cull && !inView(qRotate(this.view, invQ, rel), r, tanY, aspect, 0.5)) continue;
          const kind = rocks[o + 4], cells = r / (Math.max(d, 1) * cellK);
          const bucket = kind * LODS + (cells > FINE ? 0 : cells > MIDDLE ? 1 : 2);
          if (this.count[bucket] >= CAPACITY) { this.dropped++; continue; }
          const w = (bucket * CAPACITY + this.count[bucket]++) * 8, data = this.data;
          data[w] = rel.x; data[w + 1] = rel.y; data[w + 2] = rel.z; data[w + 3] = size * this.scales[kind];
          data[w + 4] = rocks[o + 5]; data[w + 5] = rocks[o + 6]; data[w + 6] = rocks[o + 7]; data[w + 7] = rocks[o + 8];
          this.total++;
        }
      }
    }
  }
}
