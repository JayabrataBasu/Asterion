/** Drives the renderer along the scripted path for the two reports, one picture per tick. */
import { DT } from '../../src/sim/sim';
import { ChaseCamera } from './camera';
import type { CombatField } from './combat';
import type { SwarmCounts, Tally } from './combatDraw';
import { type Input, newShip, stepShip } from './flight';
import { copy, scale, sub, v3 } from './math';
import { FlickerTally } from './metrics';
import { type PathPose, pose } from './path';
import type { Planet } from './planet';
import type { Frame3 } from './render';
import type { Scene } from './scene';
import { type FlickerRow, PathRun, type PathStep, type PerfData, type ReportWindow } from './report';
import { Measure, nearestRank, timerStepMs } from './timing';

/** What the reports use of Renderer3. */
export interface ReportRenderer {
  readonly cols: number; readonly rows: number; readonly frame: number; readonly settled: boolean; readonly hasTimer: boolean;
  readonly stats: { tiles: number; tris: number; pending: number; buildMsMean: number; buildMsMax: number; workerBuilt: number; syncBuilt: number };
  render(f: Frame3): void;
  readGlyphs(out: Uint8Array): void;
  resetHistory(): void;
  /** With a swarm: what of the last picture's swarm shows, and the processor ms its lists took. */
  countSwarm?(): SwarmCounts | null;
  readonly swarmBuildMs?: number;
}

/** What the reports use of CombatField. */
export type SwarmSource = Pick<CombatField, 'swarm' | 'update'>;

/** The swarm is counted at every this many measured frames: once a second of path. */
export const COUNT_EVERY = 60;

/** Sums counts, for their mean. */
class CountSum {
  private n = 0; private sum: SwarmCounts | null = null;
  add(c: SwarmCounts): void {
    this.n++;
    if (!this.sum) { this.sum = structuredClone(c); return; }
    for (const kind of KINDS) for (const key of KEYS) this.sum[kind][key] += c[kind][key];
  }
  result(): { samples: number; mean: SwarmCounts } | null {
    if (!this.sum) return null;
    const mean = structuredClone(this.sum);
    for (const kind of KINDS) for (const key of KEYS) mean[kind][key] /= this.n;
    return { samples: this.n, mean };
  }
}
const KINDS = ['ships', 'markers', 'bolts', 'particles'] as const;
const KEYS: readonly (keyof Tally)[] = ['drawn', 'hidden', 'covered', 'off'];

function newFrame(planet: Planet): Frame3 {
  return { camPos: v3(), camQ: { x: 0, y: 0, z: 0, w: 1 }, ship: { pos: v3(), q: { x: 0, y: 0, z: 0, w: 1 } }, planet, time: 0, stab: 2 };
}

/** The camera of a report: free flight's chase camera behind the path's ship, so that the ship turns and rolls on
 *  screen as it does when flown. At the first step of every window it is put straight behind the ship; after that it
 *  moves exactly 1/60 s for each measured frame, and stands while the lead step repeats. So a window's pictures
 *  depend on the window alone. */
class ReportCamera {
  private readonly chase = new ChaseCamera();
  private window = -1;

  /** Puts the ship of pose `p`, drawn at step `step`, and the camera into `frame`. */
  place(frame: Frame3, p: PathPose, step: PathStep): void {
    if (step.window !== this.window) {
      this.window = step.window;
      this.chase.snap(p.shipPos, p.shipQ, frame.planet);
    } else if (step.frame >= 0) this.chase.update(p.shipPos, p.shipQ, frame.planet, DT);
    frame.camPos = this.chase.pos; frame.camQ = this.chase.q; frame.time = step.t;
    frame.ship!.pos = p.shipPos; frame.ship!.q = p.shipQ;
  }
}

/** The path of the page: the world scene's own, or the default planet's. */
function poseAt(scene: Scene | undefined, t: number, planet: Planet): PathPose {
  return scene ? scene.pose(t) : pose(t, planet);
}

/** Flicker: every window is drawn afresh (no band history carried in) and its measured frames are read back. */
export class FlickerRun {
  readonly rows: FlickerRow[] = [];
  /** The step last drawn. */
  at: PathStep | null = null;
  private readonly path: PathRun;
  private readonly frame: Frame3;
  private readonly camera = new ReportCamera();
  private tally = new FlickerTally(0);
  private readonly sum = new CountSum();

  constructor(private readonly r: ReportRenderer, planet: Planet, readonly windows: readonly ReportWindow[],
    private readonly field?: SwarmSource, private readonly scene?: Scene) {
    this.path = new PathRun(windows, true);
    this.frame = newFrame(planet);
  }

  /** The swarm's counts so far (null without one). */
  get counts(): { samples: number; mean: SwarmCounts } | null { return this.sum.result(); }

  get unsettled(): number { return this.path.unsettled; }

  /** Draws one frame; false, drawing nothing, once every window is done. */
  tick(): boolean {
    const step = this.path.step(this.r.settled);
    if (!step) return false;
    this.at = step;
    const win = this.windows[step.window];
    if (step.fresh) { this.r.resetHistory(); this.tally = new FlickerTally(this.r.cols * this.r.rows); }
    const p = poseAt(this.scene, step.t, this.frame.planet);
    this.camera.place(this.frame, p, step);
    if (this.field) {
      this.field.update(step.t, p.shipPos, p.shipQ, this.frame.planet);
      this.frame.swarm = this.field.swarm;
    }
    this.frame.stab = win.mode;
    this.r.render(this.frame);
    if (step.frame >= 0) {
      this.r.readGlyphs(this.tally.next());
      this.tally.add();
      if (this.field && step.frame % COUNT_EVERY === 0) this.sum.add(this.r.countSwarm!()!);
      if (step.frame === win.frames - 1) this.rows.push({ phase: win.phase, mode: win.mode, frames: win.frames, ...this.tally.summary() });
    }
    return true;
  }
}

/** Frames drawn after the path ends, for graphics times still on their way. */
export const LATE_FRAMES = 30;

/** Performance: the path, with one simulation step a frame alongside it. The page calls `tick`, then `end` with the
 *  frame's times when its callback is done, and passes graphics results to `gpu`. With a swarm, the path is flown a
 *  second time afterwards, unmeasured, to count what of it shows: counting reads pictures back, which would spoil
 *  the times. */
export class PerfRun {
  at: PathStep | null = null;
  private readonly path: PathRun;
  private readonly frame: Frame3;
  private readonly measure: Measure;
  private camera = new ReportCamera();
  private readonly sim = newShip();
  private readonly input: Input = { mx: 0, my: 0, thrust: true, brake: false, roll: 0, strafeX: 0, strafeY: 0, boost: false, cruise: false };
  private readonly last = v3();
  private readonly poseMs: number[] = []; private readonly simMs: number[] = [];
  private readonly motionMs: number[] = []; private readonly listMs: number[] = [];
  private readonly sum = new CountSum();
  /** The second walk of the path, once the first is done (with a swarm). */
  private recount: PathRun | null = null;
  private readonly timerStep: number;
  private measured = false; private late = 0;
  private tilesPeak = 0; private trisPeak = 0; private pendingPeak = 0;

  constructor(private readonly r: ReportRenderer, private readonly planet: Planet, readonly windows: readonly ReportWindow[],
    private readonly now: () => number, private readonly field?: SwarmSource, private readonly scene?: Scene) {
    this.path = new PathRun(windows, false);
    this.frame = newFrame(planet);
    this.measure = new Measure(windows.reduce((n, w) => n + w.frames, 0));
    this.timerStep = timerStepMs(now);
  }

  get unsettled(): number { return this.path.unsettled; }
  /** The swarm's counts so far (null without one). */
  get counts(): { samples: number; mean: SwarmCounts } | null { return this.sum.result(); }
  /** True during the second, counting walk of the path. */
  get counting(): boolean { return this.recount !== null; }

  tick(): boolean {
    if (this.recount) return this.count(this.recount);
    const step = this.path.step(this.r.settled);
    this.measured = false;
    if (!step) {
      if (this.late >= LATE_FRAMES) {
        if (!this.field) return false;
        this.recount = new PathRun(this.windows, false);
        this.camera = new ReportCamera();
        return this.count(this.recount);
      }
      this.late++;
      this.r.render(this.frame);
      return true;
    }
    this.at = step;
    this.frame.stab = this.windows[step.window].mode;
    if (step.fresh) this.r.resetHistory();

    const t0 = this.now();
    const p = poseAt(this.scene, step.t, this.planet);
    const poseMs = this.now() - t0;
    this.camera.place(this.frame, p, step);
    const motionMs = this.moveSwarm(step.t, p);

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
      if (this.field) { this.motionMs.push(motionMs); this.listMs.push(this.r.swarmBuildMs ?? 0); }
      const st = this.r.stats;
      this.tilesPeak = Math.max(this.tilesPeak, st.tiles);
      this.trisPeak = Math.max(this.trisPeak, st.tris);
      this.pendingPeak = Math.max(this.pendingPeak, st.pending);
    }
    return true;
  }

  /** Places the swarm around the path ship; the ms it took. */
  private moveSwarm(t: number, p: PathPose): number {
    if (!this.field) return 0;
    const t0 = this.now();
    this.field.update(t, p.shipPos, p.shipQ, this.planet);
    const ms = this.now() - t0;
    this.frame.swarm = this.field.swarm;
    return ms;
  }

  /** One picture of the second walk: as the first walk drew it, counted once a second of path. */
  private count(path: PathRun): boolean {
    const step = path.step(this.r.settled);
    if (!step) return false;
    this.at = step;
    this.frame.stab = this.windows[step.window].mode;
    if (step.fresh) this.r.resetHistory();
    const p = poseAt(this.scene, step.t, this.planet);
    this.camera.place(this.frame, p, step);
    this.moveSwarm(step.t, p);
    this.r.render(this.frame);
    if (step.frame >= 0 && step.frame % COUNT_EVERY === 0) this.sum.add(this.r.countSwarm!()!);
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
      stab: this.windows[0].mode, windows: this.windows, frames: m.frames, slowFrames: m.slowFrames, measuredMs: m.totalMs,
      frame: m.frame, processor: m.tick, pose: spread(this.poseMs),
      sim: { p95: nearestRank(this.simMs, 0.95), mean: this.simMs.reduce((a, b) => a + b, 0) / (this.simMs.length || 1) },
      timerStep: this.timerStep, gpu: m.gpu, gpuSamples: m.gpuSamples, hasTimer: this.r.hasTimer,
      tilesPeak: this.tilesPeak, trisPeak: this.trisPeak, pendingPeak: this.pendingPeak,
      buildMean: st.buildMsMean, buildMax: st.buildMsMax, builds: st.workerBuilt + st.syncBuilt,
      swarm: this.field ? { motion: spread(this.motionMs), build: spread(this.listMs) } : undefined,
    };
  }
}
