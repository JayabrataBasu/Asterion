/** The world scenes of the prototype (?scene=gas): which bodies there are. Without a scene, the default planet. */
import { GAS_RADIUS2D } from './gas';
import { type Planet, makePlanet } from './planet';

export type SceneName = 'gas';
const NAMES: readonly string[] = ['gas'] satisfies SceneName[];

/** ?scene=gas; null for anything else (the combat scenes share the parameter: see combat.ts). */
export function parseWorldScene(params: URLSearchParams): SceneName | null {
  const name = params.get('scene') ?? '';
  return NAMES.includes(name) ? name as SceneName : null;
}

export interface World { scene: SceneName | null; planet: Planet }

export function makeWorld(scene: SceneName | null, seed = 1): World {
  if (scene === 'gas') return { scene, planet: { ...makePlanet(seed, GAS_RADIUS2D), relief: 0, kind: 'gas' } };
  return { scene, planet: makePlanet(seed) };
}
