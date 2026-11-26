/** The world scenes of the prototype (?scene=gas|moon|ring): which bodies there are. Without a scene, the default planet. */
import { GAS_RADIUS2D } from './gas';
import { v3 } from './math';
import { Moon } from './moon';
import { Ring } from './ring';
import { SUN } from './shaders';
import { type Planet, makePlanet } from './planet';

export type SceneName = 'gas' | 'moon' | 'ring';
const NAMES: readonly string[] = ['gas', 'moon', 'ring'] satisfies SceneName[];

/** ?scene=gas|moon|ring; null for anything else (the combat scenes share the parameter: see combat.ts). */
export function parseWorldScene(params: URLSearchParams): SceneName | null {
  const name = params.get('scene') ?? '';
  return NAMES.includes(name) ? name as SceneName : null;
}

export interface World {
  scene: SceneName | null; planet: Planet;
  moon?: Moon;
  ring?: Ring;
}

export function makeWorld(scene: SceneName | null, seed = 1): World {
  if (scene === 'gas') return { scene, planet: { ...makePlanet(seed, GAS_RADIUS2D), relief: 0, kind: 'gas' } };
  const planet = makePlanet(seed);
  if (scene === 'moon') return { scene, planet, moon: new Moon(planet, seed) };
  if (scene === 'ring') return { scene, planet, ring: new Ring(planet, v3(...SUN)) };
  return { scene, planet };
}
