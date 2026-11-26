/** A still picture: ?pose=<seconds> shows that moment of the scripted path (0..60, default 0). &ship=0 hides the ship,
 *  &dump=1 logs the characters as text, &measure=1 times 300 frames once the tiles have settled. The title becomes
 *  'ready' once every wanted tile is drawn. In a world scene, &look=<name> shows one of its viewpoints instead. */
import { CHARSET } from '../../src/gfx/atlas';
import { sceneLine } from './combat';
import { modeLabel } from './controls';
import { type Page, params, stabParam } from './page';
import { PATH_SECONDS } from './path';
import { altitude } from './planet';
import { FOV_Y, type Frame3 } from './render';
import { Measure } from './timing';

const MEASURE_FRAMES = 300, LATE_FRAMES = 30; // graphics results arrive a few frames late

export function showStill(page: Page): void {
  const { renderer, planet, info, gpuName, sync, combat, field, scene } = page;
  const seconds = Math.min(PATH_SECONDS, Math.max(0, Number(params.get('pose')) || 0));
  const stab = stabParam();
  const measure = params.get('measure') === '1';
  const showShip = params.get('ship') !== '0'; // ship=0 hides the ship, to look at the ground
  const view = scene.view(params.get('look') ?? '', seconds) ?? scene.pose(seconds);
  renderer.rockDir = scene.focus;

  const frame: Frame3 = {
    camPos: view.camPos, camQ: view.camQ, ship: showShip ? { pos: view.shipPos, q: view.shipQ } : null, planet,
    time: seconds, stab, swarm: field?.swarm,
  };
  field?.update(seconds, view.shipPos, view.shipQ, planet); // one moment: it stays
  const moon = scene.near?.moon;
  moon?.place(seconds);
  const alt = Math.min(altitude(planet, view.shipPos), moon ? altitude(moon.body, view.shipPos) : Infinity);
  let ready = false;
  let win: Measure | null = null, lateLeft = LATE_FRAMES;
  let report = '', dumpText = '', prevNow = 0;
  renderer.onGpu = (f, ms) => win?.gpu(f, ms);

  /** Ends the measurement window: one line for the readout and the console. */
  function measureReport(m: Measure): string {
    const r = m.result(), c = renderer.gpuCounts, f = (x: number): string => x.toFixed(2);
    const graphics = !renderer.hasTimer ? 'graphics n/a (no timer extension)'
      : renderer.profile ? 'graphics per frame not sampled while profiling (see the passes)'
        : `graphics p50 ${f(r.gpu.p50)} p95 ${f(r.gpu.p95)} max ${f(r.gpu.max)} ms from ${r.gpuSamples} fresh samples,` +
          ` ${r.gpuMissing} frames without one (timer totals: dropped ${c.dropped} discarded ${c.discarded} lost ${c.lost})`;
    return `\nmeasured ${r.frames} frames: frame interval p50 ${f(r.frame.p50)} p95 ${f(r.frame.p95)} max ${f(r.frame.max)} ms, ${r.slowFrames} over 25 ms` +
      ` | whole tick (processor) p50 ${f(r.tick.p50)} p95 ${f(r.tick.p95)} max ${f(r.tick.max)} ms | ${graphics}`;
  }

  function dump(): void { // the characters on screen, as text, for checking readGlyphs
    const g = new Uint8Array(renderer.cols * renderer.rows);
    renderer.readGlyphs(g);
    const rows = Array.from({ length: renderer.rows }, (_, y) => Array.from(g.subarray(y * renderer.cols, (y + 1) * renderer.cols), i => CHARSET[i]).join(''));
    rows.forEach((r, y) => console.log('ROW', String(y).padStart(2), r));
    const shown = g.reduce((n, i) => n + (i > 0 ? 1 : 0), 0);
    dumpText = `\nreadGlyphs: ${shown} of ${g.length} cells show a character; rows ${renderer.rows >> 1}..+2:\n` +
      rows.slice(renderer.rows >> 1, (renderer.rows >> 1) + 3).map(r => r.slice(0, 120)).join('\n');
  }

  function tick(now: number): void {
    if (page.lost()) return;
    const t0 = performance.now();
    page.fit();
    renderer.render(frame);
    const st = renderer.stats;
    if (!ready && renderer.settled) {
      ready = true; document.title = 'ready';
      if (params.get('dump') === '1') dump();
    }
    info.textContent =
      `t ${seconds} s  ${view.phase}  ship altitude ${alt.toFixed(0)}  mode ${modeLabel(stab)}  ${sync ? 'sync' : 'worker'}  fov ${(FOV_Y * 180 / Math.PI).toFixed(0)}\n` +
      `canvas ${renderer.W}x${renderer.H}  grid ${renderer.cols}x${renderer.rows}  ${ready ? 'settled' : 'loading'}\n` +
      `tiles ${st.tiles}  tris ${st.tris}  pending ${st.pending}  built: worker ${st.workerBuilt} main ${st.syncBuilt}\n` +
      `build ms mean ${st.buildMsMean.toFixed(2)} max ${st.buildMsMax.toFixed(2)}  gpu ${renderer.hasTimer ? st.gpuMs.toFixed(2) + ' ms' : 'n/a'}\n` +
      (combat ? sceneLine(combat) + `  lists ${renderer.swarmBuildMs.toFixed(2)} ms\n` : '') +
      (renderer.profile ? 'passes ms: ' + renderer.passNames.map((n, i) => `${n} ${renderer.passMs[i].toFixed(2)}`).join('  ') + '\n' : '') +
      `${gpuName}${report}${dumpText}`;
    requestAnimationFrame(tick);
    // the window: whole-callback processor time (resize check, render, readout, scheduling the next frame). Its first
    // tick is skipped, as the interval before it covers the frame in which the tiles settled.
    if (ready && measure && !report) {
      if (!win) win = new Measure(MEASURE_FRAMES, 1);
      else if (!win.full) win.frame(renderer.frame, now - prevNow, performance.now() - t0);
      else if (--lateLeft === 0) { report = measureReport(win); console.log('MEASURE pose', seconds, renderer.W + 'x' + renderer.H, report.trim()); }
    }
    prevNow = now;
  }
  requestAnimationFrame(tick);
}
