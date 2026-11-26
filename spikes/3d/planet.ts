/** The seeded planet: one height function drives both collision and the mesh. */
import { clamp } from '../../src/core/util';
import { type Vec3, len, norm, sub, v3 } from './math';
import { SCALE } from './scale';

export enum Mat { Sky = 0, Water = 1, Land = 2, Ice = 3, Rock = 4, Hull = 5 }

export interface Planet { center: Vec3; radius: number; atmo: number; relief: number; seed: number }

const OCTAVES = 7;
const WAVELENGTH = 2700; // of the first octave; the last is about 42
const AMP_SUM = 2 - 2 ** (1 - OCTAVES); // 1 + 1/2 + ... over all octaves
const ICE_Y = 0.86;

export function makePlanet(seed: number, radius2d = 46): Planet {
  const radius = radius2d * SCALE.radiusK;
  return {
    center: v3(), radius, seed,
    atmo: radius * SCALE.atmoFrac, relief: Math.min(radius * SCALE.reliefFrac, SCALE.reliefMax),
  };
}

/** Integer-lattice hash -> [0,1), as hash2 in src/core/util with a third axis and a seed. */
function hash3(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x1b873593) ^ Math.imul(seed, 0x2545f491);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function mix(a: number, b: number, t: number): number { return a + (b - a) * t; }
function smooth(t: number): number { return t * t * (3 - 2 * t); }

/** One lattice plane of the noise cell, blended across x and y. */
function plane(ix: number, iy: number, k: number, tx: number, ty: number, seed: number): number {
  return mix(
    mix(hash3(ix, iy, k, seed), hash3(ix + 1, iy, k, seed), tx),
    mix(hash3(ix, iy + 1, k, seed), hash3(ix + 1, iy + 1, k, seed), tx), ty);
}

/** 3D value noise in [0,1). */
function noise(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const tx = smooth(x - ix), ty = smooth(y - iy);
  return mix(plane(ix, iy, iz, tx, ty, seed), plane(ix, iy, iz + 1, tx, ty, seed), smooth(z - iz));
}

/** Ground height above `radius` toward the unit direction `dir`, within +-relief. Below 0 is seabed. */
export function height(p: Planet, dir: Vec3): number {
  let sum = 0, amp = 1, freq = p.radius / WAVELENGTH;
  for (let o = 0; o < OCTAVES; o++) {
    sum += amp * (2 * noise(dir.x * freq, dir.y * freq, dir.z * freq, p.seed * OCTAVES + o) - 1);
    amp /= 2; freq *= 2;
  }
  return sum / AMP_SUM * p.relief;
}

/** Distance from the centre to what you can hit: the ground, or the sea where the ground is below it. */
export function surfaceRadius(p: Planet, dir: Vec3): number { return p.radius + Math.max(0, height(p, dir)); }

const rel = v3();
export function altitude(p: Planet, pos: Vec3): number {
  const d = len(sub(rel, pos, p.center));
  return d - surfaceRadius(p, norm(rel, rel));
}

/** 1 at sea level and below, 0 from the top of the atmosphere up. */
export function atmoDensity(p: Planet, pos: Vec3): number {
  const h = len(sub(rel, pos, p.center)) - p.radius;
  return h <= 0 ? 1 : 1 - smooth(clamp(h / p.atmo, 0, 1));
}

export function material(_p: Planet, dir: Vec3, h: number): Mat {
  if (h <= 0) return Mat.Water;
  return Math.abs(dir.y) > ICE_Y ? Mat.Ice : Mat.Land;
}
