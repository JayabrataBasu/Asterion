import { describe, expect, it } from 'vitest';
import { DT } from '../../src/sim/sim';
import { CHASE } from './camera';
import { SHIP_R, newShip } from './flight';
import { cloudAltitude, crushRadius } from './gas';
import { type Vec3, dot, len, norm, qRotate, sub, v3 } from './math';
import { PATH_SECONDS, type PathPose, pathFocus, pose } from './path';
import { altitude, makePlanet } from './planet';
import { makeScene } from './scene';
import { SUN } from './shaders';
import { makeWorld } from './world';

const sun = norm(v3(), v3(...SUN));
const finitePose = (p: PathPose): boolean =>
  [p.camPos, p.camQ, p.shipPos, p.shipQ].flatMap(o => Object.values(o as Vec3)).every(Number.isFinite);
/** Every frame of the path, 1/60 s apart. */
const frames = (f: (t: number) => PathPose): PathPose[] =>
  Array.from({ length: Math.round(PATH_SECONDS / DT) + 1 }, (_, i) => f(i * DT));
const turned = (a: PathPose, b: PathPose): number => {
  const d = Math.abs(a.shipQ.x * b.shipQ.x + a.shipQ.y * b.shipQ.y + a.shipQ.z * b.shipQ.z + a.shipQ.w * b.shipQ.w);
  return 2 * Math.acos(Math.min(1, d)) * 180 / Math.PI;
};

describe('the default scene', () => {
  const scene = makeScene(makeWorld(null)), p = makePlanet(1);
  it('is the scripted path and focus as before', () => {
    expect(scene.focus).toEqual(pathFocus(p));
    for (const t of [0, 7.5, 33, 60]) expect(scene.pose(t)).toEqual(pose(t, p));
    expect(scene.start).toBeUndefined();
  });
});

describe('the gas giant scene', () => {
  const world = makeWorld('gas'), scene = makeScene(world), p = world.planet;
  const all = frames(t => scene.pose(t));
  const heights = all.map(f => cloudAltitude(p, f.shipPos));

  it('starts over the day side', () => {
    expect(dot(scene.focus, sun)).toBeGreaterThan(0.3);
    expect(len(scene.focus)).toBeCloseTo(1);
  });

  it('flies from orbit into the clouds, below the cloud tops but above the crush depth, and climbs out', () => {
    expect(heights[0]).toBeCloseTo(20000, -2);
    expect(all[0].phase).toBe('approach');
    const low = heights.filter((_, i) => all[i].phase === 'low');
    expect(Math.min(...low)).toBeLessThan(-150);
    expect(Math.min(...heights)).toBeGreaterThan(crushRadius(p) - p.radius + 50);
    expect(heights[heights.length - 1]).toBeGreaterThan(800);
    for (const f of all) expect(altitude(p, f.camPos)).toBeGreaterThan(SHIP_R);
  });

  it('moves and turns smoothly, with the camera behind', () => {
    for (let i = 0; i < all.length; i++) {
      expect(finitePose(all[i])).toBe(true);
      const off = sub(v3(), all[i].camPos, all[i].shipPos);
      expect(len(off)).toBeCloseTo(len(CHASE), 6);
      expect(dot(off, qRotate(v3(), all[i].shipQ, v3(0, 0, 1)))).toBeGreaterThan(0);
      if (i === 0) continue;
      expect(turned(all[i - 1], all[i])).toBeLessThan(2);
      if (all[i].phase !== 'approach') expect(len(sub(v3(), all[i].shipPos, all[i - 1].shipPos))).toBeLessThan(8);
    }
  });

  it('has named views for stills', () => {
    for (const name of ['far', 'mid', 'close']) {
      const v = scene.view(name)!;
      expect(finitePose(v)).toBe(true);
      expect(altitude(p, v.camPos)).toBeGreaterThan(SHIP_R);
    }
    expect(scene.view('nonsense')).toBeNull();
    const s = newShip();
    expect(s.pos).toEqual(v3());
  });
});
