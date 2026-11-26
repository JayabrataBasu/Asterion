/** Frame timing without a GPU in the loop: graphics timer queries tagged with their frame, and a fixed-length
 *  measurement window. Both are driven through small interfaces so they can be tested with a fake. */

/** The timer-query calls FrameTimer needs (WebGL2 + EXT_disjoint_timer_query_webgl2, or a fake). */
export interface QueryApi<Q> {
  create(): Q;
  begin(q: Q): void;
  end(q: Q): void;
  available(q: Q): boolean;
  resultNs(q: Q): number;
  /** Reads and clears the disjoint flag: true if timing was unreliable since the last read. */
  disjoint(): boolean;
}

interface Slot<Q> { q: Q; frame: number; busy: boolean }

/** A ring of `depth` queries. Each measured frame gets its own query; a result is delivered once, with the frame it
 *  belongs to, in frame order among the results ready at that poll. A frame that finds every slot waiting is
 *  not measured (`dropped`); a result read while the disjoint flag is up is thrown away (`discarded`); a query
 *  still waiting `giveUpFrames` frames later is abandoned (`lost`). Nothing is ever delivered twice. */
export class FrameTimer<Q> {
  dropped = 0; discarded = 0; lost = 0; delivered = 0;
  private readonly slots: Slot<Q>[] = [];
  private open: Slot<Q> | null = null;
  private readonly ready: Slot<Q>[] = [];

  constructor(private readonly api: QueryApi<Q>, depth = 5, private readonly giveUpFrames = 60) {
    for (let i = 0; i < depth; i++) this.slots.push({ q: api.create(), frame: -1, busy: false });
  }

  /** Starts timing frame `frame`, if a slot is free. */
  begin(frame: number): void {
    for (const s of this.slots) {
      if (s.busy && frame - s.frame >= this.giveUpFrames) { s.busy = false; this.lost++; }
    }
    const s = this.slots.find(x => !x.busy);
    if (!s) { this.dropped++; return; }
    s.busy = true; s.frame = frame; this.open = s;
    this.api.begin(s.q);
  }

  /** Ends the frame's timing, if begin started one. */
  end(): void {
    if (!this.open) return;
    this.api.end(this.open.q);
    this.open = null;
  }

  /** Hands over every result that has arrived: `take(frame, ms)`. */
  poll(take: (frame: number, ms: number) => void): void {
    this.ready.length = 0;
    for (const s of this.slots) if (s.busy && s !== this.open && this.api.available(s.q)) this.ready.push(s);
    if (this.ready.length === 0) return;
    const disjoint = this.api.disjoint();
    this.ready.sort((a, b) => a.frame - b.frame);
    for (const s of this.ready) {
      s.busy = false;
      if (disjoint) { this.discarded++; continue; }
      this.delivered++;
      take(s.frame, this.api.resultNs(s.q) / 1e6);
    }
  }
}

/** Nearest-rank percentile, q in 0..1; 0 for no values. */
export function nearestRank(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

export const SLOW_MS = 25;
export interface Spread { p50: number; p95: number; max: number }
export interface MeasureResult {
  /** Frames in the window. */
  frames: number;
  /** Frames of the window that got a graphics time, and those that did not (dropped, discarded, lost, late). */
  gpuSamples: number; gpuMissing: number;
  /** Frames whose interval passed SLOW_MS: missed at least one display refresh at 60 Hz. */
  slowFrames: number;
  /** Interval between frame callbacks, whole-callback processor time, graphics time; all ms. */
  frame: Spread; tick: Spread; gpu: Spread;
}

/** A window of `n` consecutive frames: their interval and processor time, and the graphics time of each one that
 *  got a fresh reading. Graphics results arrive a few frames late, so keep feeding `gpu` after `full`. */
export class Measure {
  private readonly frameNos: number[] = []; private readonly interval: number[] = []; private readonly tickMs: number[] = [];
  private readonly gpuMs = new Map<number, number>();
  constructor(readonly n: number) {}
  get full(): boolean { return this.frameNos.length >= this.n; }
  frame(frameNo: number, intervalMs: number, tickMs: number): void {
    if (this.full) return;
    this.frameNos.push(frameNo); this.interval.push(intervalMs); this.tickMs.push(tickMs);
  }
  gpu(frameNo: number, ms: number): void {
    if (this.gpuMs.has(frameNo) || !this.frameNos.includes(frameNo)) return;
    this.gpuMs.set(frameNo, ms);
  }
  result(): MeasureResult {
    const spread = (v: number[]): Spread => ({ p50: nearestRank(v, 0.5), p95: nearestRank(v, 0.95), max: nearestRank(v, 1) });
    const g = [...this.gpuMs.values()];
    return {
      frames: this.frameNos.length, gpuSamples: g.length, gpuMissing: this.frameNos.length - g.length,
      slowFrames: this.interval.filter(v => v > SLOW_MS).length,
      frame: spread(this.interval), tick: spread(this.tickMs), gpu: spread(g),
    };
  }
}
