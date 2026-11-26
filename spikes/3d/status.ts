/** What a world scene adds to the readout: one line, and a warning to put in the middle of the screen (or ''). */
import type { ShipState } from './flight';
import { CRUSH_K, FLOOR_K, cloudAltitude, crushRadius } from './gas';
import type { World } from './world';
import { altitude } from './planet';
import { cruiseExit } from './flight';
import { v3 } from './math';

export interface SceneStatus { line: string; warning: string }

const local = v3();

/** `time`: simulated seconds at the ship's state. */
export function sceneStatus(world: World, ship: ShipState, _time: number): SceneStatus {
  const p = world.planet, moon = world.moon, ring = world.ring;
  if (ring) {
    const l = ring.toLocal(local, ship.pos), rho = Math.hypot(l.x, l.y), within = rho >= ring.inner && rho <= ring.outer;
    const line = `ring: ${Math.abs(l.z).toFixed(0)} ${l.z < 0 ? 'below' : 'above'} its plane, ` +
      `${within ? 'within' : 'outside'} its width   hull chips ${ship.chips}`;
    return { line, warning: '' };
  }
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
