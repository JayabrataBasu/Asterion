import type { SaveData } from '../core/save';
import type { FrameBuilder } from '../gfx/draw';
import { Ev, MAX_POI, type Sim } from '../sim/sim';
import { COMMODITIES, FRAGMENTS, Galaxy, N_SYS, POI_NAME, POI_VALUE, Poi, STAR_NAME, STAR_TINT, SYS_BOUND } from '../sim/galaxy';
import { PLANET_STRIDE, addBody, hasMoon, planetParams, setSystem } from '../sim/world';

const PT = new Float32Array(PLANET_STRIDE);
/** Integer scan key of a body from its seed and radius (stable while a moon orbits). */
export const bodyKey = (seed: number, r: number): number => (Math.round(seed * 9973) * 131 + Math.round(r * 3)) | 0;

/**
 * Exploration + living-galaxy glue (M5/M6): owns the Galaxy, configures the sim for the current system, turns sim events
 * into survey data, lore and news, and feeds the HUD (signals, survey %, ticker). Cold path except `frame()`, which allocates nothing.
 */
export class Explorer {
  galaxy: Galaxy;
  /** Scan candidates of the current frame (index -> key / name / kind), mirrored into sim.scanList. */
  private readonly candKey = new Int32Array(16); private readonly candPoi = new Int8Array(16);
  /** Bodies (planets + moons) in the current system, for survey %. */
  bodies = 0;
  /** Selected chart target and pending jump. */
  chartSel = 0; pendingJump = -1;
  /** Notable events this run (game-over summary) and the news ticker queue. */
  readonly notable: string[] = [];
  ticker = ''; tickerT = 0; private readonly queue: string[] = [];
  private evCursor = 0; private surveyedBefore = new Set<number>();
  onToast: (s: string) => void = () => {};
  onArrive: () => void = () => {};

  constructor(private sim: Sim, private fb: FrameBuilder, private save: SaveData, seed: number, persistent: boolean) {
    this.galaxy = new Galaxy(seed, persistent ? save.galaxy : null);
    this.persistent = persistent;
    this.fb.notable = this.notable;
    for (let i = 0; i < N_SYS; i++) if (this.galaxy.survey(i, 1e9) >= 1) this.surveyedBefore.add(i);
  }
  readonly persistent: boolean;

  /** Configure the world and sim for system `id` (fresh = start of a run at the origin; otherwise a jump arrival). */
  enter(id: number, fresh: boolean): void {
    const g = this.galaxy; g.arrive(id);
    const sys = g.systems[id];
    setSystem(sys.saltX, sys.saltY, SYS_BOUND);
    if (!fresh) this.sim.enterSystem();
    this.sim.nPoi = 0;
    sys.pois.forEach((p, i) => { if (i < MAX_POI) this.sim.setPoi(i, p.x, p.y, p.kind, p.seed); if (p.kind === Poi.Rogue) addBody(p.x, p.y, 38 + p.seed * 30, 2, p.seed); });
    // POIs already resolved on earlier visits stay resolved (scanned set holds -1 - index for them)
    const sc = g.scannedIn(id);
    for (let i = 0; i < sys.pois.length && i < MAX_POI; i++) if (sc.includes(-1000 - i)) this.sim.poiDone[i] = 1;
    this.sim.hotSys = sys.hot; this.sim.pressure = g.pressure();
    this.fb.sysName = sys.name; this.fb.sunTint = STAR_TINT[sys.star];
    this.fb.designate = () => '';                                // bodies are named when scanned, not on sight
    // survey denominator: every planet and moon inside the system bound
    let n = 0;
    for (let sy = -SYS_BOUND; sy <= SYS_BOUND; sy++) for (let sx = -SYS_BOUND; sx <= SYS_BOUND; sx++) if (planetParams(sx, sy, PT, 0)) n += hasMoon(sx, sy) ? 2 : 1;
    this.bodies = n + sys.pois.filter(p => p.kind === Poi.Rogue).length;
    this.chartSel = id;
    if (!fresh) { this.note('ARRIVED AT ' + sys.name); this.onArrive(); this.save.stats.jumps++; }
    this.fb.announce(sys.name + '  -  ' + STAR_NAME[sys.star] + '  -  ' + g.factions[sys.faction].replace('THE ', ''), 0);
    this.persist();
  }

  survey(): number { return this.galaxy.survey(this.galaxy.st.current, this.bodies); }

  /** Per frame (allocation-free): scan candidates, events, ticker, HUD feeds. */
  frame(dt: number, playing: boolean): void {
    const s = this.sim, g = this.galaxy, sc = g.scannedIn(g.st.current);
    // ---- scan candidates: nearby unscanned bodies and POIs
    let n = 0;
    for (let k = 0; k < s.nPl && n < 16; k++) {
      const o = k * PLANET_STRIDE, key = bodyKey(s.pl[o + 4], s.pl[o + 2]);
      if (sc.includes(key)) continue;
      s.scanList[n * 3] = s.pl[o]; s.scanList[n * 3 + 1] = s.pl[o + 1]; s.scanList[n * 3 + 2] = s.pl[o + 2];
      this.candKey[n] = key; this.candPoi[n] = -1; n++;
    }
    for (let p = 0; p < s.nPoi && n < 16; p++) {
      const key = -1 - p;
      if (sc.includes(key)) continue;
      s.scanList[n * 3] = s.poiX[p]; s.scanList[n * 3 + 1] = s.poiY[p]; s.scanList[n * 3 + 2] = 20;
      this.candKey[n] = key; this.candPoi[n] = p; n++;
    }
    s.nScan = n;
    this.fb.scanTargetI = s.scanIdx >= 0 && s.scanIdx < n ? s.scanIdx : -1;
    this.fb.scanTargetX = this.fb.scanTargetI >= 0 ? s.scanList[s.scanIdx * 3] : 0; this.fb.scanTargetY = this.fb.scanTargetI >= 0 ? s.scanList[s.scanIdx * 3 + 1] : 0;
    // ---- events (read only; audio drains the ring afterwards)
    if (this.evCursor < s.evTail || this.evCursor > s.evHead) this.evCursor = s.evTail;
    for (; this.evCursor < s.evHead; this.evCursor++) {
      const i = this.evCursor & 255, m = s.evM[i] | 0;
      switch (s.evT[i]) {
        case Ev.Scan: this.scanned(m); break;
        case Ev.Poi: this.poi(m); break;
        case Ev.Wormhole: this.wormhole(m); break;
        case Ev.Jump: if (this.pendingJump >= 0) { const to = this.pendingJump; this.pendingJump = -1; this.enter(to, false); } break;
        case Ev.Kill: g.onKill(); break;
        case Ev.Hauler: g.onHaulerLost(); break;
        case Ev.Saved: g.onStationSaved(); this.note('DEFENDED THE STATION AT ' + g.here.name); break;
        case Ev.Boss: if (m === 1) this.note('DREADNOUGHT SIGHTED AT ' + g.here.name); break;
        case Ev.Cruise: this.onToast(m ? 'cruise engaged' : 'cruise disengaged'); break;
      }
    }
    // ---- living galaxy + ticker
    if (playing) for (const msg of g.advance(dt)) this.queue.push(msg);
    if (playing) s.pressure = g.pressure();
    if (this.tickerT > 0) this.tickerT -= dt;
    if (this.tickerT <= 0) { this.ticker = this.queue.shift() ?? ''; this.tickerT = this.ticker ? 9 : 0; }
    this.fb.ticker = this.save.ticker ? this.ticker : ''; this.fb.tickerT = this.tickerT;
    // ---- HUD feeds: signal bearings for untouched POIs within long sensor range
    let ns = 0;
    for (let p = 0; p < s.nPoi && ns < 6; p++) {
      if (s.poiDone[p]) continue;
      const dx = s.poiX[p] - s.sx, dy = s.poiY[p] - s.sy;
      if (dx * dx + dy * dy > (s.sensorR * 6) ** 2) continue;
      this.fb.sigX[ns] = s.poiX[p]; this.fb.sigY[ns] = s.poiY[p]; this.fb.sigK[ns] = s.poiK[p]; ns++;
    }
    this.fb.nSig = ns;
    this.fb.surveyPct = this.survey();
    this.fb.data = this.save.data;
  }

  skipTicker(): void { this.tickerT = 0; }

  private scanned(c: number): void {
    const g = this.galaxy, key = this.candKey[c], p = this.candPoi[c];
    if (!g.recordScan(key)) return;
    const s = this.sim, sys = g.here;
    this.save.stats.scans++;
    if (p >= 0) {
      const kind = s.poiK[p], v = POI_VALUE[kind] ?? 30;
      this.save.data += v;
      this.onToast('scanned ' + POI_NAME[kind].toLowerCase() + '  +' + v + ' survey data');
      this.fb.announce(POI_NAME[kind] + ' ' + g.discoveryName(sys.id, key), 1);
    } else {
      // find the body to describe it
      let ty = 0, r = 20;
      for (let k = 0; k < s.nPl; k++) { const o = k * PLANET_STRIDE; if (bodyKey(s.pl[o + 4], s.pl[o + 2]) === key) { ty = s.pl[o + 3]; r = s.pl[o + 2]; this.fb.scanX = s.pl[o]; this.fb.scanY = s.pl[o + 1]; this.fb.scanR = r; } }
      const v = Math.round(15 + r * 0.8 + (ty === 1 ? 20 : 0));
      this.save.data += v;
      const name = g.discoveryName(sys.id, key);
      const temp = [288, 140, 70, 900, 340][ty] + Math.round((key & 63) - 32);
      const comp = ['N2 78% O2 21% AR 1%  OCEANS', 'H2 82% HE 15% CH4 2%  STORMS', 'H2O ICE 90% CO2 8%', 'SIO2 MELT  S 4%  FE', 'FE2O3 41% SIO2 38%  DUST'][ty];
      this.fb.scanText = name + '   T=' + temp + 'K   ' + comp + '   R=' + Math.round(r * 130) + 'KM   ';
      this.fb.scanEnv = 1;
      this.fb.announce(name, 1);
      this.onToast('first survey: ' + name.toLowerCase() + '  +' + v + ' data');
      if (r > 55) this.note('CATALOGUED ' + name);
    }
    const pct = this.survey();
    if (pct >= 1 && !this.surveyedBefore.has(sys.id)) { this.surveyedBefore.add(sys.id); this.save.stats.systems++; this.note(sys.name + ' FULLY SURVEYED'); this.galaxy.news('SURVEY OF ' + sys.name + ' COMPLETE'); }
    this.persist();
  }

  private poi(p: number): void {
    const g = this.galaxy, sys = g.here, def = sys.pois[p];
    if (!def) return;
    g.recordScan(-1000 - p);                                     // resolved: stays resolved on later visits
    const lore = g.lore(def, sys.id);
    if (lore.frag >= 0) { this.save.stats.fragments = g.st.frags.length; this.onToast('fragment recovered (' + g.st.frags.length + '/' + FRAGMENTS.length + ') - see SHIP LOGS'); this.note('RECOVERED A LANE FRAGMENT'); }
    else if (lore.log) this.onToast('derelict log recovered');
    switch (def.kind) {
      case Poi.Beacon: this.onToast('distress beacon: salvage nearby' + (def.seed < 0.5 ? ' - it was bait' : '')); break;
      case Poi.Derelict: this.note('BOARDED A DERELICT AT ' + sys.name); break;
      case Poi.Pulsar: this.onToast('pulsar: radiation rising - em resist helps'); break;
      case Poi.IonStorm: this.onToast('ion storm: shields offline inside'); break;
      case Poi.OreBelt: this.onToast('ore-rich belt: rocks drop extra scrap'); break;
      case Poi.Nomads: this.onToast('nomad fleet on the move'); break;
      case Poi.Mega: this.note('SAW THE MEGASTRUCTURE AT ' + sys.name); break;
    }
    this.persist();
  }

  private wormhole(p: number): void {
    const g = this.galaxy, def = g.here.pois[p];
    if (!def || def.link < 0) return;
    this.note('WORMHOLE ' + g.here.name + ' -> ' + g.systems[def.link].name);
    this.onToast('wormhole: thrown to ' + g.systems[def.link].name.toLowerCase());
    this.enter(def.link, false);
  }

  /** Chart: try to start a jump to the selected system. Returns a status line. */
  jump(): string {
    const g = this.galaxy, s = this.sim, to = this.chartSel, from = g.st.current;
    if (to === from) return 'already here';
    if (g.known(to) === 0) return 'no fix on that system';
    const d = g.dist(from, to);
    if (d > s.ship.jumpRange * (1 + 0.1 * s.up[8])) return 'out of jump range (' + d.toFixed(1) + ' / ' + s.ship.jumpRange.toFixed(0) + ' LY)';
    const cost = Galaxy.jumpFuel(d, s.ship.fuelBurn);
    if (s.fuel < cost) return 'not enough fuel (' + cost + ' needed)';
    s.fuel -= cost; this.pendingJump = to;
    s.startJump(s.ship.jumpCharge);
    return 'jump drive charging: ' + g.systems[to].name.toLowerCase();
  }

  note(s: string): void { this.notable.push(s); if (this.notable.length > 8) this.notable.shift(); }
  persist(): void { if (this.persistent) this.save.galaxy = this.galaxy.state(); }
  commodities(): string[] { return COMMODITIES; }
}
