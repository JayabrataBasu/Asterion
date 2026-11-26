/** What a world scene adds to the readout: one line, and a warning to put in the middle of the screen (or ''). */
import type { ShipState } from './flight';
import { CRUSH_K, FLOOR_K, cloudAltitude, crushRadius } from './gas';
import type { World } from './world';
import { altitude } from './planet';
import { cruiseExit } from './flight';

export interface SceneStatus { line: string; warning: string }

/** `time`: simulated seconds at the ship's state. */
export function sceneStatus(world: World, ship: ShipState, _time: number): SceneStatus {
  const p = world.planet, moon = world.moon;
  if (moon) {
    const line = `moon: ${altitude(moon.body, ship.pos).toFixed(0)} above its ground` +
      `   ${moon.carries(ship.pos) ? 'carried with it' : 'not carried'}   cruise ends below ${cruiseExit(moon.body)}`;
    return { line, warning: '' };
  }
  if (world.scene !== 'gas') return { line: '', warning: '' };
  const h = cloudAltitude(p, ship.pos);
  const line = `gas giant: ${h.toFixed(0)} from the cloud tops   crush depth ${(-CRUSH_K * p.radius).toFixed(0)}` +
    `   floor ${(-FLOOR_K * p.radius).toFixed(0)}   hull damage ${ship.crushDamage}`;
  const warning = h < crushRadius(p) - p.radius ? `CRUSH DEPTH  hull damage ${ship.crushDamage}  climb!` : '';
  return { line, warning };
}
