import { glyphOfCode } from './atlas';

export const GLYPH_STRIDE = 8;      // x,y,glyph,bgMode | r,g,b,pad
export const GLOW_STRIDE = 8;       // x,y,radius,pad   | r,g,b,pad
export const MAX_GLYPHS = 24000;
export const MAX_GLOWS = 4096;

/** Preallocated instance buffers; the CPU only ever writes into these typed arrays. */
export class GlyphBatch {
  readonly data = new Float32Array(MAX_GLYPHS * GLYPH_STRIDE);
  n = 0; cols = 0; rows = 0;
  reset(cols: number, rows: number): void { this.n = 0; this.cols = cols; this.rows = rows; }

  /** bg: 0 = scene-tinted cell, 1 = dark panel, 2 = transparent overlay. Coordinates are cell units, y up. */
  put(cx: number, cy: number, g: number, r: number, gg: number, b: number, bg = 0): void {
    cx = Math.floor(cx); cy = Math.floor(cy);
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows || this.n >= MAX_GLYPHS) return;
    const o = this.n++ * GLYPH_STRIDE, d = this.data;
    d[o] = cx; d[o + 1] = cy; d[o + 2] = g; d[o + 3] = bg; d[o + 4] = r; d[o + 5] = gg; d[o + 6] = b;
  }

  /** row counted from the top. */
  text(s: string, col: number, row: number, r: number, g: number, b: number, bg = 1): void {
    const cy = this.rows - 1 - row;
    for (let i = 0; i < s.length; i++) this.put(col + i, cy, glyphOfCode(s.charCodeAt(i)), r, g, b, bg);
  }
}

export class GlowBatch {
  readonly data = new Float32Array(MAX_GLOWS * GLOW_STRIDE);
  n = 0;
  reset(): void { this.n = 0; }
  add(x: number, y: number, rad: number, r: number, g: number, b: number): void {
    if (this.n >= MAX_GLOWS) return;
    const o = this.n++ * GLOW_STRIDE, d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = rad; d[o + 4] = r; d[o + 5] = g; d[o + 6] = b;
  }
}

export const SPRITE_STRIDE = 12;     // x,y,angle,size | type,seed,flash,aux | bound,0,0,0
export const MAX_SPRITES = 1600;
export const enum Spr { Player = 0, Drone = 1, Gunship = 2, Minelayer = 3, Mine = 4, Asteroid = 5, Bolt = 6, EBolt = 7, Station = 8, Boss = 9, Sniper = 10, Splitter = 11, Rammer = 12, Tender = 13, Needle = 14, Anvil = 15, Sextant = 16, Mule = 17, Shade = 18, Magpie = 19, Hive = 20, Wing = 21 }

export class SpriteBatch {
  readonly data = new Float32Array(MAX_SPRITES * SPRITE_STRIDE);
  n = 0;
  /** Altitude of the next instances (sort key, stored in the unused last slot). */
  z = 0;
  private readonly tmp = new Float32Array(SPRITE_STRIDE);
  /** Stable insertion sort by altitude so higher craft draw over lower ones (verticality). Allocation-free. */
  sortByZ(): void {
    const d = this.data, t = this.tmp, S = SPRITE_STRIDE;
    for (let i = 1; i < this.n; i++) {
      const key = d[i * S + 11];
      if (d[(i - 1) * S + 11] <= key) continue;
      t.set(d.subarray(i * S, i * S + S));
      let j = i - 1;
      while (j >= 0 && d[j * S + 11] > key) { d.copyWithin((j + 1) * S, j * S, j * S + S); j--; }
      d.set(t, (j + 1) * S);
    }
  }
  reset(): void { this.n = 0; }
  add(x: number, y: number, ang: number, size: number, type: number, seed: number, flash: number, aux: number, scale = 1, shade = 1): void {
    if (this.n >= MAX_SPRITES) return;
    const o = this.n++ * SPRITE_STRIDE, d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = ang; d[o + 3] = size;
    d[o + 4] = type; d[o + 5] = seed; d[o + 6] = flash; d[o + 7] = aux; d[o + 8] = size; d[o + 9] = scale; d[o + 10] = shade; d[o + 11] = this.z;
  }
}
