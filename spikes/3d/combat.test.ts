import { describe, expect, it } from 'vitest';
import {
  BOLT_LENGTH, CombatField, FAR_RANGE, LIMITS, NEAR_RANGE, SHIP_CLEAR, type Swarm, newSwarm, parseCombat,
} from './combat';
import { type Quat, type Vec3, addScaled, dot, len, norm, qAxisAngle, qFromBasis, qIdentity, qMul, qRotate, sub, v3 } from './math';
import { pathFocus, pose } from './path';
import { altitude, makePlanet, surfaceRadius } from './planet';
import { FlightSession } from './session';

const parse = (query: string) => parseCombat(new URLSearchParams(query));

describe('parseCombat (URL parameters)', () => {
  it('is nothing without a scene or an override', () => {
    expect(parse('')).toBeNull();
    expect(parse('auto=perf&stab=1&secs=2')).toBeNull();
  });
  it('knows the two scenes', () => {
    expect(parse('scene=combat')).toEqual({ scene: 'combat', ships: 14, bolts: 200, particles: 2000 });
    expect(parse('scene=heavy')).toEqual({ scene: 'heavy', ships: 320, bolts: 640, particles: 8192 });
  });
  it('ignores an unknown scene', () => {
    expect(parse('scene=huge')).toBeNull();
    expect(parse('scene=toString')).toBeNull();
    expect(parse('scene=huge&bolts=3')).toEqual({ scene: 'custom', ships: 0, bolts: 3, particles: 0 });
  });
  it('lets each count be set on its own, with or without a scene', () => {
    expect(parse('ships=3')).toEqual({ scene: 'custom', ships: 3, bolts: 0, particles: 0 });
    expect(parse('particles=10&bolts=2')).toEqual({ scene: 'custom', ships: 0, bolts: 2, particles: 10 });
    expect(parse('scene=heavy&ships=0&particles=100')).toEqual({ scene: 'heavy (overridden)', ships: 0, bolts: 640, particles: 100 });
  });
  it('accepts the limits and ignores what lies outside them', () => {
    expect(LIMITS).toEqual({ ships: 1024, bolts: 640, particles: 8192 });
    expect(parse('ships=1024&bolts=640&particles=8192')).toMatchObject({ ships: 1024, bolts: 640, particles: 8192 });
    expect(parse('scene=combat&ships=1025&bolts=641&particles=8193')).toEqual({ scene: 'combat', ships: 14, bolts: 200, particles: 2000 });
    for (const bad of ['ships=-1', 'ships=1.5', 'ships=abc', 'ships=', 'ships=%20']) {
      expect(parse(bad), bad).toBeNull();
      expect(parse('scene=combat&' + bad), bad).toEqual({ scene: 'combat', ships: 14, bolts: 200, particles: 2000 });
    }
  });
});

const planet = makePlanet(1);
const HEAVY = { ships: 320, bolts: 640, particles: 8192 };
const focus = pathFocus(planet);

/** A level pose `alt` over the ground at the path's focus, nose along the ground. */
function levelPose(alt: number): { pos: Vec3; q: Quat } {
  const up = norm(v3(), focus);
  const pos = addScaled(v3(), planet.center, up, surfaceRadius(planet, up) + alt);
  const side = Math.abs(up.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0);
  const back = norm(v3(), addScaled(v3(), side, up, -dot(side, up)));
  const right = v3(up.y * back.z - up.z * back.y, up.z * back.x - up.x * back.z, up.x * back.y - up.y * back.x);
  return { pos, q: qFromBasis(right, up, back) };
}
const space = (): { pos: Vec3; q: Quat } => levelPose(20000);

const snapshot = (s: Swarm): number[][] => [s.shipPos, s.shipRot, s.boltHead, s.boltTail, s.boltFriendly, s.partPos, s.partAge]
  .map(a => Array.from(a));
const at = (a: Float64Array, i: number): Vec3 => v3(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]);
const dist = (a: Float64Array, i: number, p: Vec3): number => len(sub(v3(), at(a, i), p));
/** A point in the ship's own axes: x right, y up, z forward. */
function local(p: Vec3, from: { pos: Vec3; q: Quat }): Vec3 {
  const inv = { x: -from.q.x, y: -from.q.y, z: -from.q.z, w: from.q.w };
  const v = qRotate(v3(), inv, sub(v3(), p, from.pos));
  return v3(v.x, v.y, -v.z);
}
const TIMES = [-1 / 60, 0, 0.37, 1.9, 5, 14.2, 31, 59.99, 600.5];

describe('newSwarm', () => {
  it('holds the asked-for counts in arrays of that size', () => {
    const s = newSwarm({ ships: 3, bolts: 2, particles: 5 });
    expect([s.ships, s.bolts, s.particles]).toEqual([3, 2, 5]);
    expect([s.shipPos.length, s.shipRot.length, s.boltHead.length, s.boltTail.length, s.boltFriendly.length, s.partPos.length, s.partAge.length])
      .toEqual([9, 27, 6, 6, 2, 15, 5]);
  });
});

describe('CombatField (motion)', () => {
  it('gives the same positions for the same inputs, whatever was drawn in between', () => {
    const a = new CombatField(HEAVY), b = new CombatField(HEAVY), p = levelPose(150);
    a.update(7.25, p.pos, p.q, planet);
    const first = snapshot(a.swarm);
    b.update(3, space().pos, space().q, planet);
    b.update(7.25, p.pos, p.q, planet);
    expect(snapshot(b.swarm)).toEqual(first);
    a.update(100, p.pos, p.q, planet);
    a.update(7.25, p.pos, p.q, planet);
    expect(snapshot(a.swarm)).toEqual(first);
  });
  it('is seeded', () => {
    const a = new CombatField(HEAVY, 1), b = new CombatField(HEAVY, 2), p = space();
    a.update(1, p.pos, p.q, planet); b.update(1, p.pos, p.q, planet);
    expect(snapshot(a.swarm)).not.toEqual(snapshot(b.swarm));
  });
  it('writes into the same arrays every time', () => {
    const f = new CombatField(HEAVY), p = levelPose(150);
    const arrays = (): unknown[] => Object.values(f.swarm);
    f.update(0, p.pos, p.q, planet);
    const before = arrays();
    f.update(12, p.pos, p.q, planet);
    arrays().forEach((a, i) => expect(a).toBe(before[i]));
  });
  it('moves everything with time', () => {
    const f = new CombatField(HEAVY), p = space();
    f.update(10, p.pos, p.q, planet);
    const s0 = snapshot(f.swarm);
    f.update(10.1, p.pos, p.q, planet);
    const s1 = snapshot(f.swarm);
    for (const k of [0, 2, 5]) {
      const moved = s0[k].filter((v, i) => Math.abs(v - s1[k][i]) > 1e-3).length;
      expect(moved / s0[k].length, `array ${k}`).toBeGreaterThan(0.9);
    }
  });
  it('places everything 40 to 800 units from the player', () => {
    const f = new CombatField(HEAVY);
    let near = Infinity, far = 0;
    for (const t of TIMES) {
      const p = space();
      f.update(t, p.pos, p.q, planet);
      const s = f.swarm;
      for (const [a, n] of [[s.shipPos, s.ships], [s.boltHead, s.bolts], [s.partPos, s.particles]] as const) {
        for (let i = 0; i < n; i++) { const d = dist(a, i, p.pos); near = Math.min(near, d); far = Math.max(far, d); }
      }
    }
    expect(near).toBeGreaterThanOrEqual(NEAR_RANGE - 1e-6);
    expect(far).toBeLessThanOrEqual(FAR_RANGE + 1e-6);
    expect(far).toBeGreaterThan(700); // the whole range is used
    expect(near).toBeLessThan(100);
  });
  it('keeps ships above the ground, and in range, near it', () => {
    const f = new CombatField(HEAVY);
    for (const alt of [6, 40, 150]) {
      for (const t of TIMES) {
        const p = levelPose(alt);
        f.update(t, p.pos, p.q, planet);
        for (let i = 0; i < f.swarm.ships; i++) {
          expect(altitude(planet, at(f.swarm.shipPos, i)), `ship ${i} alt ${alt} t ${t}`).toBeGreaterThanOrEqual(SHIP_CLEAR - 0.5);
          const d = dist(f.swarm.shipPos, i, p.pos);
          expect(d).toBeGreaterThanOrEqual(NEAR_RANGE - 1);
          expect(d).toBeLessThanOrEqual(FAR_RANGE + 1);
        }
      }
    }
  });
  it('keeps ships above the ground along the scripted path', () => {
    const f = new CombatField(HEAVY);
    for (let t = 15; t <= 60; t += 2.5) {
      const p = pose(t, planet);
      f.update(t, p.shipPos, p.shipQ, planet);
      for (let i = 0; i < f.swarm.ships; i++) expect(altitude(planet, at(f.swarm.shipPos, i))).toBeGreaterThanOrEqual(SHIP_CLEAR - 0.5);
    }
  });
  it('lets some bolts and particles go into the ground near it, where terrain hides them', () => {
    const f = new CombatField(HEAVY), p = levelPose(60);
    f.update(2, p.pos, p.q, planet);
    let under = 0;
    for (let i = 0; i < f.swarm.particles; i++) if (altitude(planet, at(f.swarm.partPos, i)) < 0) under++;
    expect(under).toBeGreaterThan(0);
    expect(under).toBeLessThan(f.swarm.particles / 2);
  });
  it('puts most of it ahead of the player', () => {
    const f = new CombatField(HEAVY), p = space();
    f.update(4, p.pos, p.q, planet);
    const s = f.swarm;
    for (const [a, n] of [[s.shipPos, s.ships], [s.boltHead, s.bolts], [s.partPos, s.particles]] as const) {
      let ahead = 0, behind = 0;
      for (let i = 0; i < n; i++) { const v = local(at(a, i), p); if (v.z > 0 && Math.abs(v.x) < v.z * 1.1) ahead++; if (v.z < 0) behind++; }
      expect(ahead / n).toBeGreaterThan(0.45);
      expect(behind).toBeGreaterThan(0);
    }
  });
  it('turns with the player, but not with the roll in level flight', () => {
    const f = new CombatField(HEAVY), p = levelPose(20000);
    f.update(6, p.pos, p.q, planet);
    const level = snapshot(f.swarm)[0];
    const rolled = qMul(qIdentity(), p.q, qAxisAngle(qIdentity(), v3(0, 0, -1), 0.9));
    f.update(6, p.pos, rolled, planet);
    snapshot(f.swarm)[0].forEach((v, i) => expect(v).toBeCloseTo(level[i], 4));
    const yawed = qMul(qIdentity(), p.q, qAxisAngle(qIdentity(), v3(0, 1, 0), Math.PI / 2));
    f.update(6, p.pos, yawed, planet);
    const a = local(v3(level[0], level[1], level[2]), p), b = local(at(f.swarm.shipPos, 0), { pos: p.pos, q: yawed });
    expect([b.x, b.y, b.z].map(v => +v.toFixed(3))).toEqual([a.x, a.y, a.z].map(v => +v.toFixed(3)));
  });
  it('stays finite looking straight down and straight up', () => {
    const f = new CombatField(HEAVY), p = levelPose(20000);
    for (const pitch of [Math.PI / 2, -Math.PI / 2]) {
      f.update(3, p.pos, qMul(qIdentity(), p.q, qAxisAngle(qIdentity(), v3(1, 0, 0), pitch)), planet);
      for (const a of snapshot(f.swarm)) expect(a.every(Number.isFinite)).toBe(true);
    }
  });
  it('gives every ship a right-handed unit frame with its nose along its flight', () => {
    const f = new CombatField({ ships: 20, bolts: 0, particles: 0 }), p = space();
    f.update(5, p.pos, p.q, planet);
    const before = f.swarm.shipPos.slice(), rot = f.swarm.shipRot.slice();
    f.update(5.001, p.pos, p.q, planet);
    for (let i = 0; i < 20; i++) {
      const col = (c: number): Vec3 => v3(rot[i * 9 + c * 3], rot[i * 9 + c * 3 + 1], rot[i * 9 + c * 3 + 2]);
      const r = col(0), u = col(1), b = col(2);
      for (const v of [r, u, b]) expect(len(v)).toBeCloseTo(1, 4);
      expect(dot(r, u)).toBeCloseTo(0, 4);
      expect((r.y * u.z - r.z * u.y) * b.x + (r.z * u.x - r.x * u.z) * b.y + (r.x * u.y - r.y * u.x) * b.z).toBeCloseTo(1, 4);
      const vel = norm(v3(), sub(v3(), at(f.swarm.shipPos, i), at(before, i)));
      expect(dot(vel, b), `ship ${i}`).toBeLessThan(-0.99);
    }
  });
  it('makes bolts short segments of both sides', () => {
    const f = new CombatField(HEAVY), p = space();
    f.update(8, p.pos, p.q, planet);
    const s = f.swarm;
    let friendly = 0;
    for (let i = 0; i < s.bolts; i++) {
      expect(len(sub(v3(), at(s.boltHead, i), at(s.boltTail, i)))).toBeCloseTo(BOLT_LENGTH, 4);
      friendly += s.boltFriendly[i];
    }
    expect(friendly).toBeGreaterThan(s.bolts * 0.1);
    expect(friendly).toBeLessThan(s.bolts * 0.6);
  });
  it('ages particles from 0 to 1, all ages present', () => {
    const f = new CombatField(HEAVY), p = space();
    f.update(8, p.pos, p.q, planet);
    const ages = Array.from(f.swarm.partAge);
    expect(ages.every(a => a >= 0 && a <= 1)).toBe(true);
    for (const [lo, hi] of [[0, 0.33], [0.33, 0.66], [0.66, 1]]) expect(ages.filter(a => a >= lo && a <= hi).length).toBeGreaterThan(500);
  });
  it('sends ships behind one another', () => {
    const f = new CombatField({ ships: 320, bolts: 0, particles: 0 }), p = space();
    f.update(3, p.pos, p.q, planet);
    const seen = Array.from({ length: 320 }, (_, i) => local(at(f.swarm.shipPos, i), p)).filter(v => v.z > 40);
    let overlaps = 0;
    for (let i = 0; i < seen.length; i++) {
      for (let j = 0; j < seen.length; j++) {
        const a = seen[i], b = seen[j];
        if (a.z < b.z - 30 && Math.hypot(a.x / a.z - b.x / b.z, a.y / a.z - b.y / b.z) < 8 / a.z) overlaps++;
      }
    }
    expect(overlaps).toBeGreaterThan(5);
  });
  it('copes with no ships: bolts still fly', () => {
    const f = new CombatField({ ships: 0, bolts: 20, particles: 0 }), p = space();
    f.update(2, p.pos, p.q, planet);
    for (let i = 0; i < 20; i++) expect(dist(f.swarm.boltHead, i, p.pos)).toBeGreaterThanOrEqual(NEAR_RANGE - 1e-6);
  });
});

describe('CombatField with the heading held (free flight)', () => {
  const DEG = 180 / Math.PI;
  const turned = (q: Quat, axis: Vec3, angle: number): Quat => qMul(qIdentity(), q, qAxisAngle(qIdentity(), axis, angle));
  const TURNS: [Vec3, number][] = [[v3(0, 1, 0), 1.2], [v3(1, 0, 0), -0.8], [v3(0, 0, -1), 2.5], [v3(0, 1, 0), Math.PI]];
  /** Everything that must not care which way the ship points: all but the player's own shots. */
  const others = (s: Swarm): number[][] => {
    const bolts = (a: Float64Array): number[] => Array.from(a).filter((_, i) => !s.boltFriendly[Math.floor(i / 3)]);
    return [Array.from(s.shipPos), Array.from(s.shipRot), bolts(s.boltHead), bolts(s.boltTail), Array.from(s.partPos), Array.from(s.partAge)];
  };
  const held = (p: { pos: Vec3; q: Quat }, counts = HEAVY): CombatField => {
    const f = new CombatField(counts);
    f.fixHeading(p.pos, p.q, planet);
    return f;
  };
  const radial = (p: Vec3): Vec3 => norm(v3(), sub(v3(), p, planet.center));
  /** Each ship seen from the player in a level frame of heading `h`: right, up, ahead. */
  const level = (f: CombatField, pos: Vec3, h: Vec3): number[][] => {
    const u = radial(pos), r = v3(h.y * u.z - h.z * u.y, h.z * u.x - h.x * u.z, h.x * u.y - h.y * u.x);
    return Array.from({ length: f.swarm.ships }, (_, i) => {
      const d = sub(v3(), at(f.swarm.shipPos, i), pos);
      return [dot(d, r), dot(d, u), dot(d, h)];
    });
  };
  const sameRows = (a: number[][], b: number[][]): void => {
    a.forEach((row, i) => row.forEach((v, k) => expect(v, `ship ${i} axis ${k}`).toBeCloseTo(b[i][k], 3)));
  };

  it('starts as the following swarm does in level flight', () => {
    const p = space(), a = held(p), b = new CombatField(HEAVY);
    a.update(6, p.pos, p.q, planet);
    b.update(6, p.pos, p.q, planet);
    const x = snapshot(a.swarm), y = snapshot(b.swarm);
    x[0].forEach((v, i) => expect(v).toBeCloseTo(y[0][i], 4));
  });
  it('does not move when the ship turns, pitches or rolls', () => {
    const p = space(), f = held(p);
    f.update(6, p.pos, p.q, planet);
    const before = others(f.swarm);
    for (const [axis, angle] of TURNS) {
      f.update(6, p.pos, turned(p.q, axis, angle), planet);
      expect(others(f.swarm)).toEqual(before);
    }
  });
  it('so a turn carries the enemies across the view, and a half turn leaves most of them behind', () => {
    const p = space(), f = held(p);
    const ahead = (q: Quat): number => {
      f.update(6, p.pos, q, planet);
      let n = 0;
      for (let i = 0; i < f.swarm.ships; i++) { const v = local(at(f.swarm.shipPos, i), { pos: p.pos, q }); if (v.z > 0 && Math.abs(v.x) < v.z * 1.1) n++; }
      return n / f.swarm.ships;
    };
    expect(ahead(p.q)).toBeGreaterThan(0.6);
    expect(ahead(turned(p.q, v3(0, 1, 0), Math.PI))).toBeLessThan(0.2);
  });
  it('is level, along the way out of the dive, when flight starts looking straight down', () => {
    const start = new FlightSession(planet, focus), f = held({ pos: start.pos, q: start.q });
    const h = qRotate(v3(), start.q, v3(0, 1, 0)), n = radial(start.pos);
    expect(dot(h, n)).toBeCloseTo(0, 6); // the screen's up at the start lies along the ground
    f.update(4, start.pos, start.q, planet);
    const rows = level(f, start.pos, h);
    for (const [r, u, a] of rows) expect(Math.abs(Math.atan2(u, Math.hypot(r, a)) * DEG)).toBeLessThan(45);
    expect(rows.filter(([r, , a]) => a > 0 && Math.abs(r) < a * 1.3).length / rows.length).toBeGreaterThan(0.6);
  });
  it('goes with the player over the planet, staying level and on its bearing', () => {
    const p = space(), f = held(p), n = radial(p.pos), h = qRotate(v3(), p.q, v3(0, 0, -1));
    f.update(6, p.pos, p.q, planet);
    const first = level(f, p.pos, h);
    const away = len(sub(v3(), p.pos, planet.center));
    const side = v3(h.y * n.z - h.z * n.y, h.z * n.x - h.x * n.z, h.x * n.y - h.y * n.x);
    for (const angle of [0.5, 2]) {
      // along the heading: the heading tips over with the ground
      const c = Math.cos(angle), s = Math.sin(angle);
      const n1 = v3(n.x * c + h.x * s, n.y * c + h.y * s, n.z * c + h.z * s);
      const h1 = v3(h.x * c - n.x * s, h.y * c - n.y * s, h.z * c - n.z * s);
      const ahead = addScaled(v3(), planet.center, n1, away);
      f.update(6, ahead, p.q, planet);
      sameRows(level(f, ahead, h1), first);
      // to the side: the heading stays what it was
      const n2 = v3(n.x * c + side.x * s, n.y * c + side.y * s, n.z * c + side.z * s);
      const over = addScaled(v3(), planet.center, n2, away);
      f.update(6, over, p.q, planet);
      sameRows(level(f, over, h), first);
    }
  });
  it('depends on where the player is, not on the way there', () => {
    const p = space(), a = held(p), b = held(p);
    const mid = addScaled(v3(), p.pos, v3(1, 0.3, -0.5), 9000), end = addScaled(v3(), p.pos, v3(-0.4, 1, 0.8), 7000);
    a.update(6, end, p.q, planet);
    b.update(6, mid, p.q, planet);
    b.update(6, end, p.q, planet);
    expect(others(b.swarm)).toEqual(others(a.swarm));
  });
  it('takes a new heading when it is fixed again', () => {
    const p = space(), other = turned(p.q, v3(0, 1, 0), 2), f = held(p);
    f.update(6, p.pos, p.q, planet);
    const first = others(f.swarm);
    f.fixHeading(p.pos, other, planet);
    f.update(6, p.pos, p.q, planet);
    expect(others(f.swarm)).not.toEqual(first);
    f.fixHeading(p.pos, p.q, planet);
    f.update(6, p.pos, p.q, planet);
    expect(others(f.swarm)).toEqual(first);
  });
  it('lets the player\'s own shots leave from the ship as it now points', () => {
    const p = space(), f = held(p), q = turned(turned(p.q, v3(0, 1, 0), 2.2), v3(0, 0, -1), 0.7);
    let checked = 0;
    for (const t of [1, 2.5, 4, 7.5]) {
      f.update(t, p.pos, q, planet);
      const s = f.swarm;
      for (let i = 0; i < s.bolts; i += 8) {
        const d = dist(s.boltHead, i, p.pos);
        if (d < NEAR_RANGE + 0.01 || d > FAR_RANGE - 0.01) continue; // held at the edge of the range, off its line
        const head = at(s.boltHead, i), way = norm(v3(), sub(v3(), head, at(s.boltTail, i)));
        const miss = Math.min(...[-12, 12].map(x => {
          const m = addScaled(v3(), p.pos, qRotate(v3(), q, v3(x, -2, -(NEAR_RANGE + 2))), 1);
          const to = sub(v3(), m, head);
          return len(addScaled(v3(), to, way, -dot(to, way)));
        }));
        expect(miss, `bolt ${i} at ${t}`).toBeLessThan(1e-3);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
  it('stays finite at the far side of the planet', () => {
    const p = space(), f = held(p);
    f.update(3, addScaled(v3(), planet.center, radial(p.pos), -len(sub(v3(), p.pos, planet.center))), p.q, planet);
    for (const a of snapshot(f.swarm)) expect(a.every(Number.isFinite)).toBe(true);
  });
});
