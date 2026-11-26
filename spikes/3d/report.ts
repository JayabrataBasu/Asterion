/** The two reports without a browser or a renderer: which stretches of the scripted path to fly and in what order,
 *  and the text of the results. */
import { DT } from '../../src/sim/sim';
import type { FlickerSummary } from './metrics';
import { PATH_SECONDS, type Phase } from './path';
import type { Spread } from './timing';

export type Mode = 0 | 1 | 2;
/** `frames` frames of the path from `start` seconds, 1/60 s apart, drawn in stability mode `mode`. */
export interface ReportWindow { phase: Phase; start: number; frames: number; mode: Mode }

const PHASES: readonly Phase[] = ['approach', 'descent', 'low', 'climb'];
const PHASE_S = PATH_SECONDS / PHASES.length;

/** The first `secs` seconds of each phase (the URL parameter, as given), or the whole phases. At least three frames,
 *  the fewest that make a flicker sample. */
export function reportWindows(secs: string | null, mode: Mode): ReportWindow[] {
  const n = Number(secs), s = n > 0 ? Math.min(PHASE_S, n) : PHASE_S;
  const frames = Math.max(3, Math.round(s / DT));
  return PHASES.map((phase, i) => ({ phase, start: i * PHASE_S, frames, mode }));
}

/** What to draw next: the path at `t`; `frame` counts the measured frames of window `window` and is -1 for the
 *  unmeasured ones before them; `fresh` marks the first step after a break, where history must be dropped. */
export interface PathStep { t: number; window: number; frame: number; fresh: boolean }

/** Walks the windows. Before a window it shows the picture one step early until the tiles have settled, then once
 *  more, so that neither tile loading for the new place nor the interval covering it is measured. */
export class PathRun {
  /** Windows begun although the tiles never settled. */
  unsettled = 0;
  private w = 0; private i = -1; private waited = -1;

  /** `everyFresh`: treat each window as a break; otherwise only one that does not follow on from the one before. */
  constructor(private readonly windows: readonly ReportWindow[], private readonly everyFresh: boolean,
    private readonly settleLimit = 1200) {}

  /** `settled`: whether the picture of the step before this one had all its tiles. */
  step(settled: boolean): PathStep | null {
    const win = this.windows[this.w];
    if (!win) return null;
    const lead = { t: win.start - DT, window: this.w, frame: -1, fresh: false };
    if (this.i < 0) {
      if (this.waited >= 0) {
        if (!settled && this.waited < this.settleLimit) { this.waited++; return lead; }
        if (!settled) this.unsettled++;
        this.i = 0;
        return lead;
      }
      const prev = this.windows[this.w - 1];
      if (this.everyFresh || !prev || Math.abs(prev.start + prev.frames * DT - win.start) > 1e-6) {
        this.waited = 0;
        lead.fresh = true;
        return lead;
      }
      this.i = 0;
    }
    const frame = this.i++, step = { t: win.start + frame * DT, window: this.w, frame, fresh: false };
    if (this.i === win.frames) { this.w++; this.i = -1; this.waited = -1; }
    return step;
  }
}

// ------------------------------------------------------------------ text

/** Where and how a report was taken. */
export interface RunInfo {
  browser: string; gpu: string;
  W: number; H: number; cssW: number; cssH: number; dpr: number; cols: number; rows: number;
  scale: string; tiles: string; notes: string[];
}

export interface PerfData {
  stab: number; windows: readonly ReportWindow[];
  frames: number; slowFrames: number;
  frame: Spread; processor: Spread; pose: Spread; sim: { p95: number; mean: number }; timerStep: number;
  gpu: Spread; gpuSamples: number; hasTimer: boolean;
  tilesPeak: number; trisPeak: number; pendingPeak: number; buildMean: number; buildMax: number; builds: number;
}

export interface FlickerRow extends FlickerSummary { phase: Phase; mode: Mode; frames: number }

const row = (key: string, value: string): string => key.padEnd(17) + value;
const ms = (x: number): string => x.toFixed(2);

function stretch(frames: number): string {
  const s = +(frames * DT).toFixed(2);
  return s >= PHASE_S ? `full ${PHASE_S} s phases` : `first ${s} s of each phase`;
}

function head(title: string, i: RunInfo): string[] {
  return [
    `ASTERION 3D spike: ${title}`,
    row('browser', i.browser),
    row('graphics chip', i.gpu),
    row('canvas', `${i.W}x${i.H} (window ${i.cssW}x${i.cssH} at scale ${+i.dpr.toFixed(3)})`),
    row('character grid', `${i.cols}x${i.rows} (${i.cols * i.rows} cells)`),
    row('scale', i.scale),
  ];
}

const tail = (i: RunInfo): string[] => i.notes.map(n => row('note', n));

export function formatPerf(i: RunInfo, d: PerfData): string {
  const spread = (s: Spread): string => `p50 ${ms(s.p50)}  p95 ${ms(s.p95)}  worst ${ms(s.max)}`;
  return [
    ...head('performance report', i),
    row('run', `${stretch(d.windows[0].frames)}, ${d.frames} frames of 1/60 s of path, stability mode ${d.stab}, ${i.tiles}`),
    '',
    row('frame ms', `${spread(d.frame)}  (${d.slowFrames} over 25 ms)`),
    row('processor ms', `${spread(d.processor)}  (whole frame callback; budget 6)`),
    row('  scripted path', `${spread(d.pose)}  (placing the scripted camera; free flight has none of this)`),
    row('simulation ms', `p95 ${ms(d.sim.p95)}  mean ${d.sim.mean.toFixed(4)}  (one stepShip a frame, in the processor time; budget 2)`),
    row('graphics ms', d.hasTimer
      ? `${spread(d.gpu)}  (${d.gpuSamples} of ${d.frames} frames timed; budget 8)`
      : 'n/a (this browser gives no timer queries)'),
    row('peak', `tiles ${d.tilesPeak}  triangles ${d.trisPeak}  pending builds ${d.pendingPeak}`),
    row('tile build ms', `mean ${ms(d.buildMean)}  worst ${ms(d.buildMax)}  (${d.builds} builds since the page opened)`),
    row('clock', `timer step ${d.timerStep.toFixed(3)} ms: a single time is only that exact`),
    ...tail(i),
  ].join('\n');
}

export function formatFlicker(i: RunInfo, rows: readonly FlickerRow[]): string {
  const pc = (x: number): string => (x * 100).toFixed(3);
  const sorted = [...rows].sort((a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase) || a.mode - b.mode);
  const line = (c: string[]): string => c[0].padEnd(10) + c[1].padEnd(6) + c[2].padStart(6) + c.slice(3).map(v => v.padStart(14)).join('');
  const frames = Math.max(...rows.map(r => r.frames));
  return [
    ...head('flicker report', i),
    row('run', `${stretch(frames)}, 1/60 s of path per frame, ${i.tiles}`),
    '',
    'Percent of all character cells, per frame.',
    '  flicker: the cell shows something else for exactly one frame.  change: it differs from the frame before.',
    '  mode 0 dithered (key 1), mode 1 plain (key 2), mode 2 held (key 3).',
    '',
    line(['phase', 'mode', 'frames', 'flicker mean', 'flicker p95', 'change mean', 'change p95']),
    ...sorted.map(r => line([r.phase, String(r.mode), String(r.frames), pc(r.flickerMean), pc(r.flickerP95), pc(r.changeMean), pc(r.changeP95)])),
    ...tail(i),
  ].join('\n');
}
