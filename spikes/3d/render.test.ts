import { describe, expect, it } from 'vitest';
import { v3 } from './math';
import { type TileId, tileKey } from './tiles';
import { type HistoryKey, beyondHorizon, evictKeys, inView, keepsHistory, requestOrder } from './render';

describe('keepsHistory (stability history between frames)', () => {
  const key = (o: Partial<HistoryKey> = {}): HistoryKey =>
    ({ stab: 2, time: 10, planet: 'a', tiles: 3, view: [1, 2, 3, 0, 0, 0, 1], ...o });
  const moved = [1, 2, 5, 0, 0, 0, 1], turned = [1, 2, 3, 0, 0.1, 0, 0.995];

  it('has none on the first frame, which is also the first after a resize', () => {
    expect(keepsHistory(null, key())).toBe(false);
  });
  it('keeps it for a still frame and for the next frame of a flight', () => {
    expect(keepsHistory(key(), key())).toBe(true);
    expect(keepsHistory(key(), key({ time: 10 + 1 / 60, view: moved }))).toBe(true);
    expect(keepsHistory(key(), key({ time: 10 + 1 / 30, view: turned }))).toBe(true);
  });
  it('drops it on a mode change or another planet', () => {
    expect(keepsHistory(key({ stab: 1 }), key())).toBe(false);
    expect(keepsHistory(key(), key({ planet: 'b' }))).toBe(false);
  });
  it('drops it when the time jumps ahead or goes back', () => {
    expect(keepsHistory(key(), key({ time: 10.2 }))).toBe(false);
    expect(keepsHistory(key(), key({ time: 37 }))).toBe(false);
    expect(keepsHistory(key(), key({ time: 9.99 }))).toBe(false);
  });
  it('drops it when the tiles change under a still view, but not in flight', () => {
    expect(keepsHistory(key(), key({ tiles: 4 }))).toBe(false);
    expect(keepsHistory(key(), key({ tiles: 4, view: moved }))).toBe(true);
    expect(keepsHistory(key(), key({ tiles: 4, view: turned }))).toBe(true);
  });
});

describe('inView (view space, camera looks along -Z)', () => {
  const tanY = Math.tan(Math.PI / 6), aspect = 16 / 9, near = 0.5;
  it('keeps a sphere straight ahead', () => {
    expect(inView(v3(0, 0, -100), 1, tanY, aspect, near)).toBe(true);
  });
  it('drops a sphere behind the camera unless it reaches past the near plane', () => {
    expect(inView(v3(0, 0, 100), 1, tanY, aspect, near)).toBe(false);
    expect(inView(v3(0, 0, 5), 10, tanY, aspect, near)).toBe(true);
  });
  it('drops a sphere wholly outside a side plane and keeps one straddling it', () => {
    const edgeX = 100 * tanY * aspect; // x of the right plane at depth 100
    expect(inView(v3(edgeX + 50, 0, -100), 10, tanY, aspect, near)).toBe(false);
    expect(inView(v3(edgeX + 5, 0, -100), 10, tanY, aspect, near)).toBe(true);
    expect(inView(v3(0, -(100 * tanY + 50), -100), 10, tanY, aspect, near)).toBe(false);
    expect(inView(v3(0, 100 * tanY + 5, -100), 10, tanY, aspect, near)).toBe(true);
  });
});

describe('beyondHorizon (camera-relative positions)', () => {
  const R = 1000;
  const planet = v3(0, -1100, 0); // camera 100 above the sphere, which is below it
  it('hides a small sphere on the far side of the planet', () => {
    expect(beyondHorizon(v3(0, -2200, 0), 10, planet, R)).toBe(true);
  });
  it('keeps a sphere on the near side and one off to the side of the planet', () => {
    expect(beyondHorizon(v3(0, -95, 0), 10, planet, R)).toBe(false);
    expect(beyondHorizon(v3(3000, -1100, 0), 10, planet, R)).toBe(false);
  });
  it('keeps a sphere just past the horizon when it reaches above it', () => {
    // horizon plane sits R^2/D from the centre; a point a little beyond it, near the tangent cone's edge
    const D = 1100, hp = R * R / D, a = Math.asin(R / D);
    const beyond = v3(Math.sin(a) * 2000, -Math.cos(a) * 2000, 0); // along the tangent ray, well past the tangent point
    expect(beyondHorizon(beyond, 50, planet, R)).toBe(false);
    expect(hp).toBeLessThan(D);
  });
  it('never hides anything when the camera is inside the sphere', () => {
    expect(beyondHorizon(v3(0, -2000, 0), 1, v3(0, -500, 0), R)).toBe(false);
  });
});

const T = (face: number, depth: number, ix: number, iy: number): TileId => ({ face, depth, ix, iy });

describe('requestOrder', () => {
  const roots = new Set([0, 1, 2, 3, 4, 5].map(f => tileKey(T(f, 0, 0, 0))));
  it('asks for missing ancestors before the wanted tile, coarse first, without duplicates', () => {
    const wanted = [T(0, 3, 5, 2), T(0, 3, 4, 2)];
    const out = requestOrder(wanted, k => roots.has(k), () => false, () => 0, 100);
    expect(out.map(t => t.depth)).toEqual([1, 2, 3, 3]);
    expect(out[0]).toEqual(T(0, 1, 1, 0));
    expect(out[1]).toEqual(T(0, 2, 2, 1));
    expect(new Set(out.map(tileKey)).size).toBe(out.length);
  });
  it('skips what is cached or pending and stops at the limit', () => {
    const wanted = [T(2, 2, 1, 1), T(2, 2, 3, 3)];
    const cached = new Set([...roots, tileKey(T(2, 1, 0, 0))]);
    const pending = new Set([tileKey(T(2, 1, 1, 1))]);
    const out = requestOrder(wanted, k => cached.has(k), k => pending.has(k), () => 0, 100);
    expect(out).toEqual([T(2, 2, 1, 1), T(2, 2, 3, 3)]);
    expect(requestOrder(wanted, k => cached.has(k), k => pending.has(k), () => 0, 1)).toEqual([T(2, 2, 1, 1)]);
  });
  it('orders tiles of one depth nearest first', () => {
    const wanted = [T(1, 1, 0, 0), T(1, 1, 1, 0), T(1, 1, 0, 1)];
    const dist = (t: TileId): number => [5, 1, 3][t.ix + 2 * t.iy];
    const out = requestOrder(wanted, k => roots.has(k), () => false, dist, 100);
    expect(out).toEqual([T(1, 1, 1, 0), T(1, 1, 0, 1), T(1, 1, 0, 0)]);
  });
});

describe('evictKeys', () => {
  it('evicts the least recently used unprotected entries until the cache fits', () => {
    const entries = [
      { key: 1, last: 5 }, { key: 2, last: 1 }, { key: 3, last: 9 }, { key: 4, last: 0 }, { key: 5, last: 3 },
    ];
    expect(evictKeys(entries, new Set([4]), 3)).toEqual([2, 5]);
  });
  it('evicts nothing when under the bound, and never a protected entry', () => {
    const entries = [{ key: 1, last: 0 }, { key: 2, last: 0 }];
    expect(evictKeys(entries, new Set(), 2)).toEqual([]);
    expect(evictKeys(entries, new Set([1, 2]), 0)).toEqual([]);
  });
});
