/**
 * Glyph atlas: every character the game can draw, rasterised once into a texture at the exact device-pixel
 * cell size (so the ASCII pass can texelFetch pixel-perfectly). Also measures ink density per glyph so
 * brightness ramps are derived from the actual font instead of guessed.
 */
const ASCII = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');
const EXTRA = '·•○●◉◆◇▲▼◀▶░▒▓█▀▄▌▐■□▪═║╔╗╚╝╠╣╦╩╬─│┌┐└┘├┤┬┴┼╱╲╳∙°≈≡±×÷«»‹›✦✧★☆¤¦§';
export const CHARSET = ASCII + EXTRA;
if (CHARSET.length > 256) throw new Error('charset too large');

export const ATLAS_COLS = 16;
const CODE2IDX = new Uint8Array(65536);
for (let i = 0; i < CHARSET.length; i++) CODE2IDX[CHARSET.charCodeAt(i)] = i;

/** char -> atlas index (cold path; use for constants). */
export function gi(ch: string): number { return CODE2IDX[ch.charCodeAt(0)]; }
export function glyphOfCode(code: number): number { return CODE2IDX[code & 0xffff]; }

export const FONT_STACK = '"JetBrains Mono","JetBrainsMono Nerd Font Mono","JetBrainsMono NFM","SF Mono",Menlo,Consolas,"DejaVu Sans Mono",monospace';

export interface AtlasInfo {
  canvas: HTMLCanvasElement;
  cw: number; ch: number;
  density: Float32Array;     // per glyph index, 0..1 normalised ink coverage
  sig: Uint8Array;           // 4x8 ink signature per glyph, layout [(g*8+sy)*4+sx], for shape matching
}

/** Glyphs the sprite matcher may choose from (structural ASCII; letters excluded on purpose). */
export const MATCH_CHARS = ".,'`:;!|/\\()[]{}<>-_=+*^#";   // shape glyphs only: @ & $ % read as noise on hull edges
export const FILL_CHARS = ".:-=+*##";
export const MATCH_IDX = new Int32Array(48);
export let MATCH_N = 0;
{ const seen = new Set<number>(); for (const c of MATCH_CHARS) { const i = CODE2IDX[c.charCodeAt(0)]; if (i && !seen.has(i) && MATCH_N < 48) { seen.add(i); MATCH_IDX[MATCH_N++] = i; } } }

export function buildAtlas(cw: number, ch: number, weight = 600): AtlasInfo {
  const rows = Math.ceil(CHARSET.length / ATLAS_COLS);
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_COLS * cw; canvas.height = rows * ch;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.clearRect(0, 0, canvas.width, canvas.height);
  const fs = Math.round(ch * 0.78);
  g.font = `${weight} ${fs}px ${FONT_STACK}`;
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  g.fillStyle = '#fff';
  // vertical placement: centre the cap-height inside the cell
  const baseline = Math.round(ch * 0.5 + fs * 0.36);
  for (let i = 0; i < CHARSET.length; i++) {
    const x = (i % ATLAS_COLS) * cw + cw / 2, y = Math.floor(i / ATLAS_COLS) * ch + baseline;
    g.save();
    g.beginPath(); g.rect((i % ATLAS_COLS) * cw, Math.floor(i / ATLAS_COLS) * ch, cw, ch); g.clip();
    // box-drawing / block glyphs should fill the cell exactly
    g.fillText(CHARSET[i], x, y);
    g.restore();
  }
  const img = g.getImageData(0, 0, canvas.width, canvas.height).data;
  const density = new Float32Array(256);
  let max = 1e-6;
  for (let i = 0; i < CHARSET.length; i++) {
    const ox = (i % ATLAS_COLS) * cw, oy = Math.floor(i / ATLAS_COLS) * ch;
    let sum = 0;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) sum += img[((oy + y) * canvas.width + ox + x) * 4 + 3];
    density[i] = sum / (cw * ch * 255);
    if (CHARSET[i] !== '█' && density[i] > max) max = density[i];
  }
  for (let i = 0; i < 256; i++) density[i] = Math.min(1, density[i] / max);

  // 4x8 ink signatures (area-averaged), normalised so the densest matchable glyph averages ~1
  const sig = new Uint8Array(4 * 8 * 256);
  const raw = new Float32Array(4 * 8 * 256);
  let refMean = 1e-6;
  for (let i = 0; i < CHARSET.length; i++) {
    const ox = (i % ATLAS_COLS) * cw, oy = Math.floor(i / ATLAS_COLS) * ch;
    let mean = 0;
    for (let sy = 0; sy < 8; sy++) for (let sx = 0; sx < 4; sx++) {
      const x0 = Math.floor(sx * cw / 4), x1 = Math.max(x0 + 1, Math.floor((sx + 1) * cw / 4));
      const y0 = Math.floor(sy * ch / 8), y1 = Math.max(y0 + 1, Math.floor((sy + 1) * ch / 8));
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { sum += img[((oy + y) * canvas.width + ox + x) * 4 + 3]; n++; }
      const v = sum / (n * 255);
      raw[(i * 8 + sy) * 4 + sx] = v; mean += v / 32;
    }
    for (let m = 0; m < MATCH_N; m++) if (MATCH_IDX[m] === i && mean > refMean) refMean = mean;
  }
  for (let k = 0; k < raw.length; k++) sig[k] = Math.round(Math.min(1, raw[k] / refMean) * 255);
  return { canvas, cw, ch, density, sig };
}

/** Ramp definitions: candidate chars are density-sorted at runtime so the ramp is monotonic for this font. */
export const RAMPS: { name: string; chars: string; levels: number }[] = [
  { name: 'classic', chars: ' .:-=+*#%@', levels: 10 },
  { name: 'dense',  chars: ' .,:;-~=+*xX#%&@', levels: 14 },
  { name: 'dots',   chars: ' ·∙:•○●◉', levels: 8 },
  { name: 'blocks', chars: ' ░▒▓█', levels: 5 },
  { name: 'matrix', chars: ' .:;+=xX$&#@', levels: 12 },
];

/** Builds the 256-entry luminance -> glyph index LUT for a ramp. */
export function buildRampLut(ramp: number, density: Float32Array, out: Uint8Array): void {
  const def = RAMPS[ramp % RAMPS.length];
  const cand: number[] = [];
  for (const c of def.chars) cand.push(gi(c));
  cand.sort((a, b) => density[a] - density[b]);
  // keep strictly increasing density, then resample to `levels`
  const mono: number[] = [];
  for (const g of cand) if (mono.length === 0 || density[g] - density[mono[mono.length - 1]] > 0.004) mono.push(g);
  const n = Math.min(def.levels, mono.length);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const k = Math.min(n - 1, Math.floor(t * n * 0.999));
    const src = n === mono.length ? k : Math.round(k * (mono.length - 1) / Math.max(1, n - 1));
    out[i] = i === 0 ? 0 : mono[src];
  }
}
