import { hash2 } from '../core/util';

/**
 * Station contracts and faction reputation: the non-combat loop.
 * Pure logic (no DOM, no sim imports) so it is deterministic and unit-testable. main.ts owns the UI, the save and the wiring.
 *
 * Two contract kinds:
 *  - Deliver: carry N units of a commodity to another station in the same system. The goods live in the normal hold, so the player
 *    can also buy them at any market; the contract pays when they are handed over at the destination.
 *  - Hunt: destroy N hostile ships inside this system (counted from the kill total when accepted).
 */
export const enum CKind { Deliver = 0, Hunt = 1 }
export const MAX_ACTIVE = 3;
export const N_REP = 4;

export interface Contract {
  kind: CKind;
  faction: number;                 // issuing faction (owner of the system)
  sys: number;                     // system id the contract belongs to
  fromX: number; fromY: number;    // origin station sector
  toX: number; toY: number;        // destination station sector (deliver only)
  com: number; units: number;      // deliver: commodity and amount
  kills: number; base: number;     // hunt: kills needed, and the kill total when accepted
  reward: number;                  // scrap
  rep: number;                     // reputation gained with `faction`
  tier: number;                    // 0 open to all, 1 needs standing
}

export interface StationRef { sx: number; sy: number }
export interface OfferParams {
  seed: number; sys: number; faction: number;
  from: StationRef; others: StationRef[];      // other stations in the same system
  piracy: number;                               // 0..1, makes hunt jobs likelier and better paid
  unitValue: number[];                          // current price per commodity here
  bucket: number;                               // changes every so often so the board refreshes
  sector: number;                               // world units per sector, for distance-based pay
  rep: number;                                  // standing with `faction`, -1..1
}

const NAMES = ['HALCYON', 'TALLOW', 'ARGENT', 'WICKER', 'CORMORANT', 'RIME', 'PELL', 'SLOW TIDE', 'MERIDIAN', 'LANTERN', 'EMBER', 'CINDER', 'ORRERY', 'VESPER', 'QUILL', 'BRIAR'];
/** Deterministic station name for a sector: "HALCYON DEPOT". */
export function stationName(seedX: number, seedY: number, sx: number, sy: number, type: string): string {
  return NAMES[Math.floor(hash2((sx + seedX) * 29 + 3, (sy + seedY) * 31 + 7) * NAMES.length) % NAMES.length] + ' ' + type;
}

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

/** Up to three offers for one station. Same inputs, same board. Deliver jobs need another station to exist in the system. */
export function offers(p: OfferParams): Contract[] {
  const out: Contract[] = [];
  for (let slot = 0; slot < 3; slot++) {
    const h = (k: number): number => hash2(p.seed * 7 + p.sys * 131 + p.from.sx * 17 + p.from.sy * 59 + slot * 977 + p.bucket * 31 + k * 13, p.seed + slot * 3 + k);
    const wantHunt = h(1) < 0.25 + 0.5 * p.piracy;
    const tier = h(2) < 0.3 ? 1 : 0;
    if (!wantHunt && p.others.length > 0) {
      const to = p.others[Math.floor(h(3) * p.others.length) % p.others.length];
      const com = Math.floor(h(4) * p.unitValue.length) % p.unitValue.length, units = 3 + Math.floor(h(5) * 8);
      const dist = Math.hypot(to.sx - p.from.sx, to.sy - p.from.sy) * p.sector;
      const reward = Math.round(units * p.unitValue[com] * (1.5 + dist / 1200) * (tier ? 1.5 : 1));
      out.push({ kind: CKind.Deliver, faction: p.faction, sys: p.sys, fromX: p.from.sx, fromY: p.from.sy, toX: to.sx, toY: to.sy, com, units, kills: 0, base: 0, reward, rep: tier ? 0.08 : 0.05, tier });
    } else {
      const kills = 4 + Math.floor(h(6) * 6);
      out.push({ kind: CKind.Hunt, faction: p.faction, sys: p.sys, fromX: p.from.sx, fromY: p.from.sy, toX: 0, toY: 0, com: 0, units: 0, kills, base: 0,
        reward: Math.round(kills * (22 + 40 * p.piracy) * (tier ? 1.5 : 1)), rep: tier ? 0.08 : 0.05, tier });
    }
  }
  return out;
}

/** Tier-1 jobs need some standing with the issuing faction. */
export function canAccept(c: Contract, rep: number): boolean { return c.tier === 0 || rep >= 0.1; }

export function hunted(c: Contract, killsNow: number): number { return Math.max(0, killsNow - c.base); }
export function huntDone(c: Contract, killsNow: number): boolean { return c.kind === CKind.Hunt && hunted(c, killsNow) >= c.kills; }
/** A deliver job completes when the player is docked at the destination holding enough of the goods. */
export function deliverReady(c: Contract, atX: number, atY: number, sys: number, cargoBy: ArrayLike<number>): boolean {
  return c.kind === CKind.Deliver && c.sys === sys && c.toX === atX && c.toY === atY && (cargoBy[c.com] ?? 0) >= c.units;
}

/** Standing changes: the issuing faction gains `delta`; its friends gain a share and its enemies lose one (rel is the N x N matrix, -1..1). */
export function applyRep(rep: number[], faction: number, delta: number, rel: ArrayLike<number>): void {
  for (let f = 0; f < N_REP; f++) {
    const share = f === faction ? 1 : 0.4 * (rel[faction * N_REP + f] ?? 0);
    rep[f] = clamp((rep[f] ?? 0) + delta * share, -1, 1);
  }
}
/** Price factor from standing: friends get up to 12% off, enemies pay up to 12% more. */
export function repPriceMod(rep: number): number { return 1 - 0.12 * clamp(rep, -1, 1); }
export const repLabel = (rep: number): string => (rep >= 0.6 ? 'ALLIED' : rep >= 0.25 ? 'FRIENDLY' : rep > -0.25 ? 'NEUTRAL' : rep > -0.6 ? 'WARY' : 'HOSTILE');

/** Validate contracts coming from a save: drop anything malformed rather than trust it. */
export function sanitize(a: unknown, nCom: number, nSys: number): Contract[] {
  const out: Contract[] = [];
  if (!Array.isArray(a)) return out;
  const n = (x: unknown, lo: number, hi: number, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? clamp(Math.round(x), lo, hi) : d);
  for (const c of a.slice(0, MAX_ACTIVE)) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>, kind = o.kind === 1 ? CKind.Hunt : o.kind === 0 ? CKind.Deliver : null;
    if (kind === null) continue;
    out.push({ kind, faction: n(o.faction, 0, N_REP - 1, 0), sys: n(o.sys, 0, nSys - 1, 0), fromX: n(o.fromX, -99, 99, 0), fromY: n(o.fromY, -99, 99, 0), toX: n(o.toX, -99, 99, 0), toY: n(o.toY, -99, 99, 0),
      com: n(o.com, 0, nCom - 1, 0), units: n(o.units, 0, 60, 0), kills: n(o.kills, 0, 60, 0), base: n(o.base, 0, 1e7, 0), reward: n(o.reward, 0, 1e5, 0), rep: typeof o.rep === 'number' && Number.isFinite(o.rep) ? clamp(o.rep, 0, 0.5) : 0.05, tier: o.tier === 1 ? 1 : 0 });
  }
  return out;
}
