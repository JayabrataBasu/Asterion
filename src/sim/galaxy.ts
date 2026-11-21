import { Rng, hash2 } from '../core/util';

/**
 * The galaxy: a seeded chart of star systems (exploration, M5) that quietly lives its own life (M6).
 * Hierarchy: galaxy seed -> systems (chart position, star, faction, points of interest) -> sectors (world.ts, salted per system).
 * Everything here is cold path (a jump, a scan, a tick every few minutes); the 60 Hz sim never calls in.
 * Deterministic from the seed, bounded (fixed counts, capped lists) and serialisable (state() / constructor).
 */
export const N_SYS = 40, N_FAC = 4, N_COM = 6, CHART = 100;
export const TICK_S = 180;                 // a galaxy tick every three minutes of play
export const SYS_BOUND = 6;                // sectors from a system's origin before deep space
export const COMMODITIES = ['FOOD', 'ORE', 'FUEL CELLS', 'MEDICINE', 'PARTS', 'LUXURIES'];
const BASE_PRICE = [12, 18, 15, 34, 26, 48];

export const enum Poi { Beacon = 0, Derelict = 1, Pulsar = 2, Rogue = 3, Wormhole = 4, IonStorm = 5, OreBelt = 6, Comet = 7, Nomads = 8, Mega = 9, Signal = 10 }
export const POI_NAME = ['DISTRESS BEACON', 'DERELICT', 'PULSAR', 'ROGUE PLANET', 'WORMHOLE', 'ION STORM', 'ORE-RICH BELT', 'COMET', 'NOMAD FLEET', 'MEGASTRUCTURE', 'QUIET SIGNAL'];
/** Survey value of a first scan, by POI kind. */
export const POI_VALUE = [20, 40, 70, 50, 90, 30, 25, 35, 20, 120, 60];
export const STAR_NAME = ['YELLOW DWARF', 'RED DWARF', 'BLUE GIANT', 'WHITE STAR', 'ORANGE GIANT'];
export const STAR_TINT: [number, number, number][] = [[1, 1, 1], [1.25, 0.62, 0.45], [0.7, 0.95, 1.6], [1.05, 1.08, 1.2], [1.25, 0.85, 0.55]];

export interface PoiDef { kind: number; x: number; y: number; seed: number; link: number }
export interface StarSystem { id: number; name: string; x: number; y: number; star: number; saltX: number; saltY: number; faction: number; hot: boolean; pois: PoiDef[] }
export interface SysState { stability: number; wealth: number; piracy: number; supply: number[] }
export interface GalaxyState {
  gv: 1; seed: number; tick: number; clock: number; current: number;
  visited: number[]; scanned: Record<string, number[]>; sys: SysState[]; rel: number[];
  news: string[]; frags: number[]; logs: string[]; named: number;
}

const SYL = ['AL', 'BRE', 'CAL', 'DOR', 'EN', 'FEL', 'GA', 'HES', 'IR', 'JUN', 'KEL', 'LYR', 'MOR', 'NAV', 'OS', 'PER', 'QIR', 'RHO', 'SEL', 'TAV', 'UL', 'VEX', 'WEN', 'XAN', 'YR', 'ZEL'];
const END = ['A', 'IS', 'ON', 'US', 'ETH', 'ARA', 'OX', 'EN', 'IA', 'OR'];
function sysName(r: Rng): string {
  const n = 1 + Math.floor(r.next() * 2);
  let s = ''; for (let i = 0; i < n; i++) s += SYL[Math.floor(r.next() * SYL.length)];
  s += END[Math.floor(r.next() * END.length)];
  return r.next() < 0.3 ? s + '-' + (2 + Math.floor(r.next() * 9)) : s;
}
const FAC_A = ['CONCORD', 'COMBINE', 'FREEHOLD', 'LANTERN', 'COMPACT', 'ASSEMBLY', 'MERIDIAN', 'LEDGER'];
const FAC_B = ['OF VEYR', 'OF ORISTAN', 'OF KALE', 'OF ASHEN', 'OF THULE', 'OF MARRO', 'OF SENNET', 'OF BRAY'];

/** The single optional mystery: why the old jump lanes went quiet. Found in quiet signals and derelicts, in any order. */
export const FRAGMENTS = [
  'BEACON LOG: LANE 7 CARRIER WAVE DROPPED AT 03:12. NO ECHO FROM THE FAR GATE. WE ARE HOLDING POSITION.',
  'SURVEY NOTE: THE OLD LANES WERE NOT BUILT. THEY WERE GROWN, LIKE FROST ALONG A WIRE.',
  'PERSONAL: MIRA SAYS THE LANE HUMS IN HER SLEEP. I TOLD HER IT IS THE DRIVE. IT IS NOT THE DRIVE.',
  'ENGINEERING: EVERY GATE DRAWS A LITTLE FROM THE NEXT. PULL ONE OUT AND THE CHAIN UNSPOOLS.',
  'COUNCIL MINUTES: MOTION TO SHUT LANES 2 THROUGH 9 CARRIED. REASON SEALED.',
  'UNSIGNED: WE TURNED THEM OFF BECAUSE SOMETHING WAS USING THEM IN THE OTHER DIRECTION.',
  'CHILD\'S RECORDING: DAD SAYS THE STARS GOT QUIETER. I THINK THEY ARE LISTENING.',
  'FINAL ENTRY: IF YOU CAN READ THIS, THE LANES ARE STILL ASLEEP. LET THEM SLEEP. FLY THE LONG WAY.',
];
const LOG_SHIP = ['CORMORANT', 'SLOW TIDE', 'PELL', 'ARGENT', 'WICKER', 'HALCYON', 'TALLOW', 'RIME'];
const LOG_LINE = [
  'REACTOR STABLE. CREW OF FOUR. WAITING FOR A TUG THAT WILL NOT COME.',
  'HULL BREACH DECK 2. SEALED IT WITH CARGO NETTING AND OPTIMISM.',
  'TRADED OUR LAST MEDICINE FOR FUEL. WORTH IT. PROBABLY.',
  'PIRATES TOOK THE ORE AND LEFT THE COFFEE. SMALL MERCIES.',
  'NAV COMPUTER INSISTS WE ARE ALREADY HOME. IT HAS BEEN WRONG BEFORE.',
  'SAW LIGHTS IN THE DUST BELT. NOT SHIPS. NOT ROCKS.',
  'GAVE THE CAT THE CAPTAIN\'S CHAIR. MORALE IMPROVED.',
  'SIGNAL FROM THE OLD LANE AGAIN. LOGGED IT. DID NOT ANSWER.',
];

export class Galaxy {
  readonly systems: StarSystem[] = [];
  readonly factions: string[] = [];
  /** Live, serialisable state. */
  st: GalaxyState;
  /** Pilot tag stamped on first discoveries. */
  readonly pilot: string;

  constructor(readonly seed: number, saved?: unknown) {
    const r = new Rng(seed ^ 0x51f15e);
    // factions
    const used = new Set<string>();
    while (this.factions.length < N_FAC) {
      const f = 'THE ' + FAC_A[Math.floor(r.next() * FAC_A.length)] + ' ' + FAC_B[Math.floor(r.next() * FAC_B.length)];
      if (!used.has(f)) { used.add(f); this.factions.push(f); }
    }
    this.pilot = SYL[Math.floor(r.next() * SYL.length)].slice(0, 2) + (10 + Math.floor(r.next() * 89));
    // systems: home first at chart centre, the rest scattered with a minimum spacing (fully determined by the seed)
    const names = new Set<string>();
    for (let i = 0; i < N_SYS; i++) {
      let x = CHART / 2, y = CHART / 2;
      if (i > 0) for (let t = 0; t < 200; t++) {
        x = 4 + r.next() * (CHART - 8); y = 4 + r.next() * (CHART - 8);
        if (this.systems.every(s => Math.hypot(s.x - x, s.y - y) > 7)) break;
      }
      let name = i === 0 ? 'HELIX' : sysName(r);
      while (names.has(name)) name = sysName(r);
      names.add(name);
      const sr = new Rng(Math.imul(seed ^ 0x9e3779b9, i + 1) >>> 0);
      const star = i === 0 ? 0 : Math.floor(sr.next() * 5);
      const sys: StarSystem = { id: i, name, x, y, star, saltX: i === 0 ? 0 : 1000 + i * 97, saltY: i === 0 ? 0 : -700 + i * 61,
        faction: Math.floor(hash2(Math.round(x / 25), Math.round(y / 25) + seed) * N_FAC) % N_FAC, hot: star === 2 || star === 4, pois: [] };
      const np = i === 0 ? 2 : 2 + Math.floor(sr.next() * 4);
      for (let k = 0; k < np; k++) {
        let kind = Math.floor(sr.next() * 11);
        if (i === 0) kind = k === 0 ? Poi.Beacon : Poi.Signal;              // gentle home: a beacon and a quiet signal
        const a = sr.next() * Math.PI * 2, d = 900 + sr.next() * 2000;
        sys.pois.push({ kind, x: Math.cos(a) * d, y: Math.sin(a) * d, seed: sr.next(), link: -1 });
      }
      this.systems.push(sys);
    }
    // wormholes are shortcuts: link each to a far system
    for (const s of this.systems) for (const p of s.pois) if (p.kind === Poi.Wormhole) {
      let best = 0, bd = -1;
      for (const o of this.systems) { const d = Math.hypot(o.x - s.x, o.y - s.y) * (0.5 + hash2(o.id, s.id)); if (o.id !== s.id && d > bd) { bd = d; best = o.id; } }
      p.link = best;
    }
    this.st = this.fresh();
    if (saved) this.load(saved);
  }

  private fresh(): GalaxyState {
    const sys: SysState[] = this.systems.map(s => {
      const h = (k: number): number => hash2(s.id * 13 + k, this.seed & 0xffff);
      return { stability: 0.4 + 0.5 * h(1), wealth: 0.3 + 0.5 * h(2), piracy: s.id === 0 ? 0.15 : 0.1 + 0.5 * h(3), supply: COMMODITIES.map((_, c) => 0.6 + 0.8 * h(10 + c)) };
    });
    const rel: number[] = [];
    for (let a = 0; a < N_FAC; a++) for (let b = 0; b < N_FAC; b++) rel.push(a === b ? 1 : Math.round((hash2(a * 7 + b * 3, this.seed & 0xfff) * 1.4 - 0.7) * 100) / 100);
    for (let a = 0; a < N_FAC; a++) for (let b = 0; b < a; b++) rel[a * N_FAC + b] = rel[b * N_FAC + a];
    return { gv: 1, seed: this.seed, tick: 0, clock: 0, current: 0, visited: [0], scanned: {}, sys, rel, news: [], frags: [], logs: [], named: 0 };
  }

  /** Validate and adopt a saved state (any field that fails validation keeps its fresh value). */
  private load(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const p = raw as Partial<GalaxyState>, s = this.st;
    if (p.gv !== 1 || p.seed !== this.seed) return;
    const fin = (x: unknown, lo: number, hi: number, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);
    s.tick = fin(p.tick, 0, 1e9, 0) | 0; s.clock = fin(p.clock, 0, TICK_S, 0); s.current = fin(p.current, 0, N_SYS - 1, 0) | 0; s.named = fin(p.named, 0, 1e6, 0) | 0;
    const ids = (a: unknown, max: number): number[] => (Array.isArray(a) ? Array.from(new Set(a.filter((x): x is number => Number.isInteger(x) && x >= 0 && x < max))) : []);
    s.visited = Array.from(new Set([0, ...ids(p.visited, N_SYS)])); s.frags = ids(p.frags, FRAGMENTS.length);
    if (p.scanned && typeof p.scanned === 'object') for (const [k, v] of Object.entries(p.scanned)) {
      const id = Number(k); if (Number.isInteger(id) && id >= 0 && id < N_SYS && Array.isArray(v)) s.scanned[k] = v.filter((x): x is number => Number.isInteger(x)).slice(0, 96);
    }
    if (Array.isArray(p.sys) && p.sys.length === N_SYS) p.sys.forEach((q, i) => {
      if (!q || typeof q !== 'object') return;
      const d = s.sys[i]; d.stability = fin(q.stability, 0, 1, d.stability); d.wealth = fin(q.wealth, 0, 1, d.wealth); d.piracy = fin(q.piracy, 0, 1, d.piracy);
      if (Array.isArray(q.supply)) for (let c = 0; c < N_COM; c++) d.supply[c] = fin(q.supply[c], 0.2, 1.8, d.supply[c]);
    });
    if (Array.isArray(p.rel) && p.rel.length === N_FAC * N_FAC) for (let i = 0; i < p.rel.length; i++) s.rel[i] = fin(p.rel[i], -1, 1, s.rel[i]);
    if (Array.isArray(p.news)) s.news = p.news.filter((x): x is string => typeof x === 'string' && x.length < 80).slice(-12);
    if (Array.isArray(p.logs)) s.logs = p.logs.filter((x): x is string => typeof x === 'string' && x.length < 160).slice(-24);
  }
  state(): GalaxyState { return this.st; }

  get here(): StarSystem { return this.systems[this.st.current]; }
  dist(a: number, b: number): number { const A = this.systems[a], B = this.systems[b]; return Math.hypot(A.x - B.x, A.y - B.y); }
  /** Fog of war: visited systems are named; systems within 18 ly of a visited one are known as signals. */
  known(id: number): 0 | 1 | 2 {
    if (this.st.visited.includes(id)) return 2;
    for (const v of this.st.visited) if (this.dist(v, id) < 18) return 1;
    return 0;
  }
  /** Fuel for a jump of `d` light-years at a given burn factor. */
  static jumpFuel(d: number, burn: number): number { return Math.ceil(d * 1.6 * (0.6 + burn * 1.6)); }

  arrive(id: number): void {
    this.st.current = id;
    if (!this.st.visited.includes(id)) this.st.visited.push(id);
  }

  // ---------------------------------------------------------------- survey
  /** Total scannable things in a system: its planets and moons (counted by the caller via world.ts) plus POIs. */
  scannedIn(id: number): number[] { return (this.st.scanned[id] ??= []); }
  /** Record a scan; returns true when it is new. Keys are integers (bodies: from seed and radius; POIs: -1 - index). */
  recordScan(key: number): boolean {
    const a = this.scannedIn(this.st.current);
    if (a.includes(key) || a.length >= 96) return false;
    a.push(key); return true;
  }
  survey(id: number, bodies: number): number {
    const n = this.systems[id].pois.length + bodies; let k = 0;
    for (const x of this.st.scanned[id] ?? []) if (x > -1000) k++;         // -1000 - i marks a resolved POI, not a scan
    return n === 0 ? 1 : Math.min(1, k / n);
  }

  /** Procedural catalogue designation for a first discovery, stamped with the pilot tag. */
  discoveryName(sys: number, key: number): string {
    const n = 100 + Math.floor(hash2(key * 31 + sys, key >> 3) * 899);
    return this.systems[sys].name + '-' + n + ' [' + this.pilot + ']';
  }

  // ---------------------------------------------------------------- living galaxy
  /** Advance the abstract simulation by `dt` seconds of play; runs a tick every TICK_S. */
  advance(dt: number): string[] {
    const out: string[] = [];
    this.st.clock += dt;
    while (this.st.clock >= TICK_S) { this.st.clock -= TICK_S; out.push(...this.tick()); }
    return out;
  }

  /** One galaxy tick: drift toward the mean, then 1-2 data-driven events. Deterministic from (seed, tick). */
  tick(): string[] {
    const s = this.st, r = new Rng(Math.imul(this.seed, 0x2c1b3c6d) ^ Math.imul(++s.tick, 0x297a2d39));
    for (const q of s.sys) {
      q.stability += (0.6 - q.stability) * 0.05; q.wealth += (0.5 - q.wealth) * 0.04; q.piracy += (0.3 - q.piracy) * 0.05;
      for (let c = 0; c < N_COM; c++) q.supply[c] += (1 - q.supply[c]) * 0.08;
    }
    const msgs: string[] = [];
    const n = 1 + (r.next() < 0.4 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const id = Math.floor(r.next() * N_SYS), sys = this.systems[id], q = s.sys[id];
      let tot = 0; for (const e of EVENTS) tot += e.w(q, this, sys);
      let pick = r.next() * tot, ev = EVENTS[0];
      for (const e of EVENTS) { pick -= e.w(q, this, sys); if (pick <= 0) { ev = e; break; } }
      msgs.push(ev.run(q, this, sys, r));
    }
    for (const q of s.sys) { q.stability = clamp01(q.stability); q.wealth = clamp01(q.wealth); q.piracy = clamp01(q.piracy); for (let c = 0; c < N_COM; c++) q.supply[c] = Math.min(1.8, Math.max(0.2, q.supply[c])); }
    for (let i = 0; i < s.rel.length; i++) s.rel[i] = Math.min(1, Math.max(-1, s.rel[i]));
    for (const m of msgs) this.news(m);
    return msgs;
  }
  news(m: string): void { this.st.news.push(m); if (this.st.news.length > 12) this.st.news.shift(); }

  // player actions nudge the numbers of the current system
  onKill(): void { const q = this.st.sys[this.st.current]; q.piracy = clamp01(q.piracy - 0.004); }
  onHaulerLost(): void { const q = this.st.sys[this.st.current]; q.wealth = clamp01(q.wealth - 0.03); q.piracy = clamp01(q.piracy + 0.02); }
  onStationSaved(): void { const q = this.st.sys[this.st.current]; q.stability = clamp01(q.stability + 0.08); this.news('STATION AT ' + this.here.name + ' HOLDS. CONVOYS RETURN'); }
  onTrade(com: number, units: number): void { const q = this.st.sys[this.st.current]; q.supply[com] = Math.min(1.8, Math.max(0.2, q.supply[com] + units * 0.02)); q.wealth = clamp01(q.wealth + units * 0.002); }

  /** Station price of a commodity here: scarcity and wealth push it up. Buy is 10% over, sell 10% under. */
  price(com: number, sell: boolean, sys = this.st.current): number {
    const q = this.st.sys[sys], base = BASE_PRICE[com] * (2 - q.supply[com]) * (0.8 + 0.4 * q.wealth);
    return Math.max(1, Math.round(base * (sell ? 0.9 : 1.1)));
  }
  /** Enemy pressure multiplier for the current system (piracy), used by the sim director. */
  pressure(): number { return 0.7 + 0.8 * this.st.sys[this.st.current].piracy; }

  // ---------------------------------------------------------------- lore
  /** Lore at a POI: quiet signals and derelicts carry mystery fragments (until all are found); derelicts also carry ship logs. */
  lore(poi: PoiDef, sysId: number): { frag: number; log: string } {
    let frag = -1, log = '';
    if (poi.kind === Poi.Signal || (poi.kind === Poi.Derelict && poi.seed < 0.5)) {
      for (let i = 0; i < FRAGMENTS.length; i++) { const f = (Math.floor(poi.seed * 997) + sysId + i) % FRAGMENTS.length; if (!this.st.frags.includes(f)) { frag = f; break; } }
      if (frag >= 0) this.st.frags.push(frag);
    }
    if (poi.kind === Poi.Derelict) {
      log = 'LOG ' + LOG_SHIP[Math.floor(poi.seed * LOG_SHIP.length)] + '-' + (10 + Math.floor(poi.seed * 89)) + ': ' + LOG_LINE[Math.floor(hash2(sysId, poi.seed * 1000) * LOG_LINE.length)];
      if (!this.st.logs.includes(log)) { this.st.logs.push(log); if (this.st.logs.length > 24) this.st.logs.shift(); }
    }
    return { frag, log };
  }
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** Data-driven event table: weight from the system state, effect, and a news line. */
interface GalaxyEvent { id: string; w: (q: SysState, g: Galaxy, s: StarSystem) => number; run: (q: SysState, g: Galaxy, s: StarSystem, r: Rng) => string }
const EVENTS: GalaxyEvent[] = [
  { id: 'pirates', w: q => 0.5 + q.piracy, run: (q, _g, s) => { q.piracy += 0.18; q.stability -= 0.06; return 'PIRATE ACTIVITY RISING NEAR ' + s.name; } },
  { id: 'boom', w: q => 0.4 + q.stability * 0.6, run: (q, _g, s, r) => { const c = Math.floor(r.next() * N_COM); q.wealth += 0.15; q.supply[c] += 0.5; return 'TRADE BOOM AT ' + s.name + ': ' + COMMODITIES[c] + ' PRICES FALL'; } },
  { id: 'famine', w: q => 0.3 + (1 - q.supply[0]) * 0.6, run: (q, _g, s) => { q.supply[0] -= 0.6; q.supply[3] -= 0.3; q.stability -= 0.08; return 'FOOD SHORTAGE AT ' + s.name + '. MEDICINE IN DEMAND'; } },
  { id: 'blockade', w: q => 0.2 + (1 - q.stability) * 0.6, run: (q, g, s) => { q.supply[2] -= 0.5; q.supply[4] -= 0.3; q.wealth -= 0.08; return g.factions[s.faction] + ' BLOCKADE ' + s.name; } },
  { id: 'freighter', w: q => 0.3 + q.piracy * 0.8, run: (q, _g, s, r) => { q.wealth -= 0.05; return s.name.slice(0, 4) + '-' + (2 + Math.floor(r.next() * 9)) + ' FREIGHTER LOST AT ' + (Math.floor(r.next() * 9) - 4) + ',' + (Math.floor(r.next() * 9) - 4); } },
  { id: 'war', w: (_q, g, s) => { let m = 0; for (let b = 0; b < N_FAC; b++) m = Math.min(m, g.st.rel[s.faction * N_FAC + b]); return 0.15 + Math.max(0, -m) * 0.7; },
    run: (q, g, s, r) => {
      let b = Math.floor(r.next() * N_FAC); if (b === s.faction) b = (b + 1) % N_FAC;
      g.st.rel[s.faction * N_FAC + b] -= 0.2; g.st.rel[b * N_FAC + s.faction] -= 0.2; q.stability -= 0.15; q.piracy += 0.05;
      return g.factions[s.faction].replace('THE ', '') + ' AND ' + g.factions[b].replace('THE ', '') + ' TRADE FIRE OVER ' + s.name;
    } },
  { id: 'truce', w: () => 0.25, run: (q, g, s, r) => {
      let b = Math.floor(r.next() * N_FAC); if (b === s.faction) b = (b + 1) % N_FAC;
      g.st.rel[s.faction * N_FAC + b] += 0.15; g.st.rel[b * N_FAC + s.faction] += 0.15; q.stability += 0.1;
      return 'TALKS AT ' + s.name + ' EASE TENSIONS';
    } },
  { id: 'rumour', w: () => 0.2, run: (_q, _g, s) => 'SURVEYORS REPORT A QUIET SIGNAL BEYOND ' + s.name },
];
