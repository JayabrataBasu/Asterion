/** Ship and rock models built in code: flat-shaded triangle lists, counter-clockwise seen from outside.
 *  Ship axes: nose -Z, up +Y, right +X. A colour channel above 1 marks a part that glows (unlit). */
export interface Mesh { pos: Float32Array; nrm: Float32Array; col: Float32Array }

type P = [number, number, number];
type C = [number, number, number];

class Builder {
  private pos: number[] = []; private nrm: number[] = []; private col: number[] = [];

  /** Adds a triangle, turned so that it faces away from `inside`. */
  tri(a: P, b: P, c: P, col: C, inside: P): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    nx /= l; ny /= l; nz /= l;
    const ox = (a[0] + b[0] + c[0]) / 3 - inside[0], oy = (a[1] + b[1] + c[1]) / 3 - inside[1], oz = (a[2] + b[2] + c[2]) / 3 - inside[2];
    if (nx * ox + ny * oy + nz * oz < 0) { [b, c] = [c, b]; nx = -nx; ny = -ny; nz = -nz; }
    for (const p of [a, b, c]) { this.pos.push(...p); this.nrm.push(nx, ny, nz); this.col.push(...col); }
  }

  /** A convex six-sided solid from its eight corners: 0-3 one end, 4-7 the other, in the same turning order. */
  hexa(k: P[], col: C): void {
    const inside: P = [0, 1, 2].map(i => k.reduce((s, p) => s + p[i], 0) / 8) as P;
    const quad = (a: number, b: number, c: number, d: number): void => {
      this.tri(k[a], k[b], k[c], col, inside); this.tri(k[a], k[c], k[d], col, inside);
    };
    quad(0, 1, 2, 3); quad(4, 5, 6, 7);
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; quad(i, j, j + 4, i + 4); }
  }

  /** Box along Z from z0 to z1, centred on (x, y), half sizes (w, h) at z0 and scaled by `taper` at z1. */
  box(x: number, y: number, z0: number, z1: number, w: number, h: number, col: C, taper = 1, lift = 0): void {
    const ring = (z: number, s: number, dy: number): P[] => [
      [x - w * s, y - h * s + dy, z], [x + w * s, y - h * s + dy, z], [x + w * s, y + h * s + dy, z], [x - w * s, y + h * s + dy, z],
    ];
    this.hexa([...ring(z0, 1, 0), ...ring(z1, taper, lift)], col);
  }

  done(): Mesh { return { pos: new Float32Array(this.pos), nrm: new Float32Array(this.nrm), col: new Float32Array(this.col) }; }
}

const HULL: C = [0.78, 0.78, 0.80], DARK: C = [0.36, 0.37, 0.40], RED: C = [0.85, 0.18, 0.12];
const GLASS: C = [0.12, 0.22, 0.42], GLOW: C = [2.4, 0.9, 0.35];

/** The Wren, the 2D game's X-wing style fighter: about 23 long and 26 across the wing tips. */
export function wrenMesh(): Mesh {
  const b = new Builder();
  b.box(0, 0, 7, -9, 1.7, 1.4, HULL, 0.55, -0.2);         // fuselage, narrowing toward the nose
  b.box(0, -0.25, -9, -15, 0.95, 0.75, HULL, 0.35, -0.2); // nose
  b.box(0, -0.4, -14.6, -16, 0.35, 0.3, RED, 0.6);        // nose tip
  b.box(0, 1.5, 1.5, -3.5, 0.95, 0.5, GLASS, 0.6, -0.3);   // canopy
  b.box(0, 0, 7, 8.2, 1.3, 1.1, DARK);                     // tail block
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const dihedral = 0.36 * sy;                           // the X: upper wings tilt up, lower ones down
      const tipX = sx * 13, tipY = sy * 0.6 + 11.5 * dihedral;
      const rootX = sx * 1.6, rootY = sy * 0.6;
      const t = 0.18;
      // wing plate: root chord z 1..6.5, tip chord z 2.5..5.5
      b.hexa([
        [rootX, rootY - t, 6.5], [rootX, rootY - t, 1], [tipX, tipY - t, 2.5], [tipX, tipY - t, 5.5],
        [rootX, rootY + t, 6.5], [rootX, rootY + t, 1], [tipX, tipY + t, 2.5], [tipX, tipY + t, 5.5],
      ], HULL);
      // red band near the root
      const mx = sx * 5.2, my = sy * 0.6 + (5.2 / 13) * 11.5 * dihedral;
      b.hexa([
        [mx, my - t - 0.05, 6.2], [mx, my - t - 0.05, 1.6], [mx + sx * 1.6, my + 1.6 / 13 * 11.5 * dihedral - t - 0.05, 1.8], [mx + sx * 1.6, my + 1.6 / 13 * 11.5 * dihedral - t - 0.05, 6.0],
        [mx, my + t + 0.05, 6.2], [mx, my + t + 0.05, 1.6], [mx + sx * 1.6, my + 1.6 / 13 * 11.5 * dihedral + t + 0.05, 1.8], [mx + sx * 1.6, my + 1.6 / 13 * 11.5 * dihedral + t + 0.05, 6.0],
      ], RED);
      // engine at the wing root, glowing at the back
      const ex = sx * 2.6, ey = sy * 1.3;
      b.box(ex, ey, 0, 7.6, 0.85, 0.85, DARK, 1.1);
      b.box(ex, ey, 7.6, 8.1, 0.7, 0.7, GLOW);
      // wing-tip cannon with a red muzzle
      b.box(tipX, tipY, 5, -8, 0.3, 0.3, DARK, 0.8);
      b.box(tipX, tipY, -8, -9.5, 0.22, 0.22, RED);
    }
  }
  return b.done();
}

/** Integer hash -> [0,1). */
function hash(n: number): number {
  let h = Math.imul(n ^ 0x5bd1e995, 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** A lumpy rock of about unit radius: a twice-split icosahedron pushed in and out by a seeded bump field. */
export function rockMesh(seed: number): Mesh {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts: P[] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  let faces: [number, number, number][] = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4],
    [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11],
    [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const unit = (p: P): P => { const l = Math.hypot(...p); return [p[0] / l, p[1] / l, p[2] / l]; };
  verts = verts.map(unit);
  for (let s = 0; s < 2; s++) {
    const mids = new Map<string, number>();
    const mid = (a: number, b: number): number => {
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      let i = mids.get(k);
      if (i === undefined) {
        const A = verts[a], B = verts[b];
        i = verts.push(unit([(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2])) - 1;
        mids.set(k, i);
      }
      return i;
    };
    const next: [number, number, number][] = [];
    for (const [a, b, c] of faces) {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  // a few seeded bumps and dents, plus an overall squash
  const bumps = Array.from({ length: 7 }, (_, i) => ({
    d: unit([hash(seed * 31 + i * 3) - 0.5, hash(seed * 31 + i * 3 + 1) - 0.5, hash(seed * 31 + i * 3 + 2) - 0.5]),
    k: (hash(seed * 17 + i) - 0.45) * 0.55,
  }));
  const sq: P = [0.8 + 0.4 * hash(seed + 101), 0.65 + 0.3 * hash(seed + 102), 0.85 + 0.3 * hash(seed + 103)];
  const shaped = verts.map(v => {
    let r = 1;
    for (const { d, k } of bumps) r += k * Math.max(0, v[0] * d[0] + v[1] * d[1] + v[2] * d[2]) ** 3;
    r += 0.06 * (hash(Math.round((v[0] + 2) * 97) * 7919 + Math.round((v[1] + 2) * 89) * 104729 + Math.round((v[2] + 2) * 83) + seed) - 0.5);
    return [v[0] * r * sq[0], v[1] * r * sq[1], v[2] * r * sq[2]] as P;
  });
  const tone = hash(seed + 7);
  const base: C = [0.42 + 0.12 * tone, 0.37 + 0.06 * tone, 0.32 - 0.04 * tone];
  const b = new Builder();
  for (const [i, j, k] of faces) {
    const shade = 0.88 + 0.24 * hash(i * 7 + j * 13 + k * 29 + seed);
    b.tri(shaped[i], shaped[j], shaped[k], [base[0] * shade, base[1] * shade, base[2] * shade], [0, 0, 0]);
  }
  return b.done();
}
