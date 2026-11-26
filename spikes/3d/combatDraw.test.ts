import { describe, expect, it } from 'vitest';
import { type Swarm, newSwarm } from './combat';
import {
  GLYPH_FLOATS, MARKER_CELLS, MAX_BOLT_CELLS, SHIP_FLOATS, SHIP_RADIUS, SHIP_SPAN, SwarmList, type SwarmView, boltGlyph, isMarker, particleGlyph, shipSpanCells,
} from './combatDraw';
import { qIdentity, v3 } from './math';
import { wrenMesh } from './meshes';

const TAN = Math.tan(Math.PI / 6), COLS = 240, ROWS = 67;

describe('ship size on screen and the marker threshold', () => {
  it('spans about 30 characters at 100 units and about 6 at 500, at 1920x1080', () => {
    expect(shipSpanCells(100, ROWS, TAN)).toBeCloseTo(30.2, 0);
    expect(shipSpanCells(500, ROWS, TAN)).toBeCloseTo(6.0, 0);
  });
  it('becomes a marker under 4 characters', () => {
    expect(MARKER_CELLS).toBe(4);
    const edge = 26 * ROWS / TAN / 4; // about 754 units
    expect(isMarker(edge - 1, ROWS, TAN)).toBe(false);
    expect(isMarker(edge + 1, ROWS, TAN)).toBe(true);
  });
  it('comes nearer on a smaller screen', () => {
    expect(isMarker(400, ROWS, TAN)).toBe(false);
    expect(isMarker(400, 28, TAN)).toBe(true);
  });
  it('never marks a ship level with or behind the camera', () => {
    expect(isMarker(0, ROWS, TAN)).toBe(false);
    expect(isMarker(-20, ROWS, TAN)).toBe(false);
  });
  it('measures the ship that is drawn: its span, and a sphere holding all of it', () => {
    const p = wrenMesh().pos;
    let span = 0, radius = 0;
    for (let i = 0; i < p.length; i += 3) {
      span = Math.max(span, 2 * Math.abs(p[i]));
      radius = Math.max(radius, Math.hypot(p[i], p[i + 1], p[i + 2]));
    }
    expect(Math.abs(span - SHIP_SPAN)).toBeLessThan(1);
    expect(radius).toBeLessThanOrEqual(SHIP_RADIUS);
    expect(radius).toBeGreaterThan(SHIP_RADIUS - 2);
  });
});

describe('boltGlyph (direction on screen in pixels, y up)', () => {
  it('follows the direction, either way round', () => {
    for (const [dx, dy, g] of [[1, 0, '-'], [0, 1, '|'], [1, 1, '/'], [-1, 1, '\\']] as const) {
      expect(boltGlyph(dx, dy)).toBe(g);
      expect(boltGlyph(-dx, -dy)).toBe(g);
    }
  });
  it('changes at 22.5 degrees from each axis', () => {
    const deg = (a: number): string => boltGlyph(Math.cos(a * Math.PI / 180), Math.sin(a * Math.PI / 180));
    expect([deg(22), deg(23), deg(67), deg(68), deg(112), deg(113), deg(157), deg(158)])
      .toEqual(['-', '/', '/', '|', '|', '\\', '\\', '-']);
  });
});

describe('particleGlyph (by age)', () => {
  it('goes * + . from young to old', () => {
    expect([0, 0.32, 0.34, 0.65, 0.68, 1].map(particleGlyph)).toEqual(['*', '*', '+', '+', '.', '.']);
  });
});

// ------------------------------------------------------------------ the lists

const glyph = (c: string): number => c.charCodeAt(0);
const view: SwarmView = { camPos: v3(), camQ: qIdentity(), cols: COLS, rows: ROWS, tanY: TAN, planet: null };
const ASPECT = COLS / (ROWS * 2);
/** The point that shows at the centre of cell (x, y), y from the bottom, `depth` ahead of the camera. */
const inCell = (x: number, y: number, depth: number): [number, number, number] =>
  [((x + 0.5) / COLS * 2 - 1) * TAN * ASPECT * depth, ((y + 0.5) / ROWS * 2 - 1) * TAN * depth, -depth];

interface Parts { ships?: [number, number, number][]; bolts?: [number, number, number][][]; parts?: [number, number, number][] }
function build(p: Parts, v = view): { list: SwarmList; swarm: Swarm } {
  const swarm = newSwarm({ ships: p.ships?.length ?? 0, bolts: p.bolts?.length ?? 0, particles: p.parts?.length ?? 0 });
  p.ships?.forEach((s, i) => { swarm.shipPos.set(s, i * 3); swarm.shipRot.set([1, 0, 0, 0, 1, 0, 0, 0, 1], i * 9); });
  p.bolts?.forEach(([h, t], i) => { swarm.boltHead.set(h, i * 3); swarm.boltTail.set(t, i * 3); });
  p.parts?.forEach((q, i) => swarm.partPos.set(q, i * 3));
  const list = new SwarmList(swarm, glyph);
  list.build(swarm, v, null);
  return { list, swarm };
}
/** The cells to draw as [x, y, glyph], in list order. */
const drawn = (l: SwarmList): [number, number, string][] => Array.from({ length: l.drawCount }, (_, i) => {
  const o = i * GLYPH_FLOATS;
  return [l.draw[o], l.draw[o + 1], String.fromCharCode(l.draw[o + 3])];
});

describe('SwarmList: particles', () => {
  it('puts a particle into the cell it projects to, with its depth', () => {
    const { list } = build({ parts: [inCell(10, 50, 200)] });
    expect(drawn(list)).toEqual([[10, 50, '*']]);
    expect(list.candCount).toBe(1);
    expect(list.draw[2]).toBeCloseTo(200, 3);
  });
  it('drops what is behind the camera or off the screen', () => {
    const { list } = build({ parts: [[0, 0, 100], inCell(-1, 10, 100), inCell(COLS, 10, 100), inCell(10, ROWS, 100), inCell(10, -1, 100)] });
    expect(list.candCount).toBe(0);
    expect(list.drawCount).toBe(0);
  });
  it('shows the nearest of those in one cell, and keeps all for counting', () => {
    const { list, swarm } = build({ parts: [inCell(5, 5, 300), inCell(5, 5, 100), inCell(5, 5, 200)] });
    swarm.partAge.set([0, 0.5, 1]);
    list.build(swarm, view, null);
    expect(drawn(list)).toEqual([[5, 5, '+']]);
    expect(list.candCount).toBe(3);
  });
  it('starts afresh at each build', () => {
    const { list, swarm } = build({ parts: [inCell(5, 5, 100)] });
    swarm.partPos.set(inCell(6, 5, 100));
    list.build(swarm, view, null);
    list.build(swarm, view, null);
    expect(drawn(list)).toEqual([[6, 5, '*']]);
  });
  it('is relative to the camera', () => {
    const v = { ...view, camPos: v3(1000, -500, 20000) };
    const [x, y, z] = inCell(100, 30, 250);
    expect(drawn(build({ parts: [[x + 1000, y - 500, z + 20000]] }, v).list)).toEqual([[100, 30, '*']]);
  });
});

describe('SwarmList: bolts', () => {
  const bolt = (a: [number, number], b: [number, number], depth = 200) => [inCell(a[0], a[1], depth), inCell(b[0], b[1], depth)];
  it('draws a level bolt as a run of - from head to tail', () => {
    const cells = drawn(build({ bolts: [bolt([20, 10], [16, 10])] }).list);
    expect(cells.map(c => c.join()).sort()).toEqual([16, 17, 18, 19, 20].map(x => `${x},10,-`));
  });
  it('takes the character from the direction in pixels: cells are twice as tall as wide', () => {
    expect(new Set(drawn(build({ bolts: [bolt([20, 10], [20, 14])] }).list).map(c => c[2]))).toEqual(new Set(['|']));
    // 2 columns for each row is 45 degrees on screen
    expect(new Set(drawn(build({ bolts: [bolt([20, 10], [28, 14])] }).list).map(c => c[2]))).toEqual(new Set(['/']));
    expect(new Set(drawn(build({ bolts: [bolt([20, 14], [28, 10])] }).list).map(c => c[2]))).toEqual(new Set(['\\']));
  });
  it('leaves no gaps and no cell twice', () => {
    const cells = drawn(build({ bolts: [bolt([3, 3], [14, 9])] }).list);
    expect(cells.length).toBe(12);
    expect(new Set(cells.map(c => c[0])).size).toBe(12);
  });
  it('is at most MAX_BOLT_CELLS long, from the head', () => {
    const cells = drawn(build({ bolts: [bolt([10, 10], [200, 10])] }).list);
    expect(MAX_BOLT_CELLS).toBe(24);
    expect(cells.map(c => c[0]).sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, i) => 10 + i));
  });
  it('keeps the part that is on screen', () => {
    const cells = drawn(build({ bolts: [bolt([-3, 10], [2, 10])] }).list);
    expect(cells.map(c => c[0]).sort()).toEqual([0, 1, 2]);
  });
  it('cuts a bolt at the near plane instead of mirroring it', () => {
    const { list } = build({ bolts: [[inCell(120, 33, 50), [0.01, 0.01, 30]]] });
    expect(list.candCount).toBeGreaterThan(0);
    for (let i = 0; i < list.candCount; i++) expect(list.cand[i * GLYPH_FLOATS + 2]).toBeGreaterThan(0.49);
    expect(build({ bolts: [[[0, 0, 5], [0, 0, 15]]] }).list.candCount).toBe(0);
  });
  it('has depth running from one end to the other', () => {
    const { list } = build({ bolts: [[inCell(20, 10, 100), inCell(24, 10, 300)]] });
    const w = Array.from({ length: list.candCount }, (_, i) => [list.cand[i * GLYPH_FLOATS], list.cand[i * GLYPH_FLOATS + 2]]).sort((a, b) => a[0] - b[0]);
    expect(w[0][1]).toBeCloseTo(100, 0);
    expect(w[4][1]).toBeCloseTo(300, 0);
    for (let i = 1; i < 5; i++) expect(w[i][1]).toBeGreaterThan(w[i - 1][1]);
  });
});

describe('SwarmList: ships', () => {
  it('draws a near ship as a mesh instance, relative to the camera', () => {
    const v = { ...view, camPos: v3(10, 20, 30) };
    const { list } = build({ ships: [[10, 20, -170]] }, v);
    expect(list.meshCount).toBe(1);
    expect(list.candCount).toBe(0);
    expect(Array.from(list.shipData.subarray(0, SHIP_FLOATS))).toEqual([0, 0, -200, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });
  it('draws a far ship as a marker in brackets', () => {
    const { list } = build({ ships: [inCell(100, 20, 790)] });
    expect(list.meshCount).toBe(0);
    expect(drawn(list)).toEqual([[99, 20, '['], [100, 20, String.fromCharCode(glyph('◆'))], [101, 20, ']']]);
  });
  it('keeps the part of a marker that is on screen', () => {
    expect(drawn(build({ ships: [inCell(0, 20, 790)] }).list).map(c => c[0])).toEqual([0, 1]);
    expect(drawn(build({ ships: [inCell(-1, 20, 790)] }).list).map(c => c[0])).toEqual([0]);
  });
  it('leaves out ships behind the camera or far to the side', () => {
    const { list } = build({ ships: [[0, 0, 200], [900, 0, -100], inCell(-30, 5, 790)] });
    expect(list.meshCount).toBe(0);
    expect(list.candCount).toBe(0);
  });
  it('keeps a mesh ship that reaches into the screen from outside', () => {
    expect(build({ ships: [inCell(-3, 30, 100)] }).list.meshCount).toBe(1);
  });
  it('does not submit a ship wholly beyond the planet horizon', () => {
    const planet = { center: v3(0, 0, -7000), radius: 6000, atmo: 1, relief: 1, seed: 1 };
    const { list } = build({ ships: [[0, 0, -14000]] }, { ...view, planet });
    expect(list.meshCount + list.candCount).toBe(0);
    const t = list.tally(new Uint8Array(0), new Uint8Array(0));
    expect(t.markers.hidden + t.ships.hidden).toBe(1);
  });
  it('appends the player after the mesh ships, for the visibility count only', () => {
    const swarm = newSwarm({ ships: 1, bolts: 0, particles: 0 });
    swarm.shipPos.set([0, 0, -100]);
    const list = new SwarmList(swarm, glyph);
    list.build(swarm, view, { pos: v3(0, -10, -40), q: qIdentity() });
    expect(list.meshCount).toBe(1);
    expect(list.countShips).toBe(2);
    expect(Array.from(list.shipData.subarray(SHIP_FLOATS, SHIP_FLOATS + 3))).toEqual([0, -10, -40]);
  });
});

describe('SwarmList.tally (drawn, hidden, covered, off screen)', () => {
  it('sorts every object into one of the four', () => {
    // ships: mesh seen, mesh unseen, marker seen, marker hidden, one behind
    const ships: [number, number, number][] = [inCell(40, 30, 100), inCell(80, 30, 100), inCell(120, 30, 790), inCell(160, 30, 790), [0, 0, 100]];
    const parts: [number, number, number][] = [inCell(1, 1, 100), inCell(1, 1, 200), inCell(2, 2, 100), [0, 0, 50]];
    const bolts = [[inCell(10, 50, 100), inCell(14, 50, 100)], [inCell(10, 55, 100), inCell(14, 55, 100)]];
    const { list } = build({ ships, parts, bolts });
    const visible = new Uint8Array(list.candCount);
    for (let i = 0; i < list.candCount; i++) {
      const o = i * GLYPH_FLOATS, x = list.cand[o], y = list.cand[o + 1];
      // visible: marker at 120 (one cell of it is enough), particles at (1,1), one cell of the bolt on row 50
      visible[i] = (y === 30 && x === 119) || (x === 1 && y === 1) || (y === 50 && x === 12) ? 1 : 0;
    }
    const t = list.tally(Uint8Array.of(1, 0), visible);
    // the one behind the camera is counted by what its distance makes it: a mesh at 100 units
    expect(t.ships).toEqual({ drawn: 1, hidden: 1, covered: 0, off: 1 });
    expect(t.markers).toEqual({ drawn: 1, hidden: 1, covered: 0, off: 0 });
    expect(t.bolts).toEqual({ drawn: 1, hidden: 1, covered: 0, off: 0 });
    // the farther particle at (1,1) is visible by depth but its cell shows the nearer one
    expect(t.particles).toEqual({ drawn: 1, hidden: 1, covered: 1, off: 1 });
  });
});
