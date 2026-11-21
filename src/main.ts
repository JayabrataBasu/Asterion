import { PRESETS, settings } from './core/config';
import { ACTIONS, DEFAULT_BINDS, loadSave, writeSave, type Action } from './core/save';
import { PerfHud } from './dev/perfHud';
import { FrameBuilder } from './gfx/draw';
import { panel, panelOrigin } from './gfx/menu';
import { Renderer } from './gfx/renderer';
import { RAMPS, gi } from './gfx/atlas';
import { Audio } from './audio/audio';
import { DT, In, Kind, MAX_B, MAX_E, MAX_P, PROF_NAMES, Sim, UP_DESC, UP_MAX, UP_N, UP_NAME } from './sim/sim';
import { MAX_PLANETS, PLANET_STRIDE, STATION_NAMES, hasStation, planetParams, planetsNear, sectorOf, stationType } from './sim/world';
import { hash2 } from './core/util';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const perfEl = document.getElementById('perf') as HTMLElement;

function fatal(msg: string): never {
  document.body.style.cssText = 'margin:0;background:#04070c;color:#9fd;font:16px monospace;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:24px';
  document.body.textContent = msg;
  throw new Error(msg);
}
let rendererTmp: Renderer;
try { rendererTmp = new Renderer(canvas); }
catch (e) { fatal('ASTERION needs WebGL2 with float render targets, which this browser or GPU did not provide.\n(' + (e instanceof Error ? e.message.split('\n')[0] : 'unknown error') + ')'); }
const renderer = rendererTmp;
canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); say('graphics context lost - recovering'); lost = true; });
canvas.addEventListener('webglcontextrestored', () => location.reload());
let lost = false;

const save = loadSave();
const urlSeed = new URLSearchParams(location.search).get('seed');
const sim = new Sim(urlSeed !== null ? parseInt(urlSeed, 10) >>> 0 : (Math.random() * 1e9) >>> 0);
const fb = new FrameBuilder(sim, renderer);
const perf = new PerfHud(perfEl);
const audio = new Audio();
const view = new Float32Array(MAX_PLANETS * PLANET_STRIDE);
let hitStop = 0, lastKills = 0, lastHp = 100;

// ---------------------------------------------------------------- persistent options -> live state
audio.volume = save.volume; audio.muted = save.muted;
sim.assist = save.assist; sim.aimAssist = save.aimAssist; settings.cb = save.cb; settings.reduceFx = save.reduceFx; sim.hard = save.hard;
let mouseAim = save.aim;
function persist(): void {
  sim.hard = save.hard; applyHc();
  save.volume = audio.volume; save.muted = audio.muted; save.assist = sim.assist; save.aimAssist = sim.aimAssist; save.aim = mouseAim; save.cb = settings.cb; save.reduceFx = settings.reduceFx;
  writeSave(save);
}
let hcBase: { nebula: number; bgK: number; sun: number } | null = null;
function applyHc(): void {
  if (save.hc) { if (!hcBase) hcBase = { nebula: settings.nebula, bgK: settings.bgK, sun: settings.sun }; settings.nebula = 0.4; settings.bgK = 0.2; settings.sun = 0.5; }
  else if (hcBase) { settings.nebula = hcBase.nebula; settings.bgK = hcBase.bgK; settings.sun = hcBase.sun; hcBase = null; }
}
function dailySeed(): number { const d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }
function bank(): void { for (let i = 0; i < UP_N; i++) save.up[i] = sim.up[i]; save.scrap = sim.scrap; writeSave(save); }
function newRun(): void {
  for (let i = 0; i < UP_N; i++) sim.up[i] = save.up[i];
  sim.scrap = save.scrap;
  sim.hard = save.hard;
  sim.reset(urlSeed !== null ? parseInt(urlSeed, 10) >>> 0 : save.daily ? dailySeed() : (Math.random() * 1e9) >>> 0);
  fb.hiScore = save.hi; deathHandled = false; lastHp = sim.hp;
}
let deathHandled = false;
newRun();

// ---------------------------------------------------------------- state machine
type State = 'menu' | 'play' | 'pause' | 'shop' | 'controls' | 'map';
let state: State = 'menu';
let sel = 0;
let waitingBind = -1;           // index into ACTIONS while capturing a key
const keys = new Set<string>();
const BLOCK = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);
let toast = ''; let toastT = 0;
function say(s: string): void { toast = s; toastT = 2.2; }

function keyLabel(code: string): string {
  return code.replace(/^Key/, '').replace(/^Digit/, '').replace('Space', 'SPACE').replace('ShiftLeft', 'L-SHIFT').replace('ShiftRight', 'R-SHIFT').replace(/^Arrow/, '').toUpperCase();
}
const bindOf = (a: Action): string => save.binds[a];
fb.dockKey = keyLabel(bindOf('dock'));

// ---- tutorial (first run only)
let tut = save.tutDone ? 99 : 0, tutAcc = 0, tutTurn = 0, tutLastA = 0;
function tutorial(dt: number): void {
  if (tut >= 99 || !sim.alive) { fb.prompt = ''; return; }
  if (tut === 0) { fb.prompt = 'HOLD ' + keyLabel(bindOf('thrust')) + ' TO THRUST'; if (sim.thrusting) tutAcc += dt; if (tutAcc > 1.2) tut = 1; tutLastA = sim.sa; }
  else if (tut === 1) {
    fb.prompt = 'TURN WITH ' + keyLabel(bindOf('left')) + ' / ' + keyLabel(bindOf('right'));
    let da = sim.sa - tutLastA; da = Math.atan2(Math.sin(da), Math.cos(da)); tutTurn += Math.abs(da); tutLastA = sim.sa;
    if (tutTurn > 2.5) tut = 2;
  } else if (tut === 2) { fb.prompt = 'HOLD ' + keyLabel(bindOf('fire')) + ' TO FIRE'; if (sim.shots >= 8) tut = 3; }
  else if (tut === 3) { fb.prompt = 'SHOOT ROCKS AND SHIPS, THEN FLY OVER THE  ◆  SCRAP'; if (sim.scrapTotal > 0) tut = 4; }
  else if (tut === 4) { fb.prompt = 'FLY TO THE STATION RING (RADAR ◆) AND PRESS ' + keyLabel(bindOf('dock')) + ' TO UPGRADE'; }
}
function finishTut(): void { if (tut < 99) { tut = 99; save.tutDone = true; writeSave(save); fb.prompt = ''; } }

// ---- adaptive quality governor
function applyPreset(name: string): void {
  Object.assign(settings, PRESETS[name]); govLevel = 3; snapBase(); resize(); say('preset: ' + name);
}
const base = { chroma: 0, grain: 0, scan: 0, bloom: 1, bloomLevels: 5, cellCss: 8 };
let govLevel = 3, govSlow = 0, govFast = 0;
function snapBase(): void { base.chroma = settings.chroma; base.grain = settings.grain; base.scan = settings.scan; base.bloom = settings.bloom; base.bloomLevels = 5; base.cellCss = settings.cellCss; }
function applyGov(): void {
  settings.chroma = govLevel >= 3 ? base.chroma : 0;
  settings.grain = govLevel >= 3 ? base.grain : 0;
  settings.scan = govLevel >= 2 ? base.scan : 0;
  settings.bloom = govLevel >= 1 ? base.bloom : 0;
  settings.bloomLevels = govLevel >= 3 ? 5 : govLevel === 2 ? 4 : 3;
  const cell = govLevel === 0 ? base.cellCss + 2 : base.cellCss;
  if (cell !== settings.cellCss) { settings.cellCss = cell; resize(); }
}
function governor(): void {
  if (!settings.auto) return;
  const cost = renderer.gpuMs > 0 ? renderer.gpuMs + perf.cpuMs : perf.frameMs;
  if (perf.frameMs > 24) { govSlow++; govFast = 0; } else if (cost < 7 && renderer.gpuMs > 0) { govFast++; govSlow = 0; } else { govSlow = Math.max(0, govSlow - 1); govFast = 0; }
  if (govSlow > 90 && govLevel > 0) { govLevel--; govSlow = 0; applyGov(); say('auto-quality: level ' + govLevel + ' (frames running long)'); }
  else if (govFast > 600 && govLevel < 3) { govLevel++; govFast = 0; applyGov(); say('auto-quality: level ' + govLevel); }
}

// ---------------------------------------------------------------- menus
interface MenuDef { title: string; lines: string[]; footer: string }
const onOff = (b: boolean): string => (b ? 'ON ' : 'OFF');
function optionsMenu(): MenuDef {
  return {
    title: state === 'menu' ? 'A S T E R I O N' : 'P A U S E D',
    lines: [
      state === 'menu' ? 'LAUNCH' : 'RESUME',
      'MOUSE AIM ........ ' + onOff(mouseAim),
      'FLIGHT ASSIST .... ' + onOff(sim.assist),
      'AIM ASSIST ....... ' + ['OFF   ', 'WIDE  ', 'LEAD  ', 'HOMING'][sim.aimAssist],
      'VOLUME ........... ' + Math.round(audio.volume * 100) + '%',
      'SOUND ............ ' + onOff(!audio.muted),
      'COLOUR-BLIND ..... ' + onOff(settings.cb),
      'REDUCED FX ....... ' + onOff(settings.reduceFx),
      'HIGH CONTRAST .... ' + onOff(save.hc),
      'DAILY SEED ....... ' + onOff(save.daily),
      'HARD MODE ........ ' + onOff(save.hard),
      'REBIND KEYS',
    ],
    footer: 'UP/DOWN  SELECT     ENTER  CHANGE     LEFT/RIGHT  VOLUME',
  };
}
/** Read-only cheat sheet of every control (uses the player's current bindings); shown beside the title and pause menus. */
function controlsCard(): MenuDef {
  const k = (a: Action): string => keyLabel(bindOf(a));
  const row = (n: string, v: string): string => (n + ' ..................').slice(0, 15) + ' ' + v;
  return {
    title: 'F L I G H T   C O N T R O L S',
    lines: [
      row('THRUST', k('thrust') + ' / UP'), row('TURN', k('left') + ' ' + k('right') + ' / ARROWS'), row('BRAKE', k('brake') + ' / DOWN'),
      row('FIRE', k('fire') + (mouseAim ? ' / CLICK' : '')), row('BOOST', 'HOLD ' + k('boost')), row('DODGE', k('dodge') + '  (BRIEF INVULN.)'),
      row('MISSILE', k('missile') + '  (NEEDS UPGRADE)'), row('DOCK / SHOP', k('dock') + '  AT STATION RING'),
      row('MAP', 'N'), row('PAUSE', 'P / ESC'), row('MOUSE AIM', 'ON/OFF IN OPTIONS'),
    ],
    footer: 'REBIND ANY KEY UNDER  REBIND KEYS',
  };
}
function controlsMenu(): MenuDef {
  const lines: string[] = [];
  for (let i = 0; i < ACTIONS.length; i++) lines.push((ACTIONS[i].toUpperCase() + ' ..............').slice(0, 14) + ' ' + (waitingBind === i ? '[ PRESS A KEY ]' : keyLabel(bindOf(ACTIONS[i]))));
  lines.push('RESET DEFAULTS', 'BACK');
  return { title: 'C O N T R O L S', lines, footer: 'ENTER  REBIND     ESC  BACK     (ARROW KEYS ALWAYS WORK)' };
}
function shopMenu(): MenuDef {
  const lines: string[] = [];
  for (let i = 0; i < UP_N; i++) {
    const l = sim.up[i];
    lines.push((UP_NAME[i] + '              ').slice(0, 14) + ' ' + '#'.repeat(l) + '.'.repeat(UP_MAX - l) + '  ' + (l >= UP_MAX ? 'MAXED   ' : String(sim.price(i)).padStart(3) + ' SCRAP') + '  ' + UP_DESC[i]);
  }
  lines.push('UNDOCK');
  return { title: STATION_NAMES[sim.dockType].split('').join(' ') + '   -   SCRAP ' + sim.scrap, lines, footer: 'PRICES x' + sim.dockMult.toFixed(2) + '   HULL REPAIRED + BOOST REFILLED   ENTER  BUY   ESC  UNDOCK' };
}
function menuLen(): number { return state === 'controls' ? ACTIONS.length + 2 : state === 'shop' ? UP_N + 1 : 12; }

function activate(): void {
  if (state === 'menu' || state === 'pause') {
    switch (sel) {
      case 0: if (state === 'menu') newRun(); state = 'play'; break;
      case 1: mouseAim = !mouseAim; break;
      case 2: sim.assist = !sim.assist; break;
      case 3: sim.aimAssist = (sim.aimAssist + 1) % 4; break;
      case 4: audio.setVolume(audio.volume >= 1 ? 0.2 : Math.min(1, audio.volume + 0.2)); break;
      case 5: audio.setMuted(!audio.muted); break;
      case 6: settings.cb = !settings.cb; break;
      case 7: settings.reduceFx = !settings.reduceFx; break;
      case 8: save.hc = !save.hc; break;
      case 9: save.daily = !save.daily; break;
      case 10: save.hard = !save.hard; break;
      case 11: state = 'controls'; sel = 0; return;
    }
    persist();
  } else if (state === 'controls') {
    if (sel < ACTIONS.length) waitingBind = sel;
    else if (sel === ACTIONS.length) { for (const a of ACTIONS) save.binds[a] = DEFAULT_BINDS[a]; fb.dockKey = keyLabel(bindOf('dock')); writeSave(save); }
    else { state = 'pause'; sel = 11; }
  } else if (state === 'shop') {
    if (sel < UP_N) {
      if (sim.buyUpgrade(sel)) { audio.unlock(); say('installed: ' + UP_NAME[sel]); bank(); } else say(sim.up[sel] >= UP_MAX ? 'already maxed' : 'not enough scrap');
    } else leaveShop();
  }
}
function leaveShop(): void { state = 'play'; bank(); finishTut(); }
function tryDock(): void {
  if (sim.alive && sim.dockable >= 0 && state === 'play') { sim.serviceShip(); bank(); state = 'shop'; sel = 0; }
}

// ---------------------------------------------------------------- input
function menuKey(code: string): void {
  if (state === 'map') { if (code === 'Escape' || code === 'KeyN' || code === 'Enter' || code === 'KeyP') state = 'play'; return; }
  if (waitingBind >= 0) {
    if (code !== 'Escape') { save.binds[ACTIONS[waitingBind]] = code; fb.dockKey = keyLabel(bindOf('dock')); writeSave(save); }
    waitingBind = -1; return;
  }
  const n = menuLen();
  switch (code) {
    case 'ArrowUp': case 'KeyW': sel = (sel + n - 1) % n; break;
    case 'ArrowDown': case 'KeyS': sel = (sel + 1) % n; break;
    case 'ArrowLeft': if ((state === 'menu' || state === 'pause') && sel === 4) { audio.setVolume(Math.max(0, audio.volume - 0.1)); persist(); } break;
    case 'ArrowRight': if ((state === 'menu' || state === 'pause') && sel === 4) { audio.setVolume(Math.min(1, audio.volume + 0.1)); persist(); } break;
    case 'Enter': case 'Space': activate(); break;
    case 'Escape': case 'KeyP':
      if (state === 'shop') leaveShop();
      else if (state === 'controls') { state = 'pause'; sel = 11; }
      else if (state === 'pause') state = 'play';
      break;
  }
}

function onKey(code: string): void {
  audio.unlock();
  if (state !== 'play') { menuKey(code); return; }
  if (!sim.alive && (code === 'KeyR' || code === 'Enter') && sim.deadT > 0.6) { newRun(); return; }
  if (!sim.alive && code === 'KeyC' && sim.deadT > 0.6) {
    const acc = sim.shots > 0 ? Math.round(100 * sim.hits / sim.shots) : 0, m = (sim.time / 60) | 0, sec = (sim.time | 0) % 60;
    const txt = 'ASTERION  score ' + sim.score + '  kills ' + sim.kills + '  time ' + m + ':' + String(sec).padStart(2, '0') + '  accuracy ' + acc + '%  bosses ' + sim.bossKills;
    void navigator.clipboard?.writeText(txt).then(() => say('result copied to clipboard'), () => say('clipboard unavailable'));
    return;
  }
  if (code === 'Escape' || code === 'KeyP') { if (sim.alive) { state = 'pause'; sel = 0; } return; }
  if (code === bindOf('dock')) { tryDock(); return; }
  if (code === 'KeyN') { state = 'map'; return; }
  switch (code) {
    case 'Tab': mouseAim = !mouseAim; say('mouse aim ' + (mouseAim ? 'on' : 'off')); persist(); break;
    case 'KeyV': sim.assist = !sim.assist; say('flight assist ' + (sim.assist ? 'on' : 'off')); persist(); break;
    case 'KeyM': audio.setMuted(!audio.muted); say('sound ' + (audio.muted ? 'off' : 'on')); persist(); break;
    case 'F3': case 'Backquote': settings.perf = !settings.perf; perf.show(settings.perf); break;
    case 'Digit1': applyPreset('low'); break;
    case 'Digit2': applyPreset('medium'); break;
    case 'Digit3': applyPreset('high'); break;
    case 'Digit4': applyPreset('ultra'); break;
    case 'KeyB': settings.bloom = settings.bloom > 0 ? 0 : 1; say('bloom ' + (settings.bloom ? 'on' : 'off')); break;
    case 'KeyC': settings.curve = settings.curve > 0 ? 0 : 0.05; say('crt ' + (settings.curve ? 'on' : 'off')); break;
    case 'KeyG': settings.chroma = settings.chroma > 0 ? 0 : 0.005; say('aberration ' + (settings.chroma ? 'on' : 'off')); break;
    case 'KeyH': settings.hud = !settings.hud; break;
    case 'KeyT': settings.ramp = (settings.ramp + 1) % RAMPS.length; say('ramp: ' + RAMPS[settings.ramp].name); break;
    case 'KeyQ': settings.auto = !settings.auto; if (!settings.auto) { govLevel = 3; applyGov(); } say('auto-quality ' + (settings.auto ? 'on' : 'off')); break;
    case 'BracketLeft': settings.cellCss = Math.min(24, settings.cellCss + 1); snapBase(); resize(); say('cell ' + settings.cellCss + 'px'); break;
    case 'BracketRight': settings.cellCss = Math.max(4, settings.cellCss - 1); snapBase(); resize(); say('cell ' + settings.cellCss + 'px'); break;
    case 'Minus': settings.bgK = Math.max(0, settings.bgK - 0.04); say('backdrop ' + settings.bgK.toFixed(2)); break;
    case 'Equal': settings.bgK = Math.min(1, settings.bgK + 0.04); say('backdrop ' + settings.bgK.toFixed(2)); break;
  }
}
addEventListener('keydown', e => {
  if (BLOCK.has(e.code) || (e.code === 'Backquote')) e.preventDefault();
  if (e.repeat) { if (state !== 'play' && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) menuKey(e.code); return; }
  keys.add(e.code);
  onKey(e.code);
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); if (state === 'play' && sim.alive) { state = 'pause'; sel = 0; } });

// ---- mouse (twin-stick aim)
let mouseDown = 0, mouseMoved = false, mAng = 0;
addEventListener('pointerdown', e => { audio.unlock(); mouseDown |= 1 << e.button; });
addEventListener('pointerup', e => { mouseDown &= ~(1 << e.button); });
addEventListener('contextmenu', e => e.preventDefault());
addEventListener('pointermove', e => { mAng = Math.atan2(-(e.clientY - innerHeight * 0.5), e.clientX - innerWidth * 0.5); mouseMoved = true; });

// ---- gamepad
let padPrev = 0;
function pollPad(): { m: number; aim: boolean; ang: number } {
  const out = { m: 0, aim: false, ang: 0 };
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let gp: Gamepad | null = null;
  for (const p of pads) if (p && p.connected) { gp = p; break; }
  if (!gp) { padPrev = 0; return out; }
  const b = (i: number): boolean => !!gp!.buttons[i]?.pressed;
  const ax = (i: number): number => { const v = gp!.axes[i] ?? 0; return Math.abs(v) < 0.18 ? 0 : v; };
  const lx = ax(0), ly = ax(1), rx = ax(2), ry = ax(3);
  if (ly < -0.35 || b(12)) out.m |= In.Thrust;
  if (ly > 0.6) out.m |= In.Brake;
  if (lx < -0.3) out.m |= In.Left; else if (lx > 0.3) out.m |= In.Right;
  if (b(0) || b(7)) out.m |= In.Fire;
  if (b(5) || b(6)) out.m |= In.Boost;
  if (b(1)) out.m |= In.Dodge;
  if (b(4)) out.m |= In.Missile;
  if (b(2)) out.m |= In.Brake;
  if (rx * rx + ry * ry > 0.25) { out.aim = true; out.ang = Math.atan2(-ry, rx); }
  // edge-triggered menu / interact buttons
  const bits = (b(9) ? 1 : 0) | (b(3) ? 2 : 0);
  const up = ly < -0.6 || b(12) ? 16 : 0, dn = ly > 0.6 || b(13) ? 32 : 0, ok = b(0) ? 64 : 0, back = b(1) ? 128 : 0;
  const all = bits | up | dn | ok | back, edge = all & ~padPrev; padPrev = all;
  if (edge & 1) onKey('Escape');
  if (edge & 2) { if (state === 'play') tryDock(); }
  if (state !== 'play') {
    if (edge & 16) menuKey('ArrowUp'); if (edge & 32) menuKey('ArrowDown'); if (edge & 64) menuKey('Enter'); if (edge & 128) menuKey('Escape');
  } else if (!sim.alive && (edge & 64) && sim.deadT > 0.6) newRun();
  return out;
}
function rumble(d: number): void {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const p of pads) {
    const act = (p as unknown as { vibrationActuator?: { playEffect?: (t: string, o: object) => unknown } } | null)?.vibrationActuator;
    if (act?.playEffect) { act.playEffect('dual-rumble', { duration: 120, strongMagnitude: Math.min(1, d / 20), weakMagnitude: 0.4 }); break; }
  }
}

let demo = false;
function autopilot(): number {
  // debug attract mode: hunt the nearest hostile
  let best = -1, bd = 1e12;
  for (let i = 0; i < MAX_E; i++) {
    const k = sim.ek[i]; if (k < 1 || k > 3) continue;
    const dx = sim.ex[i] - sim.sx, dy = sim.ey[i] - sim.sy, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  let m = 0;
  if (best < 0) return In.Thrust | In.Left;
  const want = Math.atan2(sim.ey[best] - sim.sy, sim.ex[best] - sim.sx);
  let da = want - sim.sa; da = Math.atan2(Math.sin(da), Math.cos(da));
  if (da > 0.05) m |= In.Left; else if (da < -0.05) m |= In.Right;
  if (Math.abs(da) < 0.5 && bd > 60 * 60) m |= In.Thrust;
  if (Math.abs(da) < 0.25 && bd < 160 * 160) m |= In.Fire;
  if (bd < 30 * 30) m |= In.Brake;
  return m;
}
const alt: Partial<Record<Action, string>> = { thrust: 'ArrowUp', left: 'ArrowLeft', right: 'ArrowRight', brake: 'ArrowDown', boost: 'ShiftRight' };
const held = (a: Action): boolean => keys.has(save.binds[a]) || (alt[a] !== undefined && keys.has(alt[a]!));
function pollInput(): number {
  if (demo) { sim.aimOn = false; return autopilot(); }
  let m = 0;
  if (held('thrust')) m |= In.Thrust;
  if (held('left')) m |= In.Left;
  if (held('right')) m |= In.Right;
  if (held('brake')) m |= In.Brake;
  if (held('fire')) m |= In.Fire;
  if (held('boost')) m |= In.Boost;
  if (held('dodge')) m |= In.Dodge;
  if (held('missile')) m |= In.Missile;
  const pad = pollPad();
  m |= pad.m;
  if (mouseAim && mouseMoved) { if (mouseDown & 1) m |= In.Fire; if (mouseDown & 4) m |= In.Thrust; if (mouseDown & 2) m |= In.Missile; }
  if (pad.aim) { sim.aimOn = true; sim.aimAng = pad.ang; }
  else if (mouseAim && mouseMoved) { sim.aimOn = true; sim.aimAng = mAng; }
  else sim.aimOn = false;
  return m;
}

// debug / screenshot overrides: ?nebula=0&bloom=0&cell=10&ramp=1&chroma=0
{
  const q = new URLSearchParams(location.search);
  for (const k of ['nebula', 'sun', 'bloom', 'chroma', 'scan', 'grain', 'vig', 'bgK', 'exposure', 'fgBase', 'fgGain', 'curve', 'ramp', 'cellCss'] as const) {
    const v = q.get(k === 'cellCss' ? 'cell' : k);
    if (v !== null) (settings as unknown as Record<string, number>)[k] = parseFloat(v);
  }
  demo = q.has('demo');
  const ff = parseFloat(q.get('ff') ?? '0');
  const debug = demo || ff > 0 || q.has('x') || q.has('y') || q.has('hud') || q.has('perf') || q.has('play');
  if (debug) { state = 'play'; finishTutQuiet(); }
  for (let i = 0; i < ff * 60; i++) { sim.input = demo ? autopilot() : 0; sim.step(); if (!sim.alive && sim.deadT > 1) sim.reset(5); }
  const qs = q.get('state'); if (qs === 'shop' || qs === 'pause' || qs === 'controls' || qs === 'map') { state = qs; sim.scrap = 140; }
  if (q.has('event')) { sim.triggerEvent(Math.min(4, Math.max(0, ({ comet: 1, meteors: 2, flare: 3, storm: 4 } as Record<string, number>)[q.get('event')!] ?? (parseInt(q.get('event')!, 10) | 0)))); sim.warnT = parseFloat(q.get('evwarn') ?? '0.05'); }
  if (q.has('hp')) sim.hp = parseFloat(q.get('hp')!);
  const spawn = q.get('spawn');
  if (spawn) {
    const defs: Record<string, number> = { boss: Kind.Boss, sniper: Kind.Sniper, tender: Kind.Tender, splitter: Kind.Splitter, rammer: Kind.Rammer, gunship: Kind.Gunship, drone: Kind.Drone };
    let n = 0;
    for (const nm of spawn.split(',')) if (defs[nm]) { const e = sim.spawnEnt(defs[nm], sim.sx + 30 + 24 * n, sim.sy + (n & 1 ? 16 : -16), 0, 0); if (e >= 0) { sim.ea[e] = 3.1; sim.es[e] = 0; if (nm === 'gunship') sim.eshield[e] = 8; } n++; }
  }
  if (q.has('x')) { sim.sx = sim.spx = parseFloat(q.get('x')!); }
  if (q.has('y')) { sim.sy = sim.spy = parseFloat(q.get('y')!); }
  if (q.has('obj')) { sim.objTier = parseInt(q.get('obj')!, 10) | 0; sim.objKills = 0; sim.step(); }
  if (q.has('hud') && q.get('hud') === '0') settings.hud = false;
  if (q.has('perf')) { settings.perf = true; perf.show(true); }
}
function finishTutQuiet(): void { tut = 99; }
snapBase();
function resize(): void { renderer.resize(innerWidth, innerHeight, devicePixelRatio || 1); }
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- loop
let acc = 0, last = performance.now();
let camX = 0, camY = 0, camInit = false;
let combat = 0;
const THEMES: [number, number, number][] = [[1, 1, 1], [1.55, 0.6, 0.55], [0.6, 1.3, 0.8], [1.2, 0.7, 1.55], [1.4, 1.0, 0.5], [0.7, 1.1, 1.55]];
const tint: [number, number, number] = [1, 1, 1];
function updateTint(dt: number, x: number, y: number): void {
  const sx = sectorOf(x), sy = sectorOf(y);
  const th = (sx === 0 && sy === 0) ? THEMES[0] : THEMES[Math.floor(hash2(sx * 7 + 3, sy * 13 + 1) * THEMES.length) % THEMES.length];
  const k = 1 - Math.exp(-0.8 * dt);
  for (let i = 0; i < 3; i++) tint[i] += (th[i] - tint[i]) * k;
}
function nearHostile(): boolean {
  for (let i = 0; i < MAX_E; i++) {
    const k = sim.ek[i]; if (k < 1 || k > 3) continue;
    const dx = sim.ex[i] - sim.sx, dy = sim.ey[i] - sim.sy;
    if (dx * dx + dy * dy < 150 * 150) return true;
  }
  return false;
}

const visited = new Set<number>();
const planetScratch = new Float32Array(PLANET_STRIDE);
const G_DIA = gi('◆'), G_RING = gi('○'), G_AT = gi('@'), G_DOT = gi('·');
function drawMap(): void {
  const RX = 7, RY = 4, W = (2 * RX + 1) * 3, bt = renderer.glyphs;
  const title = 'S E C T O R   M A P', footer = 'N / ESC  CLOSE     ◆ STATION   ○ PLANET   @ YOU';
  const lines: string[] = [];
  for (let i = 0; i < 2 * RY + 1; i++) lines.push(' '.repeat(W - 4));
  panel(bt, renderer.cols, renderer.rows, title, lines, -1, footer, 0);
  const o = panelOrigin(renderer.cols, renderer.rows, title, lines, footer);
  const cx = sectorOf(sim.sx), cy = sectorOf(sim.sy);
  for (let gy = -RY; gy <= RY; gy++) for (let gx = -RX; gx <= RX; gx++) {
    const sx = cx + gx, sy = cy - gy;
    const col = o.x + 3 + 2 + (gx + RX) * 3, row = renderer.rows - 1 - (o.y + 3 + gy + RY);
    const known = visited.has(((sx & 0xffff) << 16) | (sy & 0xffff)) || (sx === cx && sy === cy);
    if (!known) { bt.put(col + 1, row, G_DOT, 0.18, 0.22, 0.26, 1); continue; }
    if (planetParams(sx, sy, planetScratch, 0)) bt.put(col, row, G_RING, 0.3, 1.0, 0.55, 1);
    if (hasStation(sx, sy)) { const t = stationType(sx, sy); bt.put(col + 1, row, G_DIA, t === 1 ? 0.4 : t === 2 ? 1.4 : 0.4, t === 1 ? 1.4 : t === 2 ? 0.3 : 0.9, t === 1 ? 0.5 : t === 2 ? 1.2 : 1.5, 1); }
    else bt.put(col + 1, row, G_DOT, 0.4, 0.5, 0.55, 1);
    if (sx === cx && sy === cy) bt.put(col + 2, row, G_AT, 1.8, 1.6, 0.4, 1);
  }
}

const warp = new Float32Array(24);
/** Screen-space distortion sources: expanding shock rings from explosions and heat shimmer behind the player's engines. */
function buildWarp(cx: number, cy: number, fx: number): Float32Array {
  warp.fill(0);
  if (fx <= 0) return warp;
  const cols = renderer.cols, rows = renderer.rows, asp = renderer.aspect, ar = innerWidth / innerHeight;
  let n = 0;
  for (let r = 0; r < 24 && n < 4; r++) {
    if (sim.rlife[r] <= 0) continue;
    const u = (sim.rx[r] - cx) / cols + 0.5, v = (sim.ry[r] - cy) / asp / rows + 0.5;
    if (u < -0.3 || u > 1.3 || v < -0.3 || v > 1.3) continue;
    warp[n * 4] = u; warp[n * 4 + 1] = v; warp[n * 4 + 2] = sim.rrad[r] / cols * ar; warp[n * 4 + 3] = (sim.rlife[r] / 0.5) * 0.9 * fx;
    n++;
  }
  if (sim.alive && sim.thrusting) {
    const ca = Math.cos(sim.sa), sa = Math.sin(sim.sa);
    const ex = sim.sx - ca * 9, ey = sim.sy - sa * 9;
    warp[16] = (ex - cx) / cols + 0.5; warp[17] = (ey - cy) / asp / rows + 0.5; warp[19] = (sim.boosting ? 1.0 : 0.55) * fx;
  }
  return warp;
}

function frame(now: number): void {
  if (lost) { requestAnimationFrame(frame); return; }
  const t0 = performance.now();
  const dt = Math.min(0.25, (now - last) / 1000); last = now;
  const playing = state === 'play', attract = state === 'menu';
  acc = (playing || attract) ? Math.min(acc + dt * (sim.slowT > 0 ? 0.3 : 1), DT * 5) : 0;          // cap: no spiral of death

  const s0 = performance.now();
  if (playing) {
    sim.input = pollInput();
    if (hitStop > 0) { hitStop -= dt; acc = 0; }          // brief freeze on kills
    else while (acc >= DT) { sim.step(); acc -= DT; }
    if (sim.kills > lastKills) hitStop = settings.reduceFx ? 0 : 0.045;
    lastKills = sim.kills;
    if (sim.hp < lastHp - 0.5) rumble(lastHp - sim.hp);
    lastHp = sim.hp;
    if (!sim.alive && !deathHandled) { deathHandled = true; if (sim.score > save.hi) { save.hi = sim.score; } bank(); }
    tutorial(dt);
    visited.add(((sectorOf(sim.sx) & 0xffff) << 16) | (sectorOf(sim.sy) & 0xffff));
  } else if (attract) {
    sim.input = autopilot(); sim.aimOn = false;
    while (acc >= DT) { sim.step(); acc -= DT; }
    sim.invuln = 1; if (sim.hp < sim.hpMax * 0.5) sim.hp = sim.hpMax;
    if (!sim.alive && sim.deadT > 1.5) sim.reset(5);
    pollPad();
  } else pollPad();
  audio.update(sim, dt, playing);
  const simMs = performance.now() - s0;
  const alpha = acc / DT;

  // camera: follow interpolated ship with velocity look-ahead, exponential smoothing
  const ix = sim.spx + (sim.sx - sim.spx) * alpha, iy = sim.spy + (sim.sy - sim.spy) * alpha;
  const lead = 0.22 + 0.2 * Math.min(1, Math.hypot(sim.svx, sim.svy) / 150);   // look-ahead grows with speed (stands in for zoom: the glyph grid is fixed)
  const tx = ix + sim.svx * lead, ty = iy + sim.svy * lead;
  if (!camInit) { camX = tx; camY = ty; camInit = true; }
  const k = 1 - Math.exp(-6 * dt);
  camX += (tx - camX) * k; camY += (ty - camY) * k;
  const t = sim.time + alpha * DT;
  const sh = sim.shake * (settings.reduceFx ? 0.25 : 1);
  const cx = camX + (Math.sin(t * 67.1) + Math.sin(t * 131.7) * 0.5) * sh * 0.45;
  const cy = camY + (Math.sin(t * 59.3 + 1.7) + Math.sin(t * 113.9) * 0.5) * sh * 0.45;

  // dim the backdrop while hostiles are engaged so ships/bolts read clearly
  combat += ((sim.alive && sim.nEnemy > 0 && nearHostile() ? 1 : 0) - combat) * (1 - Math.exp(-1.5 * dt));
  updateTint(dt, cx, cy);
  renderer.beginFrame();
  fb.showReticle = !demo;
  fb.fx = settings.reduceFx ? 0.35 : 1;
  fb.build(cx, cy, alpha, t, settings.hud && state !== 'menu');
  if (state !== 'play') {
    if (state === 'map') drawMap();
    else {
      const m = state === 'controls' ? controlsMenu() : state === 'shop' ? shopMenu() : optionsMenu();
      const card = (state === 'menu' || state === 'pause') && renderer.cols >= 130;
      panel(renderer.glyphs, renderer.cols, renderer.rows, m.title, m.lines, sel, m.footer, state === 'shop' ? 1 : 0, card ? -34 : 0);
      if (card) { const c = controlsCard(); panel(renderer.glyphs, renderer.cols, renderer.rows, c.title, c.lines, -1, c.footer, 0, 40); }
    }
  }
  if (toastT > 0) { toastT -= dt; renderer.glyphs.text(toast, 2, renderer.rows - 2, 1.2, 1.2, 0.6, 1); }
  const np = planetsNear(cx, cy, renderer.cols * 0.5 + 80, view, sim.time + alpha * DT);
  const spd = Math.sqrt(sim.svx * sim.svx + sim.svy * sim.svy);
  const streak = Math.max(0, Math.min(1, (spd - 85) / 60));
  const fxk = settings.reduceFx ? 0.35 : 1;
  renderer.render({ camX: cx, camY: cy, time: t, planets: view, nPlanets: np, flash: sim.flash * fxk,
    hit: Math.max(sim.hitFlash * fxk, sim.alive && sim.hp < 30 ? 0.22 + 0.16 * Math.sin(t * 7) * fxk : 0),
    streakX: sim.svx, streakY: sim.svy, streak, combat, tint, flare: sim.flare * fxk, storm: sim.storm * fxk, ship: sim.alive ? [ix, iy, sim.boosting ? 1.0 : sim.thrusting ? 0.6 : 0.15] : undefined, warp: buildWarp(cx, cy, settings.reduceFx ? 0 : 1) });

  perf.frame(dt * 1000, performance.now() - t0, simMs);
  governor();
  sim.profOn = settings.perf;
  if (settings.perf) perf.update(now, () =>
    `cpu ${perf.cpuMs.toFixed(2)}ms  sim ${perf.simMs.toFixed(2)}ms  gpu ${renderer.gpuMs.toFixed(2)}ms\n` +
    'step ' + PROF_NAMES.map((n, i) => n + ' ' + sim.prof[i].toFixed(3)).join('  ') + '\n' +
    `cells ${renderer.cols}x${renderer.rows} (${renderer.cwPx}x${renderer.chPx}px)  draws ${renderer.drawCalls}  hdr ${renderer.hdr}\n` +
    `ent ${sim.nEnt}/${MAX_E}  bul ${sim.nBul}/${MAX_B}  par ${sim.nPar}/${MAX_P}  glyphs ${renderer.glyphs.n}  glows ${renderer.glows.n}\n` +
    `sprites ${renderer.sprites.n}  ramp ${renderer.rampName}  auto-q ${settings.auto ? govLevel : 'off'}  heap ${heapMb()}`);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function heapMb(): string {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return mem ? (mem.usedJSHeapSize / 1048576).toFixed(1) + 'MB' : 'n/a';
}

// dev hook for automated screenshots
(window as unknown as { __vg: unknown }).__vg = { sim, settings, renderer, setState: (s: State) => { state = s; sel = 0; } };
