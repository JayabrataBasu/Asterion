/** Flicker measures over frames of characters (one index per cell, as Renderer3.readGlyphs gives them). */
import { nearestRank } from './timing';

export { nearestRank as percentile };

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

export interface FlickerSummary { flickerMean: number; flickerP95: number; changeMean: number; changeP95: number }

const mean = (v: number[]): number => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0);

/** The samples of one unbroken run of frames: a change rate per pair of neighbours, a flicker rate per three. Make a
 *  new one for every run, so that no sample straddles two. */
export class FlickerTally {
  readonly flicker: number[] = []; readonly change: number[] = [];
  private readonly ring: Uint8Array[];
  private n = 0;
  constructor(cells: number) { this.ring = [0, 1, 2].map(() => new Uint8Array(cells)); }
  /** The buffer to put the next frame in, before calling add. */
  next(): Uint8Array { return this.ring[this.n % 3]; }
  add(): void {
    const n = this.n++, at = (ago: number): Uint8Array => this.ring[(n - ago) % 3];
    if (n >= 1) this.change.push(changeRate(at(1), at(0)));
    if (n >= 2) this.flicker.push(flickerRate(at(2), at(1), at(0)));
  }
  summary(): FlickerSummary {
    return {
      flickerMean: mean(this.flicker), flickerP95: nearestRank(this.flicker, 0.95),
      changeMean: mean(this.change), changeP95: nearestRank(this.change, 0.95),
    };
  }
}
