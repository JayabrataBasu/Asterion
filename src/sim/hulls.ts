/**
 * Collision shapes for the player hulls: a few circles that trace each drawn silhouette (nose, body, wings, rings, container rows),
 * so a wing tip or a ring really touches a rock instead of the whole hull being one small circle.
 *
 * Coordinates are the sprite's local units (x = forward, y = left), exactly as used in spriteShaders.ts; world = local * HULL_SCALE
 * (the player sprite is drawn at scale 0.8). Symmetric hulls list only y >= 0 and are mirrored; asymmetric ones (Magpie) list both sides.
 */
export const HULL_SCALE = 0.8;

export interface HullShape {
  /** Flat world-unit triples x, y, r, relative to the ship's centre and heading (already scaled and mirrored). */
  c: Float32Array;
  /** Furthest reach of any circle from the centre, world units (broad-phase radius). */
  reach: number;
}

// [x, y, r] in sprite-local units. Traced from the SDF fields in spriteShaders.ts.
const WREN = [14, 0, 1.8, 8, 0, 2.0, 2, 0, 2.5, -4, 0, 3.4, -8, 3, 1.6, -3, 5.2, 1.7, -7, 8.6, 1.6, -9, 12.2, 1.4, 2, 12.2, 1.0, 2, 8.6, 1.0];
const NEEDLE = [16, 0, 1.0, 11, 0, 1.6, 5, 0, 1.7, -1, 0, 1.7, -7, 0, 1.8, -11, 0, 1.7, 5, 2.6, 1.2, -4, 3.2, 1.6, -8, 6.2, 1.6, -11, 9.0, 1.2];
const ANVIL = [-9, 0, 3.1, -3, 0, 3.1, 3, 0, 3.1, 4, 3.0, 2.3, 4, 6.0, 2.3, 4, 9.0, 2.3, 4, 11.5, 2.2, 11, 1.1, 0.9, 11, 3.4, 0.9, -5, 4.6, 1.6, -10, 3, 1.8];
const SEXTANT = [8.1, 0, 2.0, 6.2, 4.7, 2.0, 1.5, 6.6, 2.0, -3.2, 4.7, 2.0, -5.1, 0, 2.0, 12, 0, 1.2, 16, 0, 0.9, -8, 0, 1.3, -13, 0, 1.2, 1.5, 0, 2.6];
const MULE = [14, 0, 1.6, 8, 0, 1.4, 2, 0, 1.4, -4, 0, 1.4, -10, 0, 1.8, -7.5, 6.2, 2.7, -2.5, 6.2, 2.7, 2.5, 6.2, 2.7, 7.5, 6.2, 2.7, -12.8, 6.2, 1.9, -7.5, 3.0, 0.9, 2.5, 3.0, 0.9];
const SHADE = [10, 0.5, 2.2, 7, 2.6, 2.6, 3, 4.8, 2.6, -2, 7.7, 2.4, -6, 10.4, 2.0, -9, 12.5, 1.4, 4, 0.4, 2.0, -3, 3.2, 2.0, -8, 5.6, 1.8, 1, 0, 3.4];
// Magpie is asymmetric (not mirrored): body, plates, a long articulated arm to the upper side and a two-pronged claw.
const MAGPIE = [-4, -0.5, 3.8, 2, -0.5, 3.8, 8, 0, 2.6, -5, -5.6, 2.8, -1, 5.4, 2.4, 2, 5, 1.3, 6, 9, 1.3, 12.5, 7.5, 1.3, 17, 8.5, 1.6, 20, 10.5, 1.0, 20, 6.5, 1.0, -8.6, 1.6, 1.4, -8, -3.4, 1.1];
// Hive: hexagonal ring around (-1, 0), inradius ~7.2 + thickness, with a rear bay; ring sampled at 12 points.
const HIVE: number[] = [];
for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2, rx = 8.7 * Math.cos(a), ry = 7.4 * Math.sin(a); if (!(rx < -6 && Math.abs(ry) < 2.6)) HIVE.push(-1 + rx, ry, 1.9); }
HIVE.push(-1, 0, 2.7, -11.6, 1.6, 1.4);

function build(pts: number[], mirror: boolean): HullShape {
  const out: number[] = [];
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i] * HULL_SCALE, y = pts[i + 1] * HULL_SCALE, r = pts[i + 2] * HULL_SCALE;
    out.push(x, y, r);
    if (mirror && Math.abs(y) > 0.3 * HULL_SCALE) out.push(x, -y, r);
  }
  let reach = 0;
  for (let i = 0; i < out.length; i += 3) reach = Math.max(reach, Math.hypot(out[i], out[i + 1]) + out[i + 2]);
  return { c: Float32Array.from(out), reach };
}

/** Sprite art id -> shape. Ids match Spr in batch.ts (0 Wren, 14 Needle, 15 Anvil, 16 Sextant, 17 Mule, 18 Shade, 19 Magpie, 20 Hive). */
const SHAPES = new Map<number, HullShape>([
  [0, build(WREN, true)], [14, build(NEEDLE, true)], [15, build(ANVIL, true)], [16, build(SEXTANT, true)],
  [17, build(MULE, true)], [18, build(SHADE, true)], [19, build(MAGPIE, false)], [20, build(HIVE, false)],
]);
const FALLBACK = build([0, 0, 2.4 / HULL_SCALE * 1.6, 6, 0, 1.8, -6, 0, 1.8], true);
export function hullShape(art: number): HullShape { return SHAPES.get(art) ?? FALLBACK; }
