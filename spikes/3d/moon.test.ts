import { describe, expect, it } from 'vitest';
import { WREN } from '../../src/sim/ships';
import { DT } from '../../src/sim/sim';
import { ChaseCamera, MIN_ALT } from './camera';
import { Controls } from './controls';
import { type Input, type ShipState, SHIP_R, cruiseExit, newShip, stepShip } from './flight';
import { type Vec3, add, addScaled, cross, dot, len, norm, qAxisAngle, qFromBasis, qIdentity, qMul, scale, sub, v3 } from './math';
import { CARRY_RADII, Moon, ORBIT_PERIOD, ORBIT_RADII, moonPosition } from './moon';
import { altitude, atmoDensity, height, makePlanet, material, Mat, surfaceRadius } from './planet';
import { FlightSession } from './session';
import { buildTile, faceDir, finestDepth, selectTiles, TILE_N } from './tiles';
import { makeWorld } from './world';

const IDLE: Input = { mx: 0, my: 0, thrust: false, brake: false, roll: 0, strafeX: 0, strafeY: 0, boost: false, cruise: false };
const input = (o: Partial<Input> = {}): Input => ({ ...IDLE, ...o });
const BOOST_TOP = WREN.maxSpeed * 190 / 118;
const DIRS: Vec3[] = Array.from({ length: 4000 }, (_, i) => {
  const y = 1 - 2 * (i + 0.5) / 4000, r = Math.sqrt(1 - y * y), a = i * Math.PI * (3 - Math.sqrt(5));
  return { x: r * Math.cos(a), y, z: r * Math.sin(a) };
});

const scene = (): { planet: ReturnType<typeof makePlanet>; moon: Moon } => {
  const w = makeWorld('moon');
  return { planet: w.planet, moon: w.moon! };
};
const from = (moon: Moon, pos: Vec3): number => len(sub(v3(), pos, moon.body.center));
/** A ship `alt` above the moon's ground toward `dir`, nose at the moon's centre, moving `speed` along the nose. */
function overMoon(moon: Moon, dir: Vec3, alt: number, speed = 0): ShipState {
  const s = newShip(), d = norm(v3(), dir);
  addScaled(s.pos, moon.body.center, d, surfaceRadius(moon.body, d) + alt);
  const up = norm(v3(), cross(v3(), d, Math.abs(d.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0)));
  Object.assign(s.q, qFromBasis(cross(v3(), up, d), up, d));
  scale(s.vel, d, -speed);
  return s;
}
const finite = (o: object): boolean => Object.values(o).every(Number.isFinite);

describe('the moon scene', () => {
  it('is the default planet with an airless moon of radius 1200', () => {
    const { planet, moon } = scene();
    expect(planet).toEqual(makePlanet(1));
    expect(moon.body.radius).toBe(1200);
    expect(moon.body.atmo).toBe(0);
    expect(moon.body.kind).toBe('moon');
    expect(moon.body.relief).toBeGreaterThan(30);
    expect(makeWorld(null).moon).toBeUndefined();
  });

  it('has no atmosphere anywhere, not even in a crater below the nominal radius', () => {
    const { moon } = scene(), c = moon.body.center;
    for (const r of [0, 1000, 1199, 1200, 1201, 5000]) expect(atmoDensity(moon.body, add(v3(), c, v3(r, 0, 0)))).toBe(0);
  });
});

describe('the moon\'s orbit', () => {
  const p = makePlanet(1);
  it('is 3 planet radii from the planet\'s centre, once per 600 s, in one plane', () => {
    expect([ORBIT_RADII, ORBIT_PERIOD]).toEqual([3, 600]);
    const a = moonPosition(v3(), p, 0), b = moonPosition(v3(), p, 150), n = norm(v3(), cross(v3(), a, b));
    for (let t = 0; t < 1300; t += 37) {
      const m = moonPosition(v3(), p, t);
      expect(len(m)).toBeCloseTo(3 * p.radius, 6);
      expect(dot(m, n)).toBeCloseTo(0, 6);
      expect(len(sub(v3(), moonPosition(v3(), p, t + 600), m))).toBeLessThan(1e-6);
    }
    expect(dot(a, b)).toBeCloseTo(0, 3);
    expect(len(sub(v3(), moonPosition(v3(), p, 1), a))).toBeCloseTo(2 * Math.PI * 3 * p.radius / 600, 1);
  });
});

describe('the moon\'s craters', () => {
  const { moon } = scene(), m = moon.body;
  const hs = DIRS.map(d => height(m, d));

  it('come from the seed alone', () => {
    const again = scene().moon.body;
    for (let i = 0; i < DIRS.length; i += 7) expect(height(again, DIRS[i])).toBe(hs[i]);
    const other = makeWorld('moon', 2).moon!.body;
    expect(DIRS.slice(0, 200).map(d => height(other, d))).not.toEqual(hs.slice(0, 200));
  });

  it('stay within the relief, with deep floors and raised rims', () => {
    expect(Math.max(...hs.map(Math.abs))).toBeLessThanOrEqual(m.relief);
    expect(Math.min(...hs)).toBeLessThan(-30);
    expect(Math.max(...hs)).toBeGreaterThan(10);
    expect(hs.filter(h => Math.abs(h) >= m.relief).length).toBeLessThan(DIRS.length * 0.002);
  });

  it('have no jumps: half a unit along the ground changes the height by under one unit', () => {
    const q = v3();
    let worst = 0;
    for (const d of DIRS) {
      norm(q, addScaled(q, d, norm(v3(), cross(v3(), d, v3(0.3, 0.5, 0.8))), 0.5 / m.radius));
      worst = Math.max(worst, Math.abs(height(m, q) - height(m, d)));
    }
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThan(1);
  });

  it('are what you hit, below the nominal radius too, and never sea', () => {
    const low = DIRS[hs.indexOf(Math.min(...hs))];
    expect(surfaceRadius(m, low)).toBe(1200 + height(m, low));
    expect(altitude(m, addScaled(v3(), m.center, low, 1200))).toBeCloseTo(-height(m, low), 6);
    expect(material(m, low, height(m, low))).toBe(Mat.Land);
  });

  it('are what the mesh shows, with skirts below any crater', () => {
    const at = { ...m, center: v3() }, id = { face: 0, depth: finestDepth(at), ix: 11, iy: 23 };
    const mesh = buildTile(at, id), dir = v3();
    for (const [i, j] of [[0, 0], [7, 9], [16, 16]]) {
      const k = j * (TILE_N + 1) + i;
      const u = -1 + 2 * (id.ix * TILE_N + i) / (TILE_N * 2 ** id.depth), w = -1 + 2 * (id.iy * TILE_N + j) / (TILE_N * 2 ** id.depth);
      faceDir(dir, id.face, u, w);
      const r = Math.hypot(mesh.center.x + mesh.pos[3 * k], mesh.center.y + mesh.pos[3 * k + 1], mesh.center.z + mesh.pos[3 * k + 2]);
      expect(r).toBeCloseTo(surfaceRadius(at, dir), 2);
    }
    for (const face of [0, 2, 5]) {
      const root = buildTile(at, { face, depth: 0, ix: 0, iy: 0 }), last = root.mat.length - 1;
      const foot = Math.hypot(root.center.x + root.pos[3 * last], root.center.y + root.pos[3 * last + 1], root.center.z + root.pos[3 * last + 2]);
      expect(foot).toBeLessThan(1200 * Math.cos(Math.PI / 64) - m.relief);
    }
    expect(selectTiles(at, v3(0, 0, 1300)).length).toBeGreaterThan(6);
  });
});

describe('being carried with the moon', () => {
  it('holds the ground still under a ship within 2 moon radii of the centre', () => {
    const { planet, moon } = scene(), s = overMoon(moon, v3(0.2, 0.9, 0.4), 400);
    const start = sub(v3(), s.pos, moon.body.center), centre = { ...moon.body.center };
    expect(CARRY_RADII).toBe(2);
    for (let i = 0; i < 600; i++) stepShip(s, input(), planet, DT, { moon });
    expect(moon.time).toBeCloseTo(10, 6);
    expect(len(sub(v3(), moon.body.center, centre))).toBeGreaterThan(2000);
    expect(len(sub(v3(), sub(v3(), s.pos, moon.body.center), start))).toBeLessThan(1e-6);
    expect(s.alt).toBeCloseTo(400, 6);
  });

  it('leaves a ship farther off where it is', () => {
    const { planet, moon } = scene(), s = overMoon(moon, v3(0, 1, 0), 1300), start = { ...s.pos };
    stepShip(s, input(), planet, DT, { moon });
    expect(len(sub(v3(), s.pos, start))).toBeLessThan(1e-9);
  });

  it('takes up a ship the moon runs into, which then never meets the ground', () => {
    const { planet, moon } = scene();
    const ahead = norm(v3(), sub(v3(), moonPosition(v3(), planet, 1), moonPosition(v3(), planet, 0)));
    const s = newShip();
    addScaled(s.pos, moon.body.center, ahead, 3000);
    for (let i = 0; i < 1800; i++) { stepShip(s, input(), planet, DT, { moon }); expect(s.alt).toBeGreaterThan(1000); }
    expect(from(moon, s.pos)).toBeLessThanOrEqual(CARRY_RADII * 1200 + 4);
    expect(s.hits).toBe(0);
  });
});

describe('the moon\'s ground', () => {
  it('is not passed in one 0.25 s step at boost speed, on a moving moon', () => {
    for (const dir of [v3(1, 0, 0), v3(-0.3, 0.8, 0.5), v3(0, -1, 0), v3(0.1, 0.2, -0.97)]) {
      const { planet, moon } = scene(), s = overMoon(moon, dir, 12, BOOST_TOP);
      stepShip(s, input({ thrust: true, boost: true }), planet, 0.25, { moon });
      expect(altitude(moon.body, s.pos)).toBeGreaterThanOrEqual(SHIP_R - 1e-6);
      expect(dot(sub(v3(), s.pos, moon.body.center), norm(v3(), dir))).toBeGreaterThan(0);
      expect(s.hits).toBe(1);
    }
  });

  it('is not passed at any speed or step length', () => {
    for (const [alt, speed, dt] of [[30, 2000, 0.25], [700, 20000, 0.25], [1100, 1e5, 1], [2000, 3000, 2]] as const) {
      const { planet, moon } = scene(), dir = norm(v3(), v3(0.5, 0.5, 0.7)), s = overMoon(moon, dir, alt, speed);
      stepShip(s, input(), planet, dt, { moon });
      expect(altitude(moon.body, s.pos)).toBeGreaterThanOrEqual(SHIP_R - 1e-6);
      expect(finite(s.pos) && finite(s.vel)).toBe(true);
    }
  });

  it('bounces a ship as the planet\'s does', () => {
    const { planet, moon } = scene(), s = overMoon(moon, v3(0, 1, 0), SHIP_R + 0.5, 60);
    stepShip(s, input(), planet, DT, { moon });
    const out = norm(v3(), sub(v3(), s.pos, moon.body.center));
    expect(dot(s.vel, out)).toBeGreaterThan(20);
    expect(s.hits).toBe(1);
  });

  it('keeps the camera above it', () => {
    const { moon, planet } = scene(), s = overMoon(moon, v3(0, 1, 0), 8), cam = new ChaseCamera();
    qMul(s.q, s.q, qAxisAngle(qIdentity(), v3(1, 0, 0), Math.PI)); // nose straight up: the camera hangs below
    cam.snap(s.pos, s.q, planet, moon.body);
    expect(altitude(moon.body, cam.pos)).toBeGreaterThanOrEqual(MIN_ALT - 1e-6);
  });
});

describe('cruise by the moon', () => {
  it('drops out below max(1.5 atmosphere, 0.5 radius) near an airless body, and as before near the planet', () => {
    const { planet, moon } = scene();
    expect(cruiseExit(moon.body)).toBe(600);
    expect(cruiseExit(planet)).toBe(1.5 * planet.atmo);
  });

  it('drops out safely on the way in', () => {
    const { planet, moon } = scene();
    const out = norm(v3(), moon.body.center), s = overMoon(moon, out, 8000);
    stepShip(s, input({ cruise: true }), planet, DT, { moon });
    expect(s.cruising).toBe(true);
    for (let i = 0; i < 60 * 120 && s.cruising; i++) stepShip(s, input(), planet, DT, { moon });
    expect(s.cruising).toBe(false);
    expect(altitude(moon.body, s.pos)).toBeLessThan(600);
    expect(altitude(moon.body, s.pos)).toBeGreaterThan(500);
    // left alone, it stops well above the ground
    for (let i = 0; i < 60 * 20; i++) stepShip(s, input({ brake: true }), planet, DT, { moon });
    expect(altitude(moon.body, s.pos)).toBeGreaterThan(300);
    expect(s.hits).toBe(0);
  });

  it('goes by the nearer body', () => {
    const { planet, moon } = scene(), s = overMoon(moon, norm(v3(), moon.body.center), 3000);
    stepShip(s, input({ cruise: true }), planet, DT, { moon });
    expect(len(s.vel)).toBeCloseTo(3000 * 0.35, -1);
  });

  it('cannot be switched on near the ground', () => {
    const { planet, moon } = scene(), s = overMoon(moon, v3(0, 1, 0), 500);
    stepShip(s, input({ cruise: true }), planet, DT, { moon });
    expect(s.cruising).toBe(false);
  });
});

describe('flying over the poles with the moon about', () => {
  it('stays finite over both of the moon\'s and both of the planet\'s', () => {
    for (const onMoon of [true, false]) {
      for (const pole of [1, -1]) {
        const { planet, moon } = scene(), body = onMoon ? moon.body : planet, s = newShip(), cam = new ChaseCamera();
        addScaled(s.pos, body.center, v3(0, pole, 0), body.radius + body.relief + 60);
        addScaled(s.pos, s.pos, v3(1, 0, 0), -150);
        Object.assign(s.q, qFromBasis(v3(0, 0, pole), v3(0, pole, 0), v3(-1, 0, 0)));
        cam.snap(s.pos, s.q, planet, moon.body);
        for (let i = 0; i < 180; i++) {
          stepShip(s, input({ thrust: true }), planet, DT, { moon });
          cam.update(s.pos, s.q, planet, DT, moon.body);
          expect(finite(s.pos) && finite(s.vel) && finite(s.q) && finite(cam.pos) && Number.isFinite(s.alt)).toBe(true);
        }
        expect(s.pos.x - body.center.x).toBeGreaterThan(0);
        const at = { ...body, center: v3() };
        expect(selectTiles(at, v3(0, pole * (body.radius + 100), 0)).length).toBeGreaterThan(6);
      }
    }
  });
});

describe('a free flight round the moon', () => {
  it('moves the moon with the flight\'s clock and places it where the picture is drawn', () => {
    const { planet, moon } = scene(), session = new FlightSession(planet, v3(0, 0, 1), { near: { moon } });
    const c = new Controls();
    c.resume();
    for (let i = 0; i < 90; i++) session.advance(1 / 90, c);
    expect(moon.time).toBeCloseTo(1, 1);
    expect(len(sub(v3(), moon.body.center, moonPosition(v3(), planet, session.time)))).toBeLessThan(1e-6);
  });

  it('starts, and restarts, where the scene says', () => {
    const { planet, moon } = scene();
    let calls = 0;
    const session = new FlightSession(planet, v3(0, 0, 1), {
      near: { moon }, start: s => { calls++; addScaled(s.pos, moon.body.center, v3(0, 1, 0), 2000); Object.assign(s.prevPos, s.pos); },
    });
    const c = new Controls();
    c.resume();
    for (let i = 0; i < 120; i++) session.advance(DT, c);
    session.restart(c);
    expect(calls).toBe(2);
    expect(from(moon, session.ship.pos)).toBeCloseTo(2000, 0);
    expect(from(moon, session.pos)).toBeCloseTo(2000, 0);
  });
});
