#!/usr/bin/env node
// Golden-image check: renders fixed scenes in headless Chrome/Chromium (SwiftShader GL) and compares against test/golden/*.png.
//   node scripts/golden.mjs                 compare (exit 1 on any scene above the tolerance)
//   node scripts/golden.mjs update          regenerate baselines
//   node scripts/golden.mjs shots <dir>     save full-size screenshots of every scene (for docs / before-after)
//   node scripts/golden.mjs url '<query>' <file.png>   one ad-hoc screenshot
//   node scripts/golden.mjs console '<query>'          print browser console errors / logs for a scene
//   node scripts/golden.mjs contrast       hull-vs-surround luminance test: every hull x nebula theme x context (home, sun glare, planet shadow), idle (fails below 3:1)
//   node scripts/golden.mjs silhouette     flat-white silhouette test: no two hulls may have near-identical outlines (fails above IoU 0.80)
//   node scripts/golden.mjs sheets         before/after sheets: new half-size screens in docs/screens/v4 plus side-by-sides against the v3.3 screens in docs/screens
//   GOLDEN_ONLY=a,b limits the scenes; CHROME=<path> picks the browser.
// No dependencies: PNG decode/encode uses node:zlib. Baselines are per-machine regression guards (software GL), not cross-GPU truth.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODE = process.argv[2] ?? 'check';
const TOL = parseFloat(process.env.GOLDEN_TOL ?? '0.06');
const PORT = 5197;

export const SCENES = {
  home: 'seed=7&x=0&y=0&ff=0.02',
  fleet: 'seed=7&x=0&y=0&ff=0.02&hud=0&spawn=boss,sniper,tender,splitter,rammer',
  shop: 'seed=7&state=shop&ff=0.02',
  map: 'seed=7&state=map&ff=0.02',
  gasgiant: 'seed=1&x=560&y=-53&ff=0.02&hud=0',
  hangar: 'seed=7&state=hangar&ff=0.02',
  roster: 'seed=7&x=0&y=-3120&ff=0.02&hud=0&roster=1',
  vert_off: 'seed=7&x=-95&y=40&ff=0.02&spawn=gunship,drone,drone',
  vert_on: 'seed=7&x=-95&y=40&ff=0.02&spawn=gunship,drone,drone&vert=1',
  chart: 'seed=7&state=chart&ff=0.02',
  derelict: 'seed=7&x=0&y=0&ff=0.02&hud=0&setpiece=derelict',
  eclipse: 'seed=7&x=0&y=0&ff=0.02&hud=0&event=eclipse&evwarn=0.01&evt=0.5',
  scan: 'seed=1&x=520&y=-53&ff=0.02&scanview=1',
  layers: 'seed=7&x=0&y=0&ff=0.02&layers=1',
  // Phase H scenes: idle ships over every nebula theme, near the sun, in a planet's shadow; silhouettes; enemies; hangar previews
  idle_neb_0: 'seed=7&x=0&y=0&ff=0.02&hud=0&idle=1&theme=0', idle_neb_1: 'seed=7&x=0&y=0&ff=0.02&hud=0&idle=1&theme=1',
  idle_neb_2: 'seed=7&x=0&y=0&ff=0.02&hud=0&idle=1&theme=2', idle_neb_3: 'seed=7&x=0&y=0&ff=0.02&hud=0&idle=1&theme=3',
  idle_neb_4: 'seed=7&x=0&y=0&ff=0.02&hud=0&idle=1&theme=4', idle_neb_5: 'seed=7&x=0&y=0&ff=0.02&hud=0&idle=1&theme=5',
  idle_sun: 'seed=7&x=1600&y=1900&ff=0.02&hud=0&idle=1',
  idle_shadow: 'seed=7&x=131&y=-114&ff=0.02&hud=0&idle=1',
  roster_silhouette: 'seed=7&x=0&y=-3120&ff=0.02&hud=0&roster=1&idle=1&sil=1&nebula=0&bloom=0',
  roster_enemies: 'seed=7&x=0&y=-3120&ff=0.02&hud=0&roster=2&idle=1',
  hangar_needle: 'seed=7&state=hangar&ff=0.02&ship=needle', hangar_hive: 'seed=7&state=hangar&ff=0.02&ship=hive',
};

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const c = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  for (const p of c) if (existsSync(p)) return p;
  return 'chromium';
}

// ---------------------------------------------------------------- PNG
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
export function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported png'); ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0; if (!bpp) throw new Error('png colour type ' + ct);
  const raw = inflateSync(Buffer.concat(idat)), stride = w * bpp, out = new Uint8Array(w * h * 3), prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v;
    }
    for (let x = 0; x < w; x++) for (let k = 0; k < 3; k++) out[(y * w + x) * 3 + k] = cur[x * bpp + k];
    prev.set(cur);
  }
  return { w, h, rgb: out };
}
export function encodePng({ w, h, rgb }) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1); }
  const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function half(img) {       // 2x2 box downsample (1600x900 -> 800x450)
  const w = img.w >> 1, h = img.h >> 1, o = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let k = 0; k < 3; k++) {
    const s = (i, j) => img.rgb[((y * 2 + j) * img.w + x * 2 + i) * 3 + k];
    o[(y * w + x) * 3 + k] = (s(0, 0) + s(1, 0) + s(0, 1) + s(1, 1) + 2) >> 2;
  }
  return { w, h, rgb: o };
}
function rmse(a, b) {
  if (a.w !== b.w || a.h !== b.h) return 1;
  let s = 0; for (let i = 0; i < a.rgb.length; i++) { const d = (a.rgb[i] - b.rgb[i]) / 255; s += d * d; }
  return Math.sqrt(s / a.rgb.length);
}

// ---------------------------------------------------------------- contrast test
const HULLS = ['wren', 'needle', 'anvil', 'sextant', 'mule', 'shade', 'magpie', 'hive'];
// sun: the sun is drawn at a fixed screen spot that drifts with the camera, so (1600, 1900) parks it behind the ship; shadow: behind the home planet, opposite the light
const CONTEXTS = { home: 'seed=7&x=0&y=0', gas: 'seed=1&x=560&y=-53', sun: 'seed=7&x=1600&y=1900', shadow: 'seed=7&x=131&y=-114' };
const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
/** Contrast of the brighter half of the hull cells (edge cells are mostly empty) against the ring 2-4 cells out. Hull cells come from the ?layers=1 debug shot (ship cells are red). */
export function hullContrast(normal, layers, cw = 8, ch = 16) {
  const cols = Math.floor(layers.w / cw), rows = Math.floor(layers.h / ch), mask = new Uint8Array(cols * rows), lum = new Float32Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
    let red = 0, l = 0;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const i = ((cy * ch + y) * layers.w + cx * cw + x) * 3, j = ((cy * ch + y) * normal.w + cx * cw + x) * 3;
      if (layers.rgb[i] > 60 && layers.rgb[i] > 2 * layers.rgb[i + 1] && layers.rgb[i] > 2 * layers.rgb[i + 2]) red++;
      l += 0.2126 * lin(normal.rgb[j]) + 0.7152 * lin(normal.rgb[j + 1]) + 0.0722 * lin(normal.rgb[j + 2]);
    }
    mask[cy * cols + cx] = red > 6 ? 1 : 0; lum[cy * cols + cx] = l / (cw * ch);
  }
  // the ship is the LARGEST mask component within 15 cells of the screen centre (a tiny red nav-light glyph must not be mistaken for the hull)
  const label = new Int32Array(mask.length).fill(-1), comps = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || label[i] >= 0) continue;
    const id = comps.length, st = [i]; label[i] = id; let n = 0, near = 1e9;
    while (st.length) { const k = st.pop(), x = k % cols, y = (k / cols) | 0; n++; near = Math.min(near, Math.hypot(x - cols / 2, y - rows / 2));
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue; const q = ny * cols + nx; if (mask[q] && label[q] < 0) { label[q] = id; st.push(q); } } }
    comps.push({ n, near });
  }
  let bestId = -1;
  for (let c = 0; c < comps.length; c++) if (comps[c].near < 15 && (bestId < 0 || comps[c].n > comps[bestId].n)) bestId = c;
  if (bestId < 0) return null;
  const comp = new Uint8Array(mask.length); for (let i = 0; i < mask.length; i++) if (label[i] === bestId) comp[i] = 1;
  const hl = []; let rs = 0, rn = 0;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    if (comp[y * cols + x]) { hl.push(lum[y * cols + x]); continue; }
    let dmin = 99; for (let yy = Math.max(0, y - 4); yy <= Math.min(rows - 1, y + 4); yy++) for (let xx = Math.max(0, x - 4); xx <= Math.min(cols - 1, x + 4); xx++) if (comp[yy * cols + xx]) dmin = Math.min(dmin, Math.max(Math.abs(xx - x), Math.abs(yy - y)));
    if (dmin >= 2 && dmin <= 4) { rs += lum[y * cols + x]; rn++; }
  }
  hl.sort((a, b) => b - a); const top = hl.slice(0, Math.max(1, hl.length >> 1)), hn = hl.length, lh = top.reduce((a, b) => a + b, 0) / top.length + 0.05, lr = rs / Math.max(1, rn) + 0.05;
  return { ratio: Math.max(lh, lr) / Math.min(lh, lr), hull: hn, ring: rn, lh, lr };
}

// ---------------------------------------------------------------- silhouette distinctness
/** Occupied-cell grid of one hull from the flat-white roster shot: the connected blob nearest the expected centre. */
export function hullBlob(img, cx, cy, cw = 8, ch = 16, halfW = 12, halfH = 11) {
  const col0 = Math.round(cx / cw) - halfW, row0 = Math.round(cy / ch) - halfH, W = halfW * 2 + 1, H = halfH * 2 + 1, occ = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    let n = 0;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const px = (col0 + c) * cw + x, py = (row0 + r) * ch + y; if (px < 0 || py < 0 || px >= img.w || py >= img.h) continue; const i = (py * img.w + px) * 3; if (img.rgb[i] > 150 && img.rgb[i + 1] > 150 && img.rgb[i + 2] > 150) n++; }
    occ[r * W + c] = n >= 5 ? 1 : 0;
  }
  let best = -1, bd = 1e9;
  for (let i = 0; i < occ.length; i++) if (occ[i]) { const d = Math.hypot(i % W - halfW, Math.floor(i / W) - halfH); if (d < bd) { bd = d; best = i; } }
  if (best < 0) return null;
  const comp = new Set([best]), st = [best];
  while (st.length) { const i = st.pop(), x = i % W, y = (i / W) | 0; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const k = ny * W + nx; if (occ[k] && !comp.has(k)) { comp.add(k); st.push(k); } } }
  const cells = [...comp].map(i => [i % W, (i / W) | 0]);
  const mx = cells.reduce((a, c) => a + c[0], 0) / cells.length, my = cells.reduce((a, c) => a + c[1], 0) / cells.length;
  return new Set(cells.map(([x, y]) => `${Math.round(x - mx)},${Math.round(y - my)}`));       // centred on the centroid, so the test compares outlines, not placement
}
export function iou(a, b) { let i = 0; for (const k of a) if (b.has(k)) i++; return i / (a.size + b.size - i); }

// ---------------------------------------------------------------- run
async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'golden-'));
  const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: root, shell: true, stdio: 'ignore' });
  const t0 = Date.now();
  const sweep = () => { try { for (const f of readdirSync(tmpdir())) if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.test(f)) { const p = join(tmpdir(), f); if (statSync(p).mtimeMs >= t0 - 5000) rmSync(p, { force: true }); } } catch { /* best effort */ } };
  const stop = () => { sweep(); try { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(vite.pid), '/T', '/F']); else vite.kill(); } catch { /* gone */ } rmSync(tmp, { recursive: true, force: true }); };
  try {
    for (let i = 0; i < 120; i++) { try { await fetch(`http://localhost:${PORT}/`); break; } catch { await new Promise(r => setTimeout(r, 500)); } }
    const chrome = findChrome(), only = process.env.GOLDEN_ONLY?.split(',');
    const shotDir = MODE === 'shots' ? (process.argv[3] ?? join(root, 'docs', 'screens')) : null;
    if (shotDir) mkdirSync(shotDir, { recursive: true });
    let fail = 0;
    if (MODE === 'silhouette') {
      const f = join(tmp, 's.png'); spawnSync(chrome, ['--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars', `--user-data-dir=${join(tmp, 'prof')}`, '--window-size=1600,900', '--virtual-time-budget=3000', `--screenshot=${f}`, `http://localhost:${PORT}/?${SCENES.roster_silhouette}`], { timeout: 120000, stdio: 'ignore' });
      const img = decodePng(readFileSync(f)), MAXI = parseFloat(process.env.SIL_MAX ?? '0.80'), blobs = [];
      for (let i = 0; i < HULLS.length; i++) {            // roster layout: 4 per row, 44 cells apart, rows 22 world units above / 18 below the centre
        const cx = (100 - 66 + (i % 4) * 44) * 8 + 4, cy = i < 4 ? 450 - (22 / 2) * 16 : 450 + (18 / 2) * 16;
        const b = hullBlob(img, cx, cy); blobs.push(b);
        if (!b || b.size < 12) { console.log(`FAIL  ${HULLS[i]}: no silhouette found (${b ? b.size : 0} cells)`); fail = 1; }
      }
      let worst = 0, wp = '';
      for (let i = 0; i < blobs.length; i++) for (let j = i + 1; j < blobs.length; j++) { if (!blobs[i] || !blobs[j]) continue; const v = iou(blobs[i], blobs[j]); if (v > worst) { worst = v; wp = HULLS[i] + ' vs ' + HULLS[j]; } if (v > MAXI) { console.log(`FAIL  ${HULLS[i]} vs ${HULLS[j]}  IoU ${v.toFixed(2)} (max ${MAXI})`); fail = 1; } }
      console.log(`${fail ? 'FAIL' : 'ok  '}  silhouettes: ${blobs.map((b, i) => HULLS[i] + '=' + (b ? b.size : 0)).join(' ')}  | most similar pair: ${wp} IoU ${worst.toFixed(2)}`);
      return fail;
    }
    if (MODE === 'contrast') {
      const MIN = parseFloat(process.env.CONTRAST_MIN ?? '3'), ctxs = (process.env.CONTRAST_CTX ?? 'home').split(','), themes = (process.env.CONTRAST_THEMES ?? '0,1,2,3,4,5').split(',');
      const shot = (q, f) => { spawnSync(chrome, ['--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars', `--user-data-dir=${join(tmp, 'prof')}`, '--window-size=1600,900', '--virtual-time-budget=3000', `--screenshot=${f}`, `http://localhost:${PORT}/?${q}`], { timeout: 120000, stdio: 'ignore' }); return decodePng(readFileSync(f)); };
      for (const cx of ctxs) for (const hull of (only ?? HULLS)) for (const th of themes) {
        const q = `${CONTEXTS[cx]}&ff=0.02&hud=0&idle=1&ship=${hull}&theme=${th}&bloom=0&chroma=0&scan=0&grain=0&vig=0`;
        const r = hullContrast(shot(q, join(tmp, 'n.png')), shot(q + '&layers=1', join(tmp, 'l.png')));
        const ok = r && r.ratio >= MIN; if (!ok) fail = 1;
        console.log(`${ok ? 'ok  ' : 'FAIL'}  ${cx}/${hull}/theme${th}  ${r ? `contrast ${r.ratio.toFixed(1)}:1 (hull ${r.hull} cells L=${r.lh.toFixed(2)}, ring ${r.ring} L=${r.lr.toFixed(2)})` : 'ship not found'}`);
      }
      return fail;
    }
    const sheet = MODE === 'sheets', sheetDir = join(root, 'docs', 'screens', 'v4');
    if (sheet) mkdirSync(sheetDir, { recursive: true });
    const list = MODE === 'url' || MODE === 'console' || MODE === 'perf' ? [['adhoc', process.argv[3]]] : Object.entries(SCENES);
    for (const [name, q] of list) {
      if (only && !only.includes(name)) continue;
      const file = join(tmp, name + '.png');
      if (MODE === 'perf') {
        for (const [w, h] of [[1280, 720], [1920, 1080], [2560, 1440]]) {
          const r = spawnSync(chrome, ['--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', `--window-size=${w},${h}`,
            `--user-data-dir=${join(tmp, 'prof')}`, '--virtual-time-budget=6000', '--dump-dom', `http://localhost:${PORT}/?${q}&perf=1`], { timeout: 180000, encoding: 'utf8' });
          const m = /<pre id="perf"[^>]*>([^<]*)</.exec(r.stdout ?? '');
          console.log(`--- ${w}x${h}`); console.log(m ? m[1] : '(no perf text)');
        }
        continue;
      }
      if (MODE === 'console') {
        const r = spawnSync(chrome, ['--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--enable-logging=stderr', '--v=0',
          `--user-data-dir=${join(tmp, 'prof')}`, '--virtual-time-budget=2000', '--dump-dom', `http://localhost:${PORT}/?${q}`], { timeout: 120000, encoding: 'utf8' });
        for (const l of (r.stderr ?? '').split(String.fromCharCode(10))) if (/CONSOLE|Uncaught|ERROR:/.test(l) && !/gpu|GPU|dbus|sandbox/.test(l)) console.log(l.slice(0, 600));
        continue;
      }
      spawnSync(chrome, ['--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars',
        `--user-data-dir=${join(tmp, 'prof')}`, '--window-size=1600,900', '--virtual-time-budget=3000', `--screenshot=${file}`, `http://localhost:${PORT}/?${q}`], { timeout: 120000, stdio: 'ignore' });
      if (!existsSync(file)) { console.log(`FAIL  ${name}: no screenshot`); fail = 1; continue; }
      if (MODE === 'url') { writeFileSync(process.argv[4], readFileSync(file)); console.log('shot ' + process.argv[4]); continue; }
      if (shotDir) { writeFileSync(join(shotDir, name + '.png'), readFileSync(file)); console.log(`shot  ${name}`); continue; }
      if (sheet) {                                                   // half-size new shot, plus old|new side by side when a v3.3 screen of the same name exists
        const nw = half(decodePng(readFileSync(file))); writeFileSync(join(sheetDir, name + '.png'), encodePng(nw));
        const old = join(root, 'docs', 'screens', name + '.png');
        if (existsSync(old)) { const ol = half(decodePng(readFileSync(old))), W = ol.w + nw.w, h2 = Math.min(ol.h, nw.h), rgb = new Uint8Array(W * h2 * 3);
          for (let y = 0; y < h2; y++) { rgb.set(ol.rgb.subarray(y * ol.w * 3, (y + 1) * ol.w * 3), y * W * 3); rgb.set(nw.rgb.subarray(y * nw.w * 3, (y + 1) * nw.w * 3), (y * W + ol.w) * 3); }
          writeFileSync(join(sheetDir, 'compare_' + name + '.png'), encodePng({ w: W, h: h2, rgb })); }
        console.log(`sheet ${name}`); continue; }
      const small = half(decodePng(readFileSync(file))), gold = join(root, 'test', 'golden', name + '.png');
      if (MODE === 'update') { writeFileSync(gold, encodePng(small)); console.log(`updated ${name}`); continue; }
      if (!existsSync(gold)) { console.log(`FAIL  ${name}: no baseline (run: npm run golden:update)`); fail = 1; continue; }
      const e = rmse(decodePng(readFileSync(gold)), small);
      if (e <= TOL) console.log(`ok    ${name}  rmse=${e.toFixed(4)}`); else { console.log(`FAIL  ${name}  rmse=${e.toFixed(4)} (tol ${TOL})`); fail = 1; }
    }
    return fail;
  } finally { stop(); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().then(code => process.exit(code), e => { console.error(e); process.exit(1); });
