/** Flicker measures over frames of characters (one index per cell, as Renderer3.readGlyphs gives them). */
export { nearestRank as percentile } from './timing';

function sameSize(a: Uint8Array, b: Uint8Array): void {
  if (a.length !== b.length) throw new Error(`frames of different sizes: ${a.length} and ${b.length} cells`);
}

/** Share of cells that show something else in the middle frame of three and the same again after it. */
export function flickerRate(a: Uint8Array, b: Uint8Array, c: Uint8Array): number {
  sameSize(a, b); sameSize(a, c);
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === c[i] && b[i] !== a[i]) n++;
  return a.length ? n / a.length : 0;
}

/** Share of cells that differ between two frames. */
export function changeRate(a: Uint8Array, b: Uint8Array): number {
  sameSize(a, b);
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return a.length ? n / a.length : 0;
}
