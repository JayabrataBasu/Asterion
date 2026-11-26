/** Prototype page, still pictures only: ?pose=<seconds> shows that moment of the scripted path (0..60, default 0),
 *  &sync=1 builds tiles on the main thread, &stab=0|1|2 (default 2), &measure=1 times 300 frames once the tiles have
 *  settled. The title becomes 'ready' once every wanted tile is drawn. */
import { PATH_SECONDS, pathFocus, pose } from './path';
import { altitude, makePlanet } from './planet';
import { CHARSET } from '../../src/gfx/atlas';
import { FOV_Y, type Frame3, PASSES, Renderer3 } from './render';
import { Measure } from './timing';

const params = new URLSearchParams(location.search);
const intParam = (name: string, lo: number, hi: number, dflt: number): number => {
  const n = Number(params.get(name));
  return params.has(name) && Number.isInteger(n) && n >= lo && n <= hi ? n : dflt;
};
const seconds = Math.min(PATH_SECONDS, Math.max(0, Number(params.get('pose')) || 0));
const sync = params.get('sync') === '1';
const stab = intParam('stab', 0, 2, 2) as 0 | 1 | 2;
const measure = params.get('measure') === '1';
const showShip = params.get('ship') !== '0'; // ship=0 hides the ship, to look at the ground

const canvas = document.getElementById('c') as HTMLCanvasElement;
const info = document.getElementById('info') as HTMLPreElement;
const planet = makePlanet(1);
const view = pose(seconds, planet);
const renderer = new Renderer3(canvas, { sync });
renderer.rockDir = pathFocus(planet);
renderer.debug = intParam('dbg', 0, 1, 0);
renderer.profile = params.get('profile') === '1'; // graphics time per pass
const gl = renderer.gl;
const dbg = gl.getExtension('WEBGL_debug_renderer_info');
const gpuName = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER));

let dpr = 0, cssW = 0, cssH = 0;
function fit(): void {
  if (window.devicePixelRatio === dpr && innerWidth === cssW && innerHeight === cssH) return;
  dpr = window.devicePixelRatio; cssW = innerWidth; cssH = innerHeight;
  renderer.resize(cssW, cssH, dpr);
}

const frame: Frame3 = {
  camPos: view.camPos, camQ: view.camQ, ship: showShip ? { pos: view.shipPos, q: view.shipQ } : null, planet,
  time: seconds, stab,
};
const alt = altitude(planet, view.shipPos);
let ready = false;
const MEASURE_FRAMES = 300, LATE_FRAMES = 30; // graphics results arrive a few frames late
let win: Measure | null = null, lateLeft = LATE_FRAMES;
let report = '', dumpText = '';
renderer.onGpu = (f, ms) => win?.gpu(f, ms);

/** Ends the measurement window: one line for the readout and the console. */
function measureReport(m: Measure): string {
  const r = m.result(), c = renderer.gpuCounts, f = (x: number): string => x.toFixed(2);
  return `\nmeasured ${r.frames} frames: frame interval p50 ${f(r.frame.p50)} p95 ${f(r.frame.p95)} max ${f(r.frame.max)} ms, ${r.slowFrames} over 25 ms` +
    ` | whole tick (processor) p50 ${f(r.tick.p50)} p95 ${f(r.tick.p95)} max ${f(r.tick.max)} ms` +
    (renderer.hasTimer
      ? ` | graphics p50 ${f(r.gpu.p50)} p95 ${f(r.gpu.p95)} max ${f(r.gpu.max)} ms from ${r.gpuSamples} fresh samples,` +
        ` ${r.gpuMissing} frames without one (timer totals: dropped ${c.dropped} discarded ${c.discarded} lost ${c.lost})`
      : ' | graphics n/a (no timer extension)');
}

function tick(now: number): void {
  const t0 = performance.now();
  fit();
  renderer.render(frame);
  const st = renderer.stats;
  if (!ready && renderer.settled) {
    ready = true; document.title = 'ready';
    if (params.get('dump') === '1') { // the characters on screen, as text, for checking readGlyphs
      const g = new Uint8Array(renderer.cols * renderer.rows);
      renderer.readGlyphs(g);
      const rows = Array.from({ length: renderer.rows }, (_, y) => Array.from(g.subarray(y * renderer.cols, (y + 1) * renderer.cols), i => CHARSET[i]).join(''));
      rows.forEach((r, y) => console.log('ROW', String(y).padStart(2), r));
      const shown = g.reduce((n, i) => n + (i > 0 ? 1 : 0), 0);
      dumpText = `\nreadGlyphs: ${shown} of ${g.length} cells show a character; rows ${renderer.rows >> 1}..+2:\n` +
        rows.slice(renderer.rows >> 1, (renderer.rows >> 1) + 3).map(r => r.slice(0, 120)).join('\n');
    }
  }
  info.textContent =
    `t ${seconds} s  ${view.phase}  ship altitude ${alt.toFixed(0)}  stab ${stab}  ${sync ? 'sync' : 'worker'}  fov ${(FOV_Y * 180 / Math.PI).toFixed(0)}\n` +
    `canvas ${renderer.W}x${renderer.H}  grid ${renderer.cols}x${renderer.rows}  ${ready ? 'settled' : 'loading'}\n` +
    `tiles ${st.tiles}  tris ${st.tris}  pending ${st.pending}  built: worker ${st.workerBuilt} main ${st.syncBuilt}\n` +
    `build ms mean ${st.buildMsMean.toFixed(2)} max ${st.buildMsMax.toFixed(2)}  gpu ${renderer.hasTimer ? st.gpuMs.toFixed(2) + ' ms' : 'n/a'}\n` +
    (renderer.profile ? 'passes ms: ' + PASSES.map((n, i) => `${n} ${renderer.passMs[i].toFixed(2)}`).join('  ') + '\n' : '') +
    `${gpuName}${report}${dumpText}`;
  requestAnimationFrame(tick);
  // the window: whole-callback processor time (resize check, render, readout, scheduling the next frame)
  if (ready && measure && !report) {
    if (!win) win = new Measure(MEASURE_FRAMES);
    else if (!win.full) win.frame(renderer.frame, now - prevNow, performance.now() - t0);
    else if (--lateLeft === 0) { report = measureReport(win); console.log('MEASURE pose', seconds, renderer.W + 'x' + renderer.H, report.trim()); }
  }
  prevNow = now;
}
let prevNow = 0;
fit();
requestAnimationFrame(tick);
