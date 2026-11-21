#!/usr/bin/env node
// Golden-image check: renders fixed scenes in headless Chrome/Chromium (SwiftShader GL) and compares against test/golden/*.png.
//   node scripts/golden.mjs                 compare (exit 1 on any scene above the tolerance)
//   node scripts/golden.mjs update          regenerate baselines
//   node scripts/golden.mjs shots <dir>     save full-size screenshots of every scene (for docs / before-after)
//   node scripts/golden.mjs url '<query>' <file.png>   one ad-hoc screenshot
//   GOLDEN_ONLY=a,b limits the scenes; CHROME=<path> picks the browser.
// No dependencies: PNG decode/encode uses node:zlib. Baselines are per-machine regression guards (software GL), not cross-GPU truth.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  hangar: 'seed=7&state=hangar&ff=0.02&unlockall=1',
  roster: 'seed=7&x=0&y=-3120&ff=0.02&hud=0&roster=1',
  vert_off: 'seed=7&x=-95&y=40&ff=0.02&spawn=gunship,drone,drone',
  vert_on: 'seed=7&x=-95&y=40&ff=0.02&spawn=gunship,drone,drone&vert=1',
  chart: 'seed=7&state=chart&ff=0.02',
  derelict: 'seed=7&x=0&y=0&ff=0.02&hud=0&setpiece=derelict',
  eclipse: 'seed=7&x=0&y=0&ff=0.02&hud=0&event=eclipse&evwarn=0.01&evt=0.5',
  scan: 'seed=1&x=520&y=-53&ff=0.02&scanview=1',
  layers: 'seed=7&x=0&y=0&ff=0.02&layers=1',
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

// ---------------------------------------------------------------- run
async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'golden-'));
  const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: root, shell: true, stdio: 'ignore' });
  const stop = () => { try { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(vite.pid), '/T', '/F']); else vite.kill(); } catch { /* gone */ } rmSync(tmp, { recursive: true, force: true }); };
  try {
    for (let i = 0; i < 120; i++) { try { await fetch(`http://localhost:${PORT}/`); break; } catch { await new Promise(r => setTimeout(r, 500)); } }
    const chrome = findChrome(), only = process.env.GOLDEN_ONLY?.split(',');
    const shotDir = MODE === 'shots' ? (process.argv[3] ?? join(root, 'docs', 'screens')) : null;
    if (shotDir) mkdirSync(shotDir, { recursive: true });
    let fail = 0;
    const list = MODE === 'url' ? [['adhoc', process.argv[3]]] : Object.entries(SCENES);
    for (const [name, q] of list) {
      if (only && !only.includes(name)) continue;
      const file = join(tmp, name + '.png');
      spawnSync(chrome, ['--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars',
        `--user-data-dir=${join(tmp, 'prof')}`, '--window-size=1600,900', '--virtual-time-budget=3000', `--screenshot=${file}`, `http://localhost:${PORT}/?${q}`], { timeout: 120000, stdio: 'ignore' });
      if (!existsSync(file)) { console.log(`FAIL  ${name}: no screenshot`); fail = 1; continue; }
      if (MODE === 'url') { writeFileSync(process.argv[4], readFileSync(file)); console.log('shot ' + process.argv[4]); continue; }
      if (shotDir) { writeFileSync(join(shotDir, name + '.png'), readFileSync(file)); console.log(`shot  ${name}`); continue; }
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
