/** ?check=occlusion: do the world and ships hide ships, markers, bolts and particles? Each case places objects
 *  fully behind an occluder and then the same ones in front of it, on the same cells, and compares the finished
 *  screen, pixel by pixel and character by character, with the picture without them. Behind: nothing may change.
 *  In front: every cell they were placed on must show them. Control: behind, with the characters' occlusion switched
 *  off, they show (so they were on screen). The counts the reports give are checked on the way.
 *  The result is shown as text and logged; the title becomes 'done'. */
import { CHARSET, gi } from '../../src/gfx/atlas';
import { ChaseCamera } from './camera';
import { type Swarm, newSwarm } from './combat';
import { SHIP_SPAN, type SwarmCounts, type Tally, isMarker, shipSpanCells } from './combatDraw';
import { type Quat, type Vec3, add, addScaled, cross, dot, len, norm, qFromBasis, qRotate, scale, sub, v3 } from './math';
import { type Page, element } from './page';
import { pathFocus } from './path';
import { surfaceRadius } from './planet';
import { SUN } from './shaders';
import { FOV_Y, type Frame3 } from './render';

/** Room the renderer needs for the check's own objects. */
export const CHECK_ROOM = { ships: 128, bolts: 128, particles: 256 };

type Kind = 'particles' | 'bolts' | 'markers' | 'ships';
/** An object by the cell it is centred on (column, row from the bottom) and, for a bolt, the columns it runs. */
interface Spot { x: number; y: number; run: number; behind: number; front: number }
interface Shot { pixels: Uint8Array; glyphs: Uint8Array; counts: SwarmCounts }

const TAN = Math.tan(FOV_Y / 2);

export function runCheck(page: Page): void {
  const { renderer, planet, info } = page, gl = renderer.gl;
  renderer.rockDir = pathFocus(planet);
  page.fit();
  const { cols, rows, W, H } = renderer;
  const lines: string[] = [];
  let failed = 0, passed = 0;
  const verdict = (ok: boolean, text: string): void => {
    if (ok) passed++; else failed++;
    lines.push((ok ? 'PASS  ' : 'FAIL  ') + text);
  };

  const frame: Frame3 = { camPos: v3(), camQ: { x: 0, y: 0, z: 0, w: 1 }, ship: null, planet, time: 1, stab: 1 };

  // ------------------------------------------------------------------ geometry

  /** Puts the camera at `from`, looking along `forward`, with `up` roughly up. */
  function look(from: Vec3, forward: Vec3, up: Vec3): void {
    const back = norm(v3(), scale(v3(), forward, -1));
    const right = norm(v3(), cross(v3(), up, back));
    frame.camPos = { ...from };
    frame.camQ = qFromBasis(right, cross(v3(), back, right), back);
  }
  /** The camera-space ray through the centre of a cell, with length 1 along the view axis. */
  const ray = (x: number, y: number): Vec3 =>
    v3(((x + 0.5) / cols * 2 - 1) * TAN * cols / (rows * 2), ((y + 0.5) / rows * 2 - 1) * TAN, -1);
  /** The world point that shows at the centre of cell (x, y) at view depth `depth`. */
  function at(x: number, y: number, depth: number): Vec3 {
    const p = qRotate(v3(), frame.camQ as Quat, scale(v3(), ray(x, y), depth));
    return add(p, p, frame.camPos);
  }
  /** The view depth at which the ray through a cell first goes under the ground. */
  function groundDepth(x: number, y: number): number {
    const r = ray(x, y), d = norm(v3(), qRotate(v3(), frame.camQ, r)), p = v3();
    const under = (t: number): boolean => {
      sub(p, addScaled(p, frame.camPos, d, t), planet.center);
      const dist = len(p);
      return dist < surfaceRadius(planet, norm(p, p));
    };
    let t = 0;
    while (t < 20000 && !under(t)) t += 2;
    if (t >= 20000) throw new Error(`cell ${x},${y} does not meet the ground`);
    return t / len(r);
  }

  // ------------------------------------------------------------------ pictures

  /** Draws the frame and reads the screen, the characters and the counts. */
  function shot(swarm: Swarm): Shot {
    frame.swarm = swarm;
    renderer.render(frame);
    const pixels = new Uint8Array(W * H * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const glyphs = new Uint8Array(cols * rows);
    renderer.readGlyphs(glyphs);
    return { pixels, glyphs, counts: renderer.countSwarm()! };
  }
  /** Waits until the world of the current camera is all there. */
  async function settle(): Promise<void> {
    frame.swarm = newSwarm({ ships: 0, bolts: 0, particles: 0 });
    for (let i = 0; i < 1000; i++) {
      renderer.render(frame);
      await new Promise(requestAnimationFrame);
      if (i > 2 && renderer.settled) return;
    }
    throw new Error('the view never settled');
  }
  /** Pixels and cells (by pixels) that differ between two shots, and cells whose character differs. */
  function difference(a: Shot, b: Shot): { pixels: number; cells: number; glyphs: number } {
    const { ox, oy, cwPx, chPx } = renderer;
    let pixels = 0, glyphs = 0;
    const cells = new Set<number>();
    for (let i = 0; i < a.pixels.length; i += 4) {
      if (a.pixels[i] === b.pixels[i] && a.pixels[i + 1] === b.pixels[i + 1] && a.pixels[i + 2] === b.pixels[i + 2]) continue;
      pixels++;
      const p = i / 4;
      cells.add(Math.floor((Math.floor(p / W) - oy) / chPx) * 10000 + Math.floor((p % W - ox) / cwPx));
    }
    for (let i = 0; i < a.glyphs.length; i++) if (a.glyphs[i] !== b.glyphs[i]) glyphs++;
    return { pixels, cells: cells.size, glyphs };
  }

  // ------------------------------------------------------------------ objects

  /** The cells an object of `kind` at `s` must show its characters in. */
  function expected(kind: Kind, s: Spot): [number, number, string][] {
    if (kind === 'particles') return [[s.x, s.y, '*']];
    if (kind === 'markers') return [[s.x - 1, s.y, '['], [s.x, s.y, '◆'], [s.x + 1, s.y, ']']];
    if (kind === 'bolts') return Array.from({ length: s.run }, (_, i): [number, number, string] => [s.x + i, s.y, '-']);
    return [];
  }
  /** `base` (the occluder's own ships) with the spots' objects of `kind` added, at their near or far depth. */
  function place(kind: Kind, spots: Spot[], side: 'behind' | 'front', base: Swarm): Swarm {
    const ships = base.ships + (kind === 'ships' || kind === 'markers' ? spots.length : 0);
    const out = newSwarm({ ships, bolts: kind === 'bolts' ? spots.length : 0, particles: kind === 'particles' ? spots.length : 0 });
    out.shipPos.set(base.shipPos); out.shipRot.set(base.shipRot);
    spots.forEach((s, i) => {
      const depth = s[side];
      if (kind === 'particles') {
        const p = at(s.x, s.y, depth);
        out.partPos.set([p.x, p.y, p.z], i * 3);
      } else if (kind === 'bolts') {
        const head = at(s.x, s.y, depth), tail = at(s.x + s.run - 1, s.y, depth);
        out.boltHead.set([head.x, head.y, head.z], i * 3); out.boltTail.set([tail.x, tail.y, tail.z], i * 3);
      } else {
        if (isMarker(depth, rows, TAN) !== (kind === 'markers')) throw new Error(`a ${kind} case at depth ${depth.toFixed(0)}`);
        setShip(out, base.ships + i, at(s.x, s.y, depth), frame.camQ);
      }
    });
    return out;
  }
  function setShip(s: Swarm, i: number, p: Vec3, q: Quat): void {
    s.shipPos.set([p.x, p.y, p.z], i * 3);
    [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)].forEach((axis, k) => {
      const a = qRotate(v3(), q, axis);
      s.shipRot.set([a.x, a.y, a.z], i * 9 + k * 3);
    });
  }

  const show = (t: Tally): string => `${t.drawn} drawn ${t.hidden} hidden${t.covered + t.off ? ` ${t.covered} covered ${t.off} off` : ''}`;

  /** One occluder and one kind of object. `base`: what the occluder itself adds to the swarm. `baseShips`: how many
   *  ships of `base` count among the mesh ships. */
  function test(name: string, kind: Kind, spots: Spot[], base = newSwarm({ ships: 0, bolts: 0, particles: 0 }), control = true): void {
    const title = `${name}, ${spots.length} ${kind}`.padEnd(40);
    if (spots.length === 0) { verdict(false, `${title} no cells found to test`); return; }
    const without = shot(base);
    const again = difference(without, shot(base));
    if (again.pixels || again.glyphs) { verdict(false, `${title} the picture is not repeatable: ${again.pixels} pixels differ`); return; }
    const key = kind === 'markers' ? 'markers' : kind === 'ships' ? 'ships' : kind;
    const counted = (s: Shot): Tally => {
      const t = { ...s.counts[key] };
      if (kind === 'ships') t.drawn -= without.counts.ships.drawn; // the occluder's own
      return t;
    };

    const behind = shot(place(kind, spots, 'behind', base)), db = difference(without, behind), cb = counted(behind);
    const hidden = db.pixels === 0 && db.glyphs === 0 && cb.drawn === 0 && cb.hidden === spots.length;
    const front = shot(place(kind, spots, 'front', base)), df = difference(without, front), cf = counted(front);
    const cells = spots.flatMap(s => expected(kind, s));
    const shown = (s: Shot): number => cells.filter(([x, y, c]) => s.glyphs[(rows - 1 - y) * cols + x] === gi(c)).length;
    const visible = df.pixels > 0 && cf.drawn === spots.length && shown(front) === cells.length;
    let text = `${title} behind: ${db.pixels} pixels, ${db.glyphs} characters changed (${show(cb)}) | ` +
      `front: ${df.cells} cells changed` + (cells.length ? `, ${shown(front)}/${cells.length} placed cells show it` : '') + ` (${show(cf)})`;
    let controlled = true;
    // markers beyond the planet's horizon are left out on the processor: the switch is for the chip's test only
    if (control && cells.length) {
      renderer.swarmOcclude = false;
      const off = shot(place(kind, spots, 'behind', base));
      renderer.swarmOcclude = true;
      controlled = shown(off) === cells.length;
      text += ` | control, occlusion off: ${shown(off)}/${cells.length}`;
    }
    verdict(hidden && visible && controlled, text);
  }

  /** Spots on a grid of cells. */
  function grid(xs: number[], ys: number[], make: (x: number, y: number) => Omit<Spot, 'x' | 'y'>): Spot[] {
    return ys.flatMap(y => xs.map(x => ({ x, y, ...make(x, y) })));
  }
  const around = (mid: number, step: number, n: number): number[] => Array.from({ length: 2 * n + 1 }, (_, i) => mid + (i - n) * step);

  // ------------------------------------------------------------------ the cases

  async function planetFromSpace(): Promise<void> {
    const up = norm(v3(), v3(...SUN)), R = planet.radius;
    look(addScaled(v3(), planet.center, up, 3 * R), scale(v3(), up, -1), v3(0, 1, 0));
    await settle();
    const depths = (): Omit<Spot, 'x' | 'y'> => ({ run: 5, behind: 4 * R + 400, front: R });
    const spots = grid(around(cols >> 1, 9, 3), around(rows >> 1, 5, 2), depths);
    test('behind the planet', 'particles', spots);
    test('behind the planet', 'bolts', spots);
    test('behind the planet', 'markers', spots, undefined, false);
  }

  async function terrain(): Promise<void> {
    const focus = pathFocus(planet), up = norm(v3(), focus);
    const along = norm(v3(), addScaled(v3(), v3(0, 1, 0), up, -dot(v3(0, 1, 0), up)));
    const from = (alt: number, down = 25): void => {
      const eye = addScaled(v3(), planet.center, up, surfaceRadius(planet, up) + alt);
      const pitch = down * Math.PI / 180;
      look(eye, addScaled(v3(), scale(v3(), along, Math.cos(pitch)), up, -Math.sin(pitch)), up);
    };
    const ys = [Math.round(rows * 0.12), Math.round(rows * 0.22), Math.round(rows * 0.32)];
    const under = (extra: number, near: number, run: number) => (x: number, y: number): Omit<Spot, 'x' | 'y'> => {
      const d = Array.from({ length: run }, (_, i) => groundDepth(x + i, y));
      return { run, behind: Math.max(...d) + extra, front: Math.min(...d) * near };
    };
    from(60);
    await settle();
    test('behind terrain (underground)', 'particles', grid(around(cols >> 1, 11, 4), ys, under(60, 0.6, 1)));
    test('behind terrain (underground)', 'bolts', grid(around(cols >> 1, 11, 4), ys, under(60, 0.6, 5)));
    from(1100, 40); // far enough for the ships on both sides to be markers
    await settle();
    test('behind terrain (underground)', 'markers', grid(around(cols >> 1, 15, 3), ys, under(200, 0.8, 1)));
    from(150);
    await settle();
    test('behind terrain (underground)', 'ships', grid(around(cols >> 1, 60, 1), [Math.round(rows * 0.25)], under(150, 0.55, 1)));
  }

  async function rock(): Promise<void> {
    const r = renderer.rockAt(0);
    if (!r) { verdict(false, 'behind a rock: there is no rock'); return; }
    const out = norm(v3(), sub(v3(), r.pos, planet.center)), d = 8 * r.size;
    look(addScaled(v3(), r.pos, out, d), scale(v3(), out, -1), v3(0, 1, 0));
    await settle();
    const depths = (run: number) => (): Omit<Spot, 'x' | 'y'> => ({ run, behind: d + 2.5 * r.size, front: d - 2.5 * r.size });
    test('behind a rock', 'particles', grid(around(cols >> 1, 2, 2), around(rows >> 1, 1, 1), depths(1)));
    test('behind a rock', 'bolts', grid([(cols >> 1) - 3], around(rows >> 1, 1, 1), depths(6)));
  }

  /** Behind a ship near the camera, in empty sky: the player's, or one of the others. */
  async function ship(player: boolean): Promise<void> {
    const up = v3(0, 1, 0), pos = addScaled(v3(), planet.center, up, planet.radius + 40000);
    // nose away from the planet, so that there is only sky behind
    const q = qFromBasis(v3(1, 0, 0), v3(0, 0, 1), v3(0, -1, 0));
    const chase = new ChaseCamera();
    chase.snap(pos, q, planet);
    frame.camPos = { ...chase.pos }; frame.camQ = { ...chase.q };
    const none = newSwarm({ ships: 0, bolts: 0, particles: 0 });
    const near = newSwarm({ ships: player ? 0 : 1, bolts: 0, particles: 0 });
    // the other ship: 30 ahead of the camera, in the middle of the screen, seen from behind
    if (!player) setShip(near, 0, at(cols >> 1, rows >> 1, 30), frame.camQ);
    await settle();
    const sky = shot(none);
    frame.ship = player ? { pos, q } : null;
    const withShip = shot(near);
    const depth = player ? -qRotate(v3(), { x: -frame.camQ.x, y: -frame.camQ.y, z: -frame.camQ.z, w: frame.camQ.w }, sub(v3(), pos, frame.camPos)).z : 30;
    // cells the ship fills: its fill character, where the sky showed something else
    const fill = gi('#');
    const solid = (x: number, y: number): boolean => {
      if (x < 0 || x >= cols || y < 0 || y >= rows) return false;
      const i = (rows - 1 - y) * cols + x;
      return withShip.glyphs[i] === fill && sky.glyphs[i] !== fill;
    };
    /** Non-overlapping blocks of w x h filled cells, as their centre cells. */
    const blocks = (w: number, h: number, most: number): [number, number][] => {
      const used = new Set<number>(), found: [number, number][] = [];
      for (let y = 0; y < rows && found.length < most; y++) {
        for (let x = 0; x < cols && found.length < most; x++) {
          let free = true;
          for (let j = 0; j < h && free; j++) for (let i = 0; i < w && free; i++) free = solid(x + i, y + j) && !used.has((y + j) * cols + x + i);
          if (!free) continue;
          for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) used.add((y + j) * cols + x + i);
          found.push([x + (w >> 1), y + (h >> 1)]);
        }
      }
      return found;
    };
    const behind = depth + 100, front = depth * 0.4;
    const name = player ? 'behind the player ship' : 'behind another ship';
    test(name, 'particles', blocks(1, 1, 80).map(([x, y]) => ({ x, y, run: 1, behind, front })), near);
    test(name, 'bolts', blocks(3, 1, 20).map(([x, y]) => ({ x: x - 1, y, run: 3, behind, front })), near);
    // a marker is always far: only behind and the control apply, so its "front" is the screen without the ship
    markerBehindShip(name, blocks(3, 1, 3), near);
    shipBehindShip(name, blocks(7, 3, 1), near, front);
    frame.ship = null;
  }

  function markerBehindShip(name: string, cells: [number, number][], base: Swarm): void {
    const title = `${name}, ${cells.length} markers`.padEnd(40);
    if (cells.length === 0) { verdict(false, `${title} no cells found to test`); return; }
    const spots = cells.map(([x, y]) => ({ x, y, run: 1, behind: 1000, front: 1000 }));
    const without = shot(base), behind = shot(place('markers', spots, 'behind', base)), d = difference(without, behind);
    renderer.swarmOcclude = false;
    const off = shot(place('markers', spots, 'behind', base));
    renderer.swarmOcclude = true;
    const all = spots.flatMap(s => expected('markers', s));
    const n = all.filter(([x, y, c]) => off.glyphs[(rows - 1 - y) * cols + x] === gi(c)).length;
    const t = behind.counts.markers;
    verdict(d.pixels === 0 && d.glyphs === 0 && t.hidden === spots.length && t.drawn === 0 && n === all.length,
      `${title} behind: ${d.pixels} pixels, ${d.glyphs} characters changed (${show(t)}) | control, occlusion off: ${n}/${all.length}`);
  }

  /** A far mesh ship (4 to 5 characters wide) wholly behind the near one, and the same cell in front of it. */
  function shipBehindShip(name: string, cells: [number, number][], base: Swarm, front: number): void {
    const far = SHIP_SPAN * rows / (TAN * 4.2);
    if (shipSpanCells(far, rows, TAN) < 4) throw new Error('the far ship would be a marker');
    test(name, 'ships', cells.map(([x, y]) => ({ x, y, run: 1, behind: far, front })), base);
  }

  async function all(): Promise<void> {
    await planetFromSpace();
    await terrain();
    await rock();
    await ship(true);
    await ship(false);
  }

  const done = (): void => {
    const text = [
      'ASTERION 3D spike: occlusion check',
      `${page.gpuName}`,
      `canvas ${W}x${H}  grid ${cols}x${rows}  characters: ${CHARSET.length} in the set`,
      ...lines,
      failed === 0 ? `all ${passed} cases passed` : `${failed} of ${failed + passed} cases FAILED`,
    ].join('\n');
    element('reportText').textContent = text;
    element('reportHint').textContent = '';
    element('report').hidden = false;
    info.hidden = true;
    console.log(text);
    document.title = 'done';
  };
  all().catch(e => { verdict(false, String(e instanceof Error ? e.stack : e)); }).finally(done);
}
