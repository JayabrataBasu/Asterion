/** From a swarm to what the graphics chip draws, without a browser: the instances of the ships near enough to be
 *  meshes, and one entry per character cell for markers, bolts and particles. Whether the world or a ship hides an
 *  entry is only known on the chip (see combatShaders.ts); the counts are put together here from what it answers.
 *  All arrays are made once; `build` allocates nothing. */
import type { Capacity, Swarm } from './combat';
import { beyondHorizon, inView } from './cull';
import { type Quat, type Vec3, v3 } from './math';
import type { Planet } from './planet';

/** The wing span a ship is measured by, and the radius of the sphere that holds all of it. */
export const SHIP_SPAN = 26, SHIP_RADIUS = 18;
/** A ship spanning less than this many character widths is a marker. */
export const MARKER_CELLS = 4;
export const MAX_BOLT_CELLS = 24;
/** Per ship instance: place relative to the camera, then its right, up and back axes. */
export const SHIP_FLOATS = 12;
/** Per cell entry: column, row from the bottom, view depth, character, colour, 1 for crisp (no bloom). */
export const GLYPH_FLOATS = 8;
const NEAR = 0.5;

export function shipSpanCells(depth: number, rows: number, tanY: number): number {
  return depth > 0 ? SHIP_SPAN * rows / (tanY * depth) : Infinity; // a cell is depth * tanY / rows wide
}
export function isMarker(depth: number, rows: number, tanY: number): boolean {
  return shipSpanCells(depth, rows, tanY) < MARKER_CELLS;
}

const T1 = Math.tan(Math.PI / 8), T3 = Math.tan(3 * Math.PI / 8);
/** The character for a streak running (dx, dy) on screen, in pixels, y up. */
export function boltGlyph(dx: number, dy: number): '-' | '/' | '|' | '\\' {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ay <= ax * T1) return '-';
  if (ay >= ax * T3) return '|';
  return (dx > 0) === (dy > 0) ? '/' : '\\';
}

export function particleGlyph(age: number): '*' | '+' | '.' { return age < 1 / 3 ? '*' : age < 2 / 3 ? '+' : '.'; }

/** Colours (above 1 glows through the bloom). */
const MARKER_RGB = [1.6, 0.42, 0.3];
const HOSTILE_RGB = [1.9, 0.5, 0.22], FRIENDLY_RGB = [0.35, 1.6, 1.8];
const PART_RGB = [[1.9, 1.5, 0.85], [1.5, 0.7, 0.2], [0.65, 0.24, 0.14]];

export interface SwarmView { camPos: Vec3; camQ: Quat; cols: number; rows: number; tanY: number; planet: Planet | null }

/** Objects of one kind in a frame. drawn: at least one cell of it shows. hidden: on screen, but all of it behind the
 *  world or a ship. covered: not hidden, but every cell of it shows a nearer marker, bolt or particle.
 *  off: not on screen. */
export interface Tally { drawn: number; hidden: number; covered: number; off: number }
export interface SwarmCounts { ships: Tally; markers: Tally; bolts: Tally; particles: Tally }
const newTally = (): Tally => ({ drawn: 0, hidden: 0, covered: 0, off: 0 });

// what became of a ship
const OFF = 0, MESH = 1, MARKER = 2, BEYOND = 3;
// per object, while counting
const ON = 1, SEEN = 2, SHOWN = 4;

export class SwarmList {
  /** Mesh ships in the first `meshCount` entries; the player, if given, after them (`countShips` of both). */
  readonly shipData: Float32Array;
  meshCount = 0; countShips = 0;
  /** Every cell any marker, bolt or particle covers on screen. */
  readonly cand: Float32Array;
  candCount = 0;
  /** Of those, the nearest in each cell: what is drawn. A farther one in the same cell could never show, as whatever
   *  hides the nearer one hides it too. */
  readonly draw: Float32Array;
  drawCount = 0;

  private readonly candObj: Int32Array;
  private readonly shipState: Uint8Array;
  private readonly shipIsMarker: Uint8Array;
  private readonly flags: Uint8Array;
  private grid = new Int32Array(0);
  private cols = 0; private rows = 0; private tanX = 0; private tanY = 0;
  private nShips = 0; private nBolts = 0; private nParts = 0;
  // glyph indices
  private readonly open: number; private readonly shut: number; private readonly mark: number;
  private readonly boltG: Record<string, number> = {}; private readonly partG: Record<string, number> = {};
  // scratch
  private readonly m = new Float64Array(9); // world to view: rows right, up, back
  private cam: Vec3 = v3();
  private readonly rel = v3(); private readonly view = v3(); private readonly planetRel = v3();
  private readonly a = v3(); private readonly b = v3();

  constructor(cap: Capacity, glyph: (c: string) => number) {
    const cells = cap.ships * 3 + cap.bolts * MAX_BOLT_CELLS + cap.particles;
    this.shipData = new Float32Array((cap.ships + 1) * SHIP_FLOATS);
    this.cand = new Float32Array(cells * GLYPH_FLOATS);
    this.draw = new Float32Array(cells * GLYPH_FLOATS);
    this.candObj = new Int32Array(cells);
    this.shipState = new Uint8Array(cap.ships);
    this.shipIsMarker = new Uint8Array(cap.ships);
    this.flags = new Uint8Array(cap.ships + cap.bolts + cap.particles);
    this.open = glyph('['); this.shut = glyph(']'); this.mark = glyph('◆');
    for (const c of ['-', '/', '|', '\\']) this.boltG[c] = glyph(c);
    for (const c of ['*', '+', '.']) this.partG[c] = glyph(c);
  }

  /** The most entries `cand` can hold. */
  get capacity(): number { return this.candObj.length; }

  build(swarm: Swarm, view: SwarmView, player: { pos: Vec3; q: Quat } | null): void {
    this.setView(view);
    this.nShips = swarm.ships; this.nBolts = swarm.bolts; this.nParts = swarm.particles;
    this.meshCount = 0; this.candCount = 0;
    this.ships(swarm, view.planet);
    this.countShips = this.meshCount;
    if (player) this.player(player.pos, player.q);
    this.bolts(swarm);
    this.particles(swarm);
    this.keepNearest();
  }

  private setView(v: SwarmView): void {
    if (v.cols !== this.cols || v.rows !== this.rows) this.grid = new Int32Array(v.cols * v.rows); // after a resize
    this.cols = v.cols; this.rows = v.rows; this.tanY = v.tanY; this.tanX = v.tanY * v.cols / (v.rows * 2);
    this.cam = v.camPos;
    const { x, y, z, w } = v.camQ, m = this.m;
    m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y + w * z); m[2] = 2 * (x * z - w * y);
    m[3] = 2 * (x * y - w * z); m[4] = 1 - 2 * (x * x + z * z); m[5] = 2 * (y * z + w * x);
    m[6] = 2 * (x * z + w * y); m[7] = 2 * (y * z - w * x); m[8] = 1 - 2 * (x * x + y * y);
    if (v.planet) {
      this.planetRel.x = v.planet.center.x - v.camPos.x;
      this.planetRel.y = v.planet.center.y - v.camPos.y;
      this.planetRel.z = v.planet.center.z - v.camPos.z;
    }
  }

  /** `out` = entry `i` of `a` as seen from the camera: x right, y up, z back. Leaves it in world axes in `rel`. */
  private toView(out: Vec3, a: Float64Array, i: number): void {
    const x = a[i * 3] - this.cam.x, y = a[i * 3 + 1] - this.cam.y, z = a[i * 3 + 2] - this.cam.z, m = this.m;
    this.rel.x = x; this.rel.y = y; this.rel.z = z;
    out.x = m[0] * x + m[1] * y + m[2] * z;
    out.y = m[3] * x + m[4] * y + m[5] * z;
    out.z = m[6] * x + m[7] * y + m[8] * z;
  }

  /** Continuous cell coordinates of a view-space point in front of the camera. */
  private col(p: Vec3): number { return (p.x / (-p.z * this.tanX) * 0.5 + 0.5) * this.cols; }
  private row(p: Vec3): number { return (p.y / (-p.z * this.tanY) * 0.5 + 0.5) * this.rows; }

  private add(obj: number, x: number, y: number, depth: number, g: number, rgb: readonly number[], crisp: number): void {
    const i = this.candCount++, o = i * GLYPH_FLOATS, c = this.cand;
    c[o] = x; c[o + 1] = y; c[o + 2] = depth; c[o + 3] = g;
    c[o + 4] = rgb[0]; c[o + 5] = rgb[1]; c[o + 6] = rgb[2]; c[o + 7] = crisp;
    this.candObj[i] = obj;
  }

  private ships(swarm: Swarm, planet: Planet | null): void {
    const { view, rel } = this, aspect = this.tanX / this.tanY;
    for (let i = 0; i < swarm.ships; i++) {
      this.toView(view, swarm.shipPos, i);
      const depth = -view.z;
      const seen = inView(view, SHIP_RADIUS, this.tanY, aspect, NEAR);
      // a ship out of view is counted by what its distance would make it
      const far = isMarker(seen ? depth : Math.hypot(view.x, view.y, view.z), this.rows, this.tanY);
      this.shipIsMarker[i] = far ? 1 : 0;
      this.shipState[i] = OFF;
      if (!seen) continue;
      if (planet && beyondHorizon(rel, SHIP_RADIUS, this.planetRel, planet.radius)) { this.shipState[i] = BEYOND; continue; }
      if (!far) {
        this.shipState[i] = MESH;
        const o = this.meshCount++ * SHIP_FLOATS, d = this.shipData, r = swarm.shipRot, k = i * 9;
        d[o] = rel.x; d[o + 1] = rel.y; d[o + 2] = rel.z;
        for (let j = 0; j < 9; j++) d[o + 3 + j] = r[k + j];
        continue;
      }
      this.shipState[i] = MARKER; // with no cell on screen it counts as off
      if (depth < NEAR) continue;
      const x = Math.floor(this.col(view)), y = Math.floor(this.row(view));
      if (y < 0 || y >= this.rows) continue;
      for (let j = -1; j <= 1; j++) {
        if (x + j < 0 || x + j >= this.cols) continue;
        this.add(i, x + j, y, depth, j < 0 ? this.open : j > 0 ? this.shut : this.mark, MARKER_RGB, 1);
      }
    }
  }

  private player(pos: Vec3, q: Quat): void {
    const o = this.countShips++ * SHIP_FLOATS, d = this.shipData, { x, y, z, w } = q;
    d[o] = pos.x - this.cam.x; d[o + 1] = pos.y - this.cam.y; d[o + 2] = pos.z - this.cam.z;
    d[o + 3] = 1 - 2 * (y * y + z * z); d[o + 4] = 2 * (x * y + w * z); d[o + 5] = 2 * (x * z - w * y);
    d[o + 6] = 2 * (x * y - w * z); d[o + 7] = 1 - 2 * (x * x + z * z); d[o + 8] = 2 * (y * z + w * x);
    d[o + 9] = 2 * (x * z + w * y); d[o + 10] = 2 * (y * z - w * x); d[o + 11] = 1 - 2 * (x * x + y * y);
  }

  private bolts(swarm: Swarm): void {
    const { a, b, cols, rows } = this;
    for (let i = 0; i < swarm.bolts; i++) {
      this.toView(a, swarm.boltHead, i);
      this.toView(b, swarm.boltTail, i);
      const wa = -a.z, wb = -b.z;
      if (wa < NEAR && wb < NEAR) continue;
      // cut at the near plane
      if (wa < NEAR) cut(a, b, (NEAR - wa) / (wb - wa));
      else if (wb < NEAR) cut(b, a, (NEAR - wb) / (wa - wb));
      const ax = this.col(a), ay = this.row(a), bx = this.col(b), by = this.row(b);
      const g = this.boltG[boltGlyph(bx - ax, (by - ay) * 2)]; // a cell is twice as tall as wide
      const x0 = Math.floor(ax), y0 = Math.floor(ay), dx = Math.floor(bx) - x0, dy = Math.floor(by) - y0;
      const n = Math.max(Math.abs(dx), Math.abs(dy));
      // the part of the run that is on screen
      let from = 0, to = 1;
      if (dx !== 0) {
        const p = (-0.5 - x0) / dx, q = (cols - 0.5 - x0) / dx;
        from = Math.max(from, Math.min(p, q)); to = Math.min(to, Math.max(p, q));
      } else if (x0 < 0 || x0 >= cols) continue;
      if (dy !== 0) {
        const p = (-0.5 - y0) / dy, q = (rows - 0.5 - y0) / dy;
        from = Math.max(from, Math.min(p, q)); to = Math.min(to, Math.max(p, q));
      } else if (y0 < 0 || y0 >= rows) continue;
      if (from > to) continue;
      const rgb = swarm.boltFriendly[i] ? FRIENDLY_RGB : HOSTILE_RGB;
      const inv0 = -1 / a.z, inv1 = -1 / b.z;
      const last = Math.min(n, Math.ceil(to * n));
      for (let k = Math.max(0, Math.floor(from * n)), taken = 0; k <= last && taken < MAX_BOLT_CELLS; k++) {
        const t = n > 0 ? k / n : 0, x = Math.round(x0 + dx * t), y = Math.round(y0 + dy * t);
        if (x < 0 || x >= cols || y < 0 || y >= rows) continue;
        this.add(this.nShips + i, x, y, 1 / (inv0 + (inv1 - inv0) * t), g, rgb, 0);
        taken++;
      }
    }
  }

  private particles(swarm: Swarm): void {
    const { view } = this;
    for (let i = 0; i < swarm.particles; i++) {
      this.toView(view, swarm.partPos, i);
      const depth = -view.z;
      if (depth < NEAR) continue;
      const x = Math.floor(this.col(view)), y = Math.floor(this.row(view));
      if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) continue;
      const age = swarm.partAge[i], c = particleGlyph(age);
      this.add(this.nShips + this.nBolts + i, x, y, depth, this.partG[c], PART_RGB[c === '*' ? 0 : c === '+' ? 1 : 2], 0);
    }
  }

  private keepNearest(): void {
    const { grid, cand, draw, cols } = this;
    grid.fill(-1);
    for (let i = 0; i < this.candCount; i++) {
      const o = i * GLYPH_FLOATS, cell = cand[o + 1] * cols + cand[o], g = grid[cell];
      if (g < 0 || cand[o + 2] < cand[g * GLYPH_FLOATS + 2]) grid[cell] = i;
    }
    let n = 0;
    for (let i = 0; i < this.candCount; i++) {
      const o = i * GLYPH_FLOATS;
      if (grid[cand[o + 1] * cols + cand[o]] !== i) continue;
      for (let j = 0; j < GLYPH_FLOATS; j++) draw[n * GLYPH_FLOATS + j] = cand[o + j];
      n++;
    }
    this.drawCount = n;
  }

  /** The counts of the last build. `meshSeen`: per mesh instance, 1 if any of it shows. `candSeen`: per entry of
   *  `cand`, 1 if neither world nor ship hides it. */
  tally(meshSeen: ArrayLike<number>, candSeen: ArrayLike<number>): SwarmCounts {
    const out: SwarmCounts = { ships: newTally(), markers: newTally(), bolts: newTally(), particles: newTally() };
    const { flags, grid, cand, cols } = this;
    flags.fill(0);
    for (let i = 0; i < this.candCount; i++) {
      const o = i * GLYPH_FLOATS, obj = this.candObj[i];
      flags[obj] |= ON;
      if (!candSeen[i]) continue;
      flags[obj] |= grid[cand[o + 1] * cols + cand[o]] === i ? SEEN | SHOWN : SEEN;
    }
    const sort = (t: Tally, f: number): void => {
      if (!(f & ON)) t.off++; else if (!(f & SEEN)) t.hidden++; else if (f & SHOWN) t.drawn++; else t.covered++;
    };
    for (let i = 0, mesh = 0; i < this.nShips; i++) {
      const t = this.shipIsMarker[i] ? out.markers : out.ships, state = this.shipState[i];
      if (state === BEYOND) t.hidden++;
      else if (state === MESH) { if (meshSeen[mesh++]) t.drawn++; else t.hidden++; }
      else if (state === MARKER) sort(t, flags[i]);
      else t.off++;
    }
    for (let i = 0; i < this.nBolts; i++) sort(out.bolts, flags[this.nShips + i]);
    for (let i = 0; i < this.nParts; i++) sort(out.particles, flags[this.nShips + this.nBolts + i]);
    return out;
  }
}

/** Moves `p` the share `t` of the way to `q`. */
function cut(p: Vec3, q: Vec3, t: number): void {
  p.x += (q.x - p.x) * t; p.y += (q.y - p.y) * t; p.z += (q.z - p.z) * t;
}
