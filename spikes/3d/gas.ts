/** The gas giant's rules: no ground. The nominal radius is the cloud tops; below the crush depth the hull takes
 *  damage; the floor further down cannot be passed (it is the giant's surfaceRadius, so flight treats it as ground). */
import { type Vec3, len, sub, v3 } from './math';
import type { Planet } from './planet';

/** Crush depth and floor below the cloud tops, as shares of the radius. */
export const CRUSH_K = 0.03, FLOOR_K = 0.06;
/** Seconds below the crush depth for each hull damage counted. */
export const CRUSH_TICK = 0.5;
/** The giant's 2D radius. */
export const GAS_RADIUS2D = 90;

export function crushRadius(p: Planet): number { return p.radius * (1 - CRUSH_K); }
export function floorRadius(p: Planet): number { return p.radius * (1 - FLOOR_K); }

const rel = v3();
/** Height above the cloud tops (the nominal radius); negative inside the clouds. */
export function cloudAltitude(p: Planet, pos: Vec3): number { return len(sub(rel, pos, p.center)) - p.radius; }

/** How far the height that cruise goes by is above what can be hit: on a gas giant, cruise counts from the cloud
 *  tops, not from the floor far below them. */
export function cruiseDatum(p: Planet): number { return p.kind === 'gas' ? p.radius - floorRadius(p) : 0; }
