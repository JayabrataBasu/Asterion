import { PRESETS, settings } from './core/config';
import { ACTIONS, DEFAULT_BINDS, loadSave, upsOf, writeSave, type Action } from './core/save';
import { PerfHud } from './dev/perfHud';
import { mountTuner } from './dev/tune';
import { RATING_KEYS, ROSTER, bar, derive, shipById } from './sim/ships';
import { UNLOCKS, unlockOf } from './sim/unlocks';
import { Explorer } from './game/explore';
import { COMMODITIES, FRAGMENTS, Galaxy, STAR_NAME } from './sim/galaxy';
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
save.unlocked = UNLOCKS.map(u => u.id);   // every hull is open from the start (owner call); unlock goals stay as achievements
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
/** Typed arrival: the scene writes itself in outward from the centre on launch and on first entry to a sector. */
let revealT = -1;
let hyperAmt = 0; const hyperBuf: [number, number, number] = [0, 0, 0];
let dbgIn = 0;   // ?fire=1 / ?boost=1: held inputs, for screenshots
/** Auto camera zoom (off in debug / screenshot sessions unless ?zoom=1). */
function arrive(): void { revealT = 0; }
/** Bank upgrades, scrap and lifetime stats (deltas since the last bank this run). */
const banked = { kills: 0, bosses: 0, scrap: 0 };
function bank(): void {
  const u = upsOf(save, save.ship); for (let i = 0; i < UP_N; i++) u[i] = sim.up[i];
  save.scrap = sim.scrap;
  const st = save.stats;
  st.kills += sim.kills - banked.kills; st.bosses += sim.bossKills - banked.bosses; st.scrap += sim.scrapTotal - banked.scrap;
  banked.kills = sim.kills; banked.bosses = sim.bossKills; banked.scrap = sim.scrapTotal;
  st.maxTier = Math.max(st.maxTier, sim.objTier);
  writeSave(save);
}
/** Sectors seen in the current system (sector map + typed arrivals). */
const visited = new Set<number>();
/** Galaxy seed: kept in the save (random on first launch); daily mode uses the date and does not persist. */
function galaxySeed(): number {
  const g = save.galaxy as { seed?: unknown } | null;
  return typeof g?.seed === 'number' && Number.isInteger(g.seed) ? g.seed : (Math.random() * 1e9) >>> 0;
}
let explorer!: Explorer;
function newRun(): void {
  applyShip();
  explorer = new Explorer(sim, fb, save, save.daily ? dailySeed() : galaxySeed(), !save.daily);
  explorer.onToast = s => say(s);
  explorer.onArrive = () => { visited.clear(); arrive(); };
  banked.kills = banked.bosses = banked.scrap = 0;
  sim.scrap = save.scrap; sim.vert = save.vert;
  sim.hard = save.hard;
  sim.reset(urlSeed !== null ? parseInt(urlSeed, 10) >>> 0 : save.daily ? dailySeed() : (Math.random() * 1e9) >>> 0);
  explorer.enter(0, true);
  fb.hiScore = save.hi; deathHandled = false; lastHp = sim.hp; arrive();
}
let deathHandled = false;
newRun();

// ---------------------------------------------------------------- state machine
type State = 'menu' | 'play' | 'pause' | 'shop' | 'controls' | 'map' | 'hangar' | 'logs' | 'chart' | 'trade';
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
/** A menu is a list of items; each item owns its action (Enter) and optional left/right adjust. */
interface Item { label: string; act?: () => void; adj?: (d: number) => void }
interface MenuDef { title: string; items: Item[]; footer: string; tone?: number }
const onOff = (b: boolean): string => (b ? 'ON ' : 'OFF');
const opt = (label: string, value: string, act: () => void, adj?: (d: number) => void): Item => ({ label: (label + ' ..................').slice(0, 18) + ' ' + value, act: () => { act(); persist(); }, adj });
function optionsMenu(): MenuDef {
  const title = state === 'menu';
  const items: Item[] = [{ label: title ? 'LAUNCH  (' + shipById(save.ship).name + ')' : 'RESUME', act: () => { if (title) newRun(); state = 'play'; } }];
  if (title) items.push({ label: 'HANGAR', act: () => { state = 'hangar'; sel = Math.max(0, ROSTER.findIndex(d => d.id === save.ship)); } });
  items.push(
    { label: 'SHIP LOGS', act: () => { back = state as 'menu' | 'pause'; state = 'logs'; sel = 0; } },
    opt('MOUSE AIM', onOff(mouseAim), () => { mouseAim = !mouseAim; }),
    opt('FLIGHT ASSIST', onOff(sim.assist), () => { sim.assist = !sim.assist; }),
    opt('AIM ASSIST', ['OFF   ', 'WIDE  ', 'LEAD  ', 'HOMING'][sim.aimAssist], () => { sim.aimAssist = (sim.aimAssist + 1) % 4; }),
    opt('VOLUME', Math.round(audio.volume * 100) + '%', () => audio.setVolume(audio.volume >= 1 ? 0.2 : Math.min(1, audio.volume + 0.2)),
      d => { audio.setVolume(Math.min(1, Math.max(0, audio.volume + d * 0.1))); persist(); }),
    opt('SOUND', onOff(!audio.muted), () => audio.setMuted(!audio.muted)),
    opt('COLOUR-BLIND', onOff(settings.cb), () => { settings.cb = !settings.cb; }),
    opt('REDUCED FX', onOff(settings.reduceFx), () => { settings.reduceFx = !settings.reduceFx; }),
    opt('HIGH CONTRAST', onOff(save.hc), () => { save.hc = !save.hc; }),
    opt('NEWS TICKER', onOff(save.ticker), () => { save.ticker = !save.ticker; }),
    opt('VERTICAL (EXP.)', onOff(save.vert), () => { save.vert = !save.vert; sim.vert = save.vert; }),
  );
  if (title) items.push(opt('DAILY SEED', onOff(save.daily), () => { save.daily = !save.daily; }), opt('HARD MODE', onOff(save.hard), () => { save.hard = !save.hard; }));
  items.push({ label: 'REBIND KEYS', act: () => { back = state as 'menu' | 'pause'; state = 'controls'; sel = 0; } });
  return { title: title ? 'A S T E R I O N' : 'P A U S E D', items, footer: 'UP/DOWN  SELECT     ENTER  CHANGE     LEFT/RIGHT  ADJUST' };
}
let back: 'menu' | 'pause' = 'menu';
/** Read-only cheat sheet of every control (uses the player's current bindings); shown beside the title and pause menus. */
function controlsCard(): MenuDef {
  const k = (a: Action): string => keyLabel(bindOf(a));
  const row = (n: string, v: string): Item => ({ label: (n + ' ..................').slice(0, 15) + ' ' + v });
  const items = [
    row('THRUST', k('thrust') + ' / UP'), row('TURN', k('left') + ' ' + k('right') + ' / ARROWS'), row('BRAKE', k('brake') + ' / DOWN'),
    row('FIRE', k('fire') + (mouseAim ? ' / CLICK' : '')), row('BOOST', 'HOLD ' + k('boost')), row('DODGE', k('dodge') + '  (BRIEF INVULN.)'),
    row('STRAFE', k('strafeL') + ' / ' + k('strafeR')), row('MISSILE', k('missile') + '  (NEEDS MODULE)'), row('SCAN', 'HOLD ' + k('scan')),
    row('CRUISE', k('cruise') + '  (NO HOSTILES NEAR)'), row('DOCK / SHOP', k('dock') + '  AT STATION RING'), row('CHART / JUMP', 'N'),
  ];
  if (save.vert) items.push(row('CLIMB / DIVE', k('climb') + ' / ' + k('dive')));
  items.push(row('PAUSE', 'P / ESC'));
  return { title: 'F L I G H T   C O N T R O L S', items, footer: 'REBIND ANY KEY UNDER  REBIND KEYS' };
}
function controlsMenu(): MenuDef {
  const items: Item[] = ACTIONS.map((a, i) => ({ label: (a.toUpperCase() + ' ..............').slice(0, 14) + ' ' + (waitingBind === i ? '[ PRESS A KEY ]' : keyLabel(bindOf(a))), act: () => { waitingBind = i; } }));
  items.push({ label: 'RESET DEFAULTS', act: () => { for (const a of ACTIONS) save.binds[a] = DEFAULT_BINDS[a]; fb.dockKey = keyLabel(bindOf('dock')); writeSave(save); } });
  items.push({ label: 'BACK', act: () => { state = back; sel = 0; } });
  return { title: 'C O N T R O L S', items, footer: 'ENTER  REBIND     ESC  BACK     (ARROW KEYS ALWAYS WORK)' };
}
function shopMenu(): MenuDef {
  const items: Item[] = [];
  for (let i = 0; i < UP_N; i++) {
    const l = sim.up[i];
    items.push({ label: (UP_NAME[i] + '              ').slice(0, 14) + ' ' + '#'.repeat(l) + '.'.repeat(UP_MAX - l) + '  ' + (l >= UP_MAX ? 'MAXED   ' : String(sim.price(i)).padStart(3) + ' SCRAP') + '  ' + UP_DESC[i],
      act: () => { if (sim.buyUpgrade(i)) { audio.unlock(); say('installed: ' + UP_NAME[i]); bank(); } else say(sim.up[i] >= UP_MAX ? 'already maxed' : 'not enough scrap'); } });
  }
  for (const it of stationExtras()) items.push(it);
  items.push({ label: 'UNDOCK', act: leaveShop });
  return { title: STATION_NAMES[sim.dockType].split('').join(' ') + '   -   SCRAP ' + sim.scrap, items, tone: 1,
    footer: 'PRICES x' + sim.dockMult.toFixed(2) + '   HULL REPAIRED + BOOST REFILLED   ENTER  BUY   ESC  UNDOCK' };
}
/** Station services added by later systems (survey data, fuel, trade). */
let stationExtras = (): Item[] => [];

// ---- hangar: pick / unlock hulls, stat bars and a rotating preview
function hangarMenu(): MenuDef {
  const items: Item[] = ROSTER.map(d => {
    const u = unlockOf(d.id), have = save.unlocked.includes(d.id), ready = !have && u.ok(save.stats);
    const status = d.id === save.ship ? 'FLYING' : have ? 'READY' : ready ? 'UNLOCK ' + u.cost + ' SCRAP' : 'LOCKED';
    return { label: (d.name + '          ').slice(0, 9) + (d.role + '              ').slice(0, 13) + status, act: () => {
      if (have) { save.ship = d.id; writeSave(save); applyShip(); say(d.name + ' selected'); }
      else if (!ready) say('locked: ' + u.need.toLowerCase());
      else if (save.scrap < u.cost) say('not enough scrap (' + save.scrap + '/' + u.cost + ')');
      else { save.scrap -= u.cost; save.unlocked.push(d.id); save.ship = d.id; writeSave(save); applyShip(); say(d.name + ' unlocked'); }
    } };
  });
  items.push({ label: 'BACK', act: () => { state = 'menu'; sel = 1; } });
  return { title: 'H A N G A R   -   SCRAP ' + save.scrap, items, footer: 'ENTER  SELECT / UNLOCK     ESC  BACK' };
}
function hangarCard(): MenuDef {
  const d = ROSTER[Math.min(sel, ROSTER.length - 1)], dv = derive(d), u = unlockOf(d.id), have = save.unlocked.includes(d.id);
  const items: Item[] = [{ label: d.name + '  -  ' + d.role }, { label: d.quirk.toUpperCase() }, { label: '' }];
  for (const k of RATING_KEYS) items.push({ label: (k + '          ').slice(0, 10) + bar(dv.ratings[k], 20) + String(dv.ratings[k] | 0).padStart(4) });
  items.push({ label: '' },
    { label: 'ACCEL ' + dv.accel.toFixed(0) + '  TOP ' + dv.topSpeed + '  0-95% ' + dv.timeToTop.toFixed(1) + 'S' },
    { label: 'STOP ' + dv.stopDist.toFixed(0) + 'U  TURN CIRCLE ' + dv.turnCircle.toFixed(0) + 'U' },
    { label: 'HULL ' + d.hullMax + '  SHIELD ' + d.shieldMax + '  EHP ' + dv.ehp.toFixed(0) + '  DPS ' + dv.dps.toFixed(1) },
    { label: 'GUNS ' + d.hardpoints.length + ' ' + (d.hardpoints[0] === 'turret' ? 'TURRET' : 'FIXED') + '  CARGO ' + d.cargo + '  FUEL ' + d.fuelMax },
    { label: 'BEST ' + String(save.hiBy[d.id] ?? 0).padStart(7, '0') },
    { label: have ? '' : 'NEEDS: ' + u.need });
  return { title: 'S T A T S', items, footer: 'RATINGS: 50 = WREN' };
}
function applyShip(): void { for (let i = 0; i < UP_N; i++) sim.up[i] = upsOf(save, save.ship)[i]; sim.setShip(shipById(save.ship)); }

function currentMenu(): MenuDef {
  switch (state) {
    case 'controls': return controlsMenu();
    case 'shop': return shopMenu();
    case 'hangar': return hangarMenu();
    case 'logs': return logsMenu();
    case 'trade': return tradeMenu();
    default: return optionsMenu();
  }
}
/** Lore fragments (M6); placeholder until the galaxy layer provides them. */
let logsMenu = (): MenuDef => ({ title: 'S H I P   L O G S', items: [{ label: 'NO LOGS RECOVERED YET' }, { label: 'BACK', act: () => { state = back; sel = 0; } }], footer: 'ESC  BACK' });
function menuLen(): number { return currentMenu().items.length; }
function activate(): void { currentMenu().items[sel]?.act?.(); }
function leaveShop(): void { state = 'play'; bank(); finishTut(); }
function tryDock(): void {
  if (sim.alive && sim.dockable >= 0 && state === 'play') { sim.serviceShip(); bank(); state = 'shop'; sel = 0; }
}

// ---------------------------------------------------------------- input
function menuKey(code: string): void {
  if (state === 'map') { if (code === 'Tab') state = 'chart'; else if (code === 'Escape' || code === 'KeyN' || code === 'Enter' || code === 'KeyP') state = 'play'; return; }
  if (state === 'chart') { chartKey(code); return; }
  if (waitingBind >= 0) {
    if (code !== 'Escape') { save.binds[ACTIONS[waitingBind]] = code; fb.dockKey = keyLabel(bindOf('dock')); writeSave(save); }
    waitingBind = -1; return;
  }
  const n = menuLen();
  switch (code) {
    case 'ArrowUp': case 'KeyW': sel = (sel + n - 1) % n; break;
    case 'ArrowDown': case 'KeyS': sel = (sel + 1) % n; break;
    case 'ArrowLeft': case 'ArrowRight': currentMenu().items[sel]?.adj?.(code === 'ArrowLeft' ? -1 : 1); break;
    case 'Enter': case 'Space': activate(); break;
    case 'Escape': case 'KeyP':
      if (state === 'shop') leaveShop();
      else if (state === 'trade') { state = 'shop'; sel = 0; bank(); }
      else if (state === 'controls' || state === 'logs') { state = back; sel = 0; }
      else if (state === 'hangar') { state = 'menu'; sel = 1; }
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
    const txt = 'ASTERION  ' + sim.ship.name + '  score ' + sim.score + '  kills ' + sim.kills + '  survey ' + Math.round(explorer.survey() * 100) + '%  distance ' + (sim.dist / 1000).toFixed(1) + 'ku' + '  time ' + m + ':' + String(sec).padStart(2, '0') + '  accuracy ' + acc + '%  bosses ' + sim.bossKills;
    void navigator.clipboard?.writeText(txt).then(() => say('result copied to clipboard'), () => say('clipboard unavailable'));
    return;
  }
  if (code === 'Escape' || code === 'KeyP') { if (sim.alive) { state = 'pause'; sel = 0; } return; }
  if (code === bindOf('dock')) { tryDock(); return; }
  if (code === 'KeyN') { state = 'chart'; explorer.chartSel = explorer.galaxy.st.current; return; }
  if (code === 'KeyK') { explorer.skipTicker(); return; }
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
    case 'F7': settings.curve = settings.curve > 0 ? 0 : 0.05; say('crt ' + (settings.curve ? 'on' : 'off')); break;
    case 'F8': settings.chroma = settings.chroma > 0 ? 0 : 0.005; say('aberration ' + (settings.chroma ? 'on' : 'off')); break;
    case 'KeyH': settings.hud = !settings.hud; break;
    case 'F10': layersOn = !layersOn; say('layer debug ' + (layersOn ? 'on' : 'off')); break;
    case 'KeyT': settings.ramp = (settings.ramp + 1) % RAMPS.length; say('ramp: ' + RAMPS[settings.ramp].name); break;
    case 'F9': settings.auto = !settings.auto; if (!settings.auto) { govLevel = 3; applyGov(); } say('auto-quality ' + (settings.auto ? 'on' : 'off')); break;
    case 'BracketLeft': settings.cellCss = Math.min(24, settings.cellCss + 1); snapBase(); resize(); say('cell ' + settings.cellCss + 'px'); break;
    case 'BracketRight': settings.cellCss = Math.max(4, settings.cellCss - 1); snapBase(); resize(); say('cell ' + settings.cellCss + 'px'); break;
    case 'Minus': settings.bgK = Math.max(0, settings.bgK - 0.04); say('backdrop ' + settings.bgK.toFixed(2)); break;
    case 'Equal': settings.bgK = Math.min(1, settings.bgK + 0.04); say('backdrop ' + settings.bgK.toFixed(2)); break;
  }
}
addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;     // typing in the tuning panel
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
  if (sim.vert) { if (b(5)) out.m |= In.Climb; if (b(4)) out.m |= In.Dive; if (b(6)) out.m |= In.Boost; if (b(13)) out.m |= In.Missile; }   // bumpers change band
  else { if (b(5) || b(6)) out.m |= In.Boost; if (b(4)) out.m |= In.Missile; }
  if (b(1)) out.m |= In.Dodge;
  if (b(10)) out.m |= In.Scan;
  if (b(11)) out.m |= In.Cruise;
  if (b(14)) out.m |= In.StrafeL;
  if (b(15)) out.m |= In.StrafeR;
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
  if (held('strafeL')) m |= In.StrafeL;
  if (held('strafeR')) m |= In.StrafeR;
  if (held('climb')) m |= In.Climb;
  if (held('dive')) m |= In.Dive;
  if (held('scan')) m |= In.Scan;
  if (held('cruise')) m |= In.Cruise;
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
  if (debug) { state = 'play'; finishTutQuiet(); }   // screenshots: no timing-dependent zoom
  for (let i = 0; i < ff * 60; i++) { sim.input = demo ? autopilot() : 0; sim.step(); if (!sim.alive && sim.deadT > 1) sim.reset(5); }
  const qs = q.get('state'); if (qs === 'shop' || qs === 'pause' || qs === 'controls' || qs === 'map' || qs === 'hangar' || qs === 'chart' || qs === 'logs') { state = qs; sim.scrap = 140; }
  if (q.has('event')) { sim.triggerEvent(Math.min(6, Math.max(0, ({ comet: 1, meteors: 2, flare: 3, storm: 4, eclipse: 5, mega: 6 } as Record<string, number>)[q.get('event')!] ?? (parseInt(q.get('event')!, 10) | 0)))); sim.warnT = parseFloat(q.get('evwarn') ?? '0.05'); }
  if (q.has('hp')) sim.hp = parseFloat(q.get('hp')!);
  const spawn = q.get('spawn');
  if (spawn) {
    const defs: Record<string, number> = { boss: Kind.Boss, sniper: Kind.Sniper, tender: Kind.Tender, splitter: Kind.Splitter, rammer: Kind.Rammer, gunship: Kind.Gunship, drone: Kind.Drone };
    let n = 0;
    for (const nm of spawn.split(',')) if (defs[nm]) { const e = sim.spawnEnt(defs[nm], sim.sx + 30 + 24 * n, sim.sy + (n & 1 ? 16 : -16), 0, 0); if (e >= 0) { sim.ea[e] = 3.1; sim.es[e] = 0; if (nm === 'gunship') sim.eshield[e] = 8; if (sim.vert) sim.ez[e] = sim.eband[e] = [1, -1, 0][n % 3]; } n++; }
  }
  if (q.has('x')) { sim.sx = sim.spx = parseFloat(q.get('x')!); }
  if (q.has('y')) { sim.sy = sim.spy = parseFloat(q.get('y')!); }
  if (q.has('obj')) { sim.objTier = parseInt(q.get('obj')!, 10) | 0; sim.objKills = 0; sim.step(); }
  if (q.has('hud') && q.get('hud') === '0') settings.hud = false;
  dbgIn = (q.get('fire') === '1' ? In.Fire : 0) | (q.get('boost') === '1' ? In.Boost | In.Thrust : 0);
  if (q.has('perf')) { settings.perf = true; perf.show(true); }
  if (q.has('evt')) sim.debugEvtP = parseFloat(q.get('evt')!);
  if (q.has('modules')) { sim.up[1] = 3; sim.up[6] = 1; sim.up[8] = 2; sim.refreshShip(); sim.invuln = 0; }
  if (q.has('sys')) explorer.enter(Math.max(0, Math.min(39, parseInt(q.get('sys')!, 10) | 0)), false);
  if (q.has('setpiece')) { const k = ({ beacon: 0, derelict: 1, pulsar: 2, wormhole: 4, signal: 10 } as Record<string, number>)[q.get('setpiece')!] ?? 1; sim.setPoi(0, sim.sx + (k === 1 ? 40 : 70), sim.sy + (k === 1 ? 70 : 20), k, 0.3); sim.poiDone[0] = 1; }
  if (q.has('scanview')) { fb.scanR = -1; fb.scanEnv = 1; fb.scanText = 'T=184K  CH4 62% H2 31% NH3 5%  MASS 4.1E26 KG  RINGS: ICE  '; }
  if (q.has('idle')) sim.invuln = 0;   // debug: no spawn-invulnerability blink, so screenshots always catch the ship
  if (q.has('ship')) sim.setShip(shipById(q.get('ship')!));
  if (q.has('vert')) sim.vert = q.get('vert') !== '0';
  if (q.has('tune')) mountTuner(sim, id => sim.setShip(shipById(id)));
}
function finishTutQuiet(): void { tut = 99; }

// ---------------------------------------------------------------- galaxy chart (M5): fog of war, jump range, system info
const G_SEL_L = gi('['), G_SEL_R = gi(']'), G_STAR = gi('*'), G_Q = gi('?');
function chartMove(dx: number, dy: number): void {
  const g = explorer.galaxy, cur = g.systems[explorer.chartSel];
  let best = -1, bd = 1e9;
  for (const s of g.systems) {
    if (s.id === cur.id || g.known(s.id) === 0) continue;
    const ex = s.x - cur.x, ey = s.y - cur.y, along = ex * dx + ey * dy, off = Math.abs(ex * dy - ey * dx);
    if (along <= 0) continue;
    const score = along + off * 2;
    if (score < bd) { bd = score; best = s.id; }
  }
  if (best >= 0) explorer.chartSel = best;
}
function drawChart(): void {
  const g = explorer.galaxy, bt = renderer.glyphs, W = 70, H = 30, here = g.here, sel = g.systems[explorer.chartSel];
  const lines: string[] = []; for (let i = 0; i < H; i++) lines.push(' '.repeat(W - 4));
  const title = 'G A L A X Y   C H A R T', footer = 'ARROWS SELECT   ENTER JUMP   TAB SYSTEM MAP   N/ESC CLOSE';
  const wide = renderer.cols >= 150;
  panel(bt, renderer.cols, renderer.rows, title, lines, -1, footer, 0, wide ? -30 : 0);
  const o = panelOrigin(renderer.cols, renderer.rows, title, lines, footer); o.x += wide ? -30 : 0;
  const px = (x: number): number => o.x + 4 + Math.round(x / 100 * (W - 8)), py = (y: number): number => renderer.rows - 1 - (o.y + 3 + Math.round((100 - y) / 100 * (H - 1)));
  const range = sim.ship.jumpRange;
  for (let j = 0; j < 72; j++) { const a = j / 72 * Math.PI * 2; bt.put(px(here.x + Math.cos(a) * range), py(here.y + Math.sin(a) * range), G_DOT, 0.15, 0.35, 0.35, 1); }
  for (const s of g.systems) {
    const k = g.known(s.id); if (k === 0) continue;
    const c = px(s.x), r = py(s.y), inR = g.dist(here.id, s.id) <= range;
    if (s.id === here.id) bt.put(c, r, G_AT, 0.4, 2.0, 1.4, 1);
    else if (k === 2) bt.put(c, r, G_DIA, inR ? 0.5 : 0.25, inR ? 1.4 : 0.7, inR ? 1.6 : 0.8, 1);
    else bt.put(c, r, inR ? G_STAR : G_Q, 0.5, 0.6, 0.65, 1);
    if (s.id === sel.id) { bt.put(c - 1, r, G_SEL_L, 1.6, 1.4, 0.4, 1); bt.put(c + 1, r, G_SEL_R, 1.6, 1.4, 0.4, 1); }
  }
  if (!wide) return;
  const d = g.dist(here.id, sel.id), known = g.known(sel.id) === 2, q = g.st.sys[sel.id];
  const pct = (v: number): string => '#'.repeat(Math.round(v * 10)) + '.'.repeat(10 - Math.round(v * 10));
  const info = [
    known ? sel.name : 'UNKNOWN SIGNAL', known ? STAR_NAME[sel.star] : '', known ? g.factions[sel.faction] : '', '',
    'DISTANCE ' + d.toFixed(1) + ' LY' + (d > range ? '  (OUT OF RANGE)' : ''), 'JUMP FUEL ' + Galaxy.jumpFuel(d, sim.ship.fuelBurn) + '  (HAVE ' + Math.floor(sim.fuel) + ')',
    known ? 'SURVEY ' + Math.round(g.survey(sel.id, sel.id === here.id ? explorer.bodies : 40) * 100) + '%' : '', '',
    'STABILITY ' + pct(q.stability), 'WEALTH    ' + pct(q.wealth), 'PIRACY    ' + pct(q.piracy), '',
    'NEWS', ...g.st.news.slice(-5).map(n => n.slice(0, 44)),
  ];
  panel(bt, renderer.cols, renderer.rows, 'S Y S T E M', info, -1, '@ YOU   ◆ VISITED   * IN RANGE   ? SIGNAL', 0, 44);
}
function chartKey(code: string): void {
  switch (code) {
    case 'ArrowLeft': case 'KeyA': chartMove(-1, 0); break;
    case 'ArrowRight': case 'KeyD': chartMove(1, 0); break;
    case 'ArrowUp': case 'KeyW': chartMove(0, 1); break;
    case 'ArrowDown': case 'KeyS': chartMove(0, -1); break;
    case 'Enter': case 'Space': { const r = explorer.jump(); say(r); if (sim.jumpT > 0) state = 'play'; break; }
    case 'Tab': state = 'map'; break;
    case 'Escape': case 'KeyN': case 'KeyP': state = 'play'; break;
  }
}

// ---------------------------------------------------------------- station services + trade + logs (M5/M6)
const boughtAt = new Int8Array(6).fill(-1);
stationExtras = (): Item[] => {
  const g = explorer.galaxy, q = g.st.sys[g.st.current], dataVal = Math.floor(save.data * (0.5 + 0.3 * q.wealth));
  const fuelNeed = Math.ceil(sim.fuelMax - sim.fuel), fuelCost = Math.ceil(fuelNeed * 0.35);
  return [
    { label: 'SELL SURVEY DATA ... ' + (save.data | 0) + ' -> ' + dataVal + ' SCRAP', act: () => {
      if (save.data <= 0) { say('no survey data'); return; }
      sim.scrap += dataVal; save.stats.survey += save.data | 0; save.data = 0; say('survey data sold for ' + dataVal + ' scrap'); bank();
    } },
    { label: 'REFUEL ............. ' + (fuelNeed <= 0 ? 'FULL' : fuelCost + ' SCRAP'), act: () => {
      if (fuelNeed <= 0) { say('tanks full'); return; }
      const can = Math.min(fuelNeed, Math.floor(sim.scrap / 0.35)); if (can <= 0) { say('not enough scrap'); return; }
      sim.fuel += can; sim.scrap -= Math.ceil(can * 0.35); say('refuelled'); bank();
    } },
    { label: 'TRADE GOODS ........ HOLD ' + Math.round(sim.cargoUsed) + '/' + sim.ship.cargo, act: () => { state = 'trade'; sel = 0; } },
  ];
};
function tradeMenu(): MenuDef {
  const g = explorer.galaxy;
  const items: Item[] = COMMODITIES.map((name, c) => {
    const buy = g.price(c, false), sell = g.price(c, true);
    const doBuy = (): void => {
      if (sim.scrap < buy) { say('not enough scrap'); return; }
      if (sim.moveCargo(c, 1) < 1) { say('hold full'); return; }
      sim.scrap -= buy; g.onTrade(c, -1); boughtAt[c] = g.st.current;
    };
    const doSell = (): void => {
      if (sim.moveCargo(c, -1) > -1) { say('none in the hold'); return; }
      sim.scrap += sell; g.onTrade(c, 1);
      if (boughtAt[c] !== g.st.current) { save.stats.delivered++; }
    };
    return { label: (name + '            ').slice(0, 12) + 'BUY ' + String(buy).padStart(3) + '   SELL ' + String(sell).padStart(3) + '   HOLD ' + sim.cargoBy[c], act: doBuy, adj: (d: number) => (d > 0 ? doBuy() : doSell()) };
  });
  items.push({ label: 'BACK', act: () => { state = 'shop'; sel = 0; bank(); } });
  return { title: 'T R A D E   -   ' + g.here.name + '   -   SCRAP ' + sim.scrap, items, tone: 1, footer: 'ENTER / RIGHT  BUY     LEFT  SELL     HOLD ' + Math.round(sim.cargoUsed) + '/' + sim.ship.cargo };
}
logsMenu = (): MenuDef => {
  const g = explorer.galaxy, items: Item[] = [];
  const wrap = (s: string): void => { for (let i = 0; i < s.length; i += 64) items.push({ label: s.slice(i, i + 64) }); };
  items.push({ label: 'THE QUIET LANES  ' + g.st.frags.length + '/' + FRAGMENTS.length + ' FRAGMENTS' });
  for (const f of g.st.frags.slice().sort((a, b) => a - b)) { items.push({ label: '' }); wrap(FRAGMENTS[f]); }
  if (g.st.logs.length) { items.push({ label: '' }, { label: 'RECOVERED LOGS' }); for (const l of g.st.logs.slice(-5)) wrap(l); }
  if (items.length === 1) items.push({ label: 'NOTHING RECOVERED YET. QUIET SIGNALS AND DERELICTS KEEP RECORDS.' });
  items.push({ label: '' }, { label: 'BACK', act: () => { state = back; sel = 0; } });
  return { title: 'S H I P   L O G S', items, footer: 'ESC  BACK' };
};

/** Hangar: ship list on the left, stat card on the right, rotating glyph preview of the highlighted hull between them. */
function drawHangar(m: MenuDef, labels: string[], cx: number, cy: number, t: number): void {
  const wide = renderer.cols >= 150;
  panel(renderer.glyphs, renderer.cols, renderer.rows, m.title, labels, sel, m.footer, 0, wide ? -48 : 0);
  if (!wide || sel >= ROSTER.length) return;
  const c = hangarCard();
  panel(renderer.glyphs, renderer.cols, renderer.rows, c.title, c.items.map(i => i.label), -1, c.footer, 0, 46);
  const d = ROSTER[sel], wx = cx, wy = cy + 2;
  renderer.sprites.add(wx, wy, t * 0.7, d.artSize, d.art, d.art === 17 ? 0.5 + 0.5 * Math.sin(t * 0.6) : d.art === 0 ? 0.5 : Math.max(0, Math.sin(t * 0.9)), 0, 0.5 + 0.4 * Math.sin(t * 2), 0.9, 1);
}
/** ?roster=1: every hull side by side (silhouette / glyph-weight check). */
let rosterView = new URLSearchParams(location.search).has('roster');
function drawRoster(cx: number, cy: number, t: number): void {
  for (let i = 0; i < ROSTER.length; i++) {
    const d = ROSTER[i], wx = cx - 66 + (i % 4) * 44, wy = cy + (i < 4 ? 22 : -18);
    renderer.sprites.add(wx, wy, Math.PI / 2 + Math.sin(t * 0.5 + i) * 0.15, d.artSize, d.art, d.art === 0 ? 0.5 : d.art === 18 ? 0 : 0.6, 0, 0.9, 0.72, 1);
    const row = Math.round(renderer.rows * 0.5 - (wy - cy) / renderer.aspect) + 10;
    renderer.glyphs.text(d.name, Math.round(renderer.cols * 0.5 + (wx - cx)) - (d.name.length >> 1), row, 0.6, 1.2, 1.0, 1);
  }
}
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
const forceTheme = parseInt(new URLSearchParams(location.search).get('theme') ?? '-1', 10);   // debug: ?theme=0..5 pins the nebula theme
if (forceTheme >= 0) { const t0 = THEMES[forceTheme % THEMES.length]; tint[0] = t0[0]; tint[1] = t0[1]; tint[2] = t0[2]; }
function updateTint(dt: number, x: number, y: number): void {
  const sx = sectorOf(x), sy = sectorOf(y);
  const th = forceTheme >= 0 ? THEMES[forceTheme % THEMES.length] : (sx === 0 && sy === 0) ? THEMES[0] : THEMES[Math.floor(hash2(sx * 7 + 3, sy * 13 + 1) * THEMES.length) % THEMES.length];
  const k = 1 - Math.exp(-0.8 * dt);
  for (let i = 0; i < 3; i++) tint[i] += (th[i] - tint[i]) * k;
}
let layersOn = new URLSearchParams(location.search).has('layers');
const scanHold = new URLSearchParams(location.search).has('scanview');
function nearHostile(): boolean {
  for (let i = 0; i < MAX_E; i++) {
    const k = sim.ek[i]; if (k < 1 || k > 3) continue;
    const dx = sim.ex[i] - sim.sx, dy = sim.ey[i] - sim.sy;
    if (dx * dx + dy * dy < 150 * 150) return true;
  }
  return false;
}

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
    sim.input = pollInput() | dbgIn;
    if (hitStop > 0) { hitStop -= dt; acc = 0; }          // brief freeze on kills
    else while (acc >= DT) { sim.step(); acc -= DT; }
    if (sim.kills > lastKills) hitStop = settings.reduceFx ? 0 : 0.045;
    lastKills = sim.kills;
    if (sim.hp < lastHp - 0.5) rumble(lastHp - sim.hp);
    lastHp = sim.hp;
    if (!sim.alive && !deathHandled) { deathHandled = true; if (sim.score > save.hi) { save.hi = sim.score; } save.hiBy[save.ship] = Math.max(save.hiBy[save.ship] ?? 0, sim.score); bank(); }
    tutorial(dt);
    const vk = ((sectorOf(sim.sx) & 0xffff) << 16) | (sectorOf(sim.sy) & 0xffff);
    if (!visited.has(vk)) { visited.add(vk); if (sim.time > 1) arrive(); }
  } else if (attract) {
    sim.input = autopilot(); sim.aimOn = false;
    while (acc >= DT) { sim.step(); acc -= DT; }
    sim.invuln = 1; if (sim.hp < sim.hpMax * 0.5) sim.hp = sim.hpMax;
    if (!sim.alive && sim.deadT > 1.5) sim.reset(5);
    pollPad();
  } else pollPad();
  explorer.frame(dt, playing);
  audio.update(sim, dt, playing);
  const simMs = performance.now() - s0;
  const alpha = acc / DT;

  // camera: follow interpolated ship with velocity look-ahead, exponential smoothing
  const ix = sim.spx + (sim.sx - sim.spx) * alpha, iy = sim.spy + (sim.sy - sim.spy) * alpha + (sim.vert ? (sim.spz + (sim.sz - sim.spz) * alpha) * FrameBuilder.OBL : 0);
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
  fb.fx = settings.reduceFx ? 0.35 : 1; fb.showLayers = layersOn;
  const np = planetsNear(cx, cy, renderer.cols * 0.5 + 80, view, sim.time + alpha * DT);
  fb.view = view; fb.nView = np;
  fb.build(cx, cy, alpha, t, settings.hud && state !== 'menu' && state !== 'hangar' && state !== 'logs' && state !== 'chart' && state !== 'trade');
  if (rosterView) drawRoster(cx, cy, t);
  if (state !== 'play') {
    if (state === 'map') drawMap();
    else if (state === 'chart') drawChart();
    else {
      const m = currentMenu(), labels = m.items.map(i => i.label);
      if (state === 'hangar') drawHangar(m, labels, cx, cy, t);
      else {
        const card = (state === 'menu' || state === 'pause') && renderer.cols >= 130;
        panel(renderer.glyphs, renderer.cols, renderer.rows, m.title, labels, sel, m.footer, m.tone ?? 0, card ? -34 : 0);
        if (card) { const c = controlsCard(); panel(renderer.glyphs, renderer.cols, renderer.rows, c.title, c.items.map(i => i.label), -1, c.footer, 0, 40); }
      }
    }
  }
  if (toastT > 0) { toastT -= dt; renderer.glyphs.text(toast, 2, renderer.rows - 2, 1.2, 1.2, 0.6, 1); }
  const spd = Math.sqrt(sim.svx * sim.svx + sim.svy * sim.svy);
  const streak = Math.max(0, Math.min(1, (spd - 85) / 60));
  hyperAmt += ((sim.alive && sim.boosting && state === 'play' ? 1 : 0) - hyperAmt) * (1 - Math.exp(-dt * (sim.boosting ? 4 : 2.5)));
  hyperBuf[0] = Math.cos(sim.sa); hyperBuf[1] = Math.sin(sim.sa); hyperBuf[2] = hyperAmt * (settings.reduceFx ? 0.4 : 1);
  const fxk = settings.reduceFx ? 0.35 : 1;
  if (revealT >= 0) { revealT += dt * (settings.reduceFx ? 2 : 1); if (revealT * 240 > renderer.cols + renderer.rows * 2) revealT = -1; }
  if (fb.scanEnv > 0 && state === 'play' && sim.scanP <= 0 && !scanHold) fb.scanEnv = Math.max(0, fb.scanEnv - dt * 0.5);
  renderer.render({ ecl: sim.ecl, mega: sim.mega, reveal: revealT >= 0 ? revealT * 240 : -1, layers: layersOn, scanPlanet: fb.scanEnv > 0.5 ? fb.scanIdx : -1, camX: cx, camY: cy, time: t, planets: view, nPlanets: np, flash: sim.flash * fxk,
    hit: Math.max(sim.hitFlash * fxk, sim.alive && sim.hp < 30 ? 0.22 + 0.16 * Math.sin(t * 7) * fxk : 0),
    streakX: sim.svx, streakY: sim.svy, streak: streak * (1 - hyperAmt), hyper: hyperBuf, combat, tint, flare: sim.flare * fxk, storm: Math.max(sim.storm, sim.zoneStorm) * fxk, sunTint: fb.sunTint, ship: sim.alive ? [ix, iy, sim.boosting ? 1.0 : sim.thrusting ? 0.6 : 0.15] : undefined, warp: buildWarp(cx, cy, settings.reduceFx ? 0 : 1) });

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
