/** Draws the moon in pass 1: its own small tile cache and worker, beside the planet's. Tiles are built with the moon
 *  centred on the origin and placed where the moon is at the picture's time. Selection and uploads follow the planet's
 *  (render.ts); the depth buffer sorts the two bodies against each other. */
import { beyondHorizon, inView } from './cull';
import { type Vec3, copy, len, qRotate, sub, v3 } from './math';
import { MOON_RADIUS2D, type Moon } from './moon';
import type { Planet } from './planet';
import { SCALE } from './scale';
import type { LayerKit, Loc, SceneFrame, SceneLayer } from './sceneLayer';
import { FS_MOON } from './sceneShaders';
import { VS_TILE } from './shaders';
import {
  TILE_N, type TileId, type TileMesh, buildTile, faceDir, finestDepth, resolveDrawList, selectTiles, tileIndices, tileKey,
} from './tiles';
import type { TileReply, TileRequest } from './worker';

/** GPU slots: the most wanted tiles with their ancestors found near the ground is about 430. */
const SLOTS = 640;
const VERTS = (TILE_N + 1) ** 2 + 4 * TILE_N;
const UPLOADS = 8, WORKERS = 2, NEAR = 0.5;

interface Tile { key: number; slot: number; center: Vec3; radius: number; spacing: number; last: number }
const never = (): boolean => false;

export class MoonLayer implements SceneLayer {
  readonly planetTiles = true;
  readonly resolve = null;
  pending = 0;

  /** The body as the tiles see it: centred on the origin. */
  private readonly at: Planet;
  private readonly program: WebGLProgram; private readonly u: Loc;
  private readonly pos: WebGLBuffer; private readonly nrm: WebGLBuffer; private readonly mat: WebGLBuffer;
  private readonly vaos: WebGLVertexArrayObject[] = [];
  private readonly nIdx: number;
  private readonly cache = new Map<number, Tile>();
  private readonly freeSlots: number[] = [];
  private readonly workers: Worker[] = []; private busy = 0;
  private readonly arrived: TileReply[] = [];
  private readonly pendingIds = new Map<number, TileId>();
  private wanted: TileId[] = []; private wantedKeys: number[] = [];
  private readonly keep = new Set<number>();
  private drawList: Tile[] = []; private queue: TileId[] = [];
  private dirty = true; private queueDirty = true; private frame = 0; private next = 0;
  private readonly eye = v3(); private readonly lastSelect = v3(Infinity, 0, 0);
  private readonly rel = v3(); private readonly moonRel = v3(); private readonly view = v3(); private readonly tmp = v3();

  constructor(private readonly kit: LayerKit, private readonly moon: Moon) {
    const gl = kit.gl, body = moon.body;
    this.at = { ...body, center: v3() };
    this.program = kit.prog(VS_TILE, FS_MOON);
    this.u = kit.locs(this.program, ['uVP', 'uOff', 'uPlanet', 'uR', 'uFC', 'uSpacing', 'uCellK', 'uRelief']);
    const idx = tileIndices(); this.nIdx = idx.length;
    const ibo = gl.createBuffer()!;
    const buffer = (bytes: number): WebGLBuffer => {
      const b = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.DYNAMIC_DRAW);
      return b;
    };
    this.pos = buffer(SLOTS * VERTS * 12); this.nrm = buffer(SLOTS * VERTS * 12); this.mat = buffer(SLOTS * VERTS);
    const attr = (loc: number, buf: WebGLBuffer, size: number, type: number, off: number): void => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, type, false, 0, off);
    };
    for (let s = 0; s < SLOTS; s++) {
      const vao = gl.createVertexArray()!; gl.bindVertexArray(vao);
      attr(0, this.pos, 3, gl.FLOAT, s * VERTS * 12); attr(1, this.nrm, 3, gl.FLOAT, s * VERTS * 12);
      attr(2, this.mat, 1, gl.UNSIGNED_BYTE, s * VERTS);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      if (s === 0) gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      this.vaos.push(vao); this.freeSlots.push(SLOTS - 1 - s);
    }
    gl.bindVertexArray(null);
    for (let face = 0; face < 6; face++) {
      const id = { face, depth: 0, ix: 0, iy: 0 };
      this.insert(buildTile(this.at, id), id);
    }
    if (!kit.sync) {
      for (let i = 0; i < WORKERS; i++) {
        const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (e: MessageEvent<TileReply>) => { this.busy--; this.arrived.push(e.data); };
        w.onerror = e => { console.error('moon tile worker', e.message); };
        this.workers.push(w);
      }
    }
  }

  get settled(): boolean { return this.wantedKeys.length > 0 && this.pending === 0 && this.wantedKeys.every(this.has); }

  private readonly has = (k: number): boolean => this.cache.has(k);
  private readonly isPending = (k: number): boolean => this.pendingIds.has(k);
  private readonly dist = (t: TileId): number => {
    const n = 2 ** t.depth;
    faceDir(this.tmp, t.face, -1 + 2 * (t.ix + 0.5) / n, -1 + 2 * (t.iy + 0.5) / n);
    const r = this.at.radius;
    return Math.hypot(this.tmp.x * r - this.eye.x, this.tmp.y * r - this.eye.y, this.tmp.z * r - this.eye.z);
  };

  private insert(m: TileMesh, id: TileId): void {
    const gl = this.kit.gl;
    if (this.cache.has(m.key)) return;
    if (this.freeSlots.length === 0) {
      for (const k of this.kit.evictKeys([...this.cache.values()], this.keep, SLOTS - 1)) {
        const t = this.cache.get(k)!; this.cache.delete(k); this.freeSlots.push(t.slot);
      }
      if (this.freeSlots.length === 0) return;
    }
    const slot = this.freeSlots.pop()!;
    let r2 = 0;
    for (let i = 0; i < m.pos.length; i += 3) r2 = Math.max(r2, m.pos[i] ** 2 + m.pos[i + 1] ** 2 + m.pos[i + 2] ** 2);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pos); gl.bufferSubData(gl.ARRAY_BUFFER, slot * VERTS * 12, m.pos);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nrm); gl.bufferSubData(gl.ARRAY_BUFFER, slot * VERTS * 12, m.nrm);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.mat); gl.bufferSubData(gl.ARRAY_BUFFER, slot * VERTS, m.mat);
    this.cache.set(m.key, {
      key: m.key, slot, center: v3(m.center.x, m.center.y, m.center.z), radius: Math.sqrt(r2),
      spacing: this.at.radius * Math.PI / 2 / 2 ** id.depth / TILE_N, last: this.frame,
    });
    this.dirty = true;
  }

  /** Brings the cache and the draw list up to date for the eye, given relative to the moon's centre. */
  private update(): void {
    const alt = Math.max(1, len(this.eye) - this.at.radius);
    if (len(sub(this.tmp, this.eye, this.lastSelect)) > Math.max(1, alt * 0.01)) {
      copy(this.lastSelect, this.eye);
      const wanted = selectTiles(this.at, this.eye), keys = wanted.map(tileKey);
      if (keys.length !== this.wantedKeys.length || keys.some((k, i) => k !== this.wantedKeys[i])) {
        this.wanted = wanted; this.wantedKeys = keys; this.dirty = true;
        this.keep.clear();
        for (const t of wanted) {
          for (let up = 0; up <= t.depth; up++) {
            const k = tileKey({ face: t.face, depth: t.depth - up, ix: t.ix >> up, iy: t.iy >> up });
            if (this.keep.has(k)) break;
            this.keep.add(k);
          }
        }
        for (const k of this.keep) { const t = this.cache.get(k); if (t) t.last = this.frame; }
      }
    }
    if (this.kit.sync) {
      if (this.dirty) for (const id of this.kit.requestOrder(this.wanted, this.has, never, this.dist, SLOTS)) this.insert(buildTile(this.at, id), id);
    } else {
      for (let n = 0; n < UPLOADS && this.arrived.length > 0; n++) {
        const m = this.arrived.shift()!, id = this.pendingIds.get(m.key);
        if (!id) continue;
        this.pendingIds.delete(m.key);
        this.insert(m, id);
      }
      const capacity = this.workers.length * 2;
      if (this.busy < capacity) {
        if (this.queueDirty) this.queue = this.kit.requestOrder(this.wanted, this.has, this.isPending, this.dist, SLOTS);
        this.queueDirty = false;
        while (this.busy < capacity && this.queue.length > 0) {
          const id = this.queue.shift()!, k = tileKey(id);
          if (this.cache.has(k) || this.pendingIds.has(k)) continue;
          const msg: TileRequest = { seed: this.at.seed, radius2d: MOON_RADIUS2D, scale: { ...SCALE }, id, kind: 'moon' };
          this.workers[this.next = (this.next + 1) % this.workers.length].postMessage(msg);
          this.busy++;
          this.pendingIds.set(k, id);
        }
      }
    }
    if (this.dirty) {
      this.queueDirty = true;
      this.drawList = resolveDrawList(this.wanted, this.has, finestDepth(this.at)).map(t => this.cache.get(tileKey(t))!);
      this.dirty = false;
    }
    let missing = 0;
    for (const k of this.wantedKeys) if (!this.cache.has(k)) missing++;
    this.pending = this.kit.sync ? 0 : Math.max(missing, this.pendingIds.size);
  }

  draw(f: SceneFrame): number {
    const gl = this.kit.gl, u = this.u, body = this.moon.body;
    this.frame++;
    this.moon.place(f.time);
    sub(this.eye, f.camPos, body.center);
    sub(this.moonRel, body.center, f.camPos);
    this.update();
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(u.uVP, false, f.vp);
    gl.uniform3f(u.uPlanet, this.moonRel.x, this.moonRel.y, this.moonRel.z);
    gl.uniform1f(u.uR, body.radius); gl.uniform1f(u.uFC, f.fc); gl.uniform1f(u.uCellK, f.cellK); gl.uniform1f(u.uRelief, body.relief);
    const inner = body.radius - body.relief; // nothing lies lower, so this sphere hides only what is truly hidden
    let drawn = 0;
    for (let i = 0; i < this.drawList.length; i++) {
      const t = this.drawList[i];
      t.last = this.frame;
      sub(this.rel, t.center, this.eye);
      if (beyondHorizon(this.rel, t.radius, this.moonRel, inner)) continue;
      if (!inView(qRotate(this.view, f.invQ, this.rel), t.radius, f.tanY, f.aspect, NEAR)) continue;
      gl.uniform3f(u.uOff, this.rel.x, this.rel.y, this.rel.z);
      gl.uniform1f(u.uSpacing, t.spacing);
      gl.bindVertexArray(this.vaos[t.slot]);
      gl.drawElements(gl.TRIANGLES, this.nIdx, gl.UNSIGNED_SHORT, 0);
      drawn++;
    }
    return drawn * this.nIdx / 3;
  }

  resolveUniforms(): void {}
}
