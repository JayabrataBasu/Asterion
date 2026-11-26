/** Builds tiles off the main thread: one TileRequest in, one TileMesh out, its buffers transferred. */
import { type Planet, makePlanet } from './planet';
import { SCALE } from './scale';
import { type TileId, buildTile } from './tiles';

/** `scale` is the page's SCALE: a worker cannot see the page's URL overrides, and the mesh must agree with collision.
 *  The planet is centred on the origin. */
export interface TileRequest { seed: number; radius2d: number; scale: typeof SCALE; id: TileId }

let planet: Planet | undefined, madeFrom = '';

self.onmessage = (e: MessageEvent<TileRequest>) => {
  const { seed, radius2d, scale, id } = e.data;
  const from = JSON.stringify([seed, radius2d, scale]);
  if (!planet || from !== madeFrom) {
    Object.assign(SCALE, scale);
    planet = makePlanet(seed, radius2d);
    madeFrom = from;
  }
  const mesh = buildTile(planet, id);
  self.postMessage(mesh, { transfer: [mesh.pos.buffer, mesh.nrm.buffer, mesh.mat.buffer] });
};
