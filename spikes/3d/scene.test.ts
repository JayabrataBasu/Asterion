import { describe, expect, it } from 'vitest';
import { DT } from '../../src/sim/sim';
import { CHASE } from './camera';
import { SHIP_R, newShip } from './flight';
import { cloudAltitude, crushRadius } from './gas';
import { type Vec3, dot, len, norm, qRotate, scale, sub, v3 } from './math';
import { PATH_SECONDS, type PathPose, pathFocus, pose } from './path';
import { altitude, makePlanet } from './planet';
import { moonPosition } from './moon';
import { CELL, newRingRock } from './ring';
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
      const v = scene.view(name, 0)!;
      expect(finitePose(v)).toBe(true);
      expect(altitude(p, v.camPos)).toBeGreaterThan(SHIP_R);
    }
    expect(scene.view('nonsense', 0)).toBeNull();
    const s = newShip();
    expect(s.pos).toEqual(v3());
  });
});

describe('the moon scene', () => {
  const world = makeWorld('moon'), scene = makeScene(world), p = world.planet, moon = world.moon!;
  const centre = (t: number): Vec3 => moonPosition(v3(), p, t);
  const all = frames(t => scene.pose(t));
  const over = all.map((f, i) => altitude({ ...moon.body, center: centre(i * DT) }, f.shipPos));

  it('flies a path round the moving moon: approach, descent, low over the craters, climb', () => {
    expect(over[0]).toBeGreaterThan(14000);
    const low = over.filter((_, i) => all[i].phase === 'low');
    expect(Math.max(...low)).toBeLessThan(300);
    expect(Math.min(...over)).toBeGreaterThan(SHIP_R + 20);
    expect(over[over.length - 1]).toBeGreaterThan(700);
    for (let i = 0; i < all.length; i++) {
      expect(finitePose(all[i])).toBe(true);
      expect(altitude({ ...moon.body, center: centre(i * DT) }, all[i].camPos)).toBeGreaterThan(SHIP_R);
      if (i === 0) continue;
      expect(turned(all[i - 1], all[i])).toBeLessThan(2);
      const rel = (k: number): Vec3 => sub(v3(), all[k].shipPos, centre(k * DT));
      if (all[i].phase !== 'approach') expect(len(sub(v3(), rel(i), rel(i - 1)))).toBeLessThan(8);
    }
  });

  it('starts free flight carried with the moon, nose to it, on its day side, with the planet beside it', () => {
    const s = newShip();
    scene.start!(s);
    const toMoon = sub(v3(), moon.body.center, s.pos), toPlanet = sub(v3(), p.center, s.pos);
    expect(len(toMoon)).toBeLessThan(2 * moon.body.radius);
    expect(len(toMoon)).toBeGreaterThan(1.8 * moon.body.radius);
    const nose = qRotate(v3(), s.q, v3(0, 0, -1));
    expect(dot(nose, norm(v3(), toMoon))).toBeCloseTo(1, 6);
    expect(Math.acos(dot(nose, norm(v3(), toPlanet))) * 180 / Math.PI).toBeLessThan(45);
    expect(dot(norm(v3(), scale(v3(), toMoon, -1)), sun)).toBeGreaterThan(0.4);
    expect(len(s.vel)).toBe(0);
    expect(s.prevPos).toEqual(s.pos);
  });

  it('has named views that follow the moon in time', () => {
    for (const name of ['far', 'mid', 'close', 'ground', 'behind', 'front']) {
      for (const t of [0, 100]) {
        const view = scene.view(name, t)!;
        expect(finitePose(view)).toBe(true);
        expect(altitude({ ...moon.body, center: centre(t) }, view.camPos)).toBeGreaterThan(SHIP_R);
        expect(altitude(p, view.camPos)).toBeGreaterThan(SHIP_R);
      }
    }
    const far = scene.view('far', 0)!, later = scene.view('far', 100)!;
    expect(len(sub(v3(), far.shipPos, centre(0)))).toBeCloseTo(len(sub(v3(), later.shipPos, centre(100))), 3);
  });
});

describe('the ring scene', () => {
  const world = makeWorld('ring'), scene = makeScene(world), p = world.planet, ring = world.ring!;
  const all = frames(t => scene.pose(t));
  const local = (q: Vec3): Vec3 => ring.toLocal(v3(), q);

  /** The distance from `q` to the nearest rock's surface. */
  const clearance = (q: Vec3): number => {
    const l = local(q), rock = newRingRock();
    let best = Infinity;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (let k = 0; k < 2; k++) {
          if (!ring.rockAt(Math.floor(l.x / CELL) + i, Math.floor(l.y / CELL) + j, k, rock)) continue;
          best = Math.min(best, Math.hypot(l.x - rock.u, l.y - rock.v, l.z - rock.h) - rock.r);
        }
      }
    }
    return best;
  };

  it('flies a path from afar into the field and out: approach, descent, low among the rocks, climb', () => {
    expect(len(sub(v3(), all[0].shipPos, p.center))).toBeGreaterThan(2 * ring.outer);
    const low = all.filter(f => f.phase === 'low').map(f => local(f.shipPos));
    expect(Math.max(...low.map(l => Math.abs(l.z)))).toBeLessThanOrEqual(66);
    expect(low.filter(l => Math.abs(l.z) < 5).length).toBeGreaterThan(low.length / 4);
    for (const l of low) expect(ring.density(Math.hypot(l.x, l.y))).toBeGreaterThan(0.5);
    expect(local(all[all.length - 1].shipPos).z).toBeGreaterThan(500);
    const near = low.length > 0 ? all.filter(f => f.phase === 'low' && clearance(f.shipPos) < 40).length : 0;
    expect(near).toBeGreaterThan(100);
  });

  it('never touches a rock, with ship or camera, and moves smoothly', () => {
    for (let i = 0; i < all.length; i++) {
      expect(finitePose(all[i])).toBe(true);
      expect(clearance(all[i].shipPos)).toBeGreaterThanOrEqual(SHIP_R - 0.01);
      expect(clearance(all[i].camPos)).toBeGreaterThan(1);
      expect(altitude(p, all[i].camPos)).toBeGreaterThan(SHIP_R);
      if (i === 0) continue;
      expect(turned(all[i - 1], all[i])).toBeLessThan(2);
      if (all[i].phase !== 'approach') expect(len(sub(v3(), all[i].shipPos, all[i - 1].shipPos))).toBeLessThan(8);
    }
  });

  it('starts free flight above the field, looking along and down into it', () => {
    const s = newShip();
    scene.start!(s);
    const l = local(s.pos);
    expect(l.z).toBeGreaterThan(100);
    expect(l.z).toBeLessThan(600);
    expect(ring.density(Math.hypot(l.x, l.y))).toBeGreaterThan(0.5);
    const nose = qRotate(v3(), s.q, v3(0, 0, -1));
    expect(dot(nose, ring.n)).toBeLessThan(-0.15);
    expect(dot(nose, ring.n)).toBeGreaterThan(-0.6);
    expect(s.prevPos).toEqual(s.pos);
  });

  it('has named views, the edge ones in the plane', () => {
    for (const name of ['far', 'mid', 'close', 'inside', 'edge', 'edgenear']) {
      const view = scene.view(name, 0)!;
      expect(finitePose(view)).toBe(true);
      expect(altitude(p, view.camPos)).toBeGreaterThan(SHIP_R);
      expect(clearance(view.camPos)).toBeGreaterThan(1);
    }
    expect(Math.abs(local(scene.view('edge', 0)!.camPos).z)).toBeLessThan(60);
    expect(Math.abs(local(scene.view('edgenear', 0)!.camPos).z)).toBeLessThan(60);
    expect(Math.abs(local(scene.view('far', 0)!.camPos).z)).toBeGreaterThan(10000);
  });
});
