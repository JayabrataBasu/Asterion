/** Versioned localStorage persistence. Every access is guarded: private mode / disabled storage must never break the game. */
export const ACTIONS = ['thrust', 'left', 'right', 'brake', 'fire', 'boost', 'dodge', 'dock', 'missile', 'strafeL', 'strafeR', 'climb', 'dive', 'scan', 'cruise'] as const;
export type Action = typeof ACTIONS[number];
export const DEFAULT_BINDS: Record<Action, string> = {
  thrust: 'KeyW', left: 'KeyA', right: 'KeyD', brake: 'KeyS', fire: 'Space', boost: 'ShiftLeft', dodge: 'KeyF', dock: 'KeyE', missile: 'KeyX',
  strafeL: 'KeyZ', strafeR: 'KeyC', climb: 'KeyR', dive: 'KeyG', scan: 'KeyQ', cruise: 'KeyY',
};
/** Upgrade / module slots per ship (sim Up enum). */
export const SAVE_UP_N = 10;

/** Lifetime counters that drive ship unlocks. */
export interface Stats { kills: number; bosses: number; scrap: number; survey: number; delivered: number; scans: number; systems: number; maxTier: number; jumps: number; fragments: number }
export const STAT_KEYS: (keyof Stats)[] = ['kills', 'bosses', 'scrap', 'survey', 'delivered', 'scans', 'systems', 'maxTier', 'jumps', 'fragments'];

export interface SaveData {
  v: 2;
  hi: number;                        // best score on any ship
  hiBy: Record<string, number>;      // best score per ship id
  ship: string;                      // selected hull
  unlocked: string[];
  upBy: Record<string, number[]>;    // banked module levels per ship
  scrap: number;                     // banked scrap
  data: number;                      // unsold survey data
  tutDone: boolean;
  volume: number;
  muted: boolean;
  assist: boolean;
  aim: boolean;          // mouse aim
  cb: boolean;           // colour-blind palette
  reduceFx: boolean;     // reduced shake / flash
  hc: boolean;           // high-contrast backdrop
  daily: boolean;        // daily seed
  hard: boolean;         // hard mode
  aimAssist: number;     // 0 off, 1 wide, 2 lead (default), 3 homing
  vert: boolean;         // verticality experiment
  ticker: boolean;       // galaxy news ticker
  binds: Record<Action, string>;
  stats: Stats;
  /** Galaxy (exploration + living galaxy) state; validated by its own loader (galaxy.ts). */
  galaxy: unknown;
}

const KEY = 'asterion.save.v1';
const OLD_KEY = 'voidglyph.save.v1';   // pre-rename saves are still read
const zeroStats = (): Stats => ({ kills: 0, bosses: 0, scrap: 0, survey: 0, delivered: 0, scans: 0, systems: 0, maxTier: 0, jumps: 0, fragments: 0 });
export const defaults = (): SaveData => ({
  v: 2, hi: 0, hiBy: {}, ship: 'wren', unlocked: ['wren'], upBy: { wren: new Array(SAVE_UP_N).fill(0) }, scrap: 0, data: 0, tutDone: false, volume: 0.7, muted: false,
  assist: true, aim: false, cb: false, reduceFx: false, hc: false, daily: false, hard: false, aimAssist: 2, vert: false, ticker: true,
  binds: { ...DEFAULT_BINDS }, stats: zeroStats(), galaxy: null,
});

const num = (x: unknown, def: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : def);
const ID = /^[a-z]{2,12}$/;
function ups(a: unknown): number[] {
  const o = new Array(SAVE_UP_N).fill(0);
  if (Array.isArray(a)) for (let i = 0; i < SAVE_UP_N; i++) o[i] = Math.min(5, Math.max(0, num(a[i], 0) | 0));
  return o;
}

/** Parse any known save version into the current shape. v1 -> v2: upgrades and best score move to the Wren slot. */
export function migrate(p: Record<string, unknown>): SaveData {
  const d = defaults();
  if (p.v !== 1 && p.v !== 2) return d;
  d.scrap = Math.max(0, num(p.scrap, 0)); d.volume = Math.min(1, Math.max(0, num(p.volume, 0.7)));
  d.tutDone = p.tutDone === true; d.muted = p.muted === true; d.assist = p.assist === true;
  d.aim = p.aim === true; d.cb = p.cb === true; d.reduceFx = p.reduceFx === true; d.hc = p.hc === true; d.daily = p.daily === true; d.hard = p.hard === true;
  d.aimAssist = typeof p.aimAssist === 'number' && Number.isInteger(p.aimAssist) && p.aimAssist >= 0 && p.aimAssist <= 3 ? p.aimAssist : 2;
  d.hi = Math.max(0, num(p.hi, 0));
  if (p.binds && typeof p.binds === 'object') for (const a of ACTIONS) { const b = (p.binds as Record<string, unknown>)[a]; if (typeof b === 'string' && b.length < 24) d.binds[a] = b; }
  if (p.v === 1) {
    d.upBy.wren = ups(p.up); d.hiBy.wren = d.hi;
    return d;
  }
  d.data = Math.max(0, num(p.data, 0));
  d.vert = p.vert === true; d.ticker = p.ticker !== false;
  if (typeof p.ship === 'string' && ID.test(p.ship)) d.ship = p.ship;
  if (Array.isArray(p.unlocked)) d.unlocked = Array.from(new Set(['wren', ...p.unlocked.filter((x): x is string => typeof x === 'string' && ID.test(x))]));
  if (!d.unlocked.includes(d.ship)) d.ship = 'wren';
  if (p.hiBy && typeof p.hiBy === 'object') for (const [k, v] of Object.entries(p.hiBy as Record<string, unknown>)) if (ID.test(k)) d.hiBy[k] = Math.max(0, num(v, 0));
  if (p.upBy && typeof p.upBy === 'object') for (const [k, v] of Object.entries(p.upBy as Record<string, unknown>)) if (ID.test(k)) d.upBy[k] = ups(v);
  if (p.stats && typeof p.stats === 'object') for (const k of STAT_KEYS) d.stats[k] = Math.max(0, num((p.stats as Record<string, unknown>)[k], 0));
  d.galaxy = p.galaxy ?? null;
  return d;
}

export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(OLD_KEY);
    if (!raw) return defaults();
    return migrate(JSON.parse(raw) as Record<string, unknown>);
  } catch { /* corrupt or unavailable: fall back to defaults */ }
  return defaults();
}

export function writeSave(s: SaveData): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* quota / private mode */ }
}
/** Module levels for a ship, created on first use. */
export function upsOf(s: SaveData, id: string): number[] { return (s.upBy[id] ??= new Array(SAVE_UP_N).fill(0)); }
