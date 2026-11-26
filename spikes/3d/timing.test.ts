import { describe, expect, it } from 'vitest';
import { FrameTimer, Measure, type QueryApi, nearestRank } from './timing';

/** A fake GPU: each query gets a result (ns) and becomes available when the test says so. */
class FakeGpu implements QueryApi<number> {
  next = 0; open = -1; disjointFlag = false;
  readonly ready = new Set<number>(); readonly ns = new Map<number, number>(); readonly began: number[] = [];
  create(): number { return this.next++; }
  begin(q: number): void { expect(this.open).toBe(-1); this.open = q; this.began.push(q); this.ready.delete(q); }
  end(q: number): void { expect(this.open).toBe(q); this.open = -1; }
  available(q: number): boolean { return this.ready.has(q); }
  resultNs(q: number): number { return this.ns.get(q) ?? 0; }
  disjoint(): boolean { const d = this.disjointFlag; this.disjointFlag = false; return d; }
  /** Finishes the query begun `ago` begins back, with `ms`. */
  finish(ago: number, ms: number): void { const q = this.began[this.began.length - 1 - ago]; this.ns.set(q, ms * 1e6); this.ready.add(q); }
}

function run(_gpu: FakeGpu, timer: FrameTimer<number>, frame: number, got: [number, number][]): void {
  timer.begin(frame); timer.end();
  timer.poll((f, ms) => got.push([f, ms]));
}

describe('FrameTimer', () => {
  it('delivers each frame once, tagged with its own frame, also when results come late and out of order', () => {
    const gpu = new FakeGpu(), t = new FrameTimer(gpu, 5), got: [number, number][] = [];
    run(gpu, t, 1, got); run(gpu, t, 2, got); run(gpu, t, 3, got);
    gpu.finish(0, 3.3); gpu.finish(2, 1.1); // frame 3 and frame 1 ready, frame 2 not yet
    run(gpu, t, 4, got);                     // frame 4's query is begun after finish(): not ready
    gpu.finish(2, 2.2);                      // frame 2
    run(gpu, t, 5, got);
    run(gpu, t, 6, got);
    expect(got).toEqual([[1, 1.1], [3, 3.3], [2, 2.2]]);
    expect(new Set(got.map(g => g[0])).size).toBe(got.length);
  });

  it('skips frames (counted) while every slot is waiting, and never repeats a value', () => {
    const gpu = new FakeGpu(), t = new FrameTimer(gpu, 4), got: [number, number][] = [];
    for (let f = 1; f <= 10; f++) run(gpu, t, f, got);
    expect(got).toEqual([]);
    expect(t.dropped).toBe(6);
    expect(gpu.began.length).toBe(4);
  });

  it('gives up on a result that never comes, without delivering anything for it', () => {
    const gpu = new FakeGpu(), t = new FrameTimer(gpu, 4, 8), got: [number, number][] = [];
    for (let f = 1; f <= 30; f++) {
      const before = gpu.began.length;
      run(gpu, t, f, got);
      if (f > 12 && gpu.began.length > before) gpu.finish(0, f); // only queries begun after frame 12 ever finish
    }
    expect(t.lost).toBeGreaterThan(0);
    for (const [f, ms] of got) expect(ms).toBe(f);
    expect(new Set(got.map(g => g[0])).size).toBe(got.length);
  });

  it('discards results read during a disjoint event', () => {
    const gpu = new FakeGpu(), t = new FrameTimer(gpu, 5), got: [number, number][] = [];
    run(gpu, t, 1, got); gpu.finish(0, 5);
    gpu.disjointFlag = true;
    run(gpu, t, 2, got);        // frame 1's result is read while the disjoint flag is up
    gpu.finish(0, 2);           // frame 2
    run(gpu, t, 3, got);
    expect(got).toEqual([[2, 2]]);
    expect(t.discarded).toBe(1);
  });
});

describe('Measure', () => {
  it('counts frames, fresh graphics samples and the frames that got none', () => {
    const m = new Measure(4);
    m.frame(1, 16.7, 1.0); m.frame(2, 16.7, 1.5); m.frame(3, 16.6, 0.9); m.frame(4, 16.8, 1.2);
    m.gpu(1, 5); m.gpu(3, 6); m.gpu(9, 99); // frame 9 is outside the window
    m.gpu(3, 7);                           // a second value for one frame is ignored
    expect(m.full).toBe(true);
    const r = m.result();
    expect(r.frames).toBe(4); expect(r.gpuSamples).toBe(2); expect(r.gpuMissing).toBe(2);
    expect(r.gpu.p50).toBe(5); expect(r.gpu.p95).toBe(6);
    expect(r.tick.p95).toBe(1.5);
    expect(r.slowFrames).toBe(0);
  });
  it('counts frames whose interval passes 25 ms', () => {
    const m = new Measure(3);
    m.frame(1, 16.7, 1); m.frame(2, 33.4, 1); m.frame(3, 25, 1);
    expect(m.result().slowFrames).toBe(1);
  });
  it('nearestRank', () => {
    expect(nearestRank([1, 2, 3, 4, 100], 0.95)).toBe(100);
    expect(nearestRank([3, 1, 2], 0.5)).toBe(2);
    expect(nearestRank([], 0.5)).toBe(0);
  });
});
