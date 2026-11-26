import { describe, expect, it } from 'vitest';
import { parseCombat } from './combat';
import { makePlanet } from './planet';
import { makeWorld, parseWorldScene } from './world';

const q = (s: string): URLSearchParams => new URLSearchParams(s);

describe('world scenes in the URL', () => {
  it('reads its own scene names and nothing else', () => {
    for (const name of ['gas', 'moon'] as const) expect(parseWorldScene(q(`scene=${name}`))).toBe(name);
    for (const s of ['', 'scene=combat', 'scene=heavy', 'scene=', 'scene=GAS', 'scene=toString', 'ships=3']) {
      expect(parseWorldScene(q(s))).toBeNull();
    }
  });

  it('leaves the combat scenes as they were', () => {
    expect(parseCombat(q('scene=combat'))).toEqual({ scene: 'combat', ships: 14, bolts: 200, particles: 2000 });
    expect(parseCombat(q('scene=heavy'))).toEqual({ scene: 'heavy', ships: 320, bolts: 640, particles: 8192 });
    for (const name of ['gas', 'moon']) expect(parseCombat(q(`scene=${name}`))).toBeNull();
  });

  it('without a scene is the default planet and nothing else', () => {
    const w = makeWorld(null);
    expect(w.scene).toBeNull();
    expect(w.planet).toEqual(makePlanet(1));
    expect(Object.keys(w.planet)).toEqual(Object.keys(makePlanet(1)));
  });
});
