import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type Quat, type Vec3, add, addScaled, copy, cross, dot, len, norm, qAxisAngle, qIdentity, qMul, qNorm, qRotate, qSlerp,
  scale, sub, v3, viewProj,
} from './math';
import { Mat, altitude, atmoDensity, height, makePlanet, material, surfaceRadius } from './planet';
import { SCALE } from './scale';

const N = 10000;
/** Evenly spread unit directions (Fibonacci sphere). */
const DIRS: Vec3[] = Array.from({ length: N }, (_, i) => {
  const y = 1 - 2 * (i + 0.5) / N, r = Math.sqrt(1 - y * y), a = i * Math.PI * (3 - Math.sqrt(5));
  return { x: r * Math.cos(a), y, z: r * Math.sin(a) };
});
const samples = (seed: number): number[] => { const p = makePlanet(seed); return DIRS.map(d => height(p, d)); };
const waterFraction = (seed: number): number => samples(seed).filter(h => h <= 0).length / N;

function close(a: Vec3 | Quat, b: Vec3 | Quat): void {
  for (const k of Object.keys(b)) expect((a as never)[k]).toBeCloseTo((b as never)[k], 9);
}

describe('planet height', () => {
  it('is the same for the same seed and direction', () => {
    const a = makePlanet(1), b = makePlanet(1);
    for (const d of DIRS) expect(height(a, d)).toBe(height(b, d));
  });

  it('differs between seeds', () => { expect(samples(1)).not.toEqual(samples(2)); });

  it('stays within the relief and uses a good part of it', () => {
    const max = Math.max(...samples(1).map(Math.abs));
    expect(max).toBeLessThanOrEqual(makePlanet(1).relief);
    expect(max).toBeGreaterThan(0.3 * makePlanet(1).relief);
  });

  it('is part water, part land', () => {
    expect(waterFraction(1)).toBeGreaterThan(0.3);
    expect(waterFraction(1)).toBeLessThan(0.8);
  });

  it('has no jumps: half a unit along the ground changes height by under one unit', () => {
    const p = makePlanet(1), q = v3();
    let worst = 0;
    for (const d of DIRS) {
      norm(q, addScaled(q, d, v3(d.y, -d.x, 0), 0.5 / p.radius));
      worst = Math.max(worst, Math.abs(height(p, q) - height(p, d)));
    }
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThan(1);
  });
});

describe('planet size', () => {
  const saved = { ...SCALE };
  afterEach(() => { Object.assign(SCALE, saved); });

  it('scales the 2D radius', () => {
    const p = makePlanet(1);
    expect(p.radius).toBe(6900);
    expect(p.atmo).toBeCloseTo(552);
    expect(p.relief).toBeCloseTo(207);
    expect(p.seed).toBe(1);
    expect(p.center).toEqual({ x: 0, y: 0, z: 0 });
    expect(makePlanet(1, 20).radius).toBe(3000);
  });

  it('caps the relief of large planets', () => { expect(makePlanet(1, 90).relief).toBe(250); });

  it('reads SCALE when the planet is made, not when the module loads', () => {
    Object.assign(SCALE, { radiusK: 100, atmoFrac: 0.1, reliefFrac: 0.02, reliefMax: 50 });
    const p = makePlanet(1);
    expect(p.radius).toBe(4600);
    expect(p.atmo).toBeCloseTo(460);
    expect(p.relief).toBe(50);
  });
});

describe('planet surface', () => {
  const p = makePlanet(1);
  p.center = v3(1000, -2000, 3000);
  const atAltitude = (h: number, d: Vec3 = DIRS[0]): Vec3 => addScaled(v3(), p.center, d, p.radius + h);
  const water = DIRS.find(d => height(p, d) < -5)!, land = DIRS.find(d => height(p, d) > 5)!;

  it('surface is the sea over water and the ground over land', () => {
    expect(surfaceRadius(p, water)).toBe(p.radius);
    expect(surfaceRadius(p, land)).toBe(p.radius + height(p, land));
  });

  it('altitude is measured from the surface below, relative to the centre', () => {
    expect(altitude(p, atAltitude(300, water))).toBeCloseTo(300, 6);
    expect(altitude(p, atAltitude(300, land))).toBeCloseTo(300 - height(p, land), 6);
    expect(altitude(p, copy(v3(), p.center))).toBeLessThan(0);
  });

  it('atmosphere density is 1 at sea level, 0 from the top up, and smooth between', () => {
    expect(atmoDensity(p, atAltitude(p.atmo + 1))).toBe(0);
    expect(atmoDensity(p, atAltitude(0))).toBeCloseTo(1);
    expect(atmoDensity(p, atAltitude(-50))).toBe(1);
    expect(atmoDensity(p, atAltitude(p.atmo / 2))).toBeCloseTo(0.5);
    let prev = 1;
    for (let h = 1; h <= p.atmo + 5; h++) {
      const d = atmoDensity(p, atAltitude(h));
      expect(d).toBeLessThanOrEqual(prev);
      expect(prev - d).toBeLessThan(0.005);
      prev = d;
    }
  });

  it('material is water, then polar ice, then land', () => {
    const equator = v3(1, 0, 0), pole = v3(0, -1, 0);
    expect(material(p, equator, 0)).toBe(Mat.Water);
    expect(material(p, pole, -1)).toBe(Mat.Water);
    expect(material(p, pole, 1)).toBe(Mat.Ice);
    expect(material(p, equator, 1)).toBe(Mat.Land);
    expect(material(p, v3(0.5, 0.87, 0), 1)).toBe(Mat.Ice);
    expect(material(p, v3(0.53, 0.85, 0), 1)).toBe(Mat.Land);
    expect([Mat.Sky, Mat.Water, Mat.Land, Mat.Ice, Mat.Rock, Mat.Hull]).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('scale URL overrides', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
  const load = async (): Promise<typeof SCALE> => { vi.resetModules(); return (await import('./scale')).SCALE; };

  it('has the defaults where there is no location', async () => {
    expect(await load()).toEqual({ radiusK: 150, atmoFrac: 0.08, reliefFrac: 0.03, reliefMax: 250, cruiseGain: 0.35, cruiseMax: 20000 });
  });

  it('takes finite numbers from the URL and ignores everything else', async () => {
    vi.stubGlobal('location', { search: '?radiusK=200&cruiseGain=0.5&atmoFrac=&reliefFrac=abc&reliefMax=Infinity&cruiseMax=%20&other=3' });
    expect(await load()).toEqual({ radiusK: 200, atmoFrac: 0.08, reliefFrac: 0.03, reliefMax: 250, cruiseGain: 0.5, cruiseMax: 20000 });
  });
});

describe('vector maths', () => {
  const a = v3(1, 2, 3), b = v3(4, -5, 6);

  it('does arithmetic into the out parameter', () => {
    const o = v3();
    expect(add(o, a, b)).toBe(o);
    close(o, v3(5, -3, 9));
    close(sub(o, a, b), v3(-3, 7, -3));
    close(scale(o, a, 2), v3(2, 4, 6));
    close(addScaled(o, a, b, 0.5), v3(3, -0.5, 6));
    close(copy(o, b), b);
    expect(dot(a, b)).toBe(12);
    expect(len(v3(2, 3, 6))).toBe(7);
  });

  it('cross follows the right hand and may write over an input', () => {
    close(cross(v3(), v3(1, 0, 0), v3(0, 1, 0)), v3(0, 0, 1));
    const o = v3(1, 2, 3);
    close(cross(o, o, b), v3(27, 6, -13));
  });

  it('norm gives unit length and leaves zero as zero', () => {
    close(norm(v3(), v3(0, 3, 4)), v3(0, 0.6, 0.8));
    close(norm(v3(9, 9, 9), v3()), v3());
  });
});

describe('quaternions', () => {
  const X = v3(1, 0, 0), Y = v3(0, 1, 0), FWD = v3(0, 0, -1);
  const quarter = (axis: Vec3): Quat => qAxisAngle(qIdentity(), axis, Math.PI / 2);

  it('identity changes nothing', () => {
    close(qRotate(v3(), qIdentity(), v3(1, 2, 3)), v3(1, 2, 3));
    close(qIdentity(quarter(X)), { x: 0, y: 0, z: 0, w: 1 });
  });

  it('rotates by the right hand rule, also in place', () => {
    close(qRotate(v3(), quarter(Y), FWD), v3(-1, 0, 0));
    close(qRotate(v3(), quarter(X), FWD), Y);
    const v = copy(v3(), FWD);
    close(qRotate(v, quarter(Y), v), v3(-1, 0, 0));
  });

  it('qMul applies the second rotation first and may write over an input', () => {
    const a = quarter(Y), b = quarter(X), v = v3(0.3, -2, 5);
    const stepped = qRotate(v3(), a, qRotate(v3(), b, v));
    close(qRotate(v3(), qMul(qIdentity(), a, b), v), stepped);
    close(qRotate(v3(), qMul(b, a, b), v), stepped);
  });

  it('qNorm restores unit length', () => {
    close(qNorm(qIdentity(), { x: 0, y: 3, z: 0, w: 4 }), { x: 0, y: 0.6, z: 0, w: 0.8 });
    close(qNorm(qIdentity(), { x: 0, y: 0, z: 0, w: 0 }), { x: 0, y: 0, z: 0, w: 1 });
  });

  it('qSlerp turns at a steady rate the short way round', () => {
    const a = qIdentity(), b = quarter(Y), third = qAxisAngle(qIdentity(), Y, Math.PI / 6);
    close(qSlerp(qIdentity(), a, b, 0), a);
    close(qSlerp(qIdentity(), a, b, 1), b);
    close(qSlerp(qIdentity(), a, b, 1 / 3), third);
    close(qSlerp(qIdentity(), a, { x: -b.x, y: -b.y, z: -b.z, w: -b.w }, 1 / 3), third);
    close(qSlerp(qIdentity(), b, b, 0.5), b);
    const o = qIdentity();
    close(qSlerp(o, o, b, 1 / 3), third);
  });
});

describe('view-projection', () => {
  const fov = Math.PI / 2, aspect = 2;
  const project = (m: Float32Array, p: Vec3): { x: number; y: number; z: number; w: number } => {
    const row = (r: number): number => m[r] * p.x + m[4 + r] * p.y + m[8 + r] * p.z + m[12 + r];
    return { x: row(0), y: row(1), z: row(2), w: row(3) };
  };

  it('looks down -Z with +Y up and +X right, with no translation', () => {
    const m = viewProj(new Float32Array(16), qIdentity(), fov, aspect);
    const c = project(m, v3(0, 0, -10));
    expect(c.x).toBe(0); expect(c.y).toBe(0); expect(c.w).toBeCloseTo(10);
    const e = project(m, v3(20, 10, -10));
    expect(e.x / e.w).toBeCloseTo(1); expect(e.y / e.w).toBeCloseTo(1);
    expect(project(m, v3(0, 0, 10)).w).toBeLessThan(0);
    expect(project(m, v3()).x).toBe(0); expect(project(m, v3()).w).toBe(0);
  });

  it('turns with the camera', () => {
    const m = viewProj(new Float32Array(16), qAxisAngle(qIdentity(), v3(0, 1, 0), Math.PI / 2), fov, aspect);
    const c = project(m, v3(-10, 0, 0));
    expect(c.x).toBeCloseTo(0); expect(c.y).toBeCloseTo(0); expect(c.w).toBeCloseTo(10);
    const up = project(m, v3(-10, 10, 0));
    expect(up.y / up.w).toBeCloseTo(1);
  });

  it('keeps near and very distant points inside the depth range', () => {
    const m = viewProj(new Float32Array(16), qIdentity(), fov, aspect);
    for (const d of [2, 100, 250000, 1e7]) {
      const c = project(m, v3(0, 0, -d));
      expect(c.z).toBeGreaterThanOrEqual(-c.w);
      expect(c.z).toBeLessThanOrEqual(c.w);
    }
  });
});
