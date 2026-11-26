/** Cube-sphere quadtree: which tiles to show from where, and their meshes, built from the planet's height function.
 *  A face's u runs along its right axis and v along its up axis, both -1..1; tile (ix, iy) counts along them. */
import { type Vec3, add, addScaled, cross, len, norm, scale, sub, v3 } from './math';
import { type Planet, height, material, surfaceRadius } from './planet';

export const TILE_N = 16; // grid cells along a tile edge
/** Grid step near the ground to aim for, in units: the mesh then stays within 3 units of the height function. */
const FINE_STEP = 11;
const MIN_FINEST = 6, MAX_FINEST = 10;

/** The finest depth of a planet's tiles: the first whose grid step is at most FINE_STEP, kept within 6..10 (past 10,
 *  radii above 16 times the default, the step grows with the radius again). */
export function finestDepth(p: Planet): number {
  const depth = Math.ceil(Math.log2(p.radius * Math.PI / 2 / TILE_N / FINE_STEP));
  return Math.min(MAX_FINEST, Math.max(MIN_FINEST, depth));
}

export interface TileId { face: number; depth: number; ix: number; iy: number }

/** Positions are relative to `center`, which is in the same space as the planet's centre.
 *  Vertices: the (TILE_N + 1)^2 grid row by row (v), each row along u, then the foot of the skirt. */
export interface TileMesh {
  key: number; center: Vec3;
  pos: Float32Array<ArrayBuffer>; nrm: Float32Array<ArrayBuffer>; mat: Uint8Array<ArrayBuffer>;
}

/** One number per tile, for depths up to 15. */
export function tileKey(t: TileId): number { return ((t.face * 16 + t.depth) * 65536 + t.ix) * 65536 + t.iy; }

/** Outward, right and up axis of each face (+X -X +Y -Y +Z -Z); right x up = outward. */
const FACES: readonly (readonly [Vec3, Vec3, Vec3])[] = [
  [v3(1, 0, 0), v3(0, 0, -1), v3(0, 1, 0)],
  [v3(-1, 0, 0), v3(0, 0, 1), v3(0, 1, 0)],
  [v3(0, 1, 0), v3(1, 0, 0), v3(0, 0, -1)],
  [v3(0, -1, 0), v3(1, 0, 0), v3(0, 0, 1)],
  [v3(0, 0, 1), v3(1, 0, 0), v3(0, 1, 0)],
  [v3(0, 0, -1), v3(-1, 0, 0), v3(0, 1, 0)],
];

/** Unit direction through the point (u, v) of a cube face. The tangent warp makes equal steps near equal angles. */
export function faceDir(out: Vec3, face: number, u: number, v: number): Vec3 {
  const [n, right, up] = FACES[face];
  addScaled(out, n, right, Math.tan(u * Math.PI / 4));
  return norm(out, addScaled(out, out, up, Math.tan(v * Math.PI / 4)));
}

/** Face coordinate of grid line `i` (0..TILE_N, or between) of the tile at `index`. Shared lines come out identical. */
function coord(depth: number, index: number, i: number): number {
  return -1 + 2 * (index * TILE_N + i) / (TILE_N * 2 ** depth);
}

function child(t: TileId, k: number): TileId {
  return { face: t.face, depth: t.depth + 1, ix: 2 * t.ix + (k & 1), iy: 2 * t.iy + (k >> 1) };
}

function root(face: number): TileId { return { face, depth: 0, ix: 0, iy: 0 }; }

const mid = v3(), toMid = v3();

/** The tiles wanted from `camPos`: they cover the sphere once, and a tile is split while the camera is nearer to its
 *  centre (on the surface) than `split` times its arc length, down to the planet's finest depth. */
export function selectTiles(p: Planet, camPos: Vec3, split = 2.2): TileId[] {
  const out: TileId[] = [], finest = finestDepth(p);
  const visit = (t: TileId): void => {
    if (t.depth < finest) {
      faceDir(mid, t.face, coord(t.depth, t.ix, TILE_N / 2), coord(t.depth, t.iy, TILE_N / 2));
      add(toMid, p.center, scale(toMid, mid, surfaceRadius(p, mid)));
      if (len(sub(toMid, toMid, camPos)) < split * p.radius * Math.PI / 2 / 2 ** t.depth) {
        for (let k = 0; k < 4; k++) visit(child(t, k));
        return;
      }
    }
    out.push(t);
  };
  for (let face = 0; face < 6; face++) visit(root(face));
  return out;
}

/** What to draw for the wanted tiles while only some meshes exist (`has`). A wanted tile is drawn itself, or else by
 *  finer tiles, down to depth `finest`, that cover all of it. Where neither can be done, the nearest available
 *  ancestor is drawn once and nothing below it. With the six roots available the result covers every wanted face
 *  without holes or overlap. */
export function resolveDrawList(wanted: TileId[], has: (key: number) => boolean, finest: number): TileId[] {
  // true: a wanted tile; false: above one
  const tree = new Map<number, boolean>();
  for (const t of wanted) {
    tree.set(tileKey(t), true);
    for (let up = 1; up <= t.depth; up++) {
      const key = tileKey({ face: t.face, depth: t.depth - up, ix: t.ix >> up, iy: t.iy >> up });
      if (tree.has(key)) break;
      tree.set(key, false);
    }
  }

  const out: TileId[] = [];
  /** Covers all of `t` with finer tiles, or adds nothing and returns false. */
  const fill = (t: TileId): boolean => {
    if (t.depth >= finest) return false;
    const mark = out.length;
    for (let k = 0; k < 4; k++) {
      const c = child(t, k);
      if (has(tileKey(c))) out.push(c);
      else if (!fill(c)) { out.length = mark; return false; }
    }
    return true;
  };
  /** Covers what is wanted of `t`, or adds nothing and returns false. */
  const cover = (t: TileId, isWanted: boolean): boolean => {
    if (isWanted) {
      if (!has(tileKey(t))) return fill(t);
      out.push(t);
      return true;
    }
    const mark = out.length;
    for (let k = 0; k < 4; k++) {
      const c = child(t, k), below = tree.get(tileKey(c));
      if (below === undefined || cover(c, below)) continue;
      out.length = mark;
      if (!has(tileKey(t))) return false;
      out.push(t);
      return true;
    }
    return true;
  };
  for (let face = 0; face < 6; face++) {
    const t = root(face), isWanted = tree.get(tileKey(t));
    if (isWanted !== undefined) cover(t, isWanted);
  }
  return out;
}

const ROW = TILE_N + 1;
const GRID = ROW * ROW;
/** The border of the grid, once round counter-clockwise seen from outside: the top edge of the skirt. */
const RING: readonly number[] = [
  ...Array.from({ length: TILE_N }, (_, i) => i),
  ...Array.from({ length: TILE_N }, (_, j) => j * ROW + TILE_N),
  ...Array.from({ length: TILE_N }, (_, i) => TILE_N * ROW + TILE_N - i),
  ...Array.from({ length: TILE_N }, (_, j) => (TILE_N - j) * ROW),
];

/** Triangle list shared by all tiles: the surface, then the skirt. All are counter-clockwise seen from the side
 *  they face, which is outward: the surface away from the planet's centre, the skirt away from its tile. So from
 *  outside the planet back faces can be culled. */
export function tileIndices(): Uint16Array {
  const out: number[] = [];
  for (let j = 0; j < TILE_N; j++) {
    for (let i = 0; i < TILE_N; i++) {
      const a = j * ROW + i, b = a + 1, c = b + ROW, d = a + ROW;
      out.push(a, b, c, a, c, d);
    }
  }
  for (let k = 0; k < RING.length; k++) {
    const next = (k + 1) % RING.length;
    const a = RING[k], b = RING[next], footA = GRID + k, footB = GRID + next;
    out.push(a, footA, footB, a, footB, b);
  }
  return new Uint16Array(out);
}

// Half-width, in ground units, of the slope measurement behind a normal: about one cell at the finest depth.
const NORMAL_STEP = 5;
const tangent = v3(), bitangent = v3(), probe = v3(), slope = v3();
const X = v3(1, 0, 0), Y = v3(0, 1, 0);

/** Rise of the surface per radian along the unit tangent `t` at `dir`. */
function rise(p: Planet, dir: Vec3, t: Vec3): number {
  const step = NORMAL_STEP / p.radius;
  const ahead = surfaceRadius(p, norm(probe, addScaled(probe, dir, t, step)));
  return (ahead - surfaceRadius(p, norm(probe, addScaled(probe, dir, t, -step)))) / (2 * step);
}

/** Normal of the surface at radius `r` toward `dir`. It depends on nothing else, so tiles agree wherever they meet,
 *  whatever their face or depth. */
function surfaceNormal(out: Vec3, p: Planet, dir: Vec3, r: number): Vec3 {
  norm(tangent, cross(tangent, Math.abs(dir.y) < 0.9 ? Y : X, dir));
  cross(bitangent, dir, tangent);
  scale(slope, tangent, rise(p, dir, tangent));
  addScaled(slope, slope, bitangent, rise(p, dir, bitangent));
  return norm(out, addScaled(out, scale(out, dir, r), slope, -1));
}

function put(into: Float32Array, k: number, a: Vec3): void { into[3 * k] = a.x; into[3 * k + 1] = a.y; into[3 * k + 2] = a.z; }

export function buildTile(p: Planet, id: TileId): TileMesh {
  const count = GRID + RING.length;
  const pos = new Float32Array(3 * count), nrm = new Float32Array(3 * count), mat = new Uint8Array(count);
  const dir = v3(), at = v3(), n = v3();
  faceDir(dir, id.face, coord(id.depth, id.ix, TILE_N / 2), coord(id.depth, id.iy, TILE_N / 2));
  const middle = scale(v3(), dir, surfaceRadius(p, dir)); // from the planet's centre

  /* Skirt: a wall from the border straight down to one radius for all tiles. No surface, of any depth, goes lower
   * than the sag of the widest cell (a root's, pi / (2 TILE_N) radians) below sea level, and neighbours share the
   * vertical plane of their common edge, so the wall of the higher one closes any step. 1 unit spare for rounding. */
  const foot = p.radius * Math.cos(Math.PI / (4 * TILE_N)) - 1 - (p.kind === 'moon' ? p.relief : 0); // craters go below

  for (let j = 0; j <= TILE_N; j++) {
    for (let i = 0; i <= TILE_N; i++) {
      const k = j * ROW + i;
      faceDir(dir, id.face, coord(id.depth, id.ix, i), coord(id.depth, id.iy, j));
      const h = height(p, dir), dry = p.kind === 'moon', r = p.radius + (dry ? h : Math.max(0, h));
      put(pos, k, sub(at, scale(at, dir, r), middle));
      put(nrm, k, dry || h > 0 ? surfaceNormal(n, p, dir, r) : dir);
      mat[k] = material(p, dir, h);
    }
  }
  RING.forEach((top, k) => {
    faceDir(dir, id.face, coord(id.depth, id.ix, top % ROW), coord(id.depth, id.iy, Math.floor(top / ROW)));
    put(pos, GRID + k, sub(at, scale(at, dir, foot), middle));
    nrm.copyWithin(3 * (GRID + k), 3 * top, 3 * top + 3);
    mat[GRID + k] = mat[top];
  });
  return { key: tileKey(id), center: add(v3(), p.center, middle), pos, nrm, mat };
}
