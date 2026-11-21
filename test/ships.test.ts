import { describe, expect, it } from 'vitest';
import { In, Kind, MAX_E, Sim } from '../src/sim/sim';
import { ANVIL, BUDGET_REF, BUDGET_TOL, FIELDS, NEEDLE, ROSTER, WREN, cloneShip, derive, getField, setField, validate } from '../src/sim/ships';
import { planetsNear } from '../src/sim/world';

function emptySpace(): [number, number] {
  const out = new Float32Array(64);
  for (let i = 1; i < 200; i++) if (planetsNear(i * 520, 0, 380, out) === 0) return [i * 520, 0];
  throw new Error('no empty space');
}
function quiet(ship = WREN): Sim {
  const s = new Sim(3); s.setShip(ship); s.reset(3);
  const [x, y] = emptySpace(); s.sx = s.spx = x; s.sy = s.spy = y; s.svx = s.svy = 0; s.sa = 0;
  for (let e = 0; e < MAX_E; e++) s.ek[e] = Kind.None;
  return s;
}
const run = (s: Sim, inp: number, n: number): void => { for (let i = 0; i < n; i++) { s.input = inp; s.step(); for (let e = 0; e < MAX_E; e++) if (s.ek[e] !== Kind.Station) s.ek[e] = Kind.None; } };

describe('ShipDef validator', () => {
  it('every roster ship is valid and within the stat budget', () => {
    for (const d of ROSTER) {
      expect(validate(d).filter(i => i.level === 'error')).toEqual([]);
      expect(Math.abs(derive(d).budget / BUDGET_REF - 1)).toBeLessThanOrEqual(BUDGET_TOL);
    }
  });
  it('flags out-of-range values', () => {
    const d = cloneShip(WREN); d.grip = 1.5;
    expect(validate(d).some(i => i.field === 'grip' && i.level === 'error')).toBe(true);
  });
  it('flags impossible combinations', () => {
    const a = cloneShip(WREN); a.dashCooldown = 0.3; a.dashIFrames = 0.3;
    expect(validate(a).some(i => i.field === 'dashCooldown')).toBe(true);
    const b = cloneShip(WREN); b.thrustFwd = 1000; b.mass = 400; b.maxSpeed = 200;
    expect(validate(b).some(i => i.field === 'thrustFwd')).toBe(true);
    const c = cloneShip(WREN); c.climbRate = 0;
    expect(validate(c).some(i => i.field === 'climbRate')).toBe(true);
    const e = cloneShip(WREN); e.boostRegen = 40; e.boostDrain = 20;
    expect(validate(e).some(i => i.field === 'boostDrain')).toBe(true);
  });
  it('flags a lopsided budget', () => {
    const d = cloneShip(WREN); d.hullMax = 500; d.shieldMax = 300; d.armor = 5; d.sensorRange = 2000; d.cargo = 200;
    expect(validate(d).some(i => i.field === 'budget')).toBe(true);
  });
  it('every metadata field reads and writes', () => {
    const d = cloneShip(WREN);
    for (const f of FIELDS) { setField(d, f.key, f.min); expect(getField(d, f.key)).toBe(f.min); }
  });
});

describe('derived stats', () => {
  it('Wren readouts match its constants', () => {
    const d = derive(WREN);
    expect(d.accel).toBe(78); expect(d.topSpeed).toBe(118); expect(d.boostTop).toBeCloseTo(190);
    expect(d.turnCircle).toBeCloseTo(2 * 118 / 2.6); expect(d.ehp).toBeCloseTo(120);
    for (const k of Object.keys(d.ratings)) expect(d.ratings[k as keyof typeof d.ratings]).toBeCloseTo(50);
  });
  it('time to top speed matches the sim', () => {
    const s = quiet(); s.assist = false;
    let t = 0; while (Math.hypot(s.svx, s.svy) < 118 * 0.95 && t < 3000) { run(s, In.Thrust, 1); t++; }
    expect(t / 60).toBeCloseTo(derive(WREN).timeToTop, 1);
  });
  it('heavier, slower ships rate slower and tougher', () => {
    const a = derive(ANVIL), n = derive(NEEDLE);
    expect(a.ratings.SPEED).toBeLessThan(n.ratings.SPEED);
    expect(a.ratings.DEFENCE).toBeGreaterThan(n.ratings.DEFENCE);
    expect(n.stopDist).toBeGreaterThan(0);
  });
});

describe('runtime ship swap', () => {
  it('changes acceleration, top speed and turn rate immediately', () => {
    const w = quiet(WREN), n = quiet(NEEDLE), a = quiet(ANVIL);
    for (const s of [w, n, a]) run(s, In.Thrust, 30);
    const v = (s: Sim): number => Math.hypot(s.svx, s.svy);
    expect(v(n)).toBeGreaterThan(v(w)); expect(v(w)).toBeGreaterThan(v(a));
    for (const s of [w, n, a]) { s.svx = s.svy = 0; s.sw = 0; run(s, In.Left, 90); }
    expect(n.sw).toBeGreaterThan(w.sw); expect(w.sw).toBeGreaterThan(a.sw);
    expect(w.hpMax).toBe(100); expect(a.hpMax).toBe(190);
  });
  it('a swap mid-flight keeps the sim finite and uses the new hitbox', () => {
    const s = quiet(WREN); run(s, In.Thrust | In.Fire, 60);
    s.setShip(ANVIL); run(s, In.Thrust | In.Fire | In.Left, 60);
    expect(Number.isFinite(s.sx + s.svx + s.sa)).toBe(true);
    expect(s.ship.radius).toBe(ANVIL.radius); expect(s.ship.hardpoints.length).toBe(4);
  });
  it('strafe moves sideways without turning', () => {
    const s = quiet(WREN); run(s, In.StrafeL, 30);
    expect(s.svy).toBeGreaterThan(5); expect(Math.abs(s.sa)).toBeLessThan(1e-9);
  });
  it('needle stores two dash charges', () => {
    const s = quiet(NEEDLE); s.dashN = 2;
    run(s, In.Dodge, 1); expect(s.dashN).toBe(1);
    run(s, 0, 20); run(s, In.Dodge, 1); expect(s.dashN).toBe(0);
  });
});
