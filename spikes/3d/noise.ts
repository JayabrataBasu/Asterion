/** Seeded 3D value noise on an integer lattice, shared by the height functions. */

/** Integer-lattice hash -> [0,1), as hash2 in src/core/util with a third axis and a seed. */
export function hash3(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x1b873593) ^ Math.imul(seed, 0x2545f491);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function mix(a: number, b: number, t: number): number { return a + (b - a) * t; }
export function smooth(t: number): number { return t * t * (3 - 2 * t); }

/** One lattice plane of the noise cell, blended across x and y. */
function plane(ix: number, iy: number, k: number, tx: number, ty: number, seed: number): number {
  return mix(
    mix(hash3(ix, iy, k, seed), hash3(ix + 1, iy, k, seed), tx),
    mix(hash3(ix, iy + 1, k, seed), hash3(ix + 1, iy + 1, k, seed), tx), ty);
}

/** 3D value noise in [0,1). */
export function noise(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const tx = smooth(x - ix), ty = smooth(y - iy);
  return mix(plane(ix, iy, iz, tx, ty, seed), plane(ix, iy, iz + 1, tx, ty, seed), smooth(z - iz));
}
