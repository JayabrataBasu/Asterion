/** Builds tiles off the main thread: one TileRequest in, one TileReply out, its buffers transferred. */
import { makeMoonBody } from './moon';
import { type Planet, makePlanet } from './planet';
import { SCALE } from './scale';
import { type TileId, type TileMesh, buildTile } from './tiles';

/** `scale` is the page's SCALE: a worker cannot see the page's URL overrides, and the mesh must agree with collision.
 *  The planet is centred on the origin. */
export interface TileRequest { seed: number; radius2d: number; scale: typeof SCALE; id: TileId; kind?: 'moon' }
/** The mesh, and how long building it took in the worker, in milliseconds. */
export type TileReply = TileMesh & { buildMs: number };

let planet: Planet | undefined, madeFrom = '';

self.onmessage = (e: MessageEvent<TileRequest>) => {
  const { seed, radius2d, scale, id, kind } = e.data;
  const from = JSON.stringify([seed, radius2d, scale, kind]);
  if (!planet || from !== madeFrom) {
    Object.assign(SCALE, scale);
    planet = kind === 'moon' ? makeMoonBody(seed) : makePlanet(seed, radius2d);
    madeFrom = from;
  }
  const start = performance.now();
  const mesh: TileReply = { ...buildTile(planet, id), buildMs: 0 };
  mesh.buildMs = performance.now() - start;
  self.postMessage(mesh, { transfer: [mesh.pos.buffer, mesh.nrm.buffer, mesh.mat.buffer] });
};
