import { Rng, TAU, clamp, hash2, wrapAngle } from '../core/util';
import { SpatialHash } from './spatial';
import { MAX_PLANETS, PLANET_STRIDE, SYS, gravReach, SECTOR, STATION_MULT, hasStation, inSystem, nebulaAt, planetParams, planetsNear, sectorOf, stationType } from './world';
import { ENEMY, FLIGHT, MODULES, WREN, applyModules, assignShip, cloneShip, type ShipDef } from './ships';

/**
 * Headless, allocation-free simulation core. Everything is struct-of-arrays; the renderer only reads.
 * Units: 1 world unit == 1 cell width, +y is up, angle 0 == +x, counter-clockwise positive.
 */
export const DT = 1 / 60;
export const MAX_E = 320;
export const MAX_B = 640;
export const MAX_P = 8192;          // must be a power of two (ring-buffer allocation)
export const MAX_R = 24;
export const MAX_GRP = 16;
const HASH_CELL = 24;

export const enum Kind { None = 0, Drone = 1, Gunship = 2, Minelayer = 3, Mine = 4, Asteroid = 5, Station = 6, Boss = 7, Sniper = 8, Splitter = 9, Tender = 10, Rammer = 11, Freighter = 12, Comet = 13, Hauler = 14, Wing = 15 }
/** Damage types, matched against ShipDef.resist. */
export const enum Dmg { Kinetic = 0, Thermal = 1, Em = 2 }
export const enum St { Patrol = 0, Chase = 1, Attack = 2, Flee = 3 }
export const enum In { Missile = 128, Thrust = 1, Left = 2, Right = 4, Brake = 8, Fire = 16, Boost = 32, Dodge = 64, StrafeL = 256, StrafeR = 512, Climb = 1024, Dive = 2048, Scan = 4096, Cruise = 8192 }
export const enum Ev { PlayerShot = 1, EnemyShot = 2, Hit = 3, Explosion = 4, ShipHit = 5, Kill = 6, Charge = 7, Pickup = 8, Dash = 9, Boss = 10, Objective = 11, Dock = 12, Missile = 13, Heal = 14,
  Scan = 15, Poi = 16, Jump = 17, Wormhole = 18, Hauler = 19, Saved = 20, Cruise = 21 }
export const enum Up { Gun = 0, Hull = 1, Boost = 2, Thrust = 3, Magnet = 4, Spread = 5, Missile = 6, Reactor = 7, Sensors = 8, Tank = 9 }
export const UP_N = 10, UP_MAX = 5;
export const UP_NAME = MODULES.map(m => m.name);
export const UP_DESC = MODULES.map(m => m.slot.toLowerCase() + ': ' + m.desc);
/** Points of interest per system (set by the galaxy layer on arrival). */
export const MAX_POI = 6;
const ORE_TAG = 0x0e0e0e0e;
export function upCost(level: number): number { return 30 + 25 * level; }
export const MAX_S = 96;
export const MAX_M = 12;
export const enum PK { Spark = 0, Exhaust = 1, Debris = 2, Smoke = 3, Flash = 4 }
export const enum Col { Fire = 0, Cyan = 1, Red = 2, White = 3, Gray = 4, Green = 5, Magenta = 6, Amber = 7 }

export const PROF_NAMES = ['ship', 'world', 'ents', 'bolts', 'misc', 'fx'];
/** Aim assist tuning. Modes: 0 off, 1 wide hits, 2 cone lead, 3 soft homing. */
export const AIM_ASSIST = { A_BONUS: 1.2, B_CONE: 8 * Math.PI / 180, B_FULL: 3 * Math.PI / 180, B_RANGE: 260, C_CONE: 25 * Math.PI / 180, C_RANGE: 180, C_TURN: 1.6 };
const GRAV_K = 9.5;
/** Verticality experiment: three bands at z = -1 (Low), 0 (Mid), 1 (High). Hits only connect within V_TOL. */
export const V_TOL = 0.5;
export const BAND_NAME = ['LOW', 'MID', 'HIGH'];   // pull is independent of planet size; reach (gravReach) is capped so giants are not bigger magnets
const AST_R = [0, 2.4, 4.3, 6.7];

/** Enemy stats come from the shared ShipDef schema (ENEMY in ships.ts); flat arrays keep the hot loop cheap. */
const KIND_R = ENEMY.map(e => e.radius), KIND_HP = ENEMY.map(e => e.hullMax), KIND_SPEED = ENEMY.map(e => e.maxSpeed);
const KIND_ACCEL = ENEMY.map(e => e.thrustFwd / e.mass), KIND_TURN = ENEMY.map(e => e.turnRate), KIND_AGGRO = ENEMY.map(e => e.sensorRange);
const ATK_IN = [0, 120, 90, 90, 0, 0, 0, 170, 230, 115, 0, 400, 0, 0, 0, 0], ATK_OUT = [0, 170, 130, 130, 0, 0, 0, 240, 300, 165, 0, 520, 0, 0, 0, 0];
const ORBIT = [0, 62, 62, 62, 0, 0, 0, 115, 170, 0, 0, 0, 0, 0, 0], FIRE_D = [0, 100, 125, 125, 0, 0, 0, 210, 280, 0, 0, 0, 0, 0, 0];
const DROP = [0, 2, 5, 4, 0, 0, 0, 40, 6, 3, 5, 2, 0, 0, 0, 0];

export class Sim {
  // ---- time / meta
  time = 0; tick = 0;
  rng = new Rng(1);
  private srng = new Rng(1);
  score = 0; kills = 0;
  shake = 0; flash = 0;           // consumed/decayed by renderer-facing code (decay done here)

  // ---- input
  input = 0;

  // ---- ship
  alive = true; deadT = 0;
  sx = 0; sy = 0; svx = 0; svy = 0; sa = 0.3; spx = 0; spy = 0; spa = 0.3;
  hp = 100; boostE = 100; cool = 0; lastHit = -99; thrusting = false; boosting = false; gunSide = 1;
  invuln = 0; hitFlash = 0;
  // ---- progression (up/scrap persist across reset(); main banks them at stations)
  readonly up = new Int8Array(UP_N);
  scrap = 0; scrapTotal = 0; boostMax = 100;
  /** The flown hull. Mutated in place by setShip() and the tuning panel; everything ship-specific reads it. */
  readonly ship: ShipDef = cloneShip(WREN);
  dashN = 1; private dashLock = 0;
  /** Shield points, weapon energy, heat (overheat locks weapons until it falls below half), live signature multiplier. */
  shield = 0; energy = 100; heat = 0; overheat = false; sigNow = 1; private firedT = 0;
  /** Trade goods carried (units); Mule converts part of incoming damage into lost cargo. */
  cargoUsed = 0;
  /** Hive wingmen alive / relaunch cooldown. */
  nWing = 0; wingCd = 0;
  /** Scan progress 0..1 while the scan key is held (M5); drives Sextant's petals. */
  scanP = 0;
  /** Scan candidates (x, y, r) supplied by the exploration layer each frame; scanIdx = the one being scanned. */
  readonly scanList = new Float32Array(16 * 3); nScan = 0; scanIdx = -1; private scanCd = 0;
  /** Fuel, time-compressed cruise, jump-drive charge (seconds left, 0 = idle). */
  fuel = 100; cruise = false; jumpT = 0; jumpLen = 0;
  /** Points of interest of the current system: x, y, kind, seed, state (0 untouched, 1 triggered). */
  readonly poiX = new Float32Array(MAX_POI); readonly poiY = new Float32Array(MAX_POI); readonly poiK = new Int8Array(MAX_POI);
  readonly poiS = new Float32Array(MAX_POI); readonly poiDone = new Uint8Array(MAX_POI); nPoi = 0;
  /** System hazards and pressure set by the galaxy layer: hot star (heat), ion zone strength (live), enemy pressure. */
  hotSys = false; zoneStorm = 0; pressure = 1; radiation = 0;
  /** Distance travelled this run (units) and trade goods by commodity. */
  dist = 0;
  readonly cargoBy = new Int16Array(6);
  get fuelMax(): number { return this.ship.fuelMax; }
  get sensorR(): number { return this.ship.sensorRange; }
  get shieldMax(): number { return this.ship.shieldMax; }
  /** The hull as designed (tuning panel edits this); `ship` is base + modules. Call refreshShip() after changing either. */
  readonly base: ShipDef = cloneShip(WREN);
  setShip(d: ShipDef): void { assignShip(this.base, d); this.refreshShip(); this.dashN = this.ship.dashCharges; }
  refreshShip(): void { applyModules(this.ship, this.base, this.up); this.boostMax = this.ship.boostCap; }
  shots = 0; hits = 0; dashCd = 0; muzzleT = 0; hpIdx = 0;
  /** Sector events: warn 0 none / 1 comet / 2 meteors / 3 flare / 4 storm; warnT counts the warning down; flare/storm are 0..1 envelopes. */
  warn = 0; warnT = 0; flare = 0; storm = 0;
  /** Rare scale set pieces (progress 0..1, 0 = off): 5 a ringed giant eclipses the sun (45 s), 6 a megastructure crosses the sky (90 s). */
  ecl = 0; mega = 0; private eclT = 0; private megaT = 0; debugEvtP = 0;
  private wasBoost = false;
  private flareT = 0; private stormT = 0; private meteorLeft = 0; private meteorCd = 0; private meteorAng = 0;
  private evtNext = 40; private lastEvt = 0; private haulCd = 45; nHaul = 0; private nHaulTmp = 0;
  aimAssist = 2; assistTarget = -1; sw = 0; assist = false; aimOn = false; aimAng = 0;
  dockable = -1; nBoss = 0; bossMax = 1; bossHp = 0;
  stationNear = false; hard = false; dockMult = 1; dockType = 0;
  private readonly caches = new Set<number>();
  slowT = 0; bossKills = 0; bossHpMax = 110; missiles = 0; missileCd = 0;
  readonly eshield = new Float32Array(MAX_E);
  readonly sck = new Uint8Array(MAX_S);
  readonly mx = new Float32Array(MAX_M); readonly my = new Float32Array(MAX_M);
  readonly mang = new Float32Array(MAX_M); readonly mspd = new Float32Array(MAX_M);
  readonly mlife = new Float32Array(MAX_M); readonly mtgt = new Int16Array(MAX_M);
  private mcur = 0;
  get missileCap(): number { return this.ship.missileCap; }
  get objType(): number { return this.objTier % 6; }
  /** Index of the escorted freighter (-1 when none) and how many mission failures this run. */
  frIdx = -1; escortFails = 0;
  objKills = 0; objTarget = 6; objTier = 0; nextBoss = 150;
  readonly scx = new Float32Array(MAX_S); readonly scy = new Float32Array(MAX_S);
  readonly scvx = new Float32Array(MAX_S); readonly scvy = new Float32Array(MAX_S);
  readonly scl = new Float32Array(MAX_S); readonly scv = new Float32Array(MAX_S);
  private scur = 0;
  get hpMax(): number { return this.ship.hullMax; }
  get tractorR(): number { return this.ship.tractor; }
  /** 0 calm, 1 build, 2 peak, 3 lull (90 s cycle) */
  get phase(): number { const c = this.time % 90; return c < 20 ? 0 : c < 50 ? 1 : c < 75 ? 2 : 3; }

  // ---- entities (enemies, mines, asteroids)
  readonly ek = new Uint8Array(MAX_E);
  readonly es = new Uint8Array(MAX_E);
  readonly ex = new Float32Array(MAX_E);
  readonly ey = new Float32Array(MAX_E);
  readonly evx = new Float32Array(MAX_E);
  readonly evy = new Float32Array(MAX_E);
  readonly ea = new Float32Array(MAX_E);
  readonly ehp = new Float32Array(MAX_E);
  readonly er = new Float32Array(MAX_E);
  readonly et = new Float32Array(MAX_E);
  readonly et2 = new Float32Array(MAX_E);
  readonly eaux = new Float32Array(MAX_E);
  readonly eseed = new Float32Array(MAX_E);
  readonly eflash = new Float32Array(MAX_E);
  readonly eg = new Int8Array(MAX_E);
  readonly eslot = new Int8Array(MAX_E);
  readonly esec = new Int32Array(MAX_E);
  readonly grpAng = new Float32Array(MAX_GRP);
  private gcount = 0;

  // ---- bullets
  readonly bx = new Float32Array(MAX_B);
  readonly by = new Float32Array(MAX_B);
  readonly bvx = new Float32Array(MAX_B);
  readonly bvy = new Float32Array(MAX_B);
  readonly blife = new Float32Array(MAX_B);
  readonly bdmg = new Float32Array(MAX_B);
  readonly bown = new Uint8Array(MAX_B);
  readonly btype = new Uint8Array(MAX_B);
  private bcur = 0;

  // ---- particles
  readonly px = new Float32Array(MAX_P);
  readonly py = new Float32Array(MAX_P);
  readonly pvx = new Float32Array(MAX_P);
  readonly pvy = new Float32Array(MAX_P);
  readonly plife = new Float32Array(MAX_P);
  readonly pmax = new Float32Array(MAX_P);
  readonly pkind = new Uint8Array(MAX_P);
  readonly pcol = new Uint8Array(MAX_P);
  readonly psize = new Float32Array(MAX_P);
  private pcur = 0;

  // ---- shockwave rings
  readonly rx = new Float32Array(MAX_R);
  readonly ry = new Float32Array(MAX_R);
  readonly rrad = new Float32Array(MAX_R);
  readonly rmax = new Float32Array(MAX_R);
  readonly rlife = new Float32Array(MAX_R);
  readonly rcol = new Uint8Array(MAX_R);
  private rcur = 0;

  // ---- planets near the ship (rebuilt every tick)
  readonly pl = new Float32Array(MAX_PLANETS * PLANET_STRIDE);
  nPl = 0;

  // ---- event ring (drained by audio/juice in main; oldest dropped if unread)
  readonly evT = new Uint8Array(256);
  readonly evX = new Float32Array(256);
  readonly evY = new Float32Array(256);
  readonly evM = new Float32Array(256);
  evHead = 0; evTail = 0;
  hitAng = 0; hitT = 0;
  readonly echarge = new Float32Array(MAX_E);

  emit(t: number, x: number, y: number, m: number): void {
    const i = this.evHead & 255;
    this.evT[i] = t; this.evX[i] = x; this.evY[i] = y; this.evM[i] = m;
    this.evHead++;
    if (this.evHead - this.evTail > 256) this.evTail = this.evHead - 256;
  }

  // ---- stats
  nEnt = 0; nEnemy = 0; nBul = 0; nPar = 0; nAst = 0;

  private readonly hash = new SpatialHash(MAX_E, HASH_CELL);
  private fx = 0; private fy = 0;
  private spawnCd = 6;
  private readonly loaded = new Int32Array(32);   // sector pairs
  private nLoaded = 0;
  private lastSx = 0x7fffffff; private lastSy = 0x7fffffff;
  private depth = 0;

  constructor(seed = 1) { this.reset(seed); }

  reset(seed = 1): void {
    this.rng.s = seed >>> 0; this.time = 0; this.tick = 0; this.score = 0; this.kills = 0;
    this.shake = 0; this.flash = 0; this.input = 0;
    this.alive = true; this.deadT = 0;
    this.sx = 0; this.sy = 0; this.svx = 0; this.svy = 0; this.sa = 0.3; this.spx = 0; this.spy = 0; this.spa = 0.3;
    this.refreshShip(); this.hp = this.hpMax; this.boostE = this.boostMax; this.cool = 0; this.dashCd = 0; this.dashN = this.ship.dashCharges; this.dashLock = 0; this.shield = this.ship.shieldMax; this.energy = this.ship.energyMax; this.fuel = this.fuelMax; this.cruise = false; this.jumpT = 0; this.scanP = 0; this.scanIdx = -1; this.dist = 0; this.cargoBy.fill(0); this.cargoUsed = 0; this.poiDone.fill(0); this.heat = 0; this.overheat = false; this.firedT = 0; this.wingCd = 3; this.nWing = 0; this.shots = 0; this.hits = 0; this.scrapTotal = 0;
    this.objKills = 0; this.objTarget = 6; this.objTier = 0; this.nextBoss = 150; this.frIdx = -1; this.escortFails = 0; this.sw = 0;
    this.wasBoost = false; this.warn = 0; this.warnT = 0; this.flare = 0; this.storm = 0; this.flareT = 0; this.stormT = 0; this.ecl = 0; this.mega = 0; this.eclT = 0; this.megaT = 0; this.meteorLeft = 0; this.evtNext = 40; this.lastEvt = 0; this.haulCd = 45; this.scl.fill(0); this.dockable = -1; this.nBoss = 0;
    this.caches.clear(); this.slowT = 0; this.bossKills = 0; this.missiles = this.missileCap; this.missileCd = 0; this.mlife.fill(0); this.eshield.fill(0);
    this.cool = 0; this.lastHit = -99; this.invuln = 2; this.hitFlash = 0; this.sz = this.spz = 0; this.szBand = 0; this.prevIn = 0; this.ez.fill(0); this.eband.fill(0);
    this.evHead = this.evTail = 0; this.hitT = 0; this.echarge.fill(0);
    this.ek.fill(0); this.blife.fill(0); this.plife.fill(0); this.rlife.fill(0);
    this.nLoaded = 0; this.lastSx = this.lastSy = 0x7fffffff; this.spawnCd = 6; this.gcount = 0;
  }

  // ===================================================================== step
  /** Per-system step timings (ms, smoothed); only measured while profOn (the ?perf=1 overlay turns it on). */
  readonly prof = new Float64Array(PROF_NAMES.length);
  profOn = false;
  private lap(i: number, t: number): number { const n = performance.now(); this.prof[i] += (n - t - this.prof[i]) * 0.05; return n; }

  step(): void {
    const P = this.profOn; let t = P ? performance.now() : 0;
    this.time += DT; this.tick++;
    this.nPl = planetsNear(this.sx, this.sy, 380, this.pl, this.time);
    if (this.alive) this.updateShip(); else this.deadT += DT;
    if (P) t = this.lap(0, t);
    this.streamSectors();
    this.director();
    this.updateEvents();
    if (P) t = this.lap(1, t);
    this.rebuildHash();
    this.updateEnts();
    if (P) t = this.lap(2, t);
    this.updateBullets();
    if (P) t = this.lap(3, t);
    this.updateScrap();
    if (this.alive) { this.objProgress(3, DT); if (this.stationNear) this.objProgress(4, DT); }
    this.updateMissiles();
    if (this.slowT > 0) this.slowT -= DT;
    if (this.alive) { this.shipVsEnts(); this.findDock(); }
    if (P) t = this.lap(4, t);
    this.updateParticles();
    if (P) t = this.lap(5, t);
    this.shake *= Math.exp(-5.5 * DT);
    this.flash *= Math.exp(-7 * DT);
    this.hitFlash *= Math.exp(-6 * DT);
    this.hitT = Math.max(0, this.hitT - DT * 1.1);
    if (this.invuln > 0) this.invuln -= DT;
  }

  // ===================================================================== ship
  private updateShip(): void {
    const inp = this.input, S = this.ship, R = S.radius, rk = R / 2.4, mk = S.mass / 100;
    this.spx = this.sx; this.spy = this.sy; this.spa = this.sa;
    let turn = 0;
    if (inp & In.Left) turn += 1;
    if (inp & In.Right) turn -= 1;
    this.boostMax = S.boostCap;
    if (this.aimOn) { this.sw = 0; const tr = S.turnRate * FLIGHT.AIM_TURN_K, da = wrapAngle(this.aimAng - this.sa); this.sa += clamp(da * 8, -tr * DT * 1.15, tr * DT * 1.15); }
    else {
      if (turn !== 0) this.sw = clamp(this.sw + turn * S.turnAccel * DT, -S.turnRate, S.turnRate);
      else this.sw = Math.abs(this.sw) < 1e-4 ? 0 : this.sw * Math.exp(-S.turnAccel * FLIGHT.TURN_DECAY_K * DT);
      this.sa += this.sw * DT;
    }
    this.dashCd -= DT; this.dashLock -= DT;
    this.spz = this.sz;
    if (this.vert) this.updateAltitude(S, inp);
    this.prevIn = inp;
    const ca = Math.cos(this.sa), sa = Math.sin(this.sa);

    this.thrusting = false; this.boosting = false;
    if ((inp & In.Cruise) && !(this.prevCruiseIn)) this.toggleCruise();
    this.prevCruiseIn = (inp & In.Cruise) !== 0;
    if (inp & In.Thrust) {
      let a = S.thrustFwd / S.mass;
      if (this.fuel <= 0) a *= 0.3;                                          // dry tanks: thrusters on reserve
      else if ((inp & In.Boost) && this.boostE > 1 && !this.cruise) { a *= S.boostMult; this.boostE -= S.boostDrain * DT; this.boosting = true; }
      if (this.cruise) a *= 3;
      if (this.fuel > 0) this.fuel = Math.max(0, this.fuel - S.fuelBurn * DT * (this.boosting ? 2 : 1) * (this.cruise ? 1.5 : 1));
      this.svx += ca * a * DT; this.svy += sa * a * DT;
      this.thrusting = true;
    }
    const strafe = ((inp & In.StrafeL) ? 1 : 0) - ((inp & In.StrafeR) ? 1 : 0);
    if (strafe !== 0) { const a = S.thrustLat / S.mass * strafe; this.svx -= sa * a * DT; this.svy += ca * a * DT; }
    if (this.boosting && !this.wasBoost && this.boostE > 15) this.ring(this.sx, this.sy, 12, Col.Cyan);
    this.wasBoost = this.boosting;
    if (!this.boosting) this.boostE = Math.min(this.boostMax, this.boostE + S.boostRegen * DT * (1 - 0.7 * (this.vert && this.sz < -V_TOL ? 0 : this.storm)));
    if (S.dashCharges <= 1) {
      if ((inp & In.Dodge) && this.dashCd <= 0) this.dash(ca, sa, S.dashCooldown);
    } else {                                                   // multi-charge dash: charges refill one per cooldown
      if (this.dashCd <= 0 && this.dashN < S.dashCharges) { this.dashN++; this.dashCd = this.dashN < S.dashCharges ? S.dashCooldown : 0; }
      if ((inp & In.Dodge) && this.dashN > 0 && this.dashLock <= 0) { this.dashN--; this.dashLock = 0.25; this.dash(ca, sa, this.dashCd > 0 ? this.dashCd : S.dashCooldown); }
    }
    this.missileCd -= DT;
    this.missiles = Math.min(this.missileCap, this.missiles + DT / 7);
    if ((inp & In.Missile) && this.missileCd <= 0 && this.missiles >= 1) this.launchMissile(ca, sa);
    {   // grip: bleed sideways velocity and hand part of it to the nose, so turns bend the path
      const vf = this.svx * ca + this.svy * sa, vl = -this.svx * sa + this.svy * ca;
      const lat = vl * Math.exp(-(this.thrusting ? S.grip : S.grip * FLIGHT.GRIP_COAST_K) * DT), nf = vf + Math.abs(vl - lat) * FLIGHT.GRIP_FWD;
      this.svx = ca * nf - sa * lat; this.svy = sa * nf + ca * lat;
    }
    if (this.assist && !(inp & In.Thrust)) { const k2 = Math.exp(-S.assist * DT); this.svx *= k2; this.svy *= k2; }
    if (inp & In.Brake) {
      const k = Math.exp(-S.brake * DT); this.svx *= k; this.svy *= k;
      if (S.thrustRev > 0 && this.svx * this.svx + this.svy * this.svy < 16) { const a = S.thrustRev / S.mass; this.svx -= ca * a * DT; this.svy -= sa * a * DT; }
    }
    const drag = Math.exp(-FLIGHT.DRAG * DT);
    this.svx *= drag; this.svy *= drag;

    // planet gravity + collision
    for (let k = 0; k < this.nPl; k++) {
      const o = k * PLANET_STRIDE;
      const dx = this.pl[o] - this.sx, dy = this.pl[o + 1] - this.sy, r = this.pl[o + 2];
      const d = Math.sqrt(dx * dx + dy * dy) + 1e-4;
      const reach = gravReach(r);
      if (d < r + reach) {
        const fall = 1 - Math.max(0, d - r) / reach;
        const g = GRAV_K * fall * S.gravSusceptibility;
        this.svx += dx / d * g * DT; this.svy += dy / d * g * DT;
      }
      if (this.vert && this.sz > V_TOL) continue;                // High band flies over planets: no pull, no collision
      if (this.vert && this.sz < -V_TOL && d < r + R + 16) {     // Low band in the atmosphere: drag, heat, cover
        const kd = Math.exp(-0.7 * DT); this.svx *= kd; this.svy *= kd; this.heat += 16 * DT; this.lowCover = 1;
      }
      if (d > r + R && d < r + R + 7 && (this.svx * this.svx + this.svy * this.svy) > 900) {   // atmosphere skim: speed boost, heat
        const k3 = 1 + 0.35 * DT; this.svx *= k3; this.svy *= k3;
        this.hp = Math.max(1, this.hp - 3 * DT);
        if (this.pl[o + 3] === 1 && (!this.vert || this.sz < -V_TOL)) { this.fuel = Math.min(this.fuelMax, this.fuel + 9 * DT); this.scooping = 0.2; }   // gas giant fuel scoop
        if ((this.tick & 3) === 0) this.sparks(this.sx, this.sy, 1, Col.Fire, 30);
      }
      if (d < r + R) {
        const nx = -dx / d, ny = -dy / d;                // outward normal
        this.sx = this.pl[o] + nx * (r + R); this.sy = this.pl[o + 1] + ny * (r + R);
        const vn = this.svx * nx + this.svy * ny;
        if (vn < 0) {
          this.svx -= 1.6 * vn * nx; this.svy -= 1.6 * vn * ny;
          if (-vn > 22) { this.damageShip((-vn - 22) * 0.45, nx, ny); this.sparks(this.sx, this.sy, 10, Col.Amber, 40); }
        }
      }
    }

    const sp = Math.sqrt(this.svx * this.svx + this.svy * this.svy);
    const maxS = this.cruise ? S.maxSpeed * 4 : this.boosting ? S.maxSpeed * FLIGHT.BOOST_TOP_K : S.maxSpeed;
    if (sp > maxS) { const f = 1 - FLIGHT.SPEED_CAP_K * DT * (1 - maxS / sp); this.svx *= f; this.svy *= f; }
    this.sx += this.svx * DT; this.sy += this.svy * DT;
    this.dist += Math.sqrt(this.svx * this.svx + this.svy * this.svy) * DT;
    this.updateExplore(S, inp);

    // weapons: one bolt per cooldown from the next hardpoint (fixed fire along the nose, turrets track the nearest hostile)
    this.assistTarget = this.aimAssist === 2 ? this.findAimTarget(this.sx, this.sy, this.sa, AIM_ASSIST.B_CONE, AIM_ASSIST.B_RANGE)
      : this.aimAssist === 3 ? this.findAimTarget(this.sx, this.sy, this.sa, AIM_ASSIST.C_CONE, AIM_ASSIST.C_RANGE) : -1;
    this.cool -= DT;
    const nhp = S.hardpoints.length;
    if ((inp & In.Fire) && this.cool <= 0 && !this.overheat && this.energy >= 1 && !this.cruise && this.jumpT <= 0) {
      this.energy -= 1; this.heat += FLIGHT.SHOT_HEAT; this.firedT = 0.6;
      this.cool = FLIGHT.FIRE_COOL * 2 / nhp / S.fireRateMult; this.shots++;
      this.gunSide = -this.gunSide;
      this.hpIdx = (this.hpIdx + 1) % nhp;
      const turret = S.hardpoints[this.hpIdx] === 'turret', lat = S.muzzle ? S.muzzle[this.hpIdx] ?? 0 : 0;
      const jit = (this.rng.next() - 0.5) * S.spread;
      const fwd = FLIGHT.MUZZLE * rk, ox = this.sx + ca * fwd - sa * lat, oy = this.sy + sa * fwd + ca * lat;
      let ba = this.sa + jit;
      if (turret) {
        const tg = this.findAimTarget(ox, oy, this.sa, Math.PI, 240);
        if (tg >= 0) { const dx = this.ex[tg] - ox, dy = this.ey[tg] - oy, tt = Math.sqrt(dx * dx + dy * dy) / FLIGHT.BOLT_SPEED; ba = Math.atan2(dy + (this.evy[tg] - this.svy * 0.5) * tt, dx + (this.evx[tg] - this.svx * 0.5) * tt) + jit; }
      } else if (this.aimAssist === 2) {
        const tg = this.findAimTarget(ox, oy, this.sa, AIM_ASSIST.B_CONE, AIM_ASSIST.B_RANGE);
        if (tg >= 0) {
          const dx = this.ex[tg] - ox, dy = this.ey[tg] - oy, tt = Math.sqrt(dx * dx + dy * dy) / 215;
          const lx = this.ex[tg] + (this.evx[tg] - this.svx * 0.5) * tt, ly = this.ey[tg] + (this.evy[tg] - this.svy * 0.5) * tt;
          const off = Math.abs(wrapAngle(Math.atan2(dy, dx) - this.sa));
          const w = off <= AIM_ASSIST.B_FULL ? 1 : 1 - (off - AIM_ASSIST.B_FULL) / (AIM_ASSIST.B_CONE - AIM_ASSIST.B_FULL);
          ba += clamp(wrapAngle(Math.atan2(ly - oy, lx - ox) - ba), -AIM_ASSIST.B_CONE, AIM_ASSIST.B_CONE) * w;   // never bend more than the cone, even for a fast crosser
        }
      }
      const bc = Math.cos(ba), bs = Math.sin(ba), bsp = FLIGHT.BOLT_SPEED * S.boltSpeedMult;
      this.shotZ = this.sz;
      const dm = S.damageMult;
      this.spawnBullet(ox, oy, this.svx * 0.5 + bc * bsp, this.svy * 0.5 + bs * bsp, 1.05, 0, dm);
      if (this.up[Up.Spread] > 0) for (let sd = -1; sd <= 1; sd += 2) {
        const sa2 = ba + sd * 0.13, ssp = FLIGHT.SIDE_SPEED * S.boltSpeedMult;
        this.spawnBullet(ox, oy, this.svx * 0.5 + Math.cos(sa2) * ssp, this.svy * 0.5 + Math.sin(sa2) * ssp, 0.9, 0, dm * 0.5 + 0.1 * this.up[Up.Spread]);
      }
      this.svx -= ca * FLIGHT.KICK / mk; this.svy -= sa * FLIGHT.KICK / mk;
      this.muzzleT = 0.06;
      this.emit(Ev.PlayerShot, ox, oy, 1);
    }
    if (this.muzzleT > 0) this.muzzleT -= DT;
    this.updatePower(S);

    // exhaust
    if (this.thrusting) {
      const n = this.boosting ? 3 : 2;
      for (let i = 0; i < n; i++) {
        const spread = (this.rng.next() - 0.5) * 0.35;
        const ea = this.sa + Math.PI + spread, v = 38 + this.rng.next() * 30 + (this.boosting ? 30 : 0);
        const side = (this.rng.next() < 0.5 ? 2.0 : -2.0) * rk;
        const tx = this.sx - ca * (7.4 + this.rng.next() * 2) * rk - sa * side, ty = this.sy - sa * (7.4 + this.rng.next() * 2) * rk + ca * side;
        this.spawnParticle(tx, ty, this.svx * 0.55 + Math.cos(ea) * v, this.svy * 0.55 + Math.sin(ea) * v,
          0.36 + this.rng.next() * 0.5, PK.Exhaust, this.boosting ? Col.Cyan : Col.Fire, 1);
      }
      if (this.boosting && (this.tick & 1) === 0)            // long glowing boost wake that hangs in space
        this.spawnParticle(this.sx - ca * 8 * rk, this.sy - sa * 8 * rk, this.svx * 0.9 + (this.rng.next() - 0.5) * 6, this.svy * 0.9 + (this.rng.next() - 0.5) * 6, 0.9 + this.rng.next() * 0.5, PK.Exhaust, Col.Cyan, 1);
    }
    if (this.hp < 35 && (this.tick & 3) === 0) {
      this.spawnParticle(this.sx + (this.rng.next() - 0.5) * 6, this.sy + (this.rng.next() - 0.5) * 3, this.svx * 0.8, this.svy * 0.8 + 6, 0.8 + this.rng.next() * 0.6, PK.Smoke, Col.Gray, 1);
      if (this.rng.next() < 0.18) this.sparks(this.sx, this.sy, 2, Col.Amber, 30);
    }
    if (this.hp < 22 && (this.tick & 1) === 0) {            // hull breach: atmosphere vents in a pulsing jet from the port wing
      const ca = Math.cos(this.sa), sa = Math.sin(this.sa), pulse = 0.5 + 0.5 * Math.sin(this.time * 7);
      const vx = this.sx - ca * 1.5 + sa * 2.2, vy = this.sy - sa * 1.5 - ca * 2.2, v = 22 + 30 * pulse;
      this.spawnParticle(vx, vy, this.svx * 0.6 + sa * v + (this.rng.next() - 0.5) * 8, this.svy * 0.6 - ca * v + (this.rng.next() - 0.5) * 8, 0.35 + this.rng.next() * 0.35, PK.Exhaust, Col.Cyan, 1);
    }
    if (this.time - this.lastHit > S.hullRegenDelay && this.hp < this.hpMax) this.hp = Math.min(this.hpMax, this.hp + S.hullRegen * DT);
  }

  /** Energy, heat, shields, signature and the hull-specific quirks that tick every frame. */
  private updatePower(S: ShipDef): void {
    this.energy = Math.min(S.energyMax, this.energy + S.energyRegen * DT);
    if (this.hotSys && this.sx * this.sx + this.sy * this.sy < 1100 * 1100) this.heat += 6 * DT;      // close to a hot star
    if (this.radiation > 0) this.hurt(this.radiation * DT, Dmg.Em);
    if (this.boosting) this.heat += FLIGHT.BOOST_HEAT * DT;
    this.heat = Math.max(0, this.heat - S.heatDissipation * DT);
    if (this.heat > S.heatMax) { this.overheat = true; this.heat = Math.min(this.heat, S.heatMax * 1.25); this.hurt((this.heat - S.heatMax) * 0.4 * DT + 2 * DT, Dmg.Thermal); }
    else if (this.overheat && this.heat < S.heatMax * 0.5) this.overheat = false;
    const stormHere = Math.max(this.storm, this.zoneStorm) > 0.3 && (!this.vert || this.sz > -V_TOL);   // storms reach Mid and High only
    if (stormHere) this.shield = 0;                                           // ion storms knock shields out
    else if (this.time - this.lastHit > S.shieldDelay) this.shield = Math.min(S.shieldMax, this.shield + S.shieldRegen * DT);
    this.firedT -= DT;
    let sig = S.signature * (this.thrusting ? 1 : 0.7) * (this.boosting ? 1.6 : 1) * (this.firedT > 0 ? 1.3 : 1);
    if (S.darkSig < 1 && !this.thrusting && this.firedT <= 0) sig = S.signature * S.darkSig;        // Shade running dark
    this.sigNow = sig * this.sigMod * (this.lowCover > 0 ? 0.4 : 1);
    this.lowCover = 0;
    if (S.darkSig < 1 && (this.tick & 3) === 0 && this.svx * this.svx + this.svy * this.svy > 400)   // ghost trail
      this.spawnParticle(this.sx - Math.cos(this.sa) * 4, this.sy - Math.sin(this.sa) * 4, this.svx * 0.2, this.svy * 0.2, 0.9, PK.Smoke, Col.Magenta, 1);
    if (S.wingmen > 0) this.updateWingLaunch(S);
  }
  /** Verticality experiment (M4): altitude bands on. Everything below is inert (z = 0) when off. */
  vert = false;
  /** Player altitude (continuous), previous-tick altitude (render interpolation) and target band. */
  sz = 0; spz = 0; szBand = 0; private prevIn = 0;
  readonly ez = new Float32Array(MAX_E);
  readonly eband = new Int8Array(MAX_E);
  readonly bz = new Float32Array(MAX_B);
  /** Environmental multiplier on signature (planet shadow / low band set by M4-M5 systems). */
  sigMod = 1;

  private lowCover = 0; private prevCruiseIn = false; scooping = 0;

  /** Cruise: time-compressed in-system travel. Only with no hostiles near; anything interesting interrupts it. */
  toggleCruise(): void {
    if (this.cruise) { this.cruise = false; this.emit(Ev.Cruise, this.sx, this.sy, 0); return; }
    if (!this.alive || this.hostileNear(320) || this.jumpT > 0) return;
    this.cruise = true; this.emit(Ev.Cruise, this.sx, this.sy, 1);
  }
  private hostileNear(r: number): boolean {
    for (let i = 0; i < MAX_E; i++) {
      const k = this.ek[i]; if (!this.isAimTarget(k)) continue;
      const dx = this.ex[i] - this.sx, dy = this.ey[i] - this.sy; if (dx * dx + dy * dy < r * r) return true;
    }
    return false;
  }
  /** Begin charging the jump drive (the exploration layer checks range and fuel first). */
  startJump(charge: number): void { if (this.alive && this.jumpT <= 0) { this.jumpT = this.jumpLen = charge; this.cruise = false; } }

  /** Scanning, cruise interruptions, jump charge, POI triggers and hazards. */
  private updateExplore(S: ShipDef, inp: number): void {
    if (this.scooping > 0) this.scooping -= DT;
    // ---- scan: hold the key; nearest unscanned candidate in sensor range; nebulae and ion storms halve the speed
    this.scanCd -= DT;
    let best = -1, bd = this.sensorR;
    if ((inp & In.Scan) && this.scanCd <= 0) for (let c = 0; c < this.nScan; c++) {
      const d = Math.hypot(this.scanList[c * 3] - this.sx, this.scanList[c * 3 + 1] - this.sy) - this.scanList[c * 3 + 2];
      if (d < bd) { bd = d; best = c; }
    }
    if (best >= 0) {
      if (best !== this.scanIdx) { this.scanIdx = best; this.scanP = 0; }
      const jam = (nebulaAt(sectorOf(this.sx), sectorOf(this.sy)) > 0.5 || Math.max(this.storm, this.zoneStorm) > 0.3) && S.nebulaScan < 1 ? 0.5 : 1;
      this.scanP += DT * S.scanRate * jam / 2.5;
      if (this.scanP >= 1) { this.emit(Ev.Scan, this.scanList[best * 3], this.scanList[best * 3 + 1], best); this.scanP = 0; this.scanIdx = -1; this.scanCd = 0.8; }
    } else { this.scanP = Math.max(0, this.scanP - DT * 2); if (this.scanP === 0) this.scanIdx = -1; }
    // ---- cruise interruptions: hostiles, gravity wells
    if (this.cruise && ((this.tick & 7) === 0 && this.hostileNear(320) || this.nearWell())) { this.cruise = false; this.emit(Ev.Cruise, this.sx, this.sy, 0); }
    // ---- jump charge
    if (this.jumpT > 0) { this.jumpT -= DT; if (this.jumpT <= 0) { this.jumpT = 0; this.emit(Ev.Jump, this.sx, this.sy, 1); } }
    // ---- points of interest: trigger once on approach; pulsars irradiate, ion storms knock out shields
    this.radiation = 0; this.zoneStorm = 0;
    for (let p = 0; p < this.nPoi; p++) {
      const dx = this.poiX[p] - this.sx, dy = this.poiY[p] - this.sy, d = Math.sqrt(dx * dx + dy * dy), k = this.poiK[p];
      if (k === 2 && d < 320) this.radiation = Math.max(this.radiation, 12 * (1 - d / 320));
      if (k === 5 && d < 420) this.zoneStorm = Math.max(this.zoneStorm, Math.min(1, (420 - d) / 120));
      if (this.cruise && d < 180) { this.cruise = false; this.emit(Ev.Cruise, this.sx, this.sy, 0); }
      if (this.poiDone[p]) continue;
      const reach = k === 1 ? 140 : k === 4 ? 14 : k === 9 ? 1500 : k === 7 || k === 8 ? 700 : k === 6 ? 600 : 80;
      if (d < reach) { this.poiDone[p] = 1; this.triggerPoi(p, k); }
    }
  }
  private nearWell(): boolean {
    for (let k = 0; k < this.nPl; k++) { const o = k * PLANET_STRIDE, dx = this.pl[o] - this.sx, dy = this.pl[o + 1] - this.sy, r = this.pl[o + 2]; if (Math.sqrt(dx * dx + dy * dy) < r + gravReach(r) * 0.6) return true; }
    return false;
  }
  /** Sim-side consequences of reaching a POI; the exploration layer adds rewards, lore and news on Ev.Poi. */
  private triggerPoi(p: number, k: number): void {
    const x = this.poiX[p], y = this.poiY[p], sd = this.poiS[p];
    this.emit(k === 4 ? Ev.Wormhole : Ev.Poi, x, y, p);
    if (k === 0) {                                                            // distress beacon: a cache, sometimes an ambush
      for (let i = 0; i < 5; i++) { this.spawnScrap(x + (this.rng.next() - 0.5) * 16, y + (this.rng.next() - 0.5) * 10, i === 4 ? 25 : 8, i === 4 ? 1 : 0); this.scl[(this.scur + MAX_S - 1) % MAX_S] = 1e6; }
      if (sd < 0.5) for (let i = 0; i < 3; i++) { const e = this.spawnEnt(Kind.Drone, x + 60 + i * 8, y + 40, 0, 0); if (e >= 0) this.es[e] = St.Chase; }
    } else if (k === 1) {                                                     // derelict: salvage along the hull
      for (let i = 0; i < 8; i++) { this.spawnScrap(x + (i - 4) * 22, y + (this.rng.next() - 0.5) * 20, 10, 0); this.scl[(this.scur + MAX_S - 1) % MAX_S] = 1e6; }
    } else if (k === 6) {                                                     // ore-rich belt: dense rocks that drop extra scrap
      for (let i = 0; i < 26; i++) {
        const a = this.rng.next() * TAU, d = Math.sqrt(this.rng.next()) * 120;
        const e = this.spawnEnt(Kind.Asteroid, x + Math.cos(a) * d, y + Math.sin(a) * d * 0.7, 0, 0);
        if (e < 0) break;
        const size = this.rng.next() < 0.4 ? 3 : 2; this.eaux[e] = size; this.er[e] = AST_R[size]; this.ehp[e] = size * 2.5; this.esec[e] = ORE_TAG;
      }
    } else if (k === 7) {                                                     // comet crossing
      const c = this.spawnEnt(Kind.Comet, x, y, 0, 0);
      if (c >= 0) { const dx = this.sx - x, dy = this.sy - y, l = Math.hypot(dx, dy) + 1e-6; this.evx[c] = dx / l * 70; this.evy[c] = dy / l * 70; this.ea[c] = Math.atan2(dy, dx); this.ehp[c] = 1e9; this.et[c] = 0; }
    } else if (k === 8) {                                                     // nomad fleet: a slow convoy
      for (let i = 0; i < 4; i++) { const h = this.spawnEnt(Kind.Hauler, x + i * 22, y + (i & 1) * 12, 12, 2); if (h >= 0) this.eseed[h] = i; }
    } else if (k === 9 && this.mega <= 0 && this.warn === 0) this.triggerEvent(6);
  }

  /** Jump arrival / new system: clear the local world, keep the ship and the run. */
  enterSystem(): void {
    for (let e = 0; e < MAX_E; e++) this.ek[e] = Kind.None;
    this.blife.fill(0); this.mlife.fill(0); this.scl.fill(0); this.caches.clear();
    this.nLoaded = 0; this.lastSx = this.lastSy = 0x7fffffff; this.spawnCd = 8; this.frIdx = -1;
    this.sx = this.spx = -260; this.sy = this.spy = -40; this.svx = 30; this.svy = 0; this.sa = this.spa = 0; this.sw = 0;
    this.cruise = false; this.jumpT = 0; this.scanP = 0; this.scanIdx = -1; this.nPoi = 0; this.poiDone.fill(0); this.nScan = 0;
    this.invuln = Math.max(this.invuln, 2); this.warn = 0;
    this.nPl = planetsNear(this.sx, this.sy, 380, this.pl, this.time);
  }
  setPoi(i: number, x: number, y: number, kind: number, seed: number): void {
    if (i >= MAX_POI) return;
    this.poiX[i] = x; this.poiY[i] = y; this.poiK[i] = kind; this.poiS[i] = seed; this.poiDone[i] = 0; this.nPoi = Math.max(this.nPoi, i + 1);
  }
  /** Band changes are edge-triggered and animate at climbRate bands per second; rings at Mid chip the hull. */
  private updateAltitude(S: ShipDef, inp: number): void {
    const nb = S.altitudeBands, lo = nb >= 3 ? -1 : 0, hi = nb >= 2 ? 1 : 0;
    if ((inp & In.Climb) && !(this.prevIn & In.Climb)) this.szBand = Math.min(hi, this.szBand + 1);
    if ((inp & In.Dive) && !(this.prevIn & In.Dive)) this.szBand = Math.max(lo, this.szBand - 1);
    if (this.szBand < lo || this.szBand > hi) this.szBand = 0;
    const step = Math.max(0, S.climbRate) * DT, dz = this.szBand - this.sz;
    this.sz = Math.abs(dz) <= step ? this.szBand : this.sz + Math.sign(dz) * step;
    if (Math.abs(this.sz) < V_TOL) {                         // planetary rings sit at Mid: flying through them hurts
      for (let k = 0; k < this.nPl; k++) {
        const o = k * PLANET_STRIDE; if (this.pl[o + 5] < 0.5) continue;
        const R = this.pl[o + 2], ex = (this.sx - this.pl[o]) / R, ey = (this.sy - this.pl[o + 1]) / R, ra = this.pl[o + 4] * Math.PI, c = Math.cos(ra), sn = Math.sin(ra);
        const vx = ex * c + ey * sn, vy = (-ex * sn + ey * c) / 0.30, rd = Math.sqrt(vx * vx + vy * vy);
        if (rd > 1.5 && rd < 2.38) { this.hurt(5 * DT, Dmg.Kinetic); if ((this.tick & 3) === 0) this.sparks(this.sx, this.sy, 1, Col.Gray, 30); }
      }
    }
  }
  /** Enemy band choice: match the player's band to attack, move off it to flee, drift in patrol. */
  private updateEnemyBand(i: number, kind: number, st: number): void {
    if (kind === Kind.Asteroid || kind === Kind.Mine || kind === Kind.Station || kind === Kind.Comet) return;
    let want = this.eband[i];
    if (kind === Kind.Wing) want = this.szBand;
    else if (st === St.Attack || st === St.Chase) want = this.szBand;
    else if (st === St.Flee) want = this.szBand === 0 ? ((this.eseed[i] | 0) & 1 ? 1 : -1) : 0;
    this.eband[i] = want;
    const rate = (kind === Kind.Boss ? 0.6 : kind === Kind.Rammer || kind === Kind.Drone ? 2.2 : 1.4) * DT, dz = want - this.ez[i];
    this.ez[i] = Math.abs(dz) <= rate ? want : this.ez[i] + Math.sign(dz) * rate;
  }

  /** Trade: add (or with negative n remove) units of a commodity, bounded by the hold. Returns units actually moved. */
  moveCargo(c: number, n: number): number {
    const room = this.ship.cargo - this.cargoUsed;
    const m = n > 0 ? Math.min(n, Math.floor(room)) : -Math.min(-n, this.cargoBy[c]);
    this.cargoBy[c] += m; this.cargoUsed += m; return m;
  }

  /** Hive: launch a wingman from a bay while hostiles are near, one per cooldown, up to ShipDef.wingmen. */
  private updateWingLaunch(S: ShipDef): void {
    this.wingCd -= DT;
    if (this.wingCd > 0 || this.nWing >= S.wingmen || this.nEnemy === 0) return;
    const e = this.spawnEnt(Kind.Wing, this.sx - Math.cos(this.sa) * 6, this.sy - Math.sin(this.sa) * 6, this.svx - Math.cos(this.sa) * 30, this.svy - Math.sin(this.sa) * 30);
    if (e < 0) return;
    this.et[e] = 25; this.eaux[e] = this.nWing; this.ehp[e] = 1e9; this.wingCd = 6; this.nWing++;
    this.ring(this.ex[e], this.ey[e], 6, Col.Green);
  }

  /** Friendly drone: orbits the player, dives at the nearest hostile and shoots it. Lives 25 s. */
  private updateWing(i: number): void {
    this.et[i] -= DT; this.et2[i] -= DT;
    if (this.et[i] <= 0 || !this.alive) { this.ek[i] = Kind.None; this.sparks(this.ex[i], this.ey[i], 6, Col.Green, 30); return; }
    const x = this.ex[i], y = this.ey[i];
    const tg = this.findAimTarget(x, y, this.ea[i], Math.PI, 200);
    let tx: number, ty: number;
    if (tg >= 0) { const a = this.time * 2 + this.eaux[i] * 2.1; tx = this.ex[tg] + Math.cos(a) * 26; ty = this.ey[tg] + Math.sin(a) * 26; }
    else { const a = this.time * 1.4 + this.eaux[i] * 2.1; tx = this.sx + Math.cos(a) * 16; ty = this.sy + Math.sin(a) * 16; }
    this.fx = 0; this.fy = 0;
    this.arrive(i, tx, ty, KIND_SPEED[Kind.Wing], 20, 2);
    const fm = Math.hypot(this.fx, this.fy), acc = KIND_ACCEL[Kind.Wing];
    if (fm > acc) { this.fx *= acc / fm; this.fy *= acc / fm; }
    this.evx[i] += this.fx * DT; this.evy[i] += this.fy * DT;
    this.ex[i] += this.evx[i] * DT; this.ey[i] += this.evy[i] * DT;
    const fa = tg >= 0 ? Math.atan2(this.ey[tg] - y, this.ex[tg] - x) : Math.atan2(this.evy[i], this.evx[i]);
    this.ea[i] += wrapAngle(fa - this.ea[i]) * Math.min(1, 8 * DT);
    if (tg >= 0 && this.et2[i] <= 0 && Math.abs(wrapAngle(fa - this.ea[i])) < 0.3) {
      this.et2[i] = 0.45;
      const c = Math.cos(this.ea[i]), sn = Math.sin(this.ea[i]);
      this.shotZ = this.ez[i];
      this.spawnBullet(x + c * 2, y + sn * 2, this.evx[i] * 0.5 + c * 200, this.evy[i] * 0.5 + sn * 200, 0.9, 0, 0.6 * this.ship.damageMult);
    }
  }

  private dash(ca: number, sa: number, cd: number): void {
    const S = this.ship;
    this.dashCd = cd; this.invuln = Math.max(this.invuln, S.dashIFrames); this.ring(this.sx, this.sy, 16, Col.Cyan);
    this.svx += ca * S.dashImpulse; this.svy += sa * S.dashImpulse; this.emit(Ev.Dash, this.sx, this.sy, 1);
    this.sparks(this.sx - ca * 6, this.sy - sa * 6, 10, Col.Cyan, 50);
  }

  /** Incoming damage: resist by type, flat armour (never below 25%), shields first, Mule cargo soak, then hull. */
  damageShip(d: number, nx: number, ny: number, type: number = Dmg.Kinetic): void {
    if (this.invuln > 0 || !this.alive) return;
    if (this.hard) d *= 1.3;
    const S = this.ship;
    d *= 1 - (type === Dmg.Kinetic ? S.resist.kinetic : type === Dmg.Thermal ? S.resist.thermal : S.resist.em);
    d = Math.max(d * 0.25, d - S.armor);
    if (this.shield > 0) { const a = Math.min(this.shield, d); this.shield -= a; d -= a; if (a > 0) this.sparks(this.sx - nx * 2, this.sy - ny * 2, 3, Col.Cyan, 30); }
    if (S.cargoSoak > 0 && this.cargoUsed > 0 && d > 0) { const soak = Math.min(d * S.cargoSoak, this.cargoUsed * 3); d -= soak; this.cargoLost += soak / 3; this.cargoUsed = Math.max(0, this.cargoUsed - soak / 3); this.trimCargo(); }
    if (this.cruise) { this.cruise = false; this.emit(Ev.Cruise, this.sx, this.sy, 0); }
    if (this.jumpT > 0 && d > 2) this.jumpT = Math.min(this.jumpLen, this.jumpT + 0.8);   // hits stall the jump drive
    this.hp -= d; this.lastHit = this.time; this.hitFlash = 1;
    this.hitAng = Math.atan2(-ny, -nx); this.hitT = 1;
    this.emit(Ev.ShipHit, this.sx, this.sy, d);
    this.shake = Math.min(14, this.shake + 2 + d * 0.25);
    this.svx += nx * d * 0.4 / (this.ship.mass / 100); this.svy += ny * d * 0.4 / (this.ship.mass / 100);
    if (this.hp <= 0) {
      this.hp = 0; this.alive = false; this.deadT = 0;
      this.explode(this.sx, this.sy, 3.2, Col.Cyan);
      this.flash = 1;
    }
  }

  /** Keep per-commodity counts within the (fractional) hold total after cargo soaks damage. */
  private trimCargo(): void {
    let tot = 0; for (let c = 0; c < 6; c++) tot += this.cargoBy[c];
    while (tot > Math.ceil(this.cargoUsed)) { let m = 0; for (let c = 1; c < 6; c++) if (this.cargoBy[c] > this.cargoBy[m]) m = c; this.cargoBy[m]--; tot--; }
  }
  /** Damage with no direction (heat, radiation): no knockback. */
  hurt(d: number, type: number): void { const vx = this.svx, vy = this.svy, sh = this.shake; this.damageShip(d, 0, 0, type); this.svx = vx; this.svy = vy; this.shake = Math.min(this.shake, sh + 0.3); }
  cargoLost = 0;

  // ===================================================================== spawning / streaming
  private streamSectors(): void {
    const sx = sectorOf(this.sx), sy = sectorOf(this.sy);
    if (sx === this.lastSx && sy === this.lastSy) return;
    this.lastSx = sx; this.lastSy = sy;
    // unload far sectors
    let w = 0;
    for (let i = 0; i < this.nLoaded; i++) {
      const lx = this.loaded[i * 2], ly = this.loaded[i * 2 + 1];
      if (Math.abs(lx - sx) <= 1 && Math.abs(ly - sy) <= 1) { this.loaded[w * 2] = lx; this.loaded[w * 2 + 1] = ly; w++; }
      else {
        const key = ((lx & 0xffff) << 16) | (ly & 0xffff);
        for (let e = 0; e < MAX_E; e++) if ((this.ek[e] === Kind.Asteroid || this.ek[e] === Kind.Station) && this.esec[e] === key) this.ek[e] = Kind.None;
      }
    }
    this.nLoaded = w;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const tx = sx + dx, ty = sy + dy;
      let have = false;
      for (let i = 0; i < this.nLoaded; i++) if (this.loaded[i * 2] === tx && this.loaded[i * 2 + 1] === ty) { have = true; break; }
      if (!have) { this.loaded[this.nLoaded * 2] = tx; this.loaded[this.nLoaded * 2 + 1] = ty; this.nLoaded++; this.loadSector(tx, ty); this.seedCache(tx, ty); }
    }
  }

  private readonly pTmp = new Float32Array(PLANET_STRIDE);
  private clrX = 0; private clrY = 0;
  /** Pushes (x,y) radially out to `margin` beyond the surface of sector (sx,sy)'s planet if it is inside; result in clrX/clrY. */
  private clearOfPlanet(sx: number, sy: number, x: number, y: number, margin: number): void {
    this.clrX = x; this.clrY = y;
    const p = this.pTmp;
    if (!planetParams(sx, sy, p, 0)) return;
    let dx = x - p[0], dy = y - p[1];
    const d = Math.sqrt(dx * dx + dy * dy), need = p[2] + margin;
    if (d >= need) return;
    if (d < 1e-3) { dx = 1; dy = 0; } else { dx /= d; dy /= d; }
    this.clrX = p[0] + dx * need; this.clrY = p[1] + dy * need;
  }

  private loadSector(sx: number, sy: number): void {
    const home = sx === 0 && sy === 0 && SYS.x === 0 && SYS.y === 0;
    if (!inSystem(sx, sy)) return;                                           // deep space between systems: empty
    if (hasStation(sx, sy)) {
      const sr = this.srng;
      sr.s = (Math.imul(sx + SYS.x, 0x2545f491) ^ Math.imul(sy + SYS.y, 0x9e3779b1) ^ 0xabcdef) >>> 0;
      const stx = home ? -175 : sx * SECTOR + (sr.next() - 0.5) * SECTOR * 0.5, sty = home ? -105 : sy * SECTOR + (sr.next() - 0.5) * SECTOR * 0.5;
      this.clearOfPlanet(sx, sy, stx, sty, 45);
      const e = this.spawnEnt(Kind.Station, this.clrX, this.clrY, 0, 0);
      if (e >= 0) { this.esec[e] = ((sx & 0xffff) << 16) | (sy & 0xffff); this.eseed[e] = sr.next(); this.ea[e] = 0; }
    }
    if (!home && hash2((sx + SYS.x) * 5 + 1, (sy + SYS.y) * 11 + 3) < 0.42) return;
    const r = this.srng;
    r.s = (Math.imul(sx + SYS.x, 0x9e3779b1) ^ Math.imul(sy + SYS.y, 0x85ebca6b) ^ 0x1234567) >>> 0;
    const cx = home ? -95 : sx * SECTOR + (r.next() - 0.5) * SECTOR * 0.55;
    const cy = home ? 70 : sy * SECTOR + (r.next() - 0.5) * SECTOR * 0.55;
    const fieldR = 70 + r.next() * 70, n = 8 + Math.floor(r.next() * 9);
    const key = ((sx & 0xffff) << 16) | (sy & 0xffff);
    const pp = this.pl;                        // scratch: planet of this sector (use tail slot)
    const po = (MAX_PLANETS - 1) * PLANET_STRIDE;
    const hasP = planetParams(sx, sy, pp, po);
    for (let i = 0; i < n; i++) {
      const a = r.next() * TAU, d = Math.sqrt(r.next()) * fieldR;
      const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d * 0.7;
      if (hasP) { const dx = x - pp[po], dy = y - pp[po + 1]; if (dx * dx + dy * dy < (pp[po + 2] + 14) ** 2) continue; }
      const rs = r.next(), size = rs < 0.22 ? 3 : rs < 0.62 ? 2 : 1;
      const e = this.spawnEnt(Kind.Asteroid, x, y, (r.next() - 0.5) * 5, (r.next() - 0.5) * 5);
      if (e < 0) return;
      this.eaux[e] = size; this.er[e] = AST_R[size]; this.ehp[e] = size * 2.5; this.esec[e] = key;
      const gap = Math.floor(hash2(sx * 29 + 1, sy * 37 + 2) * 3), bd = Math.floor(hash2(e * 7 + sx, i * 13 + sy) * 2);   // canyon: one band per field stays open
      this.ez[e] = this.eband[e] = ((gap + 1 + bd) % 3) - 1;
    }
    // asteroid belt hugging the planet
    if (hasP && hash2(sx * 3 + 5, sy * 7 + 2) < 0.5) {
      const pr = pp[po + 2] + 20, nb = Math.max(16, Math.round(pr * 0.35));
      for (let i = 0; i < nb; i++) {
        const a = (i / nb) * TAU + r.next() * 0.3, rr = pr + (r.next() - 0.5) * 8;
        const e = this.spawnEnt(Kind.Asteroid, pp[po] + Math.cos(a) * rr, pp[po + 1] + Math.sin(a) * rr, 0, 0);
        if (e < 0) break;
        const size = r.next() < 0.3 ? 2 : 1;
        this.eaux[e] = size; this.er[e] = AST_R[size]; this.ehp[e] = size * 2.5; this.esec[e] = key;
        this.ez[e] = this.eband[e] = hash2(e, i * 3 + sx) < 0.5 ? -1 : 0;                  // belts sit in the planet's bands
      }
    }
  }

  /** Derelict cargo cache: a persistent pile of scrap (and sometimes ammo / repair) that is never respawned once seeded. */
  private seedCache(sx: number, sy: number): void {
    const key = ((sx & 0xffff) << 16) | (sy & 0xffff);
    if (this.caches.has(key) || (sx === 0 && sy === 0) || !inSystem(sx, sy) || hash2((sx + SYS.x) * 13 + 7, (sy + SYS.y) * 7 + 1) < 0.72) return;
    this.caches.add(key);
    const r = this.srng; r.s = (Math.imul(sx + SYS.x, 0x1b873593) ^ Math.imul(sy + SYS.y, 0xcc9e2d51) ^ 0x5bd1e995) >>> 0;
    this.clearOfPlanet(sx, sy, sx * SECTOR + (r.next() - 0.5) * SECTOR * 0.6, sy * SECTOR + (r.next() - 0.5) * SECTOR * 0.6, 40);
    const cx = this.clrX, cy = this.clrY;
    for (let i = 0; i < 6; i++) {
      const k = i === 4 ? 1 : i === 5 ? 2 : 0;
      this.spawnScrap(cx + (r.next() - 0.5) * 14, cy + (r.next() - 0.5) * 8, k === 1 ? 25 : k === 2 ? 2 : 8, k);
      this.scl[(this.scur + MAX_S - 1) % MAX_S] = 1e6; this.scvx[(this.scur + MAX_S - 1) % MAX_S] = 0; this.scvy[(this.scur + MAX_S - 1) % MAX_S] = 0;
    }
  }

  spawnEnt(kind: number, x: number, y: number, vx: number, vy: number): number {
    for (let i = 0; i < MAX_E; i++) {
      if (this.ek[i] !== Kind.None) continue;
      this.ek[i] = kind; this.es[i] = St.Patrol; this.ex[i] = x; this.ey[i] = y; this.evx[i] = vx; this.evy[i] = vy;
      this.ea[i] = Math.atan2(vy, vx); this.ehp[i] = KIND_HP[kind]; this.er[i] = KIND_R[kind];
      this.et[i] = this.rng.next() * 1.2; this.et2[i] = 0; this.eaux[i] = 0; this.eseed[i] = this.rng.next() * 100;
      this.eflash[i] = 0; this.eshield[i] = 0; this.ez[i] = 0; this.eband[i] = 0; if (this.hard && kind !== Kind.Asteroid && kind !== Kind.Station && kind !== Kind.Mine) this.ehp[i] *= 1.5; this.eg[i] = -1; this.eslot[i] = 0; this.esec[i] = 0;
      return i;
    }
    return -1;
  }

  /** Starts a sector event: a 5 s warning, then the event itself (1 comet, 2 meteor shower, 3 solar flare, 4 ion storm). */
  triggerEvent(type: number): void { this.warn = type; this.warnT = 5; this.lastEvt = type; }

  private updateEvents(): void {
    if (this.alive && this.warn === 0 && this.flareT <= 0 && this.stormT <= 0 && this.meteorLeft <= 0 && this.eclT <= 0 && this.megaT <= 0 && this.time >= this.evtNext) {
      let ty = 1 + Math.floor(this.rng.next() * 4);
      if (ty === this.lastEvt) ty = (ty % 4) + 1;
      if (this.rng.next() < 0.14) ty = this.lastEvt === 5 ? 6 : this.lastEvt === 6 ? 5 : this.rng.next() < 0.5 ? 5 : 6;   // rare set pieces
      this.triggerEvent(ty); this.evtNext = this.time + 70 + this.rng.next() * 40;
    }
    if (this.warn > 0) {
      this.warnT -= DT;
      if (this.warnT <= 0) {
        const ty = this.warn; this.warn = 0;
        const a = this.rng.next() * TAU;
        if (ty === 1) {
          const dx = Math.cos(a), dy = Math.sin(a), off = (this.rng.next() - 0.5) * 140;
          const c = this.spawnEnt(Kind.Comet, this.sx + dx * 560, this.sy + dy * 560, 0, 0);
          if (c >= 0) {
            const tx = this.sx - dy * off - (this.sx + dx * 560), ty2 = this.sy + dx * off - (this.sy + dy * 560), l = Math.hypot(tx, ty2) + 1e-6;
            this.evx[c] = tx / l * 90; this.evy[c] = ty2 / l * 90; this.ea[c] = Math.atan2(this.evy[c], this.evx[c]); this.ehp[c] = 1e9; this.et[c] = 0;
            this.emit(Ev.Boss, this.ex[c], this.ey[c], 3);
          }
        } else if (ty === 2) { this.meteorLeft = 14; this.meteorCd = 0; this.meteorAng = a; }
        else if (ty === 3) this.flareT = 8;
        else if (ty === 5) this.eclT = 45 * (1 - this.debugEvtP);
        else if (ty === 6) this.megaT = 90 * (1 - this.debugEvtP);
        else this.stormT = 10;
      }
    }
    if (this.meteorLeft > 0) {
      this.meteorCd -= DT;
      if (this.meteorCd <= 0 && this.alive) {
        const dx = Math.cos(this.meteorAng), dy = Math.sin(this.meteorAng), lat = (this.rng.next() - 0.5) * 440, sp = 70 + this.rng.next() * 40;
        const e = this.spawnEnt(Kind.Asteroid, this.sx + dx * 450 - dy * lat, this.sy + dy * 450 + dx * lat, -dx * sp, -dy * sp);
        if (e >= 0) { this.eaux[e] = 1; this.er[e] = AST_R[1]; this.ehp[e] = 2.5; this.esec[e] = 0x5a5a5a5a; }   // key of a sector nobody can reach, so unloading home never deletes meteors

        this.meteorLeft--; this.meteorCd = 8 / 14;
      }
    }
    if (this.flareT > 0) { this.flareT -= DT; this.flare = this.flareT > 0 ? Math.sin(Math.PI * (1 - this.flareT / 8)) : 0; } else this.flare = 0;
    if (this.eclT > 0) { this.eclT -= DT; this.ecl = this.eclT > 0 ? 1 - this.eclT / 45 : 0; } else this.ecl = 0;
    if (this.megaT > 0) { this.megaT -= DT; this.mega = this.megaT > 0 ? 1 - this.megaT / 90 : 0; } else this.mega = 0;
    if (this.stormT > 0) { this.stormT -= DT; this.storm = this.stormT > 0 ? Math.min(1, (10 - this.stormT) / 1.5, this.stormT / 1.5) : 0; } else this.storm = 0;
  }

  private updateComet(i: number): void {
    this.ex[i] += this.evx[i] * DT; this.ey[i] += this.evy[i] * DT;
    this.et[i] -= DT;
    const x = this.ex[i], y = this.ey[i], ca = Math.cos(this.ea[i]), sa = Math.sin(this.ea[i]);
    for (let n = 0; n < 2; n++) this.spawnParticle(x - ca * 3 + (this.rng.next() - 0.5) * 3, y - sa * 3 + (this.rng.next() - 0.5) * 2, -ca * (10 + this.rng.next() * 20), -sa * (10 + this.rng.next() * 20), 0.5 + this.rng.next() * 0.9, PK.Exhaust, n ? Col.Cyan : Col.White, 1);
    if (this.alive && this.et[i] <= 0) {
      const dx = this.sx - x, dy = this.sy - y, rr = this.er[i] + this.ship.radius + 1;
      if (dx * dx + dy * dy < rr * rr) { const d = Math.sqrt(dx * dx + dy * dy) + 1e-4; this.damageShip(25, dx / d, dy / d, Dmg.Kinetic); this.et[i] = 3; }
    }
    for (let e = 0; e < MAX_E; e++) {                       // anything caught in the comet is wiped out, except bosses, stations and escorts
      const k = this.ek[e];
      if (k === Kind.None || k === Kind.Boss || k === Kind.Station || k === Kind.Freighter || k === Kind.Comet || k === Kind.Hauler || k === Kind.Wing) continue;
      const dx = this.ex[e] - x, dy = this.ey[e] - y, rr = this.er[e] + this.er[i];
      if (dx * dx + dy * dy < rr * rr) this.killEnt(e, false);
    }
  }

  private director(): void {
    this.spawnCd -= DT;
    if (!this.alive) return;
    if (this.time >= this.nextBoss && this.nBoss === 0) {
      const a = this.rng.next() * TAU;
      const e = this.spawnEnt(Kind.Boss, this.sx + Math.cos(a) * 260, this.sy + Math.sin(a) * 260, 0, 0);
      this.nextBoss = this.time + 240;
      if (e >= 0) { this.bossHpMax = KIND_HP[Kind.Boss] * (1 + 0.5 * this.bossKills); this.ehp[e] = this.bossHpMax; this.es[e] = St.Chase; this.emit(Ev.Boss, this.ex[e], this.ey[e], 1); }
    }
    this.haulCd -= DT;
    if (this.haulCd <= 0) {
      const ph0 = this.phase;
      if ((ph0 === 0 || ph0 === 3) && this.nHaul === 0) {            // convoys only in calm / lull phases
        const a = this.rng.next() * TAU, n = 1 + Math.floor(this.rng.next() * 3), lat = (this.rng.next() - 0.5) * 240;
        const ca = Math.cos(a), sa = Math.sin(a);
        for (let i = 0; i < n; i++) {
          const h = this.spawnEnt(Kind.Hauler, this.sx + ca * 480 - sa * lat + ca * i * 20, this.sy + sa * 480 + ca * lat + sa * i * 20, -ca * 14, -sa * 14);
          if (h >= 0) this.eseed[h] = i;
        }
        this.haulCd = 50 + this.rng.next() * 30;
      } else this.haulCd = 8;
    }
    if (this.objType === 5 && this.frIdx < 0) {
      const h = this.rng.next() * TAU;
      const f = this.spawnEnt(Kind.Freighter, this.sx + Math.cos(h) * 40, this.sy + Math.sin(h) * 40, 0, 0);
      if (f >= 0) { this.frIdx = f; this.eaux[f] = h; this.ea[f] = h; this.emit(Ev.Boss, this.ex[f], this.ey[f], 2); }
    }
    if (this.cruise || this.jumpT > 0) { this.spawnCd = Math.max(this.spawnCd, 1); }
    if (this.spawnCd > 0) return;
    const ph = this.phase, mult = (ph === 0 ? 0.3 : ph === 1 ? 0.85 : ph === 2 ? 1.4 : 0.4) * (this.objType === 4 && this.stationNear ? 1.6 : this.objType === 5 && this.frIdx >= 0 ? 1.3 : 1);
    const target = Math.min(Math.round((3 + Math.min(this.time / 45, 7)) * mult * (this.hard ? 1.25 : 1) * this.pressure), 14);
    if (this.nEnemy >= target) { this.spawnCd = 1; return; }
    this.spawnCd = ph === 2 ? 2.2 : 3.4;
    const a = this.rng.next() * TAU, dist = 190 + this.rng.next() * 50;
    const bx = this.sx + Math.cos(a) * dist, by = this.sy + Math.sin(a) * dist;
    const roll = this.rng.next();
    const g = (this.gcount++) % MAX_GRP;
    this.grpAng[g] = this.rng.next() * TAU;
    const toward = a + Math.PI;
    const T = this.time;
    const pack = (kind: number, n: number, spread: number, spd: number): void => {
      for (let i = 0; i < n; i++) {
        const e = this.spawnEnt(kind, bx + (this.rng.next() - 0.5) * spread + (i - n / 2) * 4, by + (this.rng.next() - 0.5) * spread, Math.cos(toward) * spd, Math.sin(toward) * spd);
        if (e >= 0) { this.eg[e] = g; this.eslot[e] = i; }
      }
    };
    if (roll < 0.28) pack(Kind.Drone, (ph === 2 ? 3 : 2) + Math.floor(this.rng.next() * 2), 24, 30);
    else if (roll < 0.40 && T > 60) pack(Kind.Splitter, 2, 20, 28);
    else if (roll < 0.50 && T > 75) pack(Kind.Rammer, 2 + (ph === 2 ? 1 : 0), 26, 40);
    else if (roll < 0.74) {
      pack(Kind.Gunship, 2, 16, 20);
      if (T > 100) for (let e = 0; e < MAX_E; e++) if (this.ek[e] === Kind.Gunship && this.eg[e] === g && this.rng.next() < 0.4) this.eshield[e] = 8;
    } else if (roll < 0.84 || T < 90) pack(Kind.Minelayer, 1, 0, 15);
    else if (roll < 0.92) pack(Kind.Sniper, 1, 0, 15);
    else if (T > 110) { pack(Kind.Tender, 1, 0, 14); pack(Kind.Drone, 2, 20, 30); }
    else pack(Kind.Minelayer, 1, 0, 15);
  }

  private objSetup(): void {
    const ty = this.objTier % 6, tier = this.objTier;
    this.objTarget = ty === 0 ? 6 + tier : ty === 1 ? 20 + 4 * tier : ty === 2 ? 4 + tier : ty === 3 ? 40 + 5 * tier : ty === 4 ? 30 + 4 * tier : 50 + 3 * tier;
    if (this.frIdx >= 0 && ty !== 5) { this.ek[this.frIdx] = Kind.None; this.frIdx = -1; }
  }

  /** Escort freighter: crawls along a heading, waits if the player strays, progress = distance covered. Dies -> mission failed. */
  private updateFreighter(i: number): void {
    if (this.objType !== 5 || !this.alive) { if (this.objType !== 5) { this.ek[i] = Kind.None; this.frIdx = -1; } return; }
    const dx = this.sx - this.ex[i], dy = this.sy - this.ey[i];
    const near = dx * dx + dy * dy < 230 * 230;
    const sp = near ? KIND_SPEED[Kind.Freighter] : 0, h = this.eaux[i];
    this.evx[i] += (Math.cos(h) * sp - this.evx[i]) * 0.8 * DT; this.evy[i] += (Math.sin(h) * sp - this.evy[i]) * 0.8 * DT;
    this.ex[i] += this.evx[i] * DT; this.ey[i] += this.evy[i] * DT;
    this.ea[i] = h; this.et[i] = 0;
    if (this.ehp[i] < KIND_HP[Kind.Freighter] * 0.4 && (this.tick & 3) === 0) this.spawnParticle(this.ex[i], this.ey[i], this.evx[i] * 0.3, 5, 0.9, PK.Smoke, Col.Gray, 1);
    this.objProgress(5, Math.hypot(this.evx[i], this.evy[i]) * DT / 10);
  }

  /** Shared objective accounting. type 0 = hostiles, 1 = scrap collected, 2 = asteroids. */
  private objProgress(type: number, n: number): void {
    if (this.objType !== type) return;
    this.objKills += n;
    if (this.objKills >= this.objTarget) {
      this.objKills = 0; this.objTier++;
      this.objSetup();
      const tier = this.objTier;
      const bonus = 25 + 10 * tier; this.scrap += bonus; this.scrapTotal += bonus; this.emit(Ev.Objective, this.sx, this.sy, tier);
      if (type === 4) this.emit(Ev.Saved, this.sx, this.sy, 1);
    }
  }

  private isAimTarget(k: number): boolean {
    return k === Kind.Drone || k === Kind.Gunship || k === Kind.Minelayer || k === Kind.Boss || k === Kind.Sniper || k === Kind.Splitter || k === Kind.Tender || k === Kind.Rammer;
  }
  /** Enemy within `cone` of heading `ang` from (x,y) and `range`, with the smallest angular offset (ties: lowest index); -1 if none. */
  private findAimTarget(x: number, y: number, ang: number, cone: number, range: number): number {
    let best = -1, ba = cone;
    for (let i = 0; i < MAX_E; i++) {
      if (!this.isAimTarget(this.ek[i])) continue;
      const dx = this.ex[i] - x, dy = this.ey[i] - y;
      if (dx * dx + dy * dy > range * range) continue;
      const a = Math.abs(wrapAngle(Math.atan2(dy, dx) - ang));
      if (a < ba) { ba = a; best = i; }
    }
    return best;
  }

  // ===================================================================== missiles
  /** Missiles only seek real combatants: never mines, rocks, stations, the escort freighter, comets or neutral haulers. */
  private isMissileTarget(k: number): boolean {
    return k !== Kind.None && k !== Kind.Mine && k !== Kind.Asteroid && k !== Kind.Station && k !== Kind.Freighter && k !== Kind.Comet && k !== Kind.Hauler && k !== Kind.Wing;
  }

  private launchMissile(ca: number, sa: number): void {
    let best = -1, bd = 450 * 450;
    for (let i = 0; i < MAX_E; i++) {
      const k = this.ek[i];
      if (!this.isMissileTarget(k)) continue;
      const dx = this.ex[i] - this.sx, dy = this.ey[i] - this.sy, d2 = dx * dx + dy * dy;
      const ang = Math.abs(wrapAngle(Math.atan2(dy, dx) - this.sa));
      if (ang < 1.3 && d2 < bd) { bd = d2; best = i; }
    }
    const m = this.mcur; this.mcur = (this.mcur + 1) % MAX_M;
    this.mx[m] = this.sx + ca * 9; this.my[m] = this.sy + sa * 9; this.mang[m] = this.sa; this.mspd[m] = 70 + Math.hypot(this.svx, this.svy) * 0.3;
    this.mlife[m] = 4; this.mtgt[m] = best;
    this.missiles -= 1; this.missileCd = 0.45; this.emit(Ev.Missile, this.sx, this.sy, 1);
  }

  private updateMissiles(): void {
    for (let m = 0; m < MAX_M; m++) {
      if (this.mlife[m] <= 0) continue;
      this.mlife[m] -= DT;
      let t = this.mtgt[m];
      if (t < 0 || !this.isMissileTarget(this.ek[t])) {
        t = -1; let bd = 320 * 320;
        for (let i = 0; i < MAX_E; i++) {
          const k = this.ek[i];
          if (!this.isMissileTarget(k)) continue;
          const dx = this.ex[i] - this.mx[m], dy = this.ey[i] - this.my[m], d2 = dx * dx + dy * dy;
          if (d2 < bd) { bd = d2; t = i; }
        }
        this.mtgt[m] = t;
      }
      if (t >= 0) {
        const want = Math.atan2(this.ey[t] - this.my[m], this.ex[t] - this.mx[m]);
        this.mang[m] += clamp(wrapAngle(want - this.mang[m]), -4.5 * DT, 4.5 * DT);
      }
      this.mspd[m] = Math.min(190, this.mspd[m] + 130 * DT);
      const vx = Math.cos(this.mang[m]) * this.mspd[m], vy = Math.sin(this.mang[m]) * this.mspd[m];
      this.mx[m] += vx * DT; this.my[m] += vy * DT;
      if ((this.tick & 1) === 0) this.spawnParticle(this.mx[m], this.my[m], -vx * 0.15, -vy * 0.15, 0.4, PK.Exhaust, Col.Fire, 1);
      let hit = this.mlife[m] <= 0;
      for (let i = 0; i < MAX_E && !hit; i++) {
        if (this.ek[i] === Kind.None) continue;
        const dx = this.ex[i] - this.mx[m], dy = this.ey[i] - this.my[m], rr = this.er[i] + 2.5;
        if (dx * dx + dy * dy < rr * rr) hit = true;
      }
      for (let k = 0; k < this.nPl && !hit; k++) {
        const o = k * PLANET_STRIDE, dx = this.mx[m] - this.pl[o], dy = this.my[m] - this.pl[o + 1];
        if (dx * dx + dy * dy < this.pl[o + 2] * this.pl[o + 2]) hit = true;
      }
      if (hit) { this.mlife[m] = 0; this.blastZ = t >= 0 ? this.ez[t] : this.sz; this.explode(this.mx[m], this.my[m], 1.7, Col.Fire); this.blast(this.mx[m], this.my[m], 14, 24, true); }
    }
  }

  // ===================================================================== scrap, docking, upgrades
  spawnScrap(x: number, y: number, v: number, kind = 0): void {
    const i = this.scur; this.scur = (this.scur + 1) % MAX_S; this.sck[i] = kind;
    const a = this.rng.next() * TAU, s = 6 + this.rng.next() * 16;
    this.scx[i] = x; this.scy[i] = y; this.scvx[i] = Math.cos(a) * s; this.scvy[i] = Math.sin(a) * s; this.scl[i] = 25; this.scv[i] = v;
  }

  private updateScrap(): void {
    const mr = this.tractorR, mr2 = mr * mr;
    for (let i = 0; i < MAX_S; i++) {
      if (this.scl[i] <= 0) continue;
      this.scl[i] -= DT;
      const k = Math.exp(-1.5 * DT); this.scvx[i] *= k; this.scvy[i] *= k;
      if (this.alive) {
        const dx = this.sx - this.scx[i], dy = this.sy - this.scy[i], d2 = dx * dx + dy * dy;
        if (d2 < mr2) {
          const d = Math.sqrt(d2) + 1e-4, pull = 220 * (1 - d / mr) + 40;
          this.scvx[i] += dx / d * pull * DT; this.scvy[i] += dy / d * pull * DT;
          if (d < 5) {
            this.scl[i] = 0;
            const ck = this.sck[i];
            if (ck === 1) { this.hp = Math.min(this.hpMax, this.hp + this.scv[i]); this.emit(Ev.Heal, this.scx[i], this.scy[i], 1); }
            else if (ck === 2) { this.missiles = Math.min(this.missileCap, this.missiles + this.scv[i]); this.emit(Ev.Pickup, this.scx[i], this.scy[i], 4); }
            else { this.scrap += this.scv[i]; this.scrapTotal += this.scv[i]; this.objProgress(1, this.scv[i]); this.emit(Ev.Pickup, this.scx[i], this.scy[i], this.scv[i]); }
            continue;
          }
        }
      }
      this.scx[i] += this.scvx[i] * DT; this.scy[i] += this.scvy[i] * DT;
    }
  }

  private findDock(): void {
    let best = -1; this.stationNear = false;
    for (let e = 0; e < MAX_E; e++) {
      if (this.ek[e] !== Kind.Station) continue;
      const dx = this.sx - this.ex[e], dy = this.sy - this.ey[e], r = this.er[e] + 32;
      if (dx * dx + dy * dy < 170 * 170) this.stationNear = true;
      if (dx * dx + dy * dy < r * r) { best = e; break; }
    }
    this.dockable = best;
    if (best >= 0) { const key = this.esec[best], sx = key >> 16, sy = (key << 16) >> 16; this.dockType = stationType(sx, sy); this.dockMult = STATION_MULT[this.dockType]; }
  }

  /** Test/diagnostic: longest spatial-hash chain (> MAX_E means a cycle). */
  hash_maxChain(): number { return this.hash.maxChain(MAX_E); }

  /** Buy one level of upgrade `u`. Returns false if maxed or too poor. */
  price(u: number): number { return Math.round(upCost(this.up[u]) * this.dockMult); }

  buyUpgrade(u: number): boolean {
    const l = this.up[u];
    if (l >= UP_MAX || this.scrap < this.price(u)) return false;
    this.scrap -= this.price(u); this.up[u] = l + 1;
    this.refreshShip();
    return true;
  }

  /** Free repair + refill while docked. */
  serviceShip(): void { this.cruise = false; this.hp = this.hpMax; this.shield = this.ship.shieldMax; this.energy = this.ship.energyMax; this.heat = 0; this.overheat = false; this.refreshShip(); this.boostE = this.boostMax; this.fuel = Math.max(this.fuel, this.fuelMax * 0.25); this.emit(Ev.Dock, this.sx, this.sy, 1); }

  // ===================================================================== spatial hash + entities
  private rebuildHash(): void {
    const h = this.hash;
    h.clear();
    let ne = 0, nen = 0, na = 0, nb = 0, nw = 0; this.nHaulTmp = 0;
    for (let i = 0; i < MAX_E; i++) {
      if (this.ek[i] === Kind.None) continue;
      h.insert(i, this.ex[i], this.ey[i]);
      ne++;
      const k = this.ek[i];
      if (k === Kind.Boss) { nb++; this.bossMax = this.bossHpMax; this.bossHp = this.ehp[i]; }
      if (k === Kind.Hauler) this.nHaulTmp++;
      if (k === Kind.Wing) nw++;
      if (k === Kind.Asteroid) na++; else if (k !== Kind.Mine && k !== Kind.Station && k !== Kind.Freighter && k !== Kind.Comet && k !== Kind.Hauler && k !== Kind.Wing) nen++;
    }
    this.nHaul = this.nHaulTmp; this.nWing = nw; this.nEnt = ne; this.nEnemy = nen; this.nAst = na; this.nBoss = nb;
  }

  /** Aggro-range multiplier from the player's live signature (sqrt so it never swings wildly). */
  private sigF = 1;
  private updateEnts(): void {
    this.sigF = clamp(Math.sqrt(this.sigNow), 0.2, 1.6);
    const cullR2 = 700 * 700, cullS2 = 1100 * 1100;
    for (let i = 0; i < MAX_E; i++) {
      const k = this.ek[i];
      if (k === Kind.None) continue;
      if (this.eflash[i] > 0) this.eflash[i] -= DT * 6;
      const dxs = this.ex[i] - this.sx, dys = this.ey[i] - this.sy;
      if (dxs * dxs + dys * dys > (k === Kind.Asteroid || k === Kind.Station ? cullS2 : cullR2)) { this.ek[i] = Kind.None; if (k === Kind.Freighter) this.freighterLost(); continue; }
      if (k === Kind.Station) continue;
      if (k === Kind.Freighter) { this.updateFreighter(i); continue; }
      if (k === Kind.Comet) { this.updateComet(i); continue; }
      if (k === Kind.Wing) { if (this.vert) this.updateEnemyBand(i, k, 0); this.updateWing(i); continue; }
      if (k === Kind.Hauler) { this.ex[i] += this.evx[i] * DT; this.ey[i] += this.evy[i] * DT; this.ea[i] = Math.atan2(this.evy[i], this.evx[i]); if ((this.tick & 7) === 0) this.spawnParticle(this.ex[i] - Math.cos(this.ea[i]) * 5, this.ey[i] - Math.sin(this.ea[i]) * 5, 0, 0, 0.8, PK.Exhaust, Col.Amber, 1); continue; }
      if (k === Kind.Asteroid) {
        this.ex[i] += this.evx[i] * DT; this.ey[i] += this.evy[i] * DT;
      } else if (k === Kind.Mine) {
        this.updateMine(i);
      } else {
        this.updateEnemy(i, k);
      }
    }
  }

  private freighterLost(): void {
    this.frIdx = -1; this.escortFails++;
    if (this.objType === 5) { this.objKills = 0; this.objTier++; this.objSetup(); this.emit(Ev.Objective, this.sx, this.sy, -1); }
  }

  private updateMine(i: number): void {
    this.et[i] += DT;
    const k = Math.exp(-1.2 * DT);
    this.evx[i] *= k; this.evy[i] *= k;
    this.ex[i] += this.evx[i] * DT; this.ey[i] += this.evy[i] * DT;
    if (this.et[i] > 1.0 && this.alive) {
      const dx = this.sx - this.ex[i], dy = this.sy - this.ey[i];
      if (dx * dx + dy * dy < 8 * 8 && (!this.vert || Math.abs(this.ez[i] - this.sz) <= V_TOL)) { this.killEnt(i, false); return; }
    }
    if (this.et[i] > 40) this.ek[i] = Kind.None;
  }

  private updateEnemy(i: number, kind: number): void {
    const x = this.ex[i], y = this.ey[i];
    let tgx = this.sx, tgy = this.sy, tvx = this.svx, tvy = this.svy;
    if (this.frIdx >= 0 && this.ek[this.frIdx] === Kind.Freighter && (i & 1) === 0 && kind !== Kind.Boss) {
      const fx = this.ex[this.frIdx], fy = this.ey[this.frIdx];
      if ((fx - x) ** 2 + (fy - y) ** 2 < 260 * 260) { tgx = fx; tgy = fy; tvx = this.evx[this.frIdx]; tvy = this.evy[this.frIdx]; }
    }
    const tdx = tgx - x, tdy = tgy - y;
    const d = Math.sqrt(tdx * tdx + tdy * tdy) + 1e-4;
    const maxSp = KIND_SPEED[kind], accel = KIND_ACCEL[kind];
    this.et[i] -= DT; this.et2[i] -= DT;
    if (this.echarge[i] > 0) { this.echarge[i] -= DT; if (this.echarge[i] <= 0) this.echarge[i] = -1; }
    if (this.ehp[i] < KIND_HP[kind] * 0.35 && (this.tick & 3) === 0) this.spawnParticle(x, y, this.evx[i] * 0.5, this.evy[i] * 0.5 + 4, 0.7 + this.rng.next() * 0.5, PK.Smoke, Col.Gray, 1);
    let st = this.es[i];
    const hpFrac = this.ehp[i] / KIND_HP[kind];
    this.fx = 0; this.fy = 0;
    let faceX = this.evx[i], faceY = this.evy[i];
    let wantFire = false;

    // ---- FSM transitions
    if (!this.alive) st = St.Patrol;
    else if (kind === Kind.Minelayer || kind === Kind.Tender) st = d < KIND_AGGRO[kind] * this.sigF ? St.Flee : St.Patrol;
    else {
      switch (st) {
        case St.Patrol: if (d < KIND_AGGRO[kind] * this.sigF) { st = St.Chase; this.et[i] = 0.5; } break;
        case St.Chase: if (d > KIND_AGGRO[kind] * 1.7 * this.sigF) st = St.Patrol; else if (d < ATK_IN[kind]) st = St.Attack; break;
        case St.Attack: if (hpFrac < 0.3 && kind === Kind.Gunship) { st = St.Flee; this.et[i] = 4; } else if (d > ATK_OUT[kind]) st = St.Chase; break;
        case St.Flee: if (this.et[i] <= 0) st = St.Chase; break;
      }
    }
    this.es[i] = st;
    if (this.vert) this.updateEnemyBand(i, kind, st);

    // ---- behaviours
    if (st === St.Patrol) {
      const t = this.time * 0.4 + this.eseed[i];
      const wa = this.ea[i] + Math.sin(t) * 0.8;
      this.fx += (Math.cos(wa) * maxSp * 0.45 - this.evx[i]) * 0.8;
      this.fy += (Math.sin(wa) * maxSp * 0.45 - this.evy[i]) * 0.8;
    } else if (st === St.Chase) {
      const tt = d / (maxSp + 1);
      this.seek(i, tgx + tvx * tt * 0.5, tgy + tvy * tt * 0.5, maxSp, 1);
    } else if (st === St.Flee) {
      if (kind === Kind.Minelayer || kind === Kind.Tender) {
        // keep standoff distance while circling, drop mines behind
        const px = -tdy / d, py = tdx / d;
        const away = d < 130 ? -1 : d > 200 ? 0.8 : 0;
        const dirx = tdx / d * away + px * 0.8, diry = tdy / d * away + py * 0.8;
        this.fx += (dirx * maxSp - this.evx[i]) * 1.2; this.fy += (diry * maxSp - this.evy[i]) * 1.2;
        if (kind === Kind.Minelayer && this.et2[i] <= 0 && d < 230) {
          this.et2[i] = 2.1;
          const m = this.spawnEnt(Kind.Mine, x - this.evx[i] * 0.1, y - this.evy[i] * 0.1, -this.evx[i] * 0.2, -this.evy[i] * 0.2);
          if (m >= 0) this.et[m] = 0;
        }
      } else {
        this.seek(i, x - tdx, y - tdy, maxSp * 1.15, 1.2);
      }
    } else {   // Attack
      if (kind === Kind.Rammer) {
        const tt = d / 110;
        this.seek(i, tgx + tvx * tt, tgy + tvy * tt, maxSp, 2.2);
        faceX = this.evx[i]; faceY = this.evy[i];
      } else if (kind === Kind.Drone || kind === Kind.Splitter) {
        // dive & strafe: seek lead point, break away when close
        const tt = d / 95;
        const lx = tgx + tvx * tt, ly = tgy + tvy * tt;
        if (d > 26) this.seek(i, lx, ly, maxSp, 1.1);
        else { const px = -tdy / d, py = tdx / d, s = this.eseed[i] > 50 ? 1 : -1; this.fx += (px * s * maxSp - this.evx[i]) * 1.4; this.fy += (py * s * maxSp - this.evy[i]) * 1.4; }
        faceX = tdx; faceY = tdy;
        wantFire = d < 100;
      } else {
        // gunship: group flank orbit around the player
        const g = this.eg[i];
        const base = g >= 0 ? this.grpAng[g] : this.eseed[i];
        const ang = base + (this.eslot[i] === 0 ? 0 : 2.4) + (this.eslot[i] & 1) * 0.0;
        const orb = ORBIT[kind];
        this.arrive(i, tgx + Math.cos(ang) * orb, tgy + Math.sin(ang) * orb, maxSp, 40, 1.3);
        faceX = tdx; faceY = tdy;
        wantFire = d < FIRE_D[kind];
      }
    }

    // ---- avoidance: planets, asteroids, separation
    for (let k = 0; k < this.nPl; k++) {
      const o = k * PLANET_STRIDE;
      const dx = x - this.pl[o], dy = y - this.pl[o + 1];
      const dd = Math.sqrt(dx * dx + dy * dy) + 1e-4, rr = this.pl[o + 2] + this.er[i] + 14;
      if (dd < rr * 1.5) {
        const s = (rr * 1.5 - dd) / (rr * 0.5);
        this.fx += dx / dd * accel * 1.2 * s; this.fy += dy / dd * accel * 1.2 * s;
      }
      if (dd < this.pl[o + 2] + this.er[i]) {      // hard collision
        const ov = this.pl[o + 2] + this.er[i] - dd;
        this.ex[i] += dx / dd * ov; this.ey[i] += dy / dd * ov;
        const vn = this.evx[i] * dx / dd + this.evy[i] * dy / dd;
        if (vn < 0) { this.evx[i] -= 1.5 * vn * dx / dd; this.evy[i] -= 1.5 * vn * dy / dd; }
      }
    }
    const h = this.hash, inv = h.inv;
    const cx = Math.floor(x * inv), cy = Math.floor(y * inv);
    for (let gy = cy - 1; gy <= cy + 1; gy++) for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let j = h.head[SpatialHash.key(gx, gy)]; j >= 0; j = h.next[j]) {
        if (j === i) continue;
        const dx = x - this.ex[j], dy = y - this.ey[j];
        const dd2 = dx * dx + dy * dy;
        const kj = this.ek[j];
        if (kj === Kind.Asteroid || kj === Kind.Station) {
          const rr = this.er[j] + this.er[i] + 6;
          if (dd2 < rr * rr) { const dd = Math.sqrt(dd2) + 1e-4, s = (rr - dd) / rr; this.fx += dx / dd * accel * 1.4 * s; this.fy += dy / dd * accel * 1.4 * s; }
        } else if (kj !== Kind.Mine && dd2 < 14 * 14) {
          const dd = Math.sqrt(dd2) + 1e-4, s = (14 - dd) / 14;
          this.fx += dx / dd * accel * 0.9 * s; this.fy += dy / dd * accel * 0.9 * s;
        }
      }
    }

    // ---- integrate
    const fm = Math.sqrt(this.fx * this.fx + this.fy * this.fy);
    if (fm > accel) { const f = accel / fm; this.fx *= f; this.fy *= f; }
    this.evx[i] += this.fx * DT; this.evy[i] += this.fy * DT;
    const sp = Math.sqrt(this.evx[i] * this.evx[i] + this.evy[i] * this.evy[i]);
    if (sp > maxSp * 1.2) { const f = maxSp * 1.2 / sp; this.evx[i] *= f; this.evy[i] *= f; }
    this.ex[i] += this.evx[i] * DT; this.ey[i] += this.evy[i] * DT;
    if (faceX * faceX + faceY * faceY > 1e-3) {
      const want = Math.atan2(faceY, faceX);
      this.ea[i] += wrapAngle(want - this.ea[i]) * Math.min(1, KIND_TURN[kind] * DT);
    }

    if (kind === Kind.Tender && (this.tick % 8) === 0) {
      for (let j = 0; j < MAX_E; j++) {
        const kj = this.ek[j];
        if (j === i || kj === Kind.None || kj === Kind.Mine || kj === Kind.Asteroid || kj === Kind.Station || kj === Kind.Wing) continue;
        const dx = this.ex[j] - x, dy = this.ey[j] - y;
        if (dx * dx + dy * dy < 50 * 50 && this.ehp[j] < KIND_HP[kj]) {
          this.ehp[j] = Math.min(KIND_HP[kj], this.ehp[j] + 1.2);
          this.spawnParticle(this.ex[j], this.ey[j], 0, 8, 0.5, PK.Spark, Col.Green, 1);
        }
      }
    }
    if (kind === Kind.Rammer && this.alive && d < this.er[i] + this.ship.radius + 1.5 && (!this.vert || Math.abs(this.ez[i] - this.sz) <= V_TOL)) { this.killEnt(i, false); return; }

    // ---- weapons
    this.shotZ = this.ez[i];
    if (wantFire && this.alive && (!this.vert || Math.abs(this.ez[i] - this.sz) <= V_TOL)) {
      const dir = Math.atan2(tdy, tdx);
      const diff = Math.abs(wrapAngle(dir - this.ea[i]));
      if (kind === Kind.Drone || kind === Kind.Splitter) {
        if (this.et[i] <= 0 && diff < 0.3) {
          this.et[i] = 0.55 + this.rng.next() * 0.5;
          this.enemyShot(i, 95, 0.1, 3);
        }
      } else if (kind === Kind.Boss) {
        if (this.et[i] <= 0 && diff < 0.5) {
          this.et[i] = 1.0; this.emit(Ev.EnemyShot, x, y, 2);
          const fan = 2 + Math.min(2, this.bossKills);
          for (let j = -fan; j <= fan; j++) {
            const fa = dir + j * 0.15;
            this.spawnBullet(x + Math.cos(fa) * 12, y + Math.sin(fa) * 12, this.evx[i] * 0.3 + Math.cos(fa) * 100, this.evy[i] * 0.3 + Math.sin(fa) * 100, 2.8, 1, 6, Dmg.Thermal);
          }
        }
      } else if (kind === Kind.Sniper) {
        if (this.echarge[i] === 0 && this.et[i] <= 0 && diff < 0.12) { this.echarge[i] = 1.0; this.emit(Ev.Charge, x, y, 1); }
        else if (this.echarge[i] < 0) { this.enemyShot(i, 200, 0.0, 16, Dmg.Em); this.echarge[i] = 0; this.et[i] = 2.4 + this.rng.next(); }
      } else if (this.et[i] <= 0 && diff < 0.18) {
        // telegraphed burst: 0.5 s charge (barrels glow), then 3 shots
        if (this.echarge[i] === 0) { this.echarge[i] = 0.5; this.emit(Ev.Charge, x, y, 1); }
        else if (this.echarge[i] < 0) {
          this.et[i] = 0.14;
          this.eaux[i] += 1;
          this.enemyShot(i, 105, 0.03, 5);
          if (this.eaux[i] >= 3) { this.eaux[i] = 0; this.et[i] = 1.5 + this.rng.next() * 0.6; this.echarge[i] = 0; }
        }
      }
    }
    // engine glow particles
    if (sp > maxSp * 0.3 && (this.tick & 1) === 0) {
      const ea = this.ea[i] + Math.PI;
      this.spawnParticle(x + Math.cos(ea) * this.er[i] * 2.0, y + Math.sin(ea) * this.er[i] * 2.0,
        this.evx[i] * 0.4 + Math.cos(ea) * 16, this.evy[i] * 0.4 + Math.sin(ea) * 16, 0.3 + this.rng.next() * 0.2, PK.Exhaust, Col.Red, 1);
    }
  }

  private enemyShot(i: number, speed: number, spread: number, dmg: number, type: number = Dmg.Kinetic): void {
    const dx = this.sx - this.ex[i], dy = this.sy - this.ey[i];
    const t = Math.sqrt(dx * dx + dy * dy) / speed;
    const tx = this.sx + this.svx * t - this.ex[i], ty = this.sy + this.svy * t - this.ey[i];
    const a = Math.atan2(ty, tx) + (this.rng.next() - 0.5) * spread * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const gun = this.ek[i] === Kind.Gunship, reach = gun ? 9.5 : this.er[i] * 3.6, lat = gun ? ((this.eaux[i] & 1) ? 3.5 : -3.5) : 0;
    this.emit(Ev.EnemyShot, this.ex[i], this.ey[i], 1);
    this.spawnBullet(this.ex[i] + ca * reach - sa * lat, this.ey[i] + sa * reach + ca * lat,
      this.evx[i] * 0.3 + ca * speed, this.evy[i] * 0.3 + sa * speed, 2.6, 1, dmg, type);
  }

  private seek(i: number, tx: number, ty: number, speed: number, w: number): void {
    const dx = tx - this.ex[i], dy = ty - this.ey[i];
    const k = speed / (Math.sqrt(dx * dx + dy * dy) + 1e-4);
    this.fx += (dx * k - this.evx[i]) * w; this.fy += (dy * k - this.evy[i]) * w;
  }

  private arrive(i: number, tx: number, ty: number, speed: number, slow: number, w: number): void {
    const dx = tx - this.ex[i], dy = ty - this.ey[i];
    const d = Math.sqrt(dx * dx + dy * dy) + 1e-4;
    const s = d < slow ? speed * d / slow : speed;
    const k = s / d;
    this.fx += (dx * k - this.evx[i]) * w; this.fy += (dy * k - this.evy[i]) * w;
  }

  // ===================================================================== combat
  hitEnt(j: number, dmg: number, ix: number, iy: number): void {
    const k = this.ek[j];
    if (k === Kind.Station) { this.sparks(this.ex[j] + (this.rng.next() - 0.5) * 20, this.ey[j] + (this.rng.next() - 0.5) * 20, 3, Col.Amber, 26); return; }
    if (this.eshield[j] > 0) { this.eshield[j] -= dmg; this.eflash[j] = 0.4; this.sparks(this.ex[j], this.ey[j], 3, Col.Cyan, 36); this.emit(Ev.Hit, this.ex[j], this.ey[j], dmg); return; }
    if (k === Kind.Comet) return;                                  // bolts pass through comets
    this.ehp[j] -= dmg; this.eflash[j] = 1;
    this.evx[j] += ix * 0.02; this.evy[j] += iy * 0.02;
    if ((k <= Kind.Minelayer || k >= Kind.Boss) && k !== Kind.None && this.es[j] === St.Patrol) this.es[j] = St.Chase;
    if (this.ehp[j] <= 0) this.killEnt(j, true);
    else { this.sparks(this.ex[j], this.ey[j], 4, k === Kind.Asteroid ? Col.Gray : Col.Amber, 30); this.emit(Ev.Hit, this.ex[j], this.ey[j], dmg); }
  }

  killEnt(j: number, byPlayer: boolean): void {
    const k = this.ek[j];
    if (k === Kind.None) return;
    this.ek[j] = Kind.None; this.echarge[j] = 0;
    if (k === Kind.Freighter) { this.explode(this.ex[j], this.ey[j], 4.5, Col.Fire); this.freighterLost(); return; }
    const x = this.ex[j], y = this.ey[j];
    if (byPlayer) this.emit(Ev.Kill, x, y, k === Kind.Drone ? 100 : k === Kind.Gunship ? 300 : k === Kind.Minelayer ? 250 : k === Kind.Asteroid ? 20 * this.eaux[j] : 0);
    if (k === Kind.Asteroid) {
      const size = this.eaux[j];
      this.explode(x, y, 0.5 + size * 0.35, Col.Gray);
      if (byPlayer) { this.objProgress(2, 1); this.score += 20 * size; if (this.esec[j] === ORE_TAG) this.spawnScrap(x, y, 3 * size); else if (size >= 2 && this.rng.next() < 0.5) this.spawnScrap(x, y, 1); }
      if (size > 1) {
        for (let c = 0; c < 2; c++) {
          const a = this.rng.next() * TAU;
          const e = this.spawnEnt(Kind.Asteroid, x + Math.cos(a) * 2, y + Math.sin(a) * 2, this.evx[j] + Math.cos(a) * 9, this.evy[j] + Math.sin(a) * 9);
          if (e >= 0) { this.eaux[e] = size - 1; this.er[e] = AST_R[size - 1]; this.ehp[e] = (size - 1) * 2.5; this.esec[e] = this.esec[j]; }
        }
      }
      return;
    }
    if (k === Kind.Mine) {
      this.blastZ = this.ez[j];
      this.explode(x, y, 2.0, Col.Amber);
      this.blast(x, y, 11, 34, byPlayer);
      return;
    }
    if (k === Kind.Comet) { this.ek[j] = k; this.ehp[j] = 1e9; return; }          // comets cannot be destroyed
    if (k === Kind.Hauler) {
      if (byPlayer) this.emit(Ev.Hauler, x, y, 1);
      this.explode(x, y, 2.4, Col.Amber); this.spawnScrap(x, y, 8, 0);
      if (byPlayer) this.score += 60;
      return;
    }
    this.kills++;
    if (byPlayer) {
      this.score += k === Kind.Drone ? 100 : k === Kind.Gunship ? 300 : k === Kind.Boss ? 2500 : k === Kind.Sniper ? 400 : k === Kind.Splitter ? 150 : k === Kind.Tender ? 350 : k === Kind.Rammer ? 120 : 250;
      this.objProgress(0, 1);
    }
    if (byPlayer) {
      const rr = this.rng.next();
      if (rr < 0.07 && this.hp < this.hpMax * 0.8) this.spawnScrap(x, y, 25, 1);
      else if (rr < 0.14 && this.missileCap > 0) this.spawnScrap(x, y, 2, 2);
    }
    if (k === Kind.Splitter) for (let c = 0; c < 2; c++) {
      const a = this.rng.next() * TAU;
      const e = this.spawnEnt(Kind.Drone, x + Math.cos(a) * 3, y + Math.sin(a) * 3, this.evx[j] + Math.cos(a) * 50, this.evy[j] + Math.sin(a) * 50);
      if (e >= 0) this.es[e] = St.Chase;
    }
    if (k === Kind.Rammer) { this.blastZ = this.ez[j]; this.blast(x, y, 12, 26, byPlayer); }
    if (k === Kind.Gunship || k === Kind.Boss || k === Kind.Sniper || k === Kind.Tender || k === Kind.Minelayer) {
      const nc = k === Kind.Boss ? 16 : 5;        // glowing hull chunks that tumble away and cool
      for (let c = 0; c < nc; c++) {
        const a = this.rng.next() * TAU, v = 14 + this.rng.next() * (k === Kind.Boss ? 60 : 38);
        this.spawnParticle(x, y, this.evx[j] * 0.4 + Math.cos(a) * v, this.evy[j] * 0.4 + Math.sin(a) * v, 1.4 + this.rng.next() * 1.2, PK.Debris, c & 1 ? Col.Amber : Col.Fire, 2);
      }
    }
    if (k === Kind.Boss) {
      this.bossKills++; this.slowT = 0.7; this.flash = 1;
      for (let c = 0; c < 6; c++) this.explode(x + (this.rng.next() - 0.5) * 30, y + (this.rng.next() - 0.5) * 20, 2.5 + this.rng.next() * 2, c & 1 ? Col.Amber : Col.Red);
    }
    const dv = DROP[k] ?? 0;
    if (dv > 0) { const n = k === Kind.Boss ? 8 : 1; for (let c = 0; c < n; c++) this.spawnScrap(x + (this.rng.next() - 0.5) * 8, y + (this.rng.next() - 0.5) * 8, dv / n | 0 || dv); }
    this.explode(x, y, k === Kind.Drone || k === Kind.Splitter || k === Kind.Rammer ? 1.2 : k === Kind.Boss ? 5 : 2.2, k === Kind.Gunship || k === Kind.Boss ? Col.Amber : Col.Red);
  }

  /** Radial damage to everything near (x,y); chains through mines with a recursion cap. */
  /** Altitude of the current blast (set by the caller). */
  private blastZ = 0;
  private blast(x: number, y: number, radius: number, dmg: number, byPlayer: boolean): void {
    if (this.depth > 3) return;
    this.depth++;
    for (let e = 0; e < MAX_E; e++) {
      const k = this.ek[e];
      if (k === Kind.None || k === Kind.Station || (k === Kind.Freighter && byPlayer) || k === Kind.Comet || k === Kind.Wing) continue;
      const dx = this.ex[e] - x, dy = this.ey[e] - y, rr = radius + this.er[e];
      const d2 = dx * dx + dy * dy;
      if (d2 > rr * rr) continue;
      if (this.vert && Math.abs(this.ez[e] - this.blastZ) > V_TOL * 2) continue;
      const f = 1 - Math.sqrt(d2) / rr;
      this.ehp[e] -= dmg * f * (k === Kind.Asteroid ? 0.4 : 0.4 + 0.3);
      this.eflash[e] = 1;
      if (this.ehp[e] <= 0) this.killEnt(e, byPlayer);
    }
    if (this.alive) {
      const dx = this.sx - x, dy = this.sy - y, d2 = dx * dx + dy * dy, rr = radius + this.ship.radius;
      if (d2 < rr * rr && (!this.vert || Math.abs(this.sz - this.blastZ) <= V_TOL * 2)) {
        const d = Math.sqrt(d2) + 1e-4;
        this.damageShip(dmg * (1 - d / rr), dx / d, dy / d, Dmg.Thermal);
      }
    }
    this.depth--;
  }

  private shipVsEnts(): void {
    const h = this.hash, inv = h.inv;
    const cx = Math.floor(this.sx * inv), cy = Math.floor(this.sy * inv);
    for (let gy = cy - 1; gy <= cy + 1; gy++) for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let j = h.head[SpatialHash.key(gx, gy)]; j >= 0; j = h.next[j]) {
        const k = this.ek[j];
        if (k === Kind.None || k === Kind.Mine || k === Kind.Comet || k === Kind.Wing) continue;
        const dx = this.sx - this.ex[j], dy = this.sy - this.ey[j];
        const rr = this.er[j] + this.ship.radius, d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr) continue;
        if (this.vert && k !== Kind.Station && Math.abs(this.ez[j] - this.sz) > V_TOL) continue;   // different band: pass over / under
        const d = Math.sqrt(d2) + 1e-4, nx = dx / d, ny = dy / d;
        this.sx += nx * (rr - d); this.sy += ny * (rr - d);
        const rvx = this.svx - this.evx[j], rvy = this.svy - this.evy[j];
        const vn = rvx * nx + rvy * ny;
        if (vn < 0) {
          const imp = -vn;
          const mk = this.ship.mass / 100;
          this.svx += nx * imp * 1.6; this.svy += ny * imp * 1.6;
          this.evx[j] -= nx * imp * 0.5 * mk; this.evy[j] -= ny * imp * 0.5 * mk;
          if (imp > 6) {
            this.damageShip(Math.min(30, imp * 0.35), nx, ny);
            this.hitEnt(j, (k === Kind.Asteroid ? 1 : 3) * mk * this.ship.ramMult, -nx * imp, -ny * imp);
          }
        }
      }
    }
  }

  // ===================================================================== bullets
  /** Altitude given to the next spawned bullet (shooter's z). */
  shotZ = 0;
  spawnBullet(x: number, y: number, vx: number, vy: number, life: number, owner: number, dmg: number, type: number = Dmg.Kinetic): void {
    const i = this.bcur; this.bcur = (this.bcur + 1) % MAX_B;
    this.bx[i] = x; this.by[i] = y; this.bvx[i] = vx; this.bvy[i] = vy;
    this.blife[i] = life; this.bown[i] = owner; this.bdmg[i] = dmg; this.btype[i] = type; this.bz[i] = this.shotZ;
  }

  private updateBullets(): void {
    const h = this.hash, inv = h.inv;
    let n = 0;
    for (let i = 0; i < MAX_B; i++) {
      if (this.blife[i] <= 0) continue;
      n++;
      const ox = this.bx[i], oy = this.by[i];
      const nx = ox + this.bvx[i] * DT, ny = oy + this.bvy[i] * DT;
      this.bx[i] = nx; this.by[i] = ny;
      this.blife[i] -= DT;
      if (this.aimAssist === 3 && this.bown[i] === 0) {              // soft homing: turn toward the enemy nearest the bolt's heading, keep speed
        const sp = Math.sqrt(this.bvx[i] * this.bvx[i] + this.bvy[i] * this.bvy[i]) + 1e-6, va = Math.atan2(this.bvy[i], this.bvx[i]);
        const tg = this.findAimTarget(nx, ny, va, AIM_ASSIST.C_CONE, AIM_ASSIST.C_RANGE);
        if (tg >= 0) {
          const ddx = this.ex[tg] - nx, ddy = this.ey[tg] - ny, tt = Math.sqrt(ddx * ddx + ddy * ddy) / sp;
          const na = va + clamp(wrapAngle(Math.atan2(ddy + this.evy[tg] * tt, ddx + this.evx[tg] * tt) - va), -AIM_ASSIST.C_TURN * DT, AIM_ASSIST.C_TURN * DT);
          this.bvx[i] = Math.cos(na) * sp; this.bvy[i] = Math.sin(na) * sp;
        }
      }
      let dead = false;
      // planets absorb bullets
      for (let k = 0; k < this.nPl && !dead && !(this.vert && this.bz[i] > V_TOL); k++) {
        const o = k * PLANET_STRIDE, dx = nx - this.pl[o], dy = ny - this.pl[o + 1], r = this.pl[o + 2];
        if (dx * dx + dy * dy < r * r) { dead = true; this.sparks(nx, ny, 3, Col.Gray, 24); }
      }
      if (!dead && this.bown[i] === 0) {
        const sdx = nx - ox, sdy = ny - oy, sl = sdx * sdx + sdy * sdy + 1e-6;
        const cx = Math.floor(nx * inv), cy = Math.floor(ny * inv);
        for (let gy = cy - 1; gy <= cy + 1 && !dead; gy++) for (let gx = cx - 1; gx <= cx + 1 && !dead; gx++) {
          for (let j = h.head[SpatialHash.key(gx, gy)]; j >= 0; j = h.next[j]) {
            if (this.ek[j] === Kind.None || this.ek[j] === Kind.Freighter || this.ek[j] === Kind.Wing) continue;
            if (this.vert && this.ek[j] !== Kind.Station && Math.abs(this.ez[j] - this.bz[i]) > V_TOL) continue;
            let t = ((this.ex[j] - ox) * sdx + (this.ey[j] - oy) * sdy) / sl;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const qx = ox + sdx * t - this.ex[j], qy = oy + sdy * t - this.ey[j];
            const rr = this.er[j] + 0.6 + (this.aimAssist === 1 && this.isAimTarget(this.ek[j]) ? AIM_ASSIST.A_BONUS : 0);
            if (qx * qx + qy * qy < rr * rr) {
              this.hitEnt(j, this.bdmg[i], this.bvx[i], this.bvy[i]); this.hits++;
              dead = true; break;
            }
          }
        }
      } else if (!dead && this.frIdx >= 0 && this.ek[this.frIdx] === Kind.Freighter && (nx - this.ex[this.frIdx]) ** 2 + (ny - this.ey[this.frIdx]) ** 2 < (KIND_R[Kind.Freighter] + 0.8) ** 2) {
        dead = true; this.hitEnt(this.frIdx, this.bdmg[i] * 0.6, this.bvx[i], this.bvy[i]);
      } else if (!dead && this.alive) {
        const dx = nx - this.sx, dy = ny - this.sy, rr = this.ship.radius + 0.6;
        if (dx * dx + dy * dy < rr * rr && (!this.vert || Math.abs(this.bz[i] - this.sz) <= V_TOL)) {
          dead = true;
          const l = Math.sqrt(this.bvx[i] * this.bvx[i] + this.bvy[i] * this.bvy[i]) + 1e-4;
          this.damageShip(this.bdmg[i], this.bvx[i] / l, this.bvy[i] / l, this.btype[i]);
          this.sparks(nx, ny, 5, Col.Cyan, 36);
        }
      }
      if (dead) this.blife[i] = 0;
    }
    this.nBul = n;
  }

  // ===================================================================== particles / fx
  spawnParticle(x: number, y: number, vx: number, vy: number, life: number, kind: number, col: number, size: number): void {
    const i = this.pcur; this.pcur = (this.pcur + 1) & (MAX_P - 1);
    this.px[i] = x; this.py[i] = y; this.pvx[i] = vx; this.pvy[i] = vy;
    this.plife[i] = life; this.pmax[i] = life; this.pkind[i] = kind; this.pcol[i] = col; this.psize[i] = size;
  }

  sparks(x: number, y: number, n: number, col: number, speed: number): void {
    for (let i = 0; i < n; i++) {
      const a = this.rng.next() * TAU, v = speed * (0.3 + this.rng.next() * 0.9);
      this.spawnParticle(x, y, Math.cos(a) * v, Math.sin(a) * v, 0.2 + this.rng.next() * 0.35, PK.Spark, col, 1);
    }
  }

  explode(x: number, y: number, power: number, col: number): void {
    this.emit(Ev.Explosion, x, y, power);
    const n = Math.min(70, Math.floor(10 + power * 12));
    for (let i = 0; i < n; i++) {
      const a = this.rng.next() * TAU, v = (12 + this.rng.next() * 55) * Math.sqrt(power);
      this.spawnParticle(x, y, Math.cos(a) * v, Math.sin(a) * v, 0.3 + this.rng.next() * 0.7, PK.Spark, this.rng.next() < 0.3 ? Col.White : col, 1);
    }
    const nd = Math.floor(5 + power * 4);
    for (let i = 0; i < nd; i++) {
      const a = this.rng.next() * TAU, v = 6 + this.rng.next() * 26 * Math.sqrt(power);
      this.spawnParticle(x, y, Math.cos(a) * v, Math.sin(a) * v, 0.8 + this.rng.next() * 1.2, PK.Debris, col === Col.Gray ? Col.Gray : this.rng.next() < 0.5 ? col : Col.Gray, 1);
    }
    for (let i = 0; i < 3 + power * 2; i++) {
      const a = this.rng.next() * TAU, v = 2 + this.rng.next() * 9;
      this.spawnParticle(x, y, Math.cos(a) * v, Math.sin(a) * v, 1.0 + this.rng.next() * 1.2, PK.Smoke, Col.Gray, 1);
    }
    this.spawnParticle(x, y, 0, 0, 0.28 + power * 0.06, PK.Flash, col, 4 + power * 4);
    const r = this.rcur; this.rcur = (this.rcur + 1) % MAX_R;
    this.rx[r] = x; this.ry[r] = y; this.rrad[r] = 0.5; this.rmax[r] = 5 + power * 7; this.rlife[r] = 0.5; this.rcol[r] = col;
    const dx = x - this.sx, dy = y - this.sy, d = Math.sqrt(dx * dx + dy * dy);
    this.shake = Math.min(16, this.shake + power * 2.2 * clamp(1.4 - d / 140, 0.1, 1));
    if (power > 2.5 && d < 120) this.flash = Math.min(1, this.flash + 0.5);
  }

  /** A bare shock ring (screen distortion + glyph ring) without particles. */
  private ring(x: number, y: number, rmax: number, col: number): void {
    const r = this.rcur; this.rcur = (this.rcur + 1) % MAX_R;
    this.rx[r] = x; this.ry[r] = y; this.rrad[r] = 0.5; this.rmax[r] = rmax; this.rlife[r] = 0.5; this.rcol[r] = col;
  }

  private updateParticles(): void {
    let n = 0;
    const dk = Math.exp(-2.4 * DT), de = Math.exp(-1.3 * DT), dd = Math.exp(-1.1 * DT), ds = Math.exp(-0.9 * DT);
    for (let i = 0; i < MAX_P; i++) {
      const l = this.plife[i];
      if (l <= 0) continue;
      n++;
      this.plife[i] = l - DT;
      const kd = this.pkind[i];
      const f = kd === PK.Spark ? dk : kd === PK.Exhaust ? de : kd === PK.Debris ? dd : ds;
      this.pvx[i] *= f; this.pvy[i] *= f;
      this.px[i] += this.pvx[i] * DT; this.py[i] += this.pvy[i] * DT;
    }
    this.nPar = n;
    for (let r = 0; r < MAX_R; r++) {
      if (this.rlife[r] <= 0) continue;
      this.rlife[r] -= DT;
      this.rrad[r] += (this.rmax[r] - this.rrad[r]) * Math.min(1, 9 * DT);
    }
  }
}
