/** Versioned localStorage persistence. Every access is guarded: private mode / disabled storage must never break the game. */
export const ACTIONS = ['thrust', 'left', 'right', 'brake', 'fire', 'boost', 'dodge', 'dock', 'missile'] as const;
export type Action = typeof ACTIONS[number];
export const DEFAULT_BINDS: Record<Action, string> = {
  thrust: 'KeyW', left: 'KeyA', right: 'KeyD', brake: 'KeyS', fire: 'Space', boost: 'ShiftLeft', dodge: 'KeyF', dock: 'KeyE', missile: 'KeyX',
};

export interface SaveData {
  v: 1;
  hi: number;
  up: number[];          // banked upgrade levels
  scrap: number;         // banked scrap
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
  binds: Record<Action, string>;
}

const KEY = 'asterion.save.v1';
const OLD_KEY = 'voidglyph.save.v1';   // pre-rename saves are still read
export const defaults = (): SaveData => ({
  v: 1, hi: 0, up: [0, 0, 0, 0, 0, 0, 0], scrap: 0, tutDone: false, volume: 0.7, muted: false,
  assist: true, aim: false, cb: false, reduceFx: false, hc: false, daily: false, hard: false, aimAssist: 2, binds: { ...DEFAULT_BINDS },
});

export function loadSave(): SaveData {
  const d = defaults();
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(OLD_KEY);
    if (!raw) return d;
    const p = JSON.parse(raw) as Partial<SaveData>;
    if (p.v !== 1) return d;
    const num = (x: unknown, def: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : def);
    d.hi = num(p.hi, 0); d.scrap = Math.max(0, num(p.scrap, 0)); d.volume = Math.min(1, Math.max(0, num(p.volume, 0.7)));
    if (Array.isArray(p.up)) for (let i = 0; i < 7; i++) d.up[i] = Math.min(5, Math.max(0, num(p.up[i], 0) | 0));
    d.tutDone = p.tutDone === true; d.muted = p.muted === true; d.assist = p.assist === true;
    d.aim = p.aim === true; d.cb = p.cb === true; d.reduceFx = p.reduceFx === true; d.hc = p.hc === true; d.daily = p.daily === true; d.hard = p.hard === true;
    d.aimAssist = typeof p.aimAssist === 'number' && Number.isInteger(p.aimAssist) && p.aimAssist >= 0 && p.aimAssist <= 3 ? p.aimAssist : 2;
    if (p.binds && typeof p.binds === 'object') for (const a of ACTIONS) { const b = (p.binds as Record<string, unknown>)[a]; if (typeof b === 'string' && b.length < 24) d.binds[a] = b; }
  } catch { /* corrupt or unavailable: fall back to defaults */ }
  return d;
}

export function writeSave(s: SaveData): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* quota / private mode */ }
}
