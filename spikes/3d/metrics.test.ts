import { describe, expect, it } from 'vitest';
import { SHIP_R } from './flight';
import { type Vec3, addScaled, cross, dot, len, norm, qRotate, sub, v3 } from './math';
import { FlickerTally, changeRate, flickerRate, percentile } from './metrics';
import { PATH_SECONDS, type PathPose, pathFocus, pose } from './path';
import { altitude, height, makePlanet } from './planet';

const u = (...v: number[]): Uint8Array => Uint8Array.from(v);

describe('flickerRate', () => {
  it('counts cells that changed and changed straight back', () => {
    expect(flickerRate(u(1, 1, 1, 1), u(2, 1, 2, 1), u(1, 1, 3, 1))).toBe(0.25);
  });
  it('is 0 for a still picture, for a steady change, and for no cells', () => {
    expect(flickerRate(u(5, 6), u(5, 6), u(5, 6))).toBe(0);
    expect(flickerRate(u(1, 2), u(2, 3), u(3, 4))).toBe(0);
    expect(flickerRate(u(), u(), u())).toBe(0);
  });
  it('refuses frames of different sizes', () => {
    expect(() => flickerRate(u(1, 2), u(1), u(1, 2))).toThrow();
  });
});

describe('changeRate', () => {
  it('counts cells that differ between two frames', () => {
    expect(changeRate(u(1, 2, 3, 4), u(1, 9, 3, 9))).toBe(0.5);
    expect(changeRate(u(), u())).toBe(0);
  });
  it('refuses frames of different sizes', () => {
    expect(() => changeRate(u(1, 2), u(1))).toThrow();
  });
});

describe('percentile', () => {
  it('takes the nearest rank', () => {
    expect(percentile([1, 2, 3, 4, 100], 0.95)).toBe(100);
    expect(percentile([100, 4, 3, 2, 1], 0.5)).toBe(3);
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe('the scripted path', () => {
  const p = makePlanet(1);
  const FRAMES = PATH_SECONDS * 60;
  const frames: PathPose[] = Array.from({ length: FRAMES + 1 }, (_, i) => pose(i / 60, p));
  const at = (t: number): PathPose => frames[Math.round(t * 60)];
  const alt = (t: number): number => altitude(p, at(t).shipPos);
  const step = (i: number): Vec3 => sub(v3(), frames[i].shipPos, frames[i - 1].shipPos);
  const radialUp = (f: PathPose): Vec3 => norm(v3(), sub(v3(), f.shipPos, p.center));
  /** Sine of the bank angle, right wing down positive. */
  const bank = (t: number): number => -dot(qRotate(v3(), at(t).shipQ, v3(1, 0, 0)), radialUp(at(t)));

  it('lasts 60 seconds in four phases of 15', () => {
    expect(PATH_SECONDS).toBe(60);
    const phases = [0, 14.99, 15, 29.99, 30, 44.99, 45, 60].map(t => pose(t, p).phase);
    expect(phases).toEqual(['approach', 'approach', 'descent', 'descent', 'low', 'low', 'climb', 'climb']);
  });

  it('keeps ship and chase camera above the ground on every frame, on several planets', () => {
    for (const seed of [1, 2, 7]) {
      const q = makePlanet(seed);
      let minShip = Infinity, minCam = Infinity;
      for (let i = 0; i <= FRAMES; i++) {
        const f = pose(i / 60, q);
        minShip = Math.min(minShip, altitude(q, f.shipPos));
        minCam = Math.min(minCam, altitude(q, f.camPos));
      }
      expect(minShip).toBeGreaterThan(SHIP_R);
      expect(minCam).toBeGreaterThan(SHIP_R);
    }
  });

  it('flies the altitudes of the plan, measured above the surface', () => {
    expect(Math.abs(alt(0) - 60000)).toBeLessThan(300);
    expect(Math.abs(alt(15) - p.atmo)).toBeLessThan(60);
    for (let t = 30; t <= 45; t += 0.25) expect(Math.abs(alt(t) - 150)).toBeLessThan(50);
    expect(Math.abs(alt(60) - 2000)).toBeLessThan(60);
    for (let t = 1; t <= 30; t++) expect(alt(t)).toBeLessThan(alt(t - 1) + 25);
    for (let t = 46; t <= 60; t++) expect(alt(t)).toBeGreaterThan(alt(t - 1) - 25);
  });

  it('never teleports away from the approach, including the step out of it', () => {
    let maxStep = 0;
    for (let i = 15 * 60; i <= FRAMES; i++) maxStep = Math.max(maxStep, len(step(i)));
    expect(maxStep).toBeLessThan(40);
    expect(maxStep).toBeGreaterThan(1);
  });

  it('moves without jolts: the step changes little from frame to frame, for ship and camera', () => {
    let ship = 0, cam = 0;
    for (let i = 15 * 60; i < FRAMES; i++) {
      ship = Math.max(ship, len(sub(v3(), step(i + 1), step(i))));
      const a = sub(v3(), frames[i].camPos, frames[i - 1].camPos), b = sub(v3(), frames[i + 1].camPos, frames[i].camPos);
      cam = Math.max(cam, len(sub(v3(), b, a)));
    }
    expect(ship).toBeLessThan(0.3);
    expect(cam).toBeLessThan(0.3);
  });

  it('flies the low phase mostly over and toward land, so there is ground to judge', () => {
    for (const seed of [1, 2, 7]) {
      const q = makePlanet(seed);
      let land = 0, n = 0;
      for (let t = 30; t <= 45; t += 0.5) {
        const f = pose(t, q), nose = qRotate(v3(), f.shipQ, v3(0, 0, -1));
        for (const ahead of [0, 400, 800]) {
          const at2 = addScaled(v3(), f.shipPos, nose, ahead);
          if (height(q, norm(v3(), sub(v3(), at2, q.center))) > 0) land++;
          n++;
        }
      }
      expect(land / n).toBeGreaterThan(0.75);
    }
  });

  it('flies the low phase at 143 units a second', () => {
    for (let i = 30 * 60 + 1; i <= 45 * 60; i++) expect(Math.abs(len(step(i)) * 60 - 143)).toBeLessThan(5);
  });

  it('banks into its turns in the low phase and is level elsewhere', () => {
    expect(bank(31.875)).toBeGreaterThan(0.4); // right
    expect(bank(35.625)).toBeLessThan(-0.4); // left
    for (const t of [7, 22, 30, 45, 52]) expect(Math.abs(bank(t))).toBeLessThan(1e-6);
    // the path really bends the way the wings do: heading rate to the right while banked right
    const headingRate = (t: number): number => {
      const i = Math.round(t * 60), a = step(i - 20), b = step(i + 20);
      return dot(cross(v3(), a, b), radialUp(frames[i])) / (len(a) * len(b)); // > 0 is a left turn
    };
    expect(headingRate(31.875)).toBeLessThan(-0.05);
    expect(headingRate(35.625)).toBeGreaterThan(0.05);
    expect(Math.abs(headingRate(22))).toBeLessThan(0.01);
  });

  it('chases from 10 up and 40 back with the ship\'s attitude', () => {
    for (const t of [0, 7, 22, 33, 52]) {
      const f = at(t);
      expect(f.camQ).toEqual(f.shipQ);
      expect(f.camQ).not.toBe(f.shipQ);
      const q = f.shipQ, back = qRotate(v3(), { x: -q.x, y: -q.y, z: -q.z, w: q.w }, sub(v3(), f.camPos, f.shipPos));
      expect(back.x).toBeCloseTo(0, 6); expect(back.y).toBeCloseTo(10, 6); expect(back.z).toBeCloseTo(40, 6);
    }
  });

  it('is a pure function of time and planet, clamped to the path', () => {
    const a = pose(37.123, p);
    pose(3, makePlanet(2));
    expect(pose(37.123, makePlanet(1))).toEqual(a);
    expect(pose(-5, p)).toEqual(pose(0, p));
    expect(pose(99, p)).toEqual(pose(60, p));
    a.shipPos.x += 1000;
    expect(pose(37.123, p).shipPos.x).not.toBe(a.shipPos.x);
  });

  it('names a fixed ground direction for scenery, the same for equal planets', () => {
    const d = pathFocus(p);
    expect(len(d)).toBeCloseTo(1, 9);
    expect(pathFocus(makePlanet(1))).toEqual(d);
    expect(dot(d, radialUp(at(30)))).toBeCloseTo(1, 6);
  });
});

describe('FlickerTally', () => {
  const feed = (t: FlickerTally, ...frames: number[][]): void => { for (const f of frames) { t.next().set(f); t.add(); } };
  it('takes one change sample per pair and one flicker sample per three consecutive frames', () => {
    const t = new FlickerTally(4);
    feed(t, [1, 1, 1, 1]);
    expect([t.change, t.flicker]).toEqual([[], []]);
    feed(t, [2, 1, 2, 1]);
    expect([t.change, t.flicker]).toEqual([[0.5], []]);
    feed(t, [1, 1, 3, 1]);
    expect([t.change, t.flicker]).toEqual([[0.5, 0.5], [0.25]]);
    // the ring turns over: later samples still use the three newest frames in order
    feed(t, [2, 1, 3, 1], [1, 1, 3, 1], [1, 1, 3, 1]);
    expect(t.change).toEqual([0.5, 0.5, 0.25, 0.25, 0]);
    expect(t.flicker).toEqual([0.25, 0.25, 0.25, 0]);
  });
  it('sums up as mean and 95th percentile', () => {
    const t = new FlickerTally(4);
    feed(t, [1, 1, 1, 1], [2, 1, 2, 1], [1, 1, 3, 1], [1, 1, 3, 1]);
    const s = t.summary();
    expect(s.flickerMean).toBeCloseTo(0.125, 12);
    expect(s.flickerP95).toBe(0.25);
    expect(s.changeMean).toBeCloseTo(1 / 3, 12);
    expect(s.changeP95).toBe(0.5);
  });
  it('is all zero without samples', () => {
    expect(new FlickerTally(4).summary()).toEqual({ flickerMean: 0, flickerP95: 0, changeMean: 0, changeP95: 0 });
  });
});
