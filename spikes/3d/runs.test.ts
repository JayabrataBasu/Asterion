import { describe, expect, it } from 'vitest';
import { DT } from '../../src/sim/sim';
import { ChaseCamera, MIN_ALT } from './camera';
import { type Quat, type Vec3, len, qRotate, sub, v3 } from './math';
import { moonPosition } from './moon';
import { pose } from './path';
import { altitude, makePlanet } from './planet';
import type { Frame3 } from './render';
import { type ReportWindow, reportWindows } from './report';
import { newSwarm } from './combat';
import { makeScene } from './scene';
import { makeWorld } from './world';
import type { SwarmCounts } from './combatDraw';
import { COUNT_EVERY, FlickerRun, LATE_FRAMES, PerfRun, type ReportRenderer, type SwarmSource } from './runs';

const planet = makePlanet(1);

/** A renderer whose picture alternates, so every flicker and change count is known. */
class Fake implements ReportRenderer {
  readonly cols = 4; readonly rows = 1; frame = 0; settled = false; hasTimer = true;
  readonly stats = { tiles: 0, tris: 0, pending: 0, buildMsMean: 1.5, buildMsMax: 4, workerBuilt: 3, syncBuilt: 6 };
  readonly log: string[] = []; readonly frames: Frame3[] = [];
  render(f: Frame3): void {
    this.frame++; this.settled = true;
    this.stats.tiles = this.frame; this.stats.tris = this.frame * 10;
    this.frames.push({
      ...f, camPos: { ...f.camPos }, camQ: { ...f.camQ },
      ship: f.ship && { pos: { ...f.ship.pos }, q: { ...f.ship.q } },
    });
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
    expect(d.measuredMs).toBe(24 * 16);
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

const NOSE = v3(0, 0, -1), WING = v3(1, 0, 0);
/** A direction of the ship as the camera sees it: right, up, back. */
function onScreen(f: Frame3, axis: Vec3): Vec3 {
  const inv: Quat = { x: -f.camQ.x, y: -f.camQ.y, z: -f.camQ.z, w: f.camQ.w };
  return qRotate(v3(), inv, qRotate(v3(), f.ship!.q, axis));
}
const degrees = (rad: number): number => rad * 180 / Math.PI;
const span = (v: number[]): number => Math.max(...v) - Math.min(...v);

/** Every frame a flicker run draws, by window. */
function flicker(windows: ReportWindow[]): Frame3[][] {
  const r = new Fake(), run = new FlickerRun(r, planet, windows), out: Frame3[][] = windows.map(() => []);
  while (run.tick()) out[run.at!.window].push(r.frames[r.frames.length - 1]);
  return out;
}
const camera = (frames: Frame3[]) => frames.map(f => [f.time, f.camPos, f.camQ]);
/** The window's frames after the repeats that wait for the tiles: one lead frame, then the measured ones. */
const measured = (frames: Frame3[]): Frame3[] => frames.slice(2);

/** The cameras a chase camera gives, snapped behind the ship `DT` before `start` and moved `DT` a frame. */
function chased(start: number, frames: number): [Vec3, Quat][] {
  const c = new ChaseCamera(), first = pose(start - DT, planet);
  c.snap(first.shipPos, first.shipQ, planet);
  return Array.from({ length: frames }, (_, i): [Vec3, Quat] => {
    const p = pose(start + i * DT, planet);
    c.update(p.shipPos, p.shipQ, planet, DT);
    return [{ ...c.pos }, { ...c.q }];
  });
}

describe('the camera of the reports', () => {
  const low = reportWindows(null, 2)[2];

  it('is the chase camera, started behind the ship and moved exactly 1/60 s a frame', () => {
    const frames = measured(flicker([{ ...low, frames: 120 }])[0]);
    expect(frames.map(f => [f.camPos, f.camQ])).toEqual(chased(30, 120));
  });

  it('sees the ship turn and roll on screen in the low phase', () => {
    const frames = measured(flicker([low])[0]);
    expect(frames).toHaveLength(900);
    const nose = frames.map(f => onScreen(f, NOSE)), wing = frames.map(f => onScreen(f, WING));
    expect(span(nose.map(n => degrees(Math.atan2(n.x, -n.z))))).toBeGreaterThan(3); // yaw, both ways
    expect(span(wing.map(w => degrees(Math.asin(w.y))))).toBeGreaterThan(5);       // roll, both ways
  });

  it('stays above the ground along the whole path', () => {
    const r = new Fake(), run = new PerfRun(r, planet, reportWindows(null, 2), () => 0);
    while (run.tick()) { /* to the end */ }
    expect(r.frames.length).toBeGreaterThan(3600);
    for (const f of r.frames) expect(altitude(planet, f.camPos)).toBeGreaterThanOrEqual(MIN_ALT - 1e-6);
  });

  it('gives the same cameras for the same windows, with nothing carried between windows or modes', () => {
    const windows = reportWindows('1', 0).flatMap(w => [0, 1, 2].map(mode => ({ ...w, mode: mode as 0 | 1 | 2 })));
    const all = flicker(windows);
    expect(flicker(windows).map(camera)).toEqual(all.map(camera));
    for (const [i, w] of windows.entries()) {
      expect(camera(all[i])).toEqual(camera(flicker([w])[0])); // as if it were the only window
      expect(camera(all[i])).toEqual(camera(all[i - i % 3])); // and the same in all three modes
    }
    // a window that follows on from the one before starts behind the ship all the same
    const joined = flicker([{ ...low, start: 29, frames: 60 }, { ...low, frames: 60 }]);
    expect(camera(joined[1])).toEqual(camera(flicker([{ ...low, frames: 60 }])[0]));
  });

  it('starts behind the ship again at each phase of the performance run, though the path runs on', () => {
    const r = new Fake(), windows = reportWindows(null, 2), run = new PerfRun(r, planet, windows, () => 0);
    const by: Frame3[][] = windows.map(() => []);
    while (run.tick()) by[run.at!.window].push(r.frames[r.frames.length - 1]);
    for (const i of [1, 2, 3]) {
      const first = by[i][0], p = pose(windows[i].start, planet), c = new ChaseCamera();
      c.snap(p.shipPos, p.shipQ, planet);
      expect([first.time, first.camPos, first.camQ]).toEqual([windows[i].start, c.pos, c.q]);
      c.update(pose(windows[i].start + DT, planet).shipPos, pose(windows[i].start + DT, planet).shipQ, planet, DT);
      expect([by[i][1].camPos, by[i][1].camQ]).toEqual([c.pos, c.q]);
    }
    expect(measured(by[0]).slice(0, 60).map(f => [f.camPos, f.camQ])).toEqual(chased(0, 60));
    // the frames drawn after the path ends hold the last picture
    const late = by[3].slice(-LATE_FRAMES - 1);
    expect(camera(late)).toEqual(late.map(() => camera(late)[0]));
  });
});

describe('reports with a swarm (combat load test)', () => {
  const tally = (drawn: number) => ({ drawn, hidden: 1, covered: 0, off: 2 });
  /** Counts that tell which frame they came from. */
  class SwarmFake extends Fake {
    readonly counted: number[] = []; readonly swarms: unknown[] = [];
    swarmBuildMs = 0.5;
    override render(f: Frame3): void { super.render(f); this.swarms.push(f.swarm); }
    countSwarm(): SwarmCounts {
      this.counted.push(this.frame);
      return { ships: tally(this.counted.length), markers: tally(0), bolts: tally(10), particles: tally(100) };
    }
  }
  const source = () => {
    const calls: [number, Vec3, Quat][] = [];
    const field: SwarmSource = {
      swarm: newSwarm({ ships: 1, bolts: 0, particles: 0 }),
      update: (t, pos, q) => { calls.push([t, { ...pos }, { ...q }]); },
    };
    return { field, calls };
  };

  it('counts once a second of path', () => expect(COUNT_EVERY).toBe(60));

  it('moves the swarm around the path ship before every picture of the flicker run, and counts as it goes', () => {
    const r = new SwarmFake(), { field, calls } = source();
    const run = new FlickerRun(r, planet, reportWindows('2', 0).slice(0, 2), field);
    while (run.tick()) { /* to the end */ }
    expect(calls.length).toBe(r.frames.length);
    r.frames.forEach((f, i) => expect(calls[i]).toEqual([f.time, f.ship!.pos, f.ship!.q]));
    expect(r.swarms.every(s => s === field.swarm)).toBe(true);
    // measured frames 0 and 60 of each window, after its two unmeasured ones
    expect(r.counted).toEqual([3, 63, 125, 185]);
    expect(run.counts).toEqual({ samples: 4, mean: { ships: tally(2.5), markers: tally(0), bolts: tally(10), particles: tally(100) } });
  });

  it('counts in the performance run after the timed frames, on a second pass that is not measured', () => {
    const r = new SwarmFake(), { field, calls } = source();
    let clock = 0;
    const windows = reportWindows('2', 2), run = new PerfRun(r, planet, windows, () => (clock += 0.25), field);
    let ticks = 0;
    while (run.tick()) {
      ticks++;
      expect(r.counted.length === 0 || r.frame > 4 * 122 + LATE_FRAMES).toBe(true);
      run.end(16, 2); run.gpu(r.frame, 5);
    }
    const first = 4 * 120 + 2; // the windows of a continuous stretch settle only at the jumps
    expect(ticks).toBeGreaterThan(2 * first);
    const d = run.data();
    expect(d.frames).toBe(480);
    expect(d.gpuSamples).toBe(480);
    expect(d.swarm).toEqual({ motion: { p50: 0.25, p95: 0.25, max: 0.25 }, build: { p50: 0.5, p95: 0.5, max: 0.5 } });
    expect(run.counts!.samples).toBe(8);
    expect(calls.length).toBe(r.frames.length - LATE_FRAMES); // the late frames hold the last picture
    // the counted pictures are the timed ones again: same time, same camera
    for (const n of r.counted) {
      const again = r.frames[n - 1];
      const timed = r.frames.find(f => f.time === again.time)!;
      expect([again.camPos, again.camQ]).toEqual([timed.camPos, timed.camQ]);
    }
  });

  it('leaves frames, timing data and counts alone without one', () => {
    const r = new SwarmFake(), run = new PerfRun(r, planet, reportWindows('0.1', 2), () => 0);
    let ticks = 0;
    while (run.tick()) ticks++;
    expect(ticks).toBe(4 * (2 + 6) + LATE_FRAMES);
    expect(r.swarms.every(s => s === undefined)).toBe(true);
    expect(r.counted).toEqual([]);
    expect(run.counts).toBeNull();
    expect(run.data().swarm).toBeUndefined();
  });
});

describe('a report in a world scene', () => {
  const scene = makeScene(makeWorld('gas')), p = scene.world.planet;

  it('flies the scene\'s own path', () => {
    const r = new Fake(), windows = reportWindows('0.1', 0).slice(2, 3).map(w => ({ ...w, mode: 2 as const }));
    const run = new FlickerRun(r, p, windows, undefined, scene);
    while (run.tick()) { /* all of it */ }
    const last = r.frames[r.frames.length - 1];
    expect(last.ship!.pos).toEqual(scene.pose(last.time).shipPos);
    expect(len(last.ship!.pos)).toBeLessThan(p.radius + 200);
    expect(last.planet).toBe(p);
  });

  it('times the scene\'s own path too', () => {
    const r = new Fake(), windows = reportWindows('0.1', 2);
    let at = 0;
    const run = new PerfRun(r, p, windows, () => at += 0.5, undefined, scene);
    while (run.tick()) run.end(16.7, 2);
    expect(run.data().frames).toBe(24);
    const last = r.frames[r.frames.length - 1];
    expect(last.ship!.pos).toEqual(scene.pose(last.time).shipPos);
  });
});

describe('a report round the moon', () => {
  const scene = makeScene(makeWorld('moon')), p = scene.world.planet, moon = scene.world.moon!;

  it('keeps the camera clear of the moon where it is at that moment', () => {
    const r = new Fake(), windows = reportWindows('0.1', 0).slice(2, 3).map(w => ({ ...w, mode: 2 as const }));
    const run = new FlickerRun(r, p, windows, undefined, scene);
    while (run.tick()) {
      const f = r.frames[r.frames.length - 1];
      expect(altitude({ ...moon.body, center: moonPosition(v3(), p, f.time) }, f.camPos)).toBeGreaterThanOrEqual(MIN_ALT - 1e-6);
      expect(len(sub(v3(), moon.body.center, moonPosition(v3(), p, f.time)))).toBeLessThan(1e-6);
    }
  });

  it('times the simulation with the moon in it', () => {
    const r = new Fake(), windows = reportWindows('0.1', 2);
    let at = 0;
    const run = new PerfRun(r, p, windows, () => at += 0.5, undefined, scene);
    while (run.tick()) run.end(16.7, 2);
    expect(run.data().frames).toBe(24);
    expect(moon.time).toBeCloseTo(r.frames[r.frames.length - 1].time + DT, 6);
  });
});
