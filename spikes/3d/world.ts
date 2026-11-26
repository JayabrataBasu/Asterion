/** The world scenes of the prototype (?scene=gas|moon): which bodies there are. Without a scene, the default planet. */
import { GAS_RADIUS2D } from './gas';
import { Moon } from './moon';
import { type Planet, makePlanet } from './planet';

export type SceneName = 'gas' | 'moon';
const NAMES: readonly string[] = ['gas', 'moon'] satisfies SceneName[];

/** ?scene=gas|moon; null for anything else (the combat scenes share the parameter: see combat.ts). */
export function parseWorldScene(params: URLSearchParams): SceneName | null {
  const name = params.get('scene') ?? '';
  return NAMES.includes(name) ? name as SceneName : null;
}

export interface World {
  scene: SceneName | null; planet: Planet;
  moon?: Moon;
}

export function makeWorld(scene: SceneName | null, seed = 1): World {
  if (scene === 'gas') return { scene, planet: { ...makePlanet(seed, GAS_RADIUS2D), relief: 0, kind: 'gas' } };
  const planet = makePlanet(seed);
  return scene === 'moon' ? { scene, planet, moon: new Moon(planet, seed) } : { scene, planet };
}
