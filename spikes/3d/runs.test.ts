import { describe, expect, it } from 'vitest';
import { DT } from '../../src/sim/sim';
import { makePlanet } from './planet';
import type { Frame3 } from './render';
import { reportWindows } from './report';
import { FlickerRun, LATE_FRAMES, PerfRun, type ReportRenderer } from './runs';

const planet = makePlanet(1);

/** A renderer whose picture alternates, so every flicker and change count is known. */
class Fake implements ReportRenderer {
  readonly cols = 4; readonly rows = 1; frame = 0; settled = false; hasTimer = true;
  readonly stats = { tiles: 0, tris: 0, pending: 0, buildMsMean: 1.5, buildMsMax: 4, workerBuilt: 3, syncBuilt: 6 };
  readonly log: string[] = []; readonly frames: Frame3[] = [];
  render(f: Frame3): void {
    this.frame++; this.settled = true;
    this.stats.tiles = this.frame; this.stats.tris = this.frame * 10;
    this.frames.push({ ...f, camPos: { ...f.camPos }, ship: f.ship && { pos: { ...f.ship.pos }, q: f.ship.q } });
    this.log.push(`r${f.stab}`);
  }
  readGlyphs(out: Uint8Array): void { out.fill(0); out[0] = this.frame & 1; }
  resetHistory(): void { this.log.push('reset'); }
}

describe('FlickerRun', () => {
  it('measures each phase and mode from three consecutive frames of its own, starting without history', () => {
    const r = new Fake(), windows = reportWindows('0.1', 0).flatMap(w => [0, 1, 2].map(mode => ({ ...w, mode: mode as 0 | 1 | 2 })));
    const run = new FlickerRun(r, planet, windows);
    let ticks = 0;
    while (run.tick()) ticks++;
    expect(ticks).toBe(12 * (2 + 6));
    expect(run.rows.length).toBe(12);
    // one cell in four alternates: every sample is a quarter, whatever the window
    for (const row of run.rows) expect([row.frames, row.flickerMean, row.flickerP95, row.changeMean, row.changeP95]).toEqual([6, 0.25, 0.25, 0.25, 0.25]);
    expect(run.rows.map(x => x.mode).slice(0, 3)).toEqual([0, 1, 2]);
    // history dropped before the first frame of every window
    expect(r.log.slice(0, 10)).toEqual(['reset', 'r0', 'r0', 'r0', 'r0', 'r0', 'r0', 'r0', 'r0', 'reset']);
    expect(r.log.filter(x => x === 'reset').length).toBe(12);
    const times = r.frames.slice(0, 8).map(f => f.time);
    expect(times).toEqual([-DT, -DT, 0, DT, 2 * DT, 3 * DT, 4 * DT, 5 * DT]);
    expect(r.frames.every(f => f.ship !== null)).toBe(true);
  });
});

describe('PerfRun', () => {
  const run = (secs: string) => {
    const r = new Fake();
    let clock = 0;
    const p = new PerfRun(r, planet, reportWindows(secs, 2), () => (clock += 0.25));
    return { r, p };
  };
  it('records the path frames only, then waits for late graphics results', () => {
    const { r, p } = run('0.1');
    let ticks = 0;
    while (p.tick()) {
      ticks++;
      p.end(r.frame === 1 ? 500 : 16, 2);
      p.gpu(r.frame, 5);
    }
    expect(ticks).toBe(4 * (2 + 6) + LATE_FRAMES);
    const d = p.data();
    expect(d.frames).toBe(24);
    expect(d.frame.max).toBe(16); // the settling frame with its 500 ms is outside
    expect(d.processor.p95).toBe(2);
    expect(d.gpuSamples).toBe(24);
    expect(d.sim.p95).toBeCloseTo(0.25, 12); expect(d.sim.mean).toBeCloseTo(0.25, 12);
    expect(d.pose.p95).toBeGreaterThan(0);
    expect(d.tilesPeak).toBe(4 * 8); // the last measured frame, not one of the late ones
    expect(d.trisPeak).toBe(4 * 8 * 10);
    expect([d.buildMean, d.buildMax, d.builds]).toEqual([1.5, 4, 9]);
    expect(d.stab).toBe(2);
    expect(r.frames[r.frames.length - 1].time).toBeCloseTo(45 + 5 * DT, 9); // late frames hold the last picture
    expect(r.log).not.toContain('r0');
  });
});
