import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Rng } from '../../src/core/util';
import { type Vec3, add, addScaled, cross, dot, len, norm, sub, v3 } from './math';
import { type Planet, height, makePlanet, material, surfaceRadius } from './planet';
import { SCALE } from './scale';
import {
  MAX_DEPTH, TILE_N, type TileId, type TileMesh, buildTile, faceDir, resolveDrawList, selectTiles, tileIndices, tileKey,
} from './tiles';
import type { TileRequest } from './worker';

vi.mock('./planet', async (original) => {
  const real = await original<typeof import('./planet')>();
  return { ...real, makePlanet: vi.fn(real.makePlanet) };
});

const N = TILE_N, ROW = N + 1, GRID = ROW * ROW;
const p = makePlanet(1);
const FACES = [0, 1, 2, 3, 4, 5];
const ROOTS: TileId[] = FACES.map(face => ({ face, depth: 0, ix: 0, iy: 0 }));

const children = (t: TileId): TileId[] => [0, 1, 2, 3].map(k =>
  ({ face: t.face, depth: t.depth + 1, ix: t.ix * 2 + (k & 1), iy: t.iy * 2 + (k >> 1) }));
const ancestor = (t: TileId, depth: number): TileId =>
  ({ face: t.face, depth, ix: t.ix >> (t.depth - depth), iy: t.iy >> (t.depth - depth) });
/** Strictly: a lies above b in the same quadtree. */
const above = (a: TileId, b: TileId): boolean => a.depth < b.depth && tileKey(ancestor(b, a.depth)) === tileKey(a);
const anyAncestorPair = (sel: TileId[]): boolean => sel.some(a => sel.some(b => above(a, b)));
const area = (sel: TileId[]): number => sel.reduce((s, t) => s + 4 ** -t.depth, 0);
const allAt = (depth: number): TileId[] => depth === 0 ? ROOTS : allAt(depth - 1).flatMap(children);

function randomDir(r: Rng): Vec3 {
  const y = r.range(-1, 1), a = r.range(0, 2 * Math.PI), s = Math.sqrt(1 - y * y);
  return v3(s * Math.cos(a), y, s * Math.sin(a));
}
function randomTile(r: Rng, depth: number): TileId {
  const side = 2 ** depth;
  return { face: Math.floor(r.range(0, 6)), depth, ix: Math.floor(r.range(0, side)), iy: Math.floor(r.range(0, side)) };
}
/** Whether the direction falls inside the tile, found by searching the tile's own corners and edges. */
function contains(t: TileId, d: Vec3): boolean {
  // the face axes, read back from faceDir so that the test does not repeat the table
  const n = faceDir(v3(), t.face, 0, 0), right = faceDir(v3(), t.face, 1, 0), up = faceDir(v3(), t.face, 0, 1);
  norm(right, addScaled(right, right, n, -dot(right, n)));
  norm(up, addScaled(up, up, n, -dot(up, n)));
  const w = dot(d, n);
  if (w <= 0) return false;
  const u = Math.atan(dot(d, right) / w) * 4 / Math.PI, v = Math.atan(dot(d, up) / w) * 4 / Math.PI;
  const side = 2 ** t.depth, x = (u + 1) / 2 * side, y = (v + 1) / 2 * side;
  return x >= t.ix && x <= t.ix + 1 && y >= t.iy && y <= t.iy + 1;
}
const tileUnder = (sel: TileId[], d: Vec3): TileId => sel.find(t => contains(t, d))!;
const atAltitude = (pl: Planet, d: Vec3, h: number): Vec3 => addScaled(v3(), pl.center, d, surfaceRadius(pl, d) + h);

/** Vertex k in world space. */
const world = (m: TileMesh, k: number): Vec3 => add(v3(), m.center, v3(m.pos[3 * k], m.pos[3 * k + 1], m.pos[3 * k + 2]));
const normal = (m: TileMesh, k: number): Vec3 => v3(m.nrm[3 * k], m.nrm[3 * k + 1], m.nrm[3 * k + 2]);
const dist = (a: Vec3, b: Vec3): number => len(sub(v3(), a, b));
const BORDER: number[] = [];
for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) if (i === 0 || j === 0 || i === N || j === N) BORDER.push(j * ROW + i);

function triangles(): [number, number, number][] {
  const ix = tileIndices(), out: [number, number, number][] = [];
  for (let k = 0; k < ix.length; k += 3) out.push([ix[k], ix[k + 1], ix[k + 2]]);
  return out;
}
const SURFACE = triangles().filter(t => t.every(k => k < GRID));
const SKIRT = triangles().filter(t => t.some(k => k >= GRID));

describe('cube sphere', () => {
  it('gives unit directions, one face centre on each axis', () => {
    const centres = FACES.map(f => faceDir(v3(), f, 0, 0));
    for (const c of centres) expect(Math.abs(c.x) + Math.abs(c.y) + Math.abs(c.z)).toBe(1);
    expect(new Set(centres.map(c => `${c.x},${c.y},${c.z}`)).size).toBe(6);
    const r = new Rng(3);
    for (let i = 0; i < 100; i++) expect(len(faceDir(v3(), i % 6, r.range(-1, 1), r.range(-1, 1)))).toBeCloseTo(1, 12);
  });

  it('is tangent-warped: equal steps along a midline are equal angles', () => {
    for (const f of FACES) {
      const c = faceDir(v3(), f, 0, 0);
      for (const u of [0.25, 0.5, 1]) {
        expect(Math.acos(dot(c, faceDir(v3(), f, u, 0)))).toBeCloseTo(u * Math.PI / 4, 12);
        expect(Math.acos(dot(c, faceDir(v3(), f, 0, -u)))).toBeCloseTo(u * Math.PI / 4, 12);
      }
    }
  });

  it('gives every tile its own key', () => {
    const tiles = [0, 1, 2, 3, 4].flatMap(allAt);
    tiles.push({ face: 5, depth: 7, ix: 127, iy: 0 }, { face: 5, depth: 7, ix: 0, iy: 127 }, { face: 5, depth: 7, ix: 127, iy: 127 });
    const keys = tiles.map(tileKey);
    expect(new Set(keys).size).toBe(tiles.length);
    expect(keys.every(Number.isSafeInteger)).toBe(true);
  });
});

describe('tile selection', () => {
  const r = new Rng(11);
  // face centres, a cube edge, a cube corner, and random places
  const subs = [...FACES.map(f => faceDir(v3(), f, 0, 0)), faceDir(v3(), 4, 1, 0.3), faceDir(v3(), 0, 1, 1),
    ...Array.from({ length: 30 }, () => randomDir(r))];

  it('is the six roots from far away', () => {
    expect(selectTiles(p, addScaled(v3(), p.center, subs[7], 100 * p.radius))).toHaveLength(6);
  });

  it('reaches full depth under a low camera', () => {
    for (const d of subs) expect(tileUnder(selectTiles(p, atAltitude(p, d, 20)), d).depth).toBe(MAX_DEPTH);
  });

  it('covers the sphere exactly once at every height', () => {
    for (const h of [0, 20, 500, 2000, 20000]) {
      const sel = selectTiles(p, atAltitude(p, subs[8], h));
      expect(area(sel)).toBeCloseTo(6);
      expect(anyAncestorPair(sel)).toBe(false);
      expect(new Set(sel.map(tileKey)).size).toBe(sel.length);
    }
  });

  it('follows the planet centre', () => {
    const moved = makePlanet(1);
    moved.center = v3(50000, -20000, 9000);
    expect(selectTiles(moved, atAltitude(moved, subs[9], 20))).toEqual(selectTiles(p, atAltitude(p, subs[9], 20)));
  });

  it('splits more with a larger split distance', () => {
    const cam = atAltitude(p, subs[9], 500);
    expect(selectTiles(p, cam, 3).length).toBeGreaterThan(selectTiles(p, cam).length);
    expect(selectTiles(p, cam, 0)).toHaveLength(6);
  });
});

describe('tile mesh', () => {
  it('has a grid and a skirt ring of vertices, indexed in range', () => {
    const m = buildTile(p, { face: 2, depth: 3, ix: 4, iy: 1 }), count = GRID + 4 * N;
    expect(m.key).toBe(tileKey({ face: 2, depth: 3, ix: 4, iy: 1 }));
    expect(m.pos).toBeInstanceOf(Float32Array);
    expect(m.pos).toHaveLength(3 * count);
    expect(m.nrm).toHaveLength(3 * count);
    expect(m.mat).toBeInstanceOf(Uint8Array);
    expect(m.mat).toHaveLength(count);
    expect(tileIndices()).toBeInstanceOf(Uint16Array);
    expect(SURFACE).toHaveLength(2 * N * N);
    expect(SKIRT).toHaveLength(8 * N);
    expect(Math.max(...tileIndices())).toBe(count - 1);
    expect(new Set(tileIndices()).size).toBe(count);
  });

  it('puts the vertices on the surface, relative to a centre inside the tile', () => {
    const moved = makePlanet(1);
    moved.center = v3(250000, -100000, 40000);
    const r = new Rng(5);
    for (let t = 0; t < 20; t++) {
      const id = randomTile(r, MAX_DEPTH), m = buildTile(moved, id);
      expect(contains(id, norm(v3(), sub(v3(), m.center, moved.center)))).toBe(true);
      expect(Math.max(...m.pos.map(Math.abs))).toBeLessThan(2 * moved.radius * Math.PI / 2 / 2 ** MAX_DEPTH + moved.relief);
      for (let k = 0; k < GRID; k++) {
        const rel = sub(v3(), world(m, k), moved.center), d = norm(v3(), rel);
        expect(len(rel)).toBeCloseTo(surfaceRadius(moved, d), 3);
      }
    }
  });

  it('gives each vertex the material under it', () => {
    const r = new Rng(6), seen = new Set<number>();
    for (let t = 0; t < 40; t++) {
      const m = buildTile(p, randomTile(r, 2));
      for (let k = 0; k < GRID; k++) {
        const d = norm(v3(), sub(v3(), world(m, k), p.center)), h = height(p, d);
        if (Math.abs(h) < 0.01 || Math.abs(Math.abs(d.y) - 0.86) < 1e-4) continue; // on a boundary, where rounding decides
        expect(m.mat[k]).toBe(material(p, d, h));
        seen.add(m.mat[k]);
      }
    }
    expect(seen.size).toBe(3); // water, land and ice were all checked
  });

  it('stays within 3 units of the collision surface between vertices at full depth', () => {
    const r = new Rng(7);
    let maxError = 0;
    for (let i = 0; i < 200; i++) {
      const m = buildTile(p, randomTile(r, MAX_DEPTH));
      const tri = SURFACE[Math.floor(r.range(0, SURFACE.length))];
      let a = r.next(), b = r.next();
      if (a + b > 1) { a = 1 - a; b = 1 - b; }
      const point = world(m, tri[0]);
      addScaled(point, point, sub(v3(), world(m, tri[1]), world(m, tri[0])), a);
      addScaled(point, point, sub(v3(), world(m, tri[2]), world(m, tri[0])), b);
      const rel = sub(v3(), point, p.center);
      maxError = Math.max(maxError, Math.abs(len(rel) - surfaceRadius(p, norm(v3(), rel))));
    }
    expect(maxError).toBeGreaterThan(0);
    expect(maxError).toBeLessThanOrEqual(3);
  });

  it('winds every surface triangle counter-clockwise seen from outside, on all six faces', () => {
    for (const id of [...ROOTS, ...FACES.map(face => ({ face, depth: MAX_DEPTH, ix: 13, iy: 50 }))]) {
      const m = buildTile(p, id);
      for (const [a, b, c] of SURFACE) {
        const A = world(m, a), face = cross(v3(), sub(v3(), world(m, b), A), sub(v3(), world(m, c), A));
        expect(dot(face, sub(v3(), A, p.center))).toBeGreaterThan(0);
      }
    }
  });

  it('winds every skirt triangle to face away from its tile, on all six faces', () => {
    for (const id of [...ROOTS, ...FACES.map(face => ({ face, depth: MAX_DEPTH, ix: 13, iy: 50 }))]) {
      const m = buildTile(p, id), middle = world(m, (N / 2) * ROW + N / 2);
      for (const [a, b, c] of SKIRT) {
        const A = world(m, a), B = world(m, b), C = world(m, c);
        const face = cross(v3(), sub(v3(), B, A), sub(v3(), C, A));
        const mean = add(v3(), add(v3(), A, B), C);
        addScaled(mean, v3(), mean, 1 / 3);
        expect(len(face)).toBeGreaterThan(0);
        expect(dot(face, sub(v3(), mean, middle))).toBeGreaterThan(0);
      }
    }
  });
});

describe('tile seams', () => {
  /** Border vertices of the tiles that have no vertex of another tile within 0.01, and the worst normal mismatch. */
  function seams(tiles: TileId[]): { maxEdgeGap: number; maxNormalGap: number } {
    const verts = tiles.flatMap((id, t) => {
      const m = buildTile(p, id);
      return BORDER.map(k => ({ t, at: world(m, k), n: normal(m, k) }));
    });
    let maxEdgeGap = 0, maxNormalGap = 0;
    for (const a of verts) {
      let nearest = Infinity;
      for (const b of verts) {
        if (a.t === b.t) continue;
        const d = dist(a.at, b.at);
        nearest = Math.min(nearest, d);
        if (d < 0.01) maxNormalGap = Math.max(maxNormalGap, dist(a.n, b.n));
      }
      maxEdgeGap = Math.max(maxEdgeGap, nearest);
    }
    return { maxEdgeGap, maxNormalGap };
  }

  it('same-depth neighbours meet, with equal normals, on all faces and across all cube edges', () => {
    const { maxEdgeGap, maxNormalGap } = seams(allAt(1));
    expect(maxEdgeGap).toBeLessThan(0.01);
    expect(maxNormalGap).toBeLessThan(1e-4);
  });

  it('neighbours at full depth meet, within a face and across a cube edge', () => {
    const last = 2 ** MAX_DEPTH - 1;
    // face 4's right edge is face 0's left edge, at the same v; face 0's top edge is face 2's right edge
    const pairs: [TileId, TileId][] = [
      [{ face: 4, depth: MAX_DEPTH, ix: 20, iy: 31 }, { face: 4, depth: MAX_DEPTH, ix: 21, iy: 31 }],
      [{ face: 4, depth: MAX_DEPTH, ix: last, iy: 9 }, { face: 0, depth: MAX_DEPTH, ix: 0, iy: 9 }],
      [{ face: 0, depth: MAX_DEPTH, ix: 40, iy: last }, { face: 2, depth: MAX_DEPTH, ix: last, iy: 40 }],
    ];
    for (const [a, b] of pairs) {
      const A = buildTile(p, a), B = buildTile(p, b);
      const shared = BORDER.flatMap(i => BORDER.filter(j => dist(world(A, i), world(B, j)) < 0.01).map(j => [i, j]));
      expect(shared).toHaveLength(ROW);
      for (const [i, j] of shared) expect(dist(normal(A, i), normal(B, j))).toBeLessThan(1e-4);
    }
  });

  it('a coarse tile and a finer neighbour agree at the vertices they share', () => {
    const coarse = buildTile(p, { face: 4, depth: 2, ix: 3, iy: 1 });
    const fine = buildTile(p, { face: 0, depth: 4, ix: 0, iy: 5 });
    const shared = BORDER.flatMap(i => BORDER.filter(j => dist(world(coarse, i), world(fine, j)) < 0.01).map(j => [i, j]));
    expect(shared).toHaveLength(N / 4 + 1);
    for (const [i, j] of shared) expect(dist(normal(coarse, i), normal(fine, j))).toBeLessThan(1e-4);
  });
});

describe('tile normals', () => {
  it('are unit length, radial over water and close to the slope of the mesh on land', () => {
    const r = new Rng(8);
    let land = 0, water = 0, tilted = 0;
    for (let t = 0; t < 40; t++) {
      const m = buildTile(p, randomTile(r, MAX_DEPTH));
      for (let j = 1; j < N; j++) for (let i = 1; i < N; i++) {
        const k = j * ROW + i, n = normal(m, k), d = norm(v3(), sub(v3(), world(m, k), p.center));
        expect(len(n)).toBeCloseTo(1, 5);
        if (height(p, d) < -0.01) { water++; expect(dot(n, d)).toBeCloseTo(1, 6); continue; }
        land++;
        const mesh = cross(v3(), sub(v3(), world(m, k + 1), world(m, k - 1)), sub(v3(), world(m, k + ROW), world(m, k - ROW)));
        expect(dot(n, norm(mesh, mesh))).toBeGreaterThan(0.97);
        if (dot(n, d) < 0.99) tilted++;
      }
    }
    expect(water).toBeGreaterThan(0);
    expect(land).toBeGreaterThan(0);
    expect(tilted).toBeGreaterThan(0); // the slopes are real: radial normals everywhere would not do
  });
});

describe('tile skirts', () => {
  const rel = (m: TileMesh, k: number): Vec3 => sub(v3(), world(m, k), p.center);
  /** Distance from the planet centre to the nearest point of the segment a-b (both relative to it). */
  function nearest(a: Vec3, b: Vec3): number {
    const ab = sub(v3(), b, a), t = Math.min(1, Math.max(0, -dot(a, ab) / dot(ab, ab)));
    return len(addScaled(v3(), a, ab, t));
  }

  it('hang straight toward the planet centre from the border vertices', () => {
    const m = buildTile(p, { face: 1, depth: 3, ix: 2, iy: 5 });
    const under = new Set<number>();
    for (let k = GRID; k < GRID + 4 * N; k++) {
      const d = norm(v3(), rel(m, k));
      const top = BORDER.find(b => dist(norm(v3(), rel(m, b)), d) < 1e-6)!;
      expect(top).toBeDefined();
      under.add(top);
      expect(len(rel(m, k))).toBeLessThan(len(rel(m, top)));
      expect(dist(normal(m, k), normal(m, top))).toBe(0);
      expect(m.mat[k]).toBe(m.mat[top]);
    }
    expect(under.size).toBe(4 * N);
  });

  it('reach below the edge of every tile of every depth, so no step between depths shows through', () => {
    const r = new Rng(9);
    const ids = [...ROOTS, ...allAt(1)];
    for (let d = 2; d <= MAX_DEPTH; d++) for (let i = 0; i < 20; i++) ids.push(randomTile(r, d));
    let lowestEdge = Infinity, highestSkirtFoot = 0;
    for (const id of ids) {
      const m = buildTile(p, id);
      for (const a of BORDER) for (const b of BORDER) {
        const along = Math.abs(a - b);
        const neighbours = (along === 1 && Math.floor(a / ROW) === Math.floor(b / ROW) && (a < ROW || a >= GRID - ROW))
          || (along === ROW && (a % ROW === 0 || a % ROW === N));
        if (neighbours) lowestEdge = Math.min(lowestEdge, nearest(rel(m, a), rel(m, b)));
      }
      for (let k = GRID; k < GRID + 4 * N; k++) highestSkirtFoot = Math.max(highestSkirtFoot, len(rel(m, k)));
    }
    expect(highestSkirtFoot).toBeLessThanOrEqual(lowestEdge);
    expect(highestSkirtFoot).toBeGreaterThan(p.radius - 0.01 * p.radius); // and no deeper than needed
  });
});

describe('draw list', () => {
  const parent: TileId = { face: 3, depth: 2, ix: 1, iy: 2 };
  const kids = children(parent);
  const having = (tiles: TileId[]): ((key: number) => boolean) => {
    const keys = new Set(tiles.map(tileKey));
    return key => keys.has(key);
  };

  it('draws the parent once while one child is missing', () => {
    expect(resolveDrawList(kids, having([ROOTS[3], parent, kids[0], kids[1], kids[3]]))).toEqual([parent]);
  });

  it('draws the children when all are there', () => {
    expect(resolveDrawList(kids, having([ROOTS[3], parent, ...kids]))).toEqual(kids);
  });

  it('falls back to the nearest available ancestor', () => {
    expect(resolveDrawList(kids, having([ROOTS[3], ancestor(parent, 1)]))).toEqual([ancestor(parent, 1)]);
    expect(resolveDrawList(kids, having([ROOTS[3]]))).toEqual([ROOTS[3]]);
  });

  it('draws finer tiles in place of a wanted tile that is missing, if they cover all of it', () => {
    const [a, b, c, d] = kids;
    expect(resolveDrawList([parent], having([ROOTS[3], ...kids]))).toEqual(kids);
    expect(resolveDrawList([parent], having([ROOTS[3], a, b, c, ...children(d)]))).toEqual([a, b, c, ...children(d)]);
    expect(resolveDrawList([parent], having([ROOTS[3], a, b, c, ...children(d).slice(1)]))).toEqual([ROOTS[3]]);
  });

  it('keeps a finished quadrant when its neighbour falls back', () => {
    const wanted = [...children(kids[0]), kids[1], kids[2], kids[3]];
    const has = having([ROOTS[3], parent, kids[0], kids[1], kids[2], kids[3], ...children(kids[0]).slice(1)]);
    expect(resolveDrawList(wanted, has)).toEqual([kids[0], kids[1], kids[2], kids[3]]);
  });

  it('never overlaps or leaves a hole, whatever is wanted and available', () => {
    const r = new Rng(21);
    const partition = (t: TileId, chance: number): TileId[] =>
      t.depth < MAX_DEPTH && r.next() < chance ? children(t).flatMap(c => partition(c, chance * 0.8)) : [t];
    for (let round = 0; round < 400; round++) {
      const wanted = ROOTS.flatMap(t => partition(t, r.range(0.2, 0.9)));
      const share = r.next(), memo = new Map<number, boolean>();
      const has = (key: number): boolean => {
        if (ROOTS.some(t => tileKey(t) === key)) return true;
        if (!memo.has(key)) memo.set(key, r.next() < share);
        return memo.get(key)!;
      };
      const drawn = resolveDrawList(wanted, has);

      // no hole and no overlap: no tile twice or inside another, and together the area of the whole sphere
      const keys = new Set(drawn.map(tileKey));
      expect(keys.size).toBe(drawn.length);
      expect(drawn.some(t => Array.from({ length: t.depth }, (_, d) => ancestor(t, d)).some(a => keys.has(tileKey(a))))).toBe(false);
      expect(area(drawn)).toBeCloseTo(6, 9);

      const wantedKeys = new Set(wanted.map(tileKey));
      const covered = (t: TileId): boolean => has(tileKey(t)) || (t.depth < MAX_DEPTH && children(t).every(covered));
      for (const t of drawn) {
        expect(has(tileKey(t))).toBe(true);
        if (wantedKeys.has(tileKey(t))) continue;
        const coarseWanted = wanted.find(w => above(w, t));
        if (coarseWanted) { expect(has(tileKey(coarseWanted))).toBe(false); continue; } // finer than wanted
        // coarser than wanted: something wanted below it cannot be drawn, by itself or by anything between
        expect(wanted.some(w => above(t, w) && !covered(w)
          && Array.from({ length: w.depth - t.depth - 1 }, (_, i) => ancestor(w, t.depth + 1 + i)).every(a => !has(tileKey(a))))).toBe(true);
      }
    }
  });

  it('is the wanted list itself when everything is there', () => {
    const wanted = selectTiles(p, atAltitude(p, faceDir(v3(), 0, 0.2, 0.4), 20));
    expect(resolveDrawList(wanted, () => true)).toEqual(wanted);
  });
});

describe('tile worker', () => {
  const saved = { ...SCALE };
  interface Sent { mesh: TileMesh; transfer: Transferable[] }
  const sent: Sent[] = [];
  const scope = {
    onmessage: null as null | ((e: { data: TileRequest }) => void),
    postMessage: (mesh: TileMesh, o: { transfer: Transferable[] }) => { sent.push({ mesh, transfer: o.transfer }); },
  };
  // loaded once, with the same module instances as this file: the worker writes the SCALE seen here
  beforeAll(async () => {
    vi.stubGlobal('self', scope);
    await import('./worker');
    vi.unstubAllGlobals();
  });
  afterEach(() => { Object.assign(SCALE, saved); });

  /** Delivers a request as a page would, with `self` standing for the worker's scope, and returns the reply. */
  function send(msg: TileRequest): Sent {
    vi.stubGlobal('self', scope);
    scope.onmessage!({ data: structuredClone(msg) });
    vi.unstubAllGlobals();
    return sent.pop()!;
  }
  const id: TileId = { face: 4, depth: 3, ix: 2, iy: 6 };

  it('builds with the page scale, so that the mesh agrees with collision', () => {
    const scale = { ...SCALE, radiusK: 90, reliefFrac: 0.05 };
    const { mesh, transfer } = send({ seed: 3, radius2d: 30, scale, id });
    Object.assign(SCALE, scale);
    expect(mesh).toEqual(buildTile(makePlanet(3, 30), id));
    expect(transfer).toEqual([mesh.pos.buffer, mesh.nrm.buffer, mesh.mat.buffer]);
  });

  it('makes the planet again only when the request describes another one', () => {
    vi.mocked(makePlanet).mockClear();
    const msg: TileRequest = { seed: 1, radius2d: 46, scale: { ...SCALE }, id };
    send(msg);
    send({ ...msg, id: { ...id, ix: 3 } });
    expect(makePlanet).toHaveBeenCalledTimes(1);
    send({ ...msg, seed: 2 });
    send({ ...msg, seed: 2, radius2d: 20 });
    const wider = send({ ...msg, seed: 2, radius2d: 20, scale: { ...SCALE, radiusK: 300 } });
    expect(makePlanet).toHaveBeenCalledTimes(4);
    expect(len(wider.mesh.center)).toBeGreaterThan(5000);
  });
});
