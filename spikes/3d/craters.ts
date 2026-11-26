/** The moon's height function: gentle swells and bowls with raised rims at several sizes. It depends on the direction
 *  and the seed alone and is continuous everywhere, with no seams and nothing special about the poles, so the mesh and
 *  collision read the same ground.
 *
 *  Craters are centred in the cells of 3D lattices laid through the sphere. A crater counts if its centre is within
 *  SHELL cells of the sphere, and is measured as if it lay on it; none reaches half a cell from its centre, so only
 *  the eight cells nearest a point can hold one that touches it. */
import type { Vec3 } from './math';
import { hash3, noise } from './noise';
import type { Planet } from './planet';

/** Cell sizes in units, and the lattices of each (shifted against each other). */
const CELLS = [700, 310, 130, 56];
const LATTICES = 3;
const SHELL = 0.25;
/** Rim radius in cells: RIM_MIN to RIM_MIN + RIM_SPAN, mostly small. */
const RIM_MIN = 0.14, RIM_SPAN = 0.13;
/** Depth of the bowl and height of the rim as shares of the rim radius; the rim's outer slope ends at REACH radii. */
const DEPTH = 0.23, RIM = 0.07, REACH = 1.6;
const SWELL = 420, SWELL_HEIGHT = 11;

/** Height of one crater `u` rim radii from its centre, in rim radii. */
function profile(u: number): number {
  if (u < 1) { const u2 = u * u; return RIM * u2 * u2 - DEPTH * (1 - u2); }
  const out = (REACH - u) / (REACH - 1);
  return RIM * out * out;
}

export function craterHeight(p: Planet, dir: Vec3): number {
  const k = p.radius / SWELL;
  let h = SWELL_HEIGHT * (2 * noise(dir.x * k, dir.y * k, dir.z * k, p.seed * 31 + 5) - 1)
    + 0.35 * SWELL_HEIGHT * (2 * noise(dir.x * k * 3, dir.y * k * 3, dir.z * k * 3, p.seed * 31 + 6) - 1);
  for (let level = 0; level < CELLS.length; level++) {
    const cell = CELLS[level], f = p.radius / cell;
    for (let m = 0; m < LATTICES; m++) {
      const seed = p.seed * 977 + level * LATTICES + m, shift = m / LATTICES;
      const qx = dir.x * f + shift, qy = dir.y * f + shift, qz = dir.z * f + shift;
      const bx = Math.floor(qx - 0.5), by = Math.floor(qy - 0.5), bz = Math.floor(qz - 0.5);
      for (let n = 0; n < 8; n++) {
        const ix = bx + (n & 1), iy = by + (n >> 1 & 1), iz = bz + (n >> 2);
        const bits = hash3(ix, iy, iz, seed) * 4294967296;
        const cx = ix + (bits & 1023) / 1024, cy = iy + (bits >>> 10 & 1023) / 1024, cz = iz + (bits >>> 20 & 1023) / 1024;
        const ox = cx - shift, oy = cy - shift, oz = cz - shift;
        const off = Math.sqrt(ox * ox + oy * oy + oz * oz) - f; // how far the centre lies off the sphere
        if (off > SHELL || off < -SHELL) continue;
        const dx = qx - cx, dy = qy - cy, dz = qz - cz, flat = dx * dx + dy * dy + dz * dz - off * off;
        const widest = REACH * (RIM_MIN + RIM_SPAN);
        if (flat >= widest * widest) continue;
        const s = hash3(iz, ix, iy, seed + 4099), rim = RIM_MIN + RIM_SPAN * s * s;
        const u = Math.sqrt(Math.max(0, flat)) / rim;
        if (u < REACH) h += rim * cell * profile(u);
      }
    }
  }
  return h > p.relief ? p.relief : h < -p.relief ? -p.relief : h;
}
