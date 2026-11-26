/** Drives the renderer along the scripted path for the two reports, one picture per tick. */
import { DT } from '../../src/sim/sim';
import { type Input, newShip, stepShip } from './flight';
import { copy, scale, sub, v3 } from './math';
import { FlickerTally } from './metrics';
import { pose } from './path';
import type { Planet } from './planet';
import type { Frame3 } from './render';
import { type FlickerRow, PathRun, type PathStep, type PerfData, type ReportWindow } from './report';
import { Measure, nearestRank, timerStepMs } from './timing';

/** What the reports use of Renderer3. */
export interface ReportRenderer {
  readonly cols: number; readonly rows: number; readonly frame: number; readonly settled: boolean; readonly hasTimer: boolean;
  readonly stats: { tiles: number; tris: number; pending: number; buildMsMean: number; buildMsMax: number; workerBuilt: number; syncBuilt: number };
  render(f: Frame3): void;
  readGlyphs(out: Uint8Array): void;
  resetHistory(): void;
}

function newFrame(planet: Planet): Frame3 {
  return { camPos: v3(), camQ: { x: 0, y: 0, z: 0, w: 1 }, ship: { pos: v3(), q: { x: 0, y: 0, z: 0, w: 1 } }, planet, time: 0, stab: 2 };
}

/** Points `frame` at the path `t` seconds in, and returns the pose. */
function place(frame: Frame3, t: number): ReturnType<typeof pose> {
  const p = pose(t, frame.planet);
  frame.camPos = p.camPos; frame.camQ = p.camQ; frame.time = t;
  frame.ship!.pos = p.shipPos; frame.ship!.q = p.shipQ;
  return p;
}

/** Flicker: every window is drawn afresh (no band history carried in) and its measured frames are read back. */
export class FlickerRun {
  readonly rows: FlickerRow[] = [];
  /** The step last drawn. */
  at: PathStep | null = null;
  private readonly path: PathRun;
  private readonly frame: Frame3;
  private tally = new FlickerTally(0);

  constructor(private readonly r: ReportRenderer, planet: Planet, readonly windows: readonly ReportWindow[]) {
    this.path = new PathRun(windows, true);
    this.frame = newFrame(planet);
  }

  get unsettled(): number { return this.path.unsettled; }

  /** Draws one frame; false, drawing nothing, once every window is done. */
  tick(): boolean {
    const step = this.path.step(this.r.settled);
    if (!step) return false;
    this.at = step;
    const win = this.windows[step.window];
    if (step.fresh) { this.r.resetHistory(); this.tally = new FlickerTally(this.r.cols * this.r.rows); }
    place(this.frame, step.t);
    this.frame.stab = win.mode;
    this.r.render(this.frame);
    if (step.frame >= 0) {
      this.r.readGlyphs(this.tally.next());
      this.tally.add();
      if (step.frame === win.frames - 1) this.rows.push({ phase: win.phase, mode: win.mode, frames: win.frames, ...this.tally.summary() });
    }
    return true;
  }
}

/** Frames drawn after the path ends, for graphics times still on their way. */
export const LATE_FRAMES = 30;

/** Performance: the path, with one simulation step a frame alongside it. The page calls `tick`, then `end` with the
 *  frame's times when its callback is done, and passes graphics results to `gpu`. */
export class PerfRun {
  at: PathStep | null = null;
  private readonly path: PathRun;
  private readonly frame: Frame3;
  private readonly measure: Measure;
  private readonly sim = newShip();
  private readonly input: Input = { mx: 0, my: 0, thrust: true, brake: false, roll: 0, strafeX: 0, strafeY: 0, boost: false, cruise: false };
  private readonly last = v3();
  private readonly poseMs: number[] = []; private readonly simMs: number[] = [];
  private readonly timerStep: number;
  private measured = false; private late = 0;
  private tilesPeak = 0; private trisPeak = 0; private pendingPeak = 0;

  constructor(private readonly r: ReportRenderer, private readonly planet: Planet, readonly windows: readonly ReportWindow[],
    private readonly now: () => number) {
    this.path = new PathRun(windows, false);
    this.frame = newFrame(planet);
    this.measure = new Measure(windows.reduce((n, w) => n + w.frames, 0));
    this.timerStep = timerStepMs(now);
  }

  get unsettled(): number { return this.path.unsettled; }

  tick(): boolean {
    const step = this.path.step(this.r.settled);
    this.measured = false;
    if (!step) {
      if (this.late >= LATE_FRAMES) return false;
      this.late++;
      this.r.render(this.frame);
      return true;
    }
    this.at = step;
    this.frame.stab = this.windows[step.window].mode;
    if (step.fresh) this.r.resetHistory();

    const t0 = this.now();
    const p = place(this.frame, step.t);
    const poseMs = this.now() - t0;

    // the ship the path shows, moving as the path moves, so that the step meets the same ground and air
    const s = this.sim;
    copy(s.pos, p.shipPos); Object.assign(s.q, p.shipQ);
    scale(s.vel, sub(s.vel, p.shipPos, this.last), 1 / DT);
    copy(this.last, p.shipPos);
    s.cruising = false;
    const t1 = this.now();
    stepShip(s, this.input, this.planet);
    const simMs = this.now() - t1;

    this.r.render(this.frame);
    if (step.frame >= 0) {
      this.measured = true;
      this.poseMs.push(poseMs); this.simMs.push(simMs);
      const st = this.r.stats;
      this.tilesPeak = Math.max(this.tilesPeak, st.tiles);
      this.trisPeak = Math.max(this.trisPeak, st.tris);
      this.pendingPeak = Math.max(this.pendingPeak, st.pending);
    }
    return true;
  }

  /** The times of the frame just drawn: the interval since the callback before, and this callback's processor time. */
  end(intervalMs: number, processorMs: number): void {
    if (this.measured) this.measure.frame(this.r.frame, intervalMs, processorMs);
  }

  gpu(frame: number, ms: number): void { this.measure.gpu(frame, ms); }

  data(): PerfData {
    const m = this.measure.result(), st = this.r.stats;
    const spread = (v: number[]) => ({ p50: nearestRank(v, 0.5), p95: nearestRank(v, 0.95), max: nearestRank(v, 1) });
    return {
      stab: this.windows[0].mode, windows: this.windows, frames: m.frames, slowFrames: m.slowFrames,
      frame: m.frame, processor: m.tick, pose: spread(this.poseMs),
      sim: { p95: nearestRank(this.simMs, 0.95), mean: this.simMs.reduce((a, b) => a + b, 0) / (this.simMs.length || 1) },
      timerStep: this.timerStep, gpu: m.gpu, gpuSamples: m.gpuSamples, hasTimer: this.r.hasTimer,
      tilesPeak: this.tilesPeak, trisPeak: this.trisPeak, pendingPeak: this.pendingPeak,
      buildMean: st.buildMsMean, buildMax: st.buildMsMax, builds: st.workerBuilt + st.syncBuilt,
    };
  }
}
