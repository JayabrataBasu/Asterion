import { describe, expect, it } from 'vitest';
import { DT } from '../../src/sim/sim';
import { PathRun, type PathStep, type ReportWindow, formatFlicker, formatPerf, reportWindows } from './report';

const info = {
  browser: 'TestBrowser/1.0', gpu: 'Test GPU', W: 1920, H: 1080, cssW: 1920, cssH: 1080, dpr: 1, cols: 240, rows: 67,
  scale: 'radiusK 150', sync: false, notes: [] as string[],
};

describe('reportWindows', () => {
  it('is the four whole 15 s phases by default', () => {
    expect(reportWindows(null, 2)).toEqual([
      { phase: 'approach', start: 0, frames: 900, mode: 2 }, { phase: 'descent', start: 15, frames: 900, mode: 2 },
      { phase: 'low', start: 30, frames: 900, mode: 2 }, { phase: 'climb', start: 45, frames: 900, mode: 2 },
    ]);
  });
  it('takes the first secs seconds of each phase', () => {
    const w = reportWindows('2', 1);
    expect(w.map(x => [x.start, x.frames, x.mode])).toEqual([[0, 120, 1], [15, 120, 1], [30, 120, 1], [45, 120, 1]]);
  });
  it('keeps secs within a phase and long enough for one flicker sample', () => {
    expect(reportWindows('99', 0)[0].frames).toBe(900);
    expect(reportWindows('0.001', 0)[0].frames).toBe(3);
    for (const bad of ['0', '-3', 'abc', '']) expect(reportWindows(bad, 0)[0].frames).toBe(900);
  });
});

/** Runs a PathRun, `settled` saying whether the render of the step before it was settled. */
function drive(run: PathRun, settled: (i: number) => boolean = () => true): PathStep[] {
  const out: PathStep[] = [];
  for (let i = 0; i < 100000; i++) {
    const s = run.step(i > 0 && settled(i));
    if (!s) return out;
    out.push(s);
  }
  throw new Error('never ends');
}
const W = (start: number, frames: number, mode: 0 | 1 | 2 = 2): ReportWindow => ({ phase: 'low', start, frames, mode });

describe('PathRun', () => {
  it('settles and leads in one step before the window, then advances exactly 1/60 s a frame', () => {
    const steps = drive(new PathRun([W(30, 4)], true));
    expect(steps.map(s => s.frame)).toEqual([-1, -1, 0, 1, 2, 3]);
    expect(steps.map(s => s.fresh)).toEqual([true, false, false, false, false, false]);
    expect(steps.slice(0, 2).map(s => s.t)).toEqual([30 - DT, 30 - DT]);
    expect(steps.slice(2).map(s => s.t)).toEqual([0, 1, 2, 3].map(i => 30 + i * DT));
    expect(steps.every(s => s.window === 0)).toBe(true);
  });
  it('waits for the tiles, then takes one more unmeasured step', () => {
    const run = new PathRun([W(30, 3)], true);
    const steps = drive(run, i => i >= 5);
    expect(steps.map(s => s.frame)).toEqual([-1, -1, -1, -1, -1, -1, 0, 1, 2]);
    expect(run.unsettled).toBe(0);
  });
  it('does not take the settled state of the previous window for the new one', () => {
    const steps = drive(new PathRun([W(0, 3), W(15, 3)], true));
    expect(steps.filter(s => s.window === 1).map(s => s.frame)).toEqual([-1, -1, 0, 1, 2]);
  });
  it('gives up waiting after the limit and says so', () => {
    const run = new PathRun([W(30, 3)], true, 10);
    const steps = drive(run, () => false);
    expect(steps.filter(s => s.frame >= 0).length).toBe(3);
    expect(steps.length).toBeLessThan(20);
    expect(run.unsettled).toBe(1);
  });
  it('can run windows that follow on without a break, settling only at jumps', () => {
    const steps = drive(new PathRun([W(0, 900), W(15, 900), W(30, 3), W(45, 3)], false));
    expect(steps.filter(s => s.fresh).map(s => s.window)).toEqual([0, 3]);
    const measured = steps.filter(s => s.frame >= 0);
    expect(measured.length).toBe(1806);
    expect(measured[900].t - measured[899].t).toBeCloseTo(DT, 12);
  });
  it('starts afresh for every window when asked, also for the same window in another mode', () => {
    const steps = drive(new PathRun([W(0, 900, 0), W(15, 900, 0), W(15, 900, 1)], true));
    expect(steps.filter(s => s.fresh).map(s => s.window)).toEqual([0, 1, 2]);
  });
});

describe('formatPerf', () => {
  const spread = (p50: number, p95: number, max: number) => ({ p50, p95, max });
  const data = {
    stab: 2, windows: reportWindows(null, 2), frames: 3600, slowFrames: 3, measuredMs: 90000,
    frame: spread(16.7, 16.9, 41.2), processor: spread(1.1, 2.2, 9.9), pose: spread(0.1, 0.2, 0.9),
    sim: { p95: 0.1, mean: 0.0031 }, timerStep: 0.1,
    gpu: spread(5.5, 7.5, 12), gpuSamples: 3590, hasTimer: true,
    tilesPeak: 91, trisPeak: 61234, pendingPeak: 40, buildMean: 0.93, buildMax: 6.4, builds: 4100,
  };
  it('gives every figure asked for', () => {
    const text = formatPerf({ ...info, notes: ['restarted once'] }, data);
    for (const part of [
      'TestBrowser/1.0', 'Test GPU', '1920x1080', '240x67', 'full 15 s phases', '3600 frames',
      'p50 16.70', 'p95 16.90', 'worst 41.20', '3 over 25 ms', 'p95 2.20', 'p95 0.10', 'mean 0.0031', '5.50', '7.50',
      'tiles 91', 'triangles 61234', 'mean 0.93', 'worst 6.40', 'radiusK 150', 'restarted once', 'timer step 0.100 ms',
    ]) expect(text).toContain(part);
  });
  it('gives slow frames per minute of measured time, beside the count and the worst frame', () => {
    const frameLine = (o: object): string => formatPerf(info, { ...data, ...o }).split('\n').find(l => l.startsWith('frame ms'))!;
    const line = frameLine({});
    for (const part of ['worst 41.20', '3 over 25 ms', '2.0 per minute']) expect(line).toContain(part);
    expect(formatPerf(info, data)).toContain('p95 at most 17.5 ms, and at most 3 per minute over 25 ms');
    expect(frameLine({ slowFrames: 7, measuredMs: 60000 })).toContain('7.0 per minute');
    expect(frameLine({ slowFrames: 1, measuredMs: 8000 })).toContain('7.5 per minute');
    expect(frameLine({ slowFrames: 0, measuredMs: 0 })).toContain('0.0 per minute');
  });
  it('calls the simulation time one ship only, with no budget', () => {
    const line = formatPerf(info, data).split('\n').find(l => l.startsWith('simulation ms'))!;
    expect(line).toContain('one ship only');
    expect(line).toContain('not the game\'s simulation budget');
    expect(line).not.toMatch(/budget 2/);
  });
  it('names the stability mode, its key and its stab value', () => {
    expect(formatPerf(info, data)).toContain('stability mode held (key 3, stab=2)');
    expect(formatPerf(info, { ...data, stab: 0 })).toContain('stability mode dithered (key 1, stab=0)');
    expect(formatPerf(info, { ...data, stab: 1 })).toContain('stability mode plain (key 2, stab=1)');
  });
  it('says where tiles were built', () => {
    expect(formatPerf(info, data)).toContain('tiles built by background workers');
    expect(formatPerf({ ...info, sync: true }, data)).toContain('tiles built on the main thread');
  });
  it('says when graphics time is not available', () => {
    const text = formatPerf(info, { ...data, hasTimer: false, gpuSamples: 0 });
    expect(text).toContain('graphics ms      n/a');
    expect(text).not.toContain('7.50');
  });
  it('names a shortened run', () => {
    expect(formatPerf(info, { ...data, windows: reportWindows('2', 2) })).toContain('first 2 s of each phase');
  });
});

describe('formatFlicker', () => {
  const rows = [0, 1, 2].flatMap(mode => (['approach', 'descent', 'low', 'climb'] as const).map(phase => ({
    phase, mode: mode as 0 | 1 | 2, frames: 900, flickerMean: 0.001 * (mode + 1), flickerP95: 0.00448, changeMean: 0.03133, changeP95: 0.05174,
  })));
  it('is a table of percentages, one row per phase and mode, by phase', () => {
    const text = formatFlicker(info, rows);
    const table = text.split('\n').filter(l => /^(approach|descent|low|climb) /.test(l));
    expect(table.length).toBe(12);
    expect(table.map(l => l.split(/\s+/).slice(0, 2).join(' ')).slice(0, 4))
      .toEqual(['approach dithered', 'approach plain', 'approach held', 'descent dithered']);
    expect(table[2].split(/\s+/)).toEqual(['approach', 'held', '900', '0.300', '0.448', '3.133', '5.174']);
    expect(text).toContain('mode: dithered (key 1, stab=0), plain (key 2, stab=1), held (key 3, stab=2)');
    expect(text).toContain('240x67');
    expect(text).toContain('TestBrowser/1.0');
    expect(text).toContain('full 15 s phases');
  });
});

describe('formatFlicker notes', () => {
  const rows = [{ phase: 'low' as const, mode: 2 as const, frames: 900, flickerMean: 0, flickerP95: 0, changeMean: 0, changeP95: 0 }];
  const notes = (o: object = {}): string[] =>
    formatFlicker({ ...info, sync: true, ...o }, rows).split('\n').filter(l => l.startsWith('note '));

  it('say how far the flicker figure can be trusted', () => {
    const text = notes().join('\n');
    for (const part of [
      'flicker is for comparing modes', 'beside the change rate', 'screen-fixed speckle and crawl are not counted',
      'lower or boosted flight moves the ground more than this path does', 'the eye decides the look',
    ]) expect(text).toContain(part);
    for (const line of notes()) expect(line.length).toBeLessThanOrEqual(110);
  });
  it('say that worker tile arrival pop is left out, when tiles are built on the main thread', () => {
    const pop = 'worker tile arrival pop is not included; judge popping during descent by eye';
    expect(notes().join('\n')).toContain(pop);
    expect(notes({ sync: false }).join('\n')).not.toContain(pop);
  });
  it('keep the notes of the run itself', () => {
    expect(notes({ notes: ['started again once'] }).some(l => l.includes('started again once'))).toBe(true);
  });
});

describe('reports with a swarm (combat load test)', () => {
  const tally = (drawn: number, hidden: number, covered: number, off: number) => ({ drawn, hidden, covered, off });
  const swarm = {
    scene: 'combat', ships: 14, bolts: 200, particles: 2000, samples: 60,
    mean: { ships: tally(3.25, 1, 0, 8), markers: tally(0.5, 0.25, 0, 1), bolts: tally(70, 12, 3, 115), particles: tally(600, 200, 150, 1050) },
  };
  const spread = (p50: number, p95: number, max: number) => ({ p50, p95, max });
  const perf = {
    stab: 2, windows: reportWindows(null, 2), frames: 3600, slowFrames: 0, measuredMs: 60000,
    frame: spread(16.7, 16.9, 20), processor: spread(2, 3, 5), pose: spread(0.1, 0.2, 0.9),
    sim: { p95: 0.1, mean: 0.01 }, timerStep: 0.1, gpu: spread(6, 8, 12), gpuSamples: 3600, hasTimer: true,
    tilesPeak: 91, trisPeak: 61234, pendingPeak: 40, buildMean: 0.9, buildMax: 6, builds: 800,
    swarm: { motion: spread(0.4, 0.55, 1.5), build: spread(0.7, 0.95, 2.5) },
  };
  const line = (text: string, start: string): string => text.split('\n').find(l => l.startsWith(start))!;
  const flickerRows = [{ phase: 'low' as const, mode: 2 as const, frames: 900, flickerMean: 0, flickerP95: 0, changeMean: 0, changeP95: 0 }];

  it('name the scene and its counts', () => {
    for (const text of [formatPerf({ ...info, swarm }, perf), formatFlicker({ ...info, swarm }, flickerRows)]) {
      expect(line(text, 'scene')).toContain('combat: 14 other ships, 200 bolts, 2000 particles');
    }
  });
  it('give the mean drawn, hidden, covered and off screen per sampled frame', () => {
    for (const text of [formatPerf({ ...info, swarm }, perf), formatFlicker({ ...info, swarm }, flickerRows)]) {
      expect(text).toContain('60 sampled frames');
      expect(line(text, 'per frame').split(/\s{2,}/).slice(1)).toEqual(['drawn', 'hidden', 'covered', 'off screen']);
      expect(line(text, '  mesh ships').split(/\s{2,}/).slice(2)).toEqual(['3.3', '1.0', '0.0', '8.0']);
      expect(line(text, '  marker ships').split(/\s{2,}/).slice(2)).toEqual(['0.5', '0.3', '0.0', '1.0']);
      expect(line(text, '  bolts').split(/\s{2,}/).slice(2)).toEqual(['70.0', '12.0', '3.0', '115.0']);
      expect(line(text, '  particles').split(/\s{2,}/).slice(2)).toEqual(['600.0', '200.0', '150.0', '1050.0']);
    }
  });
  it('give the processor time of motion and of the lists in the performance report', () => {
    const text = formatPerf({ ...info, swarm }, perf);
    expect(line(text, 'swarm motion ms')).toContain('p95 0.55');
    expect(line(text, 'swarm lists ms')).toContain('p95 0.95');
  });
  it('say that the glyph read-back takes in the new characters', () => {
    expect(formatFlicker({ ...info, swarm }, flickerRows)).toContain('glyph read-back includes markers, bolts and particles');
  });
  it('say nothing of a swarm when there is none', () => {
    const { swarm: _, ...plain } = perf;
    for (const text of [formatPerf(info, plain), formatFlicker(info, flickerRows)]) {
      expect(text).not.toMatch(/scene|swarm|bolt|particle/);
    }
  });
});
