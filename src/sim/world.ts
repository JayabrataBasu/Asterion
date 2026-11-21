import { hash2 } from '../core/util';

/** World units: 1 unit == 1 cell width. Sectors are square; origin sits at the centre of sector (0,0). */
export const SECTOR = 520;
export const PLANET_STRIDE = 8;   // x,y,r,type,seed,ring,hue,spin
export const MAX_PLANETS = 8;
/** Planet size tuning: medium planets are base x MEDIUM_K, ~GIANT_SHARE of sectors have giants at base x GIANT_K. */
export const PLANET_MAX_R = 90, MEDIUM_K = 1.6, GIANT_K = 3, GIANT_SHARE = 0.15;

export const enum PType { Terran = 0, Gas = 1, Ice = 2, Lava = 3, Desert = 4 }

export const STATION_NAMES = ['DEPOT', 'ARMORY', 'BLACK MARKET'];
export const STATION_MULT = [1.0, 0.8, 1.35];
/** Deterministic per-sector station layout (shared by the sim, the sector map and the shop). */
export function hasStation(sx: number, sy: number): boolean { return (sx === 0 && sy === 0) || hash2(sx * 17 + 5, sy * 3 + 9) > 0.80; }
export function stationType(sx: number, sy: number): number {
  if (sx === 0 && sy === 0) return 0;
  const h = hash2(sx * 3 + 11, sy * 5 + 2);
  return h < 0.4 ? 0 : h < 0.75 ? 1 : 2;
}
export function sectorOf(v: number): number { return Math.floor((v + SECTOR * 0.5) / SECTOR); }

/** Writes planet params for sector (sx,sy) into out[o..o+8). Returns false if the sector has none. */
export function planetParams(sx: number, sy: number, out: Float32Array, o: number): boolean {
  if (sx === 0 && sy === 0) {
    out[o] = 190; out[o + 1] = -60; out[o + 2] = 46; out[o + 3] = PType.Terran;
    out[o + 4] = 0.37; out[o + 5] = 0; out[o + 6] = 0.0; out[o + 7] = 0.05;
    return true;
  }
  if (hash2(sx * 7 + 11, sy * 13 + 5) > 0.68) return false;
  const type = Math.floor(hash2(sx * 19 + 2, sy * 23 + 7) * 5);
  const big = type === PType.Gas ? 1.45 : 1;
  const giant = hash2(sx * 71 + 13, sy * 73 + 5) < GIANT_SHARE;
  const r = Math.min(PLANET_MAX_R, (11 + hash2(sx * 29 + 4, sy * 31 + 8) * 22) * (giant ? GIANT_K : MEDIUM_K) * big);
  const lim = Math.min(SECTOR * 0.31, SECTOR / 2 - r - 20);          // keep the whole body inside its own sector
  const px = sx * SECTOR + (hash2(sx + 3, sy * 5 + 1) - 0.5) * 2 * lim;
  const py = sy * SECTOR + (hash2(sx * 3 + 9, sy + 17) - 0.5) * 2 * lim;
  out[o] = px; out[o + 1] = py; out[o + 2] = r; out[o + 3] = type;
  out[o + 4] = hash2(sx * 37 + 1, sy * 41 + 3);
  out[o + 5] = (type === PType.Gas ? hash2(sx + 77, sy + 5) > 0.35 : hash2(sx + 78, sy + 6) > 0.86) ? 1 : 0;
  out[o + 6] = hash2(sx * 43 + 6, sy * 47 + 2);
  out[o + 7] = (hash2(sx * 53, sy * 59) - 0.5) * 0.12;
  return true;
}

export const GRAV_RANGE = 6.5, GRAV_REACH = 130;
/** Gap above a body's surface at which its pull fades to zero: small moons keep a short reach, planets cap at GRAV_REACH. */
export function gravReach(r: number): number { return Math.min(GRAV_REACH, GRAV_RANGE * r); }

/** Orbit radius of the moon of the planet in sector (sx,sy) (planet offset ox,oy from the sector centre), or 0 if it has no moon or the orbit would not fit inside the sector. */
export function moonOrbit(sx: number, sy: number, R: number, ox: number, oy: number): number {
  if (!hasMoon(sx, sy)) return 0;
  const mr = 3.2 + R * 0.1;
  if (sx === 0 && sy === 0) return 100;                       // home: fixed, verified clear of neighbours by test
  const orbit = Math.min(R * 2.3 + 9, R + 70);
  if (Math.abs(ox) + orbit + mr > SECTOR / 2 - 5 || Math.abs(oy) + 0.8 * orbit + mr > SECTOR / 2 - 5) return 0;
  return orbit;
}

/** Collect planets whose bodies lie within `range` of (x,y). Returns count (<= MAX_PLANETS). */
/** Does the planet of sector (sx,sy) have an orbiting moon? */
export function hasMoon(sx: number, sy: number): boolean { return (sx === 0 && sy === 0) || hash2(sx * 61 + 3, sy * 67 + 9) < 0.45; }

export function planetsNear(x: number, y: number, range: number, out: Float32Array, time = 0): number {
  const sx0 = sectorOf(x - range - 60), sx1 = sectorOf(x + range + 60);
  const sy0 = sectorOf(y - range - 60), sy1 = sectorOf(y + range + 60);
  let n = 0;
  for (let sy = sy0; sy <= sy1; sy++) {
    for (let sx = sx0; sx <= sx1; sx++) {
      if (n >= MAX_PLANETS) return n;
      const o = n * PLANET_STRIDE;
      if (!planetParams(sx, sy, out, o)) continue;
      const dx = out[o] - x, dy = out[o + 1] - y, rr = range + out[o + 2];
      if (dx * dx + dy * dy < rr * rr) {
        n++;
        const orbit = n < MAX_PLANETS ? moonOrbit(sx, sy, out[o + 2], out[o] - sx * SECTOR, out[o + 1] - sy * SECTOR) : 0;
        if (orbit > 0) {        // moon: small body on a circular orbit, advanced by sim time
          const R = out[o + 2], seed = out[o + 4], om = o + PLANET_STRIDE;
          const ang = seed * 6.2832 + time * (0.075 + 0.04 * seed);
          out[om] = out[o] + Math.cos(ang) * orbit; out[om + 1] = out[o + 1] + Math.sin(ang) * orbit * 0.8;
          out[om + 2] = 3.2 + R * 0.1; out[om + 3] = seed < 0.34 ? PType.Ice : seed < 0.67 ? PType.Desert : PType.Lava;
          out[om + 4] = (seed * 7.31) % 1; out[om + 5] = 0; out[om + 6] = 0.5; out[om + 7] = 0.1;
          n++;
        }
      }
    }
  }
  return n;
}
