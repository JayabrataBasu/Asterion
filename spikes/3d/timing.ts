/** Frame timing without a GPU in the loop: graphics timer queries tagged with their frame, and a fixed-length
 *  measurement window. Both are driven through small interfaces so they can be tested with a fake. */

/** The timer-query calls FrameTimer needs (WebGL2 + EXT_disjoint_timer_query_webgl2, or a fake). */
export interface QueryApi<Q> {
  create(): Q;
  remove(q: Q): void;
  begin(q: Q): void;
  end(q: Q): void;
  available(q: Q): boolean;
  resultNs(q: Q): number;
  /** Reads and clears the disjoint flag: true if timing was unreliable since the last read. */
  disjoint(): boolean;
}

interface Slot<Q> { q: Q; frame: number; busy: boolean; tainted: boolean }

/** A ring of `depth` queries. Each measured frame gets its own query; a result is delivered once, with the frame it
 *  belongs to, in frame order among the results ready at that poll. A frame that finds every slot waiting is
 *  not measured (`dropped`). The disjoint flag is read at every poll, and when it is up every query pending then is
 *  tainted: its result is thrown away when it arrives (`discarded`). A query still waiting `giveUpFrames` frames
 *  later is abandoned (`lost`) and its object replaced. Nothing is ever delivered twice. */
export class FrameTimer<Q> {
  dropped = 0; discarded = 0; lost = 0; delivered = 0;
  private readonly slots: Slot<Q>[] = [];
  private open: Slot<Q> | null = null;
  private readonly ready: Slot<Q>[] = [];

  constructor(private readonly api: QueryApi<Q>, depth = 5, private readonly giveUpFrames = 60) {
    for (let i = 0; i < depth; i++) this.slots.push({ q: api.create(), frame: -1, busy: false, tainted: false });
  }

  /** Starts timing frame `frame`, if a slot is free. */
  begin(frame: number): void {
    for (const s of this.slots) {
      if (!s.busy || frame - s.frame < this.giveUpFrames) continue;
      s.busy = false; this.lost++;
      this.api.remove(s.q); s.q = this.api.create(); // the old object may still be pending: never begin it again
    }
    const s = this.slots.find(x => !x.busy);
    if (!s) { this.dropped++; return; }
    s.busy = true; s.tainted = false; s.frame = frame; this.open = s;
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
    // reading the flag clears it, so it is read even when nothing has arrived
    if (this.api.disjoint()) for (const s of this.slots) if (s.busy) s.tainted = true;
    this.ready.length = 0;
    for (const s of this.slots) if (s.busy && s !== this.open && this.api.available(s.q)) this.ready.push(s);
    if (this.ready.length === 0) return;
    this.ready.sort(byFrame);
    for (const s of this.ready) {
      s.busy = false;
      if (s.tainted) { this.discarded++; continue; }
      this.delivered++;
      take(s.frame, this.api.resultNs(s.q) / 1e6);
    }
  }
}

const byFrame = (a: { frame: number }, b: { frame: number }): number => a.frame - b.frame;

/** The graphics time for a readout: the whole-frame timer's figure, or the sum of the passes while profiling (the
 *  whole-frame timer does not run then, as timer queries cannot nest). */
export function shownGpuMs(profile: boolean, frameMs: number, passMs: ArrayLike<number>): number {
  if (!profile) return frameMs;
  let sum = 0;
  for (let i = 0; i < passMs.length; i++) sum += passMs[i];
  return sum;
}

/** The step of a clock in ms (browsers round performance.now()): the smallest of a few changes seen; 0 if it never
 *  changes within a bounded wait. */
export function timerStepMs(now: () => number): number {
  let best = Infinity, calls = 0;
  for (let n = 0; n < 8; n++) {
    const from = now();
    let to = from;
    while (to === from && calls++ < 2_000_000) to = now();
    if (to === from) break;
    if (n > 0) best = Math.min(best, to - from); // the first change starts part way through a step
  }
  return Number.isFinite(best) ? best : 0;
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
  private readonly frameNos = new Set<number>(); private readonly interval: number[] = []; private readonly tickMs: number[] = [];
  private readonly gpuMs = new Map<number, number>();
  /** The first `skip` frames handed to `frame` are left out: an interval covers the work of the frame before it. */
  constructor(readonly n: number, private skip = 0) {}
  get full(): boolean { return this.interval.length >= this.n; }
  frame(frameNo: number, intervalMs: number, tickMs: number): void {
    if (this.full) return;
    if (this.skip > 0) { this.skip--; return; }
    this.frameNos.add(frameNo); this.interval.push(intervalMs); this.tickMs.push(tickMs);
  }
  gpu(frameNo: number, ms: number): void {
    if (this.gpuMs.has(frameNo) || !this.frameNos.has(frameNo)) return;
    this.gpuMs.set(frameNo, ms);
  }
  result(): MeasureResult {
    const spread = (v: number[]): Spread => ({ p50: nearestRank(v, 0.5), p95: nearestRank(v, 0.95), max: nearestRank(v, 1) });
    const g = [...this.gpuMs.values()];
    return {
      frames: this.interval.length, gpuSamples: g.length, gpuMissing: this.interval.length - g.length,
      slowFrames: this.interval.filter(v => v > SLOW_MS).length,
      frame: spread(this.interval), tick: spread(this.tickMs), gpu: spread(g),
    };
  }
}
