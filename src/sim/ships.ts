/**
 * Ships as pure data. The flight model, weapons and defences read only these fields (plus upgrade modifiers).
 * Units: world units (1 cell), seconds, radians. See TUNING.md for what every field does and its safe range.
 */
export type Hardpoint = 'fixed' | 'turret';
export interface Resist { kinetic: number; thermal: number; em: number }

export interface ShipDef {
  id: string; name: string; role: string; quirk: string;
  /** Sprite type drawn for this hull (gfx Spr id). */
  art: number;

  // Flight
  mass: number; thrustFwd: number; thrustRev: number; thrustLat: number; maxSpeed: number;
  grip: number; assist: number; brake: number; turnRate: number; turnAccel: number;
  boostMult: number; boostCap: number; boostDrain: number; boostRegen: number;
  dashImpulse: number; dashCooldown: number; dashIFrames: number; dashCharges: number;
  gravSusceptibility: number;

  // Energy and heat
  energyMax: number; energyRegen: number; heatMax: number; heatDissipation: number;

  // Defence
  hullMax: number; hullRegen: number; hullRegenDelay: number; armor: number;
  shieldMax: number; shieldRegen: number; shieldDelay: number;
  resist: Resist; radius: number; signature: number;

  // Offence
  hardpoints: Hardpoint[]; muzzle?: number[]; fireRateMult: number; damageMult: number; boltSpeedMult: number; spread: number; missileCap: number;

  // Exploration and utility
  fuelMax: number; fuelBurn: number; jumpRange: number; jumpCharge: number; sensorRange: number; scanRate: number;
  cargo: number; tractor: number;

  // Vertical flight (M4)
  climbRate: number; altitudeBands: number;
}

/** Flight constants that are not per-ship (shared by every hull). */
export const FLIGHT = { DRAG: 0.09, GRIP_COAST_K: 0.3125, GRIP_FWD: 0.5, TURN_DECAY_K: 12 / 9, AIM_TURN_K: 3.7 / 2.6, BOOST_TOP_K: 190 / 118, SPEED_CAP_K: 2.5,
  FIRE_COOL: 0.105, BOLT_SPEED: 215, SIDE_SPEED: 205, MUZZLE: 9.5, KICK: 0.35 };

/** The original ship. Values reproduce the pre-ShipDef constants exactly (proved by test/wren.test.ts). */
export const WREN: ShipDef = {
  id: 'wren', name: 'WREN', role: 'ALL-ROUNDER', quirk: 'Strongest flight assist', art: 0,
  mass: 100, thrustFwd: 7800, thrustRev: 0, thrustLat: 3500, maxSpeed: 118,
  grip: 0.8, assist: 0.9, brake: 2.8, turnRate: 2.6, turnAccel: 9,
  boostMult: 1.9, boostCap: 100, boostDrain: 30, boostRegen: 9,
  dashImpulse: 70, dashCooldown: 1.3, dashIFrames: 0.3, dashCharges: 1,
  gravSusceptibility: 1,
  energyMax: 100, energyRegen: 14, heatMax: 100, heatDissipation: 12,
  hullMax: 100, hullRegen: 3.5, hullRegenDelay: 5, armor: 0,
  shieldMax: 20, shieldRegen: 8, shieldDelay: 3,
  resist: { kinetic: 0, thermal: 0, em: 0 }, radius: 2.4, signature: 1,
  hardpoints: ['fixed', 'fixed'], fireRateMult: 1, damageMult: 1, boltSpeedMult: 1, spread: 0.03, missileCap: 0,
  fuelMax: 100, fuelBurn: 0.25, jumpRange: 14, jumpCharge: 4, sensorRange: 600, scanRate: 1,
  cargo: 20, tractor: 28,
  climbRate: 2.5, altitudeBands: 3,
};

/** Relative-to-Wren starting points (Wren = 100) from the design brief, turned into absolute defs. */
function make(base: Partial<ShipDef> & { id: string; name: string; role: string; quirk: string; art: number },
  r: { mass: number; accel: number; top: number; turn: number; grip: number; boost: number; hull: number; shield: number; sig: number; sens: number; fuel: number; cargo: number }): ShipDef {
  const w = WREN, mass = w.mass * r.mass / 100;
  const d: ShipDef = { ...w, ...base, resist: { ...w.resist, ...(base.resist ?? {}) }, hardpoints: base.hardpoints ?? w.hardpoints.slice() } as ShipDef;
  d.mass = mass;
  d.thrustFwd = Math.round(w.thrustFwd / w.mass * r.accel / 100 * mass);
  d.thrustLat = base.thrustLat ?? Math.round(w.thrustLat / w.mass * r.accel / 100 * mass);
  d.thrustRev = base.thrustRev ?? Math.round(d.thrustFwd * 0.35);
  d.maxSpeed = Math.round(w.maxSpeed * r.top / 100);
  d.turnRate = +(w.turnRate * r.turn / 100).toFixed(2); d.turnAccel = +(w.turnAccel * r.turn / 100).toFixed(2);
  d.grip = Math.min(1, +(w.grip * r.grip / 100).toFixed(2));
  d.boostCap = Math.round(w.boostCap * r.boost / 100); d.boostRegen = +(w.boostRegen * r.boost / 100).toFixed(1);
  d.hullMax = Math.round(w.hullMax * r.hull / 100); d.shieldMax = Math.round(w.shieldMax * r.shield / 100);
  d.signature = +(w.signature * r.sig / 100).toFixed(2); d.sensorRange = Math.round(w.sensorRange * r.sens / 100);
  d.fuelMax = Math.round(w.fuelMax * r.fuel / 100); d.cargo = Math.round(w.cargo * r.cargo / 100);
  return d;
}

export const NEEDLE = make({ id: 'needle', name: 'NEEDLE', role: 'INTERCEPTOR', quirk: 'Dash has two charges', art: 14, assist: 0.55, dashCharges: 2, dashCooldown: 1.6,
  radius: 1.8, fireRateMult: 1.1, damageMult: 0.8, boltSpeedMult: 1.15, climbRate: 4, heatDissipation: 11, scanRate: 0.9, jumpRange: 12, tractor: 24 },
{ mass: 60, accel: 130, top: 125, turn: 140, grip: 110, boost: 130, hull: 55, shield: 70, sig: 110, sens: 90, fuel: 90, cargo: 40 });

export const ANVIL = make({ id: 'anvil', name: 'ANVIL', role: 'GUNSHIP', quirk: 'Ramming deals heavy damage', art: 15, assist: 0.6, armor: 1.5,
  hardpoints: ['fixed', 'fixed', 'fixed', 'fixed'], muzzle: [-3.4, 1.1, -1.1, 3.4], fireRateMult: 0.62, damageMult: 1.15, boltSpeedMult: 0.95, spread: 0.05,
  resist: { kinetic: 0.25, thermal: 0.1, em: 0 }, radius: 3.2, climbRate: 1.8, heatMax: 140, heatDissipation: 14, scanRate: 0.7, jumpRange: 10, dashImpulse: 55 },
{ mass: 170, accel: 70, top: 80, turn: 65, grip: 120, boost: 70, hull: 190, shield: 130, sig: 130, sens: 90, fuel: 80, cargo: 80 });

export const SEXTANT = make({ id: 'sextant', name: 'SEXTANT', role: 'SURVEYOR', quirk: 'Scans ignore nebula interference', art: 16, assist: 0.7,
  hardpoints: ['fixed'], fireRateMult: 1.3, damageMult: 0.95, scanRate: 2.2, jumpRange: 22, jumpCharge: 3, fuelBurn: 0.2, resist: { kinetic: 0, thermal: 0.1, em: 0.3 },
  radius: 2.3, climbRate: 2.5, tractor: 30 },
{ mass: 90, accel: 85, top: 95, turn: 90, grip: 100, boost: 80, hull: 80, shield: 90, sig: 70, sens: 220, fuel: 200, cargo: 90 });

export const MULE = make({ id: 'mule', name: 'MULE', role: 'HAULER', quirk: 'Cargo soaks damage', art: 17, assist: 0.6, armor: 1,
  hardpoints: ['turret', 'turret'], fireRateMult: 0.8, damageMult: 0.9, resist: { kinetic: 0.1, thermal: 0.1, em: 0.1 },
  radius: 3.4, climbRate: 1.2, jumpRange: 12, tractor: 40, dashImpulse: 45, scanRate: 0.8 },
{ mass: 220, accel: 55, top: 70, turn: 50, grip: 130, boost: 50, hull: 150, shield: 100, sig: 140, sens: 80, fuel: 130, cargo: 400 });

export const SHADE = make({ id: 'shade', name: 'SHADE', role: 'STEALTH', quirk: 'Engines off means near-zero signature', art: 18, assist: 0.5,
  fireRateMult: 1.05, damageMult: 1.1, radius: 2.0, climbRate: 3.5, resist: { kinetic: 0, thermal: 0, em: 0.2 }, scanRate: 1.1, jumpRange: 15 },
{ mass: 70, accel: 110, top: 105, turn: 120, grip: 80, boost: 120, hull: 60, shield: 50, sig: 40, sens: 120, fuel: 100, cargo: 60 });

export const MAGPIE = make({ id: 'magpie', name: 'MAGPIE', role: 'SALVAGER', quirk: 'Wide tractor, slow self-repair', art: 19, assist: 0.75,
  hardpoints: ['fixed'], fireRateMult: 1.4, damageMult: 1.0, tractor: 70, hullRegen: 1.5, hullRegenDelay: 0, radius: 2.6, climbRate: 2.2, scanRate: 1.2, jumpRange: 14,
  resist: { kinetic: 0.1, thermal: 0, em: 0 } },
{ mass: 110, accel: 95, top: 90, turn: 100, grip: 105, boost: 90, hull: 100, shield: 90, sig: 100, sens: 110, fuel: 110, cargo: 150 });

export const HIVE = make({ id: 'hive', name: 'HIVE', role: 'CARRIER', quirk: 'Launches small drone wingmen', art: 20, assist: 0.6, armor: 1,
  hardpoints: ['turret'], fireRateMult: 1.2, damageMult: 1.0, resist: { kinetic: 0.15, thermal: 0.15, em: 0.15 },
  radius: 3.6, climbRate: 0, altitudeBands: 1, jumpRange: 16, scanRate: 1.0, tractor: 36, dashImpulse: 40 },
{ mass: 260, accel: 50, top: 65, turn: 45, grip: 140, boost: 45, hull: 220, shield: 160, sig: 150, sens: 130, fuel: 140, cargo: 200 });

/** Enemies share the schema for the fields that make sense to them (indexed by sim Kind). sensorRange = aggro range. */
export interface EnemyDef { name: string; mass: number; thrustFwd: number; maxSpeed: number; turnRate: number; hullMax: number; radius: number; sensorRange: number }
const E = (name: string, mass: number, accel: number, maxSpeed: number, turnRate: number, hullMax: number, radius: number, sensorRange: number): EnemyDef =>
  ({ name, mass, thrustFwd: accel * mass, maxSpeed, turnRate, hullMax, radius, sensorRange });
export const ENEMY: EnemyDef[] = [
  E('none', 1, 0, 0, 0, 0, 0, 0), E('drone', 20, 120, 64, 7, 2, 1.8, 210), E('gunship', 80, 60, 42, 3.4, 9, 3.6, 230), E('minelayer', 70, 44, 34, 2.4, 6, 3.0, 260),
  E('mine', 5, 0, 0, 0, 1, 1.6, 0), E('asteroid', 50, 0, 0, 0, 0, 0, 0), E('station', 1000, 0, 0, 0, 1e9, 11.5, 0), E('boss', 600, 34, 24, 1.6, 110, 10, 420),
  E('sniper', 50, 44, 30, 3.0, 5, 3.0, 330), E('splitter', 25, 110, 56, 6, 3, 2.6, 220), E('tender', 60, 40, 28, 2.2, 8, 3.4, 250), E('rammer', 30, 200, 96, 9, 2, 1.8, 300),
  E('freighter', 400, 10, 14, 1, 40, 5.0, 0), E('comet', 200, 0, 90, 0, 1e9, 4.5, 0), E('hauler', 300, 0, 14, 0, 6, 4.2, 0),
];

export const ROSTER: ShipDef[] = [WREN, NEEDLE, ANVIL, SEXTANT, MULE, SHADE, MAGPIE, HIVE];
export function shipById(id: string): ShipDef { return ROSTER.find(s => s.id === id) ?? WREN; }
export function cloneShip(d: ShipDef): ShipDef { return { ...d, resist: { ...d.resist }, hardpoints: d.hardpoints.slice(), muzzle: d.muzzle?.slice() }; }
/** Copy every field of `src` into `dst` in place (keeps references held by the sim / tuning panel valid). */
export function assignShip(dst: ShipDef, src: ShipDef): void {
  const r = dst.resist, h = dst.hardpoints;
  Object.assign(dst, src); dst.resist = r; dst.hardpoints = h; dst.muzzle = src.muzzle?.slice();
  r.kinetic = src.resist.kinetic; r.thermal = src.resist.thermal; r.em = src.resist.em;
  h.length = 0; for (const x of src.hardpoints) h.push(x);
}

// ===================================================================== field metadata (shared by tuning panel + validator)
export interface FieldMeta { key: string; min: number; max: number; step: number; group: string; wired: string; doc: string }
const F = (key: string, min: number, max: number, step: number, group: string, wired: string, doc: string): FieldMeta => ({ key, min, max, step, group, wired, doc });
export const FIELDS: FieldMeta[] = [
  F('mass', 20, 400, 1, 'flight', 'M1', 'scales acceleration (thrust/mass), ram damage dealt, knockback taken'),
  F('thrustFwd', 1000, 40000, 50, 'flight', 'M1', 'forward thrust; acceleration = thrustFwd / mass'),
  F('thrustRev', 0, 20000, 50, 'flight', 'M1', 'reverse thrust while braking below 4 u/s (backing up)'),
  F('thrustLat', 0, 20000, 50, 'flight', 'M1', 'strafe thrust (strafe keys)'),
  F('maxSpeed', 40, 260, 1, 'flight', 'M1', 'cruise speed cap; boost cap is maxSpeed x 1.61'),
  F('grip', 0, 1, 0.01, 'flight', 'M1', 'lateral grip per second under thrust (coasting uses 31%); low = drift'),
  F('assist', 0, 1, 0.01, 'flight', 'M1', 'flight-assist damping per second when not thrusting (assist on)'),
  F('brake', 0.2, 8, 0.05, 'flight', 'M1', 'brake damping per second'),
  F('turnRate', 0.5, 6, 0.05, 'flight', 'M1', 'max keyboard turn rate (rad/s); mouse aim uses x1.42'),
  F('turnAccel', 1, 30, 0.1, 'flight', 'M1', 'angular acceleration (rad/s^2); release decays at x1.33'),
  F('boostMult', 1, 3.5, 0.05, 'flight', 'M1', 'thrust multiplier while boosting'),
  F('boostCap', 20, 300, 1, 'flight', 'M1', 'boost energy capacity'),
  F('boostDrain', 5, 80, 1, 'flight', 'M1', 'boost energy used per second'),
  F('boostRegen', 1, 40, 0.5, 'flight', 'M1', 'boost energy regained per second'),
  F('dashImpulse', 0, 160, 1, 'flight', 'M1', 'dodge velocity impulse'),
  F('dashCooldown', 0.3, 5, 0.05, 'flight', 'M1', 'seconds per dash charge'),
  F('dashIFrames', 0, 1, 0.01, 'flight', 'M1', 'invulnerable seconds after a dash'),
  F('dashCharges', 1, 3, 1, 'flight', 'M2', 'dash charges'),
  F('gravSusceptibility', 0, 2, 0.05, 'flight', 'M1', 'multiplier on planet gravity pull'),
  F('energyMax', 20, 300, 1, 'power', 'M2', 'weapon energy capacity (1 per bolt)'),
  F('energyRegen', 1, 60, 0.5, 'power', 'M2', 'weapon energy per second'),
  F('heatMax', 30, 300, 1, 'power', 'M2', 'heat capacity; over it weapons lock and the hull burns'),
  F('heatDissipation', 1, 40, 0.5, 'power', 'M2', 'heat shed per second'),
  F('hullMax', 20, 500, 1, 'defence', 'M1', 'hull points'),
  F('hullRegen', 0, 10, 0.1, 'defence', 'M1', 'hull repair per second'),
  F('hullRegenDelay', 0, 15, 0.5, 'defence', 'M1', 'seconds after a hit before hull repair starts (0 = always)'),
  F('armor', 0, 6, 0.1, 'defence', 'M2', 'flat damage reduction per hit (never below 25% of the hit)'),
  F('shieldMax', 0, 300, 1, 'defence', 'M2', 'shield points, absorbed before hull'),
  F('shieldRegen', 0, 40, 0.5, 'defence', 'M2', 'shield regen per second'),
  F('shieldDelay', 0, 10, 0.1, 'defence', 'M2', 'seconds after a hit before shields regen'),
  F('resist.kinetic', 0, 0.8, 0.01, 'defence', 'M2', 'fraction of kinetic damage ignored (bolts, rams, rocks)'),
  F('resist.thermal', 0, 0.8, 0.01, 'defence', 'M2', 'fraction of thermal damage ignored (blasts, heat, plasma)'),
  F('resist.em', 0, 0.8, 0.01, 'defence', 'M2', 'fraction of EM damage ignored (rail shots, radiation)'),
  F('radius', 1, 6, 0.1, 'defence', 'M1', 'hitbox radius'),
  F('signature', 0.1, 3, 0.01, 'defence', 'M2', 'detectability: scales enemy notice range; boost/firing raise it'),
  F('fireRateMult', 0.2, 3, 0.01, 'offence', 'M1', 'fire rate multiplier (cooldown 0.105 s x 2 / hardpoints / mult)'),
  F('damageMult', 0.2, 3, 0.01, 'offence', 'M1', 'bolt damage multiplier'),
  F('boltSpeedMult', 0.5, 2, 0.01, 'offence', 'M1', 'bolt speed multiplier'),
  F('spread', 0, 0.3, 0.005, 'offence', 'M1', 'random aim jitter (rad)'),
  F('missileCap', 0, 12, 1, 'offence', 'M1', 'base missile capacity (the MISSILES module adds to it)'),
  F('fuelMax', 10, 400, 1, 'utility', 'M5', 'fuel capacity'),
  F('fuelBurn', 0, 2, 0.01, 'utility', 'M5', 'fuel per second of thrust (jumps cost fuel by distance)'),
  F('jumpRange', 2, 40, 0.5, 'utility', 'M5', 'jump range on the chart (light-years)'),
  F('jumpCharge', 0.5, 15, 0.1, 'utility', 'M5', 'seconds to charge the jump drive'),
  F('sensorRange', 100, 2000, 10, 'utility', 'M5', 'scan range and signal-detection range'),
  F('scanRate', 0.1, 5, 0.05, 'utility', 'M5', 'scan speed multiplier (base scan 2.5 s)'),
  F('cargo', 0, 200, 1, 'utility', 'M6', 'cargo hold (trade goods)'),
  F('tractor', 5, 120, 1, 'utility', 'M1', 'pickup / salvage pull radius'),
  F('climbRate', 0, 8, 0.1, 'vertical', 'M4', 'band changes per second (0 = locked to one band)'),
  F('altitudeBands', 1, 3, 1, 'vertical', 'M4', 'altitude bands this hull can use'),
];
export function getField(d: ShipDef, key: string): number {
  if (key.startsWith('resist.')) return d.resist[key.slice(7) as keyof Resist];
  return (d as unknown as Record<string, number>)[key];
}
export function setField(d: ShipDef, key: string, v: number): void {
  if (key.startsWith('resist.')) d.resist[key.slice(7) as keyof Resist] = v;
  else (d as unknown as Record<string, number>)[key] = v;
}

// ===================================================================== derived readouts
export interface Derived {
  accel: number; boostAccel: number; topSpeed: number; boostTop: number; timeToTop: number; stopDist: number; turnCircle: number;
  ehp: number; ptw: number; dps: number; ratings: Record<RatingKey, number>; budget: number;
}
export type RatingKey = 'SPEED' | 'AGILITY' | 'DEFENCE' | 'FIREPOWER' | 'SENSORS' | 'STEALTH' | 'HAUL';
export const RATING_KEYS: RatingKey[] = ['SPEED', 'AGILITY', 'DEFENCE', 'FIREPOWER', 'SENSORS', 'STEALTH', 'HAUL'];

/** Time to reach 95% of top speed under full thrust from rest, using the sim's own integration (DT, drag, cap). */
function timeToTop(a: number, top: number): number {
  const dt = 1 / 60, k = Math.exp(-FLIGHT.DRAG * dt);
  let v = 0;
  for (let t = 0; t < 120 * 60; t++) { v = (v + a * dt) * k; if (v > top) v = top; if (v >= top * 0.95) return (t + 1) * dt; }
  return Infinity;
}
/** 0..100 on a log scale where Wren's value scores 50 and 4x (or 1/4) saturates. */
function rate(x: number, ref: number): number { return Math.max(0, Math.min(100, 50 + 50 * Math.log(Math.max(1e-6, x) / ref) / Math.log(4))); }
export function dpsOf(d: ShipDef): number {
  const hp = Math.max(1, d.hardpoints.length), turret = d.hardpoints.filter(h => h === 'turret').length / hp;
  return d.damageMult / (FLIGHT.FIRE_COOL * 2 / hp / d.fireRateMult) * (1 + 0.2 * turret);
}
export function ehpOf(d: ShipDef): number {
  const res = (d.resist.kinetic + d.resist.thermal + d.resist.em) / 3;
  return (d.hullMax + d.shieldMax) / (1 - res) / Math.max(0.25, 1 - d.armor / 5);
}
export function derive(d: ShipDef): Derived {
  const accel = d.thrustFwd / d.mass, top = d.maxSpeed, w = WREN;
  const ttt = timeToTop(accel, top);
  const ratingOf = (s: ShipDef): Record<RatingKey, number> => {
    const a = s.thrustFwd / s.mass, wa = w.thrustFwd / w.mass;
    const g3 = (x: number, y: number, z: number): number => Math.cbrt(x * y * z);
    return {
      SPEED: rate(g3(a / wa, s.maxSpeed / w.maxSpeed, (s.boostCap * s.boostMult * s.boostRegen) / (w.boostCap * w.boostMult * w.boostRegen)), 1),
      AGILITY: rate(g3(s.turnRate / w.turnRate, s.turnAccel / w.turnAccel, (s.grip + 0.2) / (w.grip + 0.2)), 1),
      DEFENCE: rate(ehpOf(s) + s.hullRegen * 10, ehpOf(w) + w.hullRegen * 10),
      FIREPOWER: rate(dpsOf(s) * Math.sqrt(s.boltSpeedMult), dpsOf(w)),
      SENSORS: rate(g3(s.sensorRange / w.sensorRange, s.scanRate / w.scanRate, (s.jumpRange * s.fuelMax) / (w.jumpRange * w.fuelMax)), 1),
      STEALTH: rate(w.signature / s.signature, 1),
      HAUL: rate(Math.sqrt((s.cargo + 10) / (w.cargo + 10) * s.tractor / w.tractor), 1),
    };
  };
  const ratings = ratingOf(d);
  let budget = 0; for (const k of RATING_KEYS) budget += ratings[k];
  return {
    accel, boostAccel: accel * d.boostMult, topSpeed: top, boostTop: top * FLIGHT.BOOST_TOP_K, timeToTop: ttt,
    stopDist: top / (d.brake + FLIGHT.DRAG + d.assist), turnCircle: 2 * top / d.turnRate,
    ehp: ehpOf(d), ptw: d.thrustFwd / d.mass / 9.81, dps: dpsOf(d), ratings, budget,
  };
}
export const BUDGET_REF = derive(WREN).budget;
export const BUDGET_TOL = 0.15;

// ===================================================================== validator
export interface Issue { level: 'error' | 'warn'; field: string; msg: string }
export function validate(d: ShipDef): Issue[] {
  const out: Issue[] = [];
  for (const f of FIELDS) {
    const v = getField(d, f.key);
    if (typeof v !== 'number' || !Number.isFinite(v)) out.push({ level: 'error', field: f.key, msg: 'not a finite number' });
    else if (v < f.min || v > f.max) out.push({ level: 'error', field: f.key, msg: `${v} outside ${f.min}..${f.max}` });
  }
  if (d.hardpoints.length < 1 || d.hardpoints.length > 6) out.push({ level: 'error', field: 'hardpoints', msg: 'needs 1..6 hardpoints' });
  if (d.dashCooldown < d.dashIFrames * 1.5) out.push({ level: 'error', field: 'dashCooldown', msg: 'dash cooldown shorter than 1.5x its invulnerability: permanent i-frames' });
  if (d.boostDrain <= d.boostRegen) out.push({ level: 'warn', field: 'boostDrain', msg: 'boost regenerates faster than it drains: infinite boost' });
  if (d.shieldMax === 0 && d.shieldRegen > 0) out.push({ level: 'warn', field: 'shieldRegen', msg: 'shield regen with no shield' });
  if (d.altitudeBands > 1 && d.climbRate <= 0) out.push({ level: 'error', field: 'climbRate', msg: 'several altitude bands but cannot climb' });
  if (d.jumpRange > 0 && d.fuelMax < 15) out.push({ level: 'warn', field: 'fuelMax', msg: 'too little fuel to make a jump' });
  const dv = derive(d);
  if (!Number.isFinite(dv.timeToTop) || dv.timeToTop > 30) out.push({ level: 'error', field: 'thrustFwd', msg: 'cannot reach 95% of top speed within 30 s (thrust too low for the drag)' });
  if (dv.turnCircle > 400) out.push({ level: 'warn', field: 'turnRate', msg: `turn circle ${dv.turnCircle | 0} u: cannot turn inside a sector` });
  if (d.energyRegen < dpsOf(d) / d.damageMult * 0.25) out.push({ level: 'warn', field: 'energyRegen', msg: 'energy regen sustains under 25% of the fire rate' });
  const dev = dv.budget / BUDGET_REF - 1;
  if (Math.abs(dev) > BUDGET_TOL) out.push({ level: 'warn', field: 'budget', msg: `stat budget ${dv.budget | 0} is ${(dev * 100).toFixed(0)}% from Wren's ${BUDGET_REF | 0}` });
  return out;
}
export function bar(v: number, w = 10): string { const n = Math.max(0, Math.min(w, Math.round(v / 100 * w))); return '#'.repeat(n) + '.'.repeat(w - n); }
