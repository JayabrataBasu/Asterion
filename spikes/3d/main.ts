/** Prototype page, static poses only: ?pose=0|1|2 (orbit at altitude 20000, mid at 2000, low at 150), &sync=1 builds
 *  tiles on the main thread, &stab=0|1|2 (default 2), &measure=1 times 300 frames once the tiles have settled.
 *  The title becomes 'ready' once every wanted tile is drawn. */
import {
  type Quat, type Vec3, add, addScaled, cross, dot, norm, qAxisAngle, qIdentity, qMul, qNorm, qRotate, scale, sub, v3,
} from './math';
import { type Planet, altitude, height, makePlanet, surfaceRadius } from './planet';
import { CHARSET } from '../../src/gfx/atlas';
import { FOV_Y, type Frame3, PASSES, Renderer3 } from './render';
import { Measure } from './timing';
import { SUN } from './shaders';

const params = new URLSearchParams(location.search);
const intParam = (name: string, lo: number, hi: number, dflt: number): number => {
  const n = Number(params.get(name));
  return params.has(name) && Number.isInteger(n) && n >= lo && n <= hi ? n : dflt;
};
const poseIdx = intParam('pose', 0, 2, 0);
const sync = params.get('sync') === '1';
const stab = intParam('stab', 0, 2, 2) as 0 | 1 | 2;
const measure = params.get('measure') === '1';
const showShip = params.get('ship') !== '0'; // ship=0 hides the ship, to look at the ground

/** Quaternion of the rotation whose matrix columns are the given unit axes. */
function qFromBasis(r: Vec3, u: Vec3, b: Vec3): Quat {
  const tr = r.x + u.y + b.z;
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = s / 4; x = (u.z - b.y) / s; y = (b.x - r.z) / s; z = (r.y - u.x) / s;
  } else if (r.x > u.y && r.x > b.z) {
    const s = Math.sqrt(1 + r.x - u.y - b.z) * 2;
    w = (u.z - b.y) / s; x = s / 4; y = (u.x + r.y) / s; z = (b.x + r.z) / s;
  } else if (u.y > b.z) {
    const s = Math.sqrt(1 + u.y - r.x - b.z) * 2;
    w = (b.x - r.z) / s; x = (u.x + r.y) / s; y = s / 4; z = (b.y + u.z) / s;
  } else {
    const s = Math.sqrt(1 + b.z - r.x - u.y) * 2;
    w = (r.y - u.x) / s; x = (b.x + r.z) / s; y = (b.y + u.z) / s; z = s / 4;
  }
  return qNorm({ x, y, z, w }, { x, y, z, w });
}

const L = norm(v3(), v3(...SUN));

/** Heading at the ground point `s`: the sun's direction along the ground turned 70 degrees, so slopes are lit
 *  from the side. */
function heading(s: Vec3): Vec3 {
  const lt = norm(v3(), addScaled(v3(), L, s, -dot(L, s)));
  const turn = 70 * Math.PI / 180;
  return norm(v3(), addScaled(v3(), scale(v3(), lt, Math.cos(turn)), cross(v3(), s, lt), Math.sin(turn)));
}

/** A point over land near `s0` with mostly land ahead of it, so the low view looks at ground rather than sea. */
function findLand(p: Planet, s0: Vec3): Vec3 {
  const a = norm(v3(), cross(v3(), Math.abs(s0.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0), s0));
  const b = cross(v3(), s0, a), d = v3(), q = v3();
  let best = s0, bestScore = -1;
  for (let ring = 0; ring <= 40; ring++) {
    for (let k = 0; k < Math.max(1, ring * 8); k++) {
      const ang = k / Math.max(1, ring * 8) * Math.PI * 2, rr = ring * 0.004;
      norm(d, addScaled(d, addScaled(d, s0, a, Math.cos(ang) * rr), b, Math.sin(ang) * rr));
      const h = height(p, d);
      if (h < 0.1 * p.relief || h > 0.3 * p.relief) continue;
      const f = heading(d);
      let score = 0;
      for (let j = 1; j <= 12; j++) if (height(p, norm(q, addScaled(q, d, f, j * 120 / p.radius))) > 0) score++;
      if (score > bestScore) { best = v3(d.x, d.y, d.z); bestScore = score; }
      if (score === 12) return best;
    }
  }
  return best;
}

interface Pose { camPos: Vec3; camQ: Quat; shipPos: Vec3; shipQ: Quat; dir: Vec3 }

function staticPose(i: number, p: Planet): Pose {
  const perp = norm(v3(), v3(-L.z, 0, L.x));
  const ang = 62 * Math.PI / 180; // sun 28 degrees above the ground: low enough for relief to show
  const s0 = norm(v3(), addScaled(v3(), scale(v3(), L, Math.cos(ang)), perp, Math.sin(ang)));
  const s = findLand(p, s0);
  const fwd = heading(s);
  const right = cross(v3(), fwd, s);
  const level = qFromBasis(right, s, scale(v3(), fwd, -1));
  const [alt, pitch] = [[20000, -70], [2000, -36], [150, -10]][i];
  const shipPos = add(v3(), p.center, scale(v3(), s, surfaceRadius(p, s) + alt));
  let shipQ: Quat;
  if (i === 0) {
    // orbit: face the planet, then turn so it sits up and to the right of the ship
    const f = norm(v3(), sub(v3(), p.center, shipPos));
    const up = norm(v3(), addScaled(v3(), fwd, f, -dot(fwd, f)));
    const look = qFromBasis(cross(v3(), f, up), up, scale(v3(), f, -1));
    shipQ = qMul(look, look, qAxisAngle(qIdentity(), v3(0, 1, 0), 0.25));
    shipQ = qNorm(shipQ, qMul(shipQ, shipQ, qAxisAngle(qIdentity(), v3(1, 0, 0), -0.1)));
  } else shipQ = qNorm(level, qMul(level, level, qAxisAngle(qIdentity(), v3(1, 0, 0), pitch * Math.PI / 180)));
  const camPos = add(v3(), shipPos, qRotate(v3(), shipQ, v3(0, 10, 40)));
  const lift = 6 - altitude(p, camPos);
  if (lift > 0) { addScaled(camPos, camPos, s, lift); addScaled(shipPos, shipPos, s, lift); }
  return { camPos, camQ: { ...shipQ }, shipPos, shipQ, dir: s };
}

const canvas = document.getElementById('c') as HTMLCanvasElement;
const info = document.getElementById('info') as HTMLPreElement;
const planet = makePlanet(1);
const pose = staticPose(poseIdx, planet);
const renderer = new Renderer3(canvas, { sync });
renderer.rockDir = pose.dir;
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
  camPos: pose.camPos, camQ: pose.camQ, ship: showShip ? { pos: pose.shipPos, q: pose.shipQ } : null, planet, time: 0, stab,
};
const alt = altitude(planet, pose.shipPos);
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
    `pose ${poseIdx}  ship altitude ${alt.toFixed(0)}  stab ${stab}  ${sync ? 'sync' : 'worker'}  fov ${(FOV_Y * 180 / Math.PI).toFixed(0)}\n` +
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
    else if (--lateLeft === 0) { report = measureReport(win); console.log('MEASURE pose', poseIdx, renderer.W + 'x' + renderer.H, report.trim()); }
  }
  prevNow = now;
}
let prevNow = 0;
fit();
requestAnimationFrame(tick);
