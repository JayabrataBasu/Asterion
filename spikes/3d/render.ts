/** The 3D ASCII renderer: render passes and the planet tile cache.
 *  Pass 1 world geometry at 2x4 samples per cell -> pass 2 per-cell resolve (character choice, sky) -> pass 3 ship
 *  at 4x8 samples per cell -> the 2D game's FS_MATCH, FS_ASCII (a copy with one change: FS_ASCII3), bloom and composite.
 *  A renderer made with room for a swarm (the combat load test, combatLayer.ts) adds other ships to pass 3 and draws
 *  markers, bolts and particles between FS_ASCII and bloom. */
import { settings } from '../../src/core/config';
import { FILL_CHARS, MATCH_IDX, MATCH_N, buildAtlas, buildRampLut, gi, type AtlasInfo } from '../../src/gfx/atlas';
import { FS_BLOOM_DOWN, FS_BLOOM_UP, FS_COMPOSITE, VS_FULLSCREEN } from '../../src/gfx/shaders';
import { FS_MATCH } from '../../src/gfx/spriteShaders';
import type { Capacity, Swarm } from './combat';
import type { SwarmCounts, SwarmView } from './combatDraw';
import { type LayerFrame, SwarmLayer } from './combatLayer';
import { beyondHorizon, inView } from './cull';
import { type Quat, type Vec3, add, len, qRotate, scale, sub, v3, viewProj } from './math';
import { type Mesh, rockMesh, wrenMesh } from './meshes';
import { type Planet, atmoDensity } from './planet';
import { SCALE } from './scale';
import * as S from './shaders';
import {
  TILE_N, type TileId, type TileMesh, buildTile, faceDir, finestDepth, resolveDrawList, selectTiles, tileIndices, tileKey,
} from './tiles';
import { FrameTimer, type QueryApi, shownGpuMs } from './timing';
import type { TileReply, TileRequest } from './worker';

export interface Frame3 {
  camPos: Vec3; camQ: Quat;
  ship: { pos: Vec3; q: Quat } | null;
  planet: Planet; time: number;
  /** Other ships, bolts and particles; only for a renderer made with room for them. */
  swarm?: Swarm;
  /** Stability mode (see MODE_NAMES): 0 dithered, a screen-pattern dither on the bands; 1 plain, characters from
   *  material and band only; 2 held, as plain, a cell changing band only once its luminance passes the edge by HOLD
   *  (see keepsHistory). */
  stab: 0 | 1 | 2;
}

/** Vertical field of view, fixed. */
export const FOV_Y = Math.PI / 3;
const NEAR = 0.5; // as viewProj
const FAR = 1e8; // log depth reaches 1 here
const FC = 1 / Math.log2(FAR + 1);
/** GPU slots, and the bound of the tile cache: more than the wanted tiles and their ancestors ever are near the
 *  ground, which is up to about 430 at depth 6 and 810 at depth 10. */
export const MAX_TILES = 1024;
const VERTS = (TILE_N + 1) ** 2 + 4 * TILE_N;
const ROCKS = 150, ROCK_KINDS = 4;
const UPLOADS_PER_FRAME = 12;
const BLOOM_LEVELS = 5;
const ZERO4 = new Float32Array(4), ONE1 = new Float32Array([1]);
/** Dithered mode: peak-to-peak luminance dither on the bands, the size of the 2D game's ramp dither. */
const DITHER = 0.09;
/** Held mode: how far past a band edge the luminance must be before the cell changes band. */
const HOLD = 0.05;
/** Resolve glyph table: index order matches the G_* defines in shaders.ts. */
/** Pass names for the per-pass profile. */
export const PASSES = ['world', 'resolve', 'ship+match', 'ascii', 'bloom', 'composite'];
/** With a swarm there are two more. */
const SWARM_PASSES = [...PASSES, 'swarm ships', 'swarm characters'];
const PASS_SWARM_SHIPS = 6, PASS_SWARM_CHARS = 7;
const GLYPHS3 = ['-', '/', '|', '\\', '~', '=', ':', '%', '#', '.', "'", '*', ',', ';'];

// ------------------------------------------------------------------ culling and cache rules (pure)

export { beyondHorizon, inView };

/** Tiles to build next: each wanted tile and its missing ancestors, without what is cached or pending,
 *  coarsest first and nearest first within a depth, at most `max`. */
export function requestOrder(
  wanted: TileId[], has: (key: number) => boolean, pending: (key: number) => boolean,
  dist: (t: TileId) => number, max: number,
): TileId[] {
  const seen = new Set<number>(), out: TileId[] = [], d = new Map<TileId, number>();
  for (const t of wanted) {
    for (let up = t.depth; up >= 0; up--) {
      const a: TileId = { face: t.face, depth: t.depth - up, ix: t.ix >> up, iy: t.iy >> up };
      const k = tileKey(a);
      if (seen.has(k)) continue;
      seen.add(k);
      if (has(k) || pending(k)) continue;
      out.push(a); d.set(a, dist(a));
    }
  }
  out.sort((a, b) => a.depth - b.depth || d.get(a)! - d.get(b)!);
  if (out.length > max) out.length = Math.max(0, max);
  return out;
}

/** Keys to drop so that at most `max` entries remain: least recently used first, never one in `keep`. */
export function evictKeys(entries: { key: number; last: number }[], keep: Set<number>, max: number): number[] {
  const over = entries.length - max;
  if (over <= 0) return [];
  return entries.filter(e => !keep.has(e.key)).sort((a, b) => a.last - b.last).slice(0, over).map(e => e.key);
}

/** A step of scripted time longer than this (seconds), or any step back, is a jump. */
const JUMP_S = 0.1;

/** What a frame's stability history depends on. `view` is the camera's position and turn; `tiles` counts changes
 *  of the drawn tile set. */
export interface HistoryKey { stab: number; time: number; planet: string; tiles: number; view: number[] }

/** Whether the bands of the frame `prev` may hold those of the frame `now` (`prev` null: there is none). A still view
 *  whose tiles changed shows new content at the same place, so it starts again; in flight tiles change all the time,
 *  and the view moving is already what the hysteresis is there for. */
export function keepsHistory(prev: HistoryKey | null, now: HistoryKey): boolean {
  if (!prev || prev.stab !== now.stab || prev.planet !== now.planet) return false;
  const dt = now.time - prev.time;
  if (!(dt >= 0 && dt <= JUMP_S)) return false;
  return prev.tiles === now.tiles || prev.view.some((v, i) => v !== now.view[i]);
}

// ------------------------------------------------------------------ renderer

type Loc = Record<string, WebGLUniformLocation | null>;
interface Target { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number }
interface Tile { id: TileId; key: number; slot: number; center: Vec3; radius: number; spacing: number; last: number }
interface Rock { pos: Vec3; size: number; q: Quat; kind: number }

/** Unit tangent axes at a direction, for placing things around it. */
function tangents(dir: Vec3): [Vec3, Vec3] {
  const a = Math.abs(dir.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0);
  const t = v3(a.y * dir.z - a.z * dir.y, a.z * dir.x - a.x * dir.z, a.x * dir.y - a.y * dir.x);
  scale(t, t, 1 / len(t));
  return [t, v3(dir.y * t.z - dir.z * t.y, dir.z * t.x - dir.x * t.z, dir.x * t.y - dir.y * t.x)];
}

function rand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Renderer3 {
  readonly gl: WebGL2RenderingContext;
  cols = 0; rows = 0; cwPx = 8; chPx = 16; W = 0; H = 0; ox = 0; oy = 0;
  readonly stats = { tiles: 0, tris: 0, pending: 0, gpuMs: 0, buildMsMean: 0, buildMsMax: 0, workerBuilt: 0, syncBuilt: 0 };
  /** Direction from the planet's centre around which the rock field sits; set before the first frame. */
  rockDir: Vec3 = v3(0.6, 0.35, 0.72);
  /** Prototype check views: 1 shows every world cell as a red '#'. */
  debug = 0;
  private readonly swarmLayer: SwarmLayer | null;
  /** The layer, if the last frame had a swarm. */
  private shown: SwarmLayer | null = null;

  private readonly sync: boolean;
  private hdr = false;
  private pTile: WebGLProgram; private pRock: WebGLProgram; private pResolve: WebGLProgram; private pShip: WebGLProgram;
  private pMatch: WebGLProgram; private pAscii: WebGLProgram; private pDown: WebGLProgram; private pUp: WebGLProgram;
  private pComp: WebGLProgram; private pGlyphs: WebGLProgram; private pHalo: WebGLProgram;
  private uTile: Loc; private uRock: Loc; private uResolve: Loc; private uShip: Loc; private uMatch: Loc; private uAscii: Loc;
  private uDown: Loc; private uUp: Loc; private uComp: Loc; private uGlyphs: Loc; private uHalo: Loc;
  private vaoEmpty: WebGLVertexArrayObject;
  private tilePos: WebGLBuffer; private tileNrm: WebGLBuffer; private tileMat: WebGLBuffer;
  private readonly tileVao: WebGLVertexArrayObject[] = [];
  private readonly nIdx: number;
  private readonly rockVao: WebGLVertexArrayObject[] = []; private readonly rockVerts: number[] = [];
  private rockInst: WebGLBuffer; private readonly rockData = new Float32Array(ROCK_KINDS * ROCKS * 8);
  private readonly rockCount = new Int32Array(ROCK_KINDS);
  private shipVao: WebGLVertexArrayObject; private readonly shipVerts: number;
  private atlasTex: WebGLTexture; private rampTex: WebGLTexture; private sigTex: WebGLTexture;
  private atlas!: AtlasInfo; private readonly atlasCache = new Map<string, AtlasInfo>();
  private readonly rampLut = new Uint8Array(256);
  private lastRamp = -1; private lastWeight = -1; private lastCell = -1;
  private readonly fill = Int32Array.from(Array.from(FILL_CHARS, c => gi(c)));
  private readonly G = new Float32Array(16);

  // size-dependent targets
  private worldFbo: WebGLFramebuffer | null = null; private worldCol: WebGLTexture | null = null;
  private worldNrm: WebGLTexture | null = null; private worldDep: WebGLTexture | null = null;
  /** The resolve target with two framebuffers onto it: [i] also writes band state i, read by the other next frame. */
  private resolveT: Target | null = null; private readonly resolveFbo: WebGLFramebuffer[] = [];
  private readonly bandState: WebGLTexture[] = []; private bandNow = 0;
  private hist: HistoryKey | null = null;
  private readonly keys: HistoryKey[] = [0, 1].map(() => ({ stab: 0, time: 0, planet: '', tiles: 0, view: [0, 0, 0, 0, 0, 0, 0] }));
  private listVersion = 0;
  private sprT: Target | null = null; private sprDepth: WebGLRenderbuffer | null = null;
  private matchFbo: WebGLFramebuffer | null = null; private matchA: WebGLTexture | null = null; private matchB: WebGLTexture | null = null;
  private compose: Target | null = null; private bloom: Target[] = []; private glyphT: Target | null = null;
  private haloT: Target | null = null;
  private readBuf = new Uint8Array(4);

  // tile cache
  private readonly cache = new Map<number, Tile>();
  private readonly freeSlots: number[] = [];
  private planetKey = ''; private planet: Planet | null = null;
  private wanted: TileId[] = []; private wantedKeys: number[] = [];
  private readonly keep = new Set<number>();
  private drawList: Tile[] = []; private dirty = true; private queueDirty = true;
  private queue: TileId[] = [];
  private readonly pendingKeys = new Set<number>();
  private readonly arrived: TileReply[] = [];
  private workers: Worker[] = []; private readonly inFlight: number[] = [];
  private lastSelect = v3(Infinity, 0, 0);
  private frameNo = 0;
  private buildN = 0; private buildSum = 0;
  private rocks: Rock[] = []; private rocksFor = ''; private readonly rocksDir = v3(NaN, NaN, NaN);

  // per-frame scratch
  private readonly vp = new Float32Array(16);
  private readonly rot = new Float32Array(9); private readonly shipRot = new Float32Array(9);
  private readonly rel = v3(); private readonly view = v3(); private readonly planetRel = v3();
  private readonly invQ: Quat = { x: 0, y: 0, z: 0, w: 1 };
  private readonly axX = v3(1, 0, 0); private readonly axY = v3(0, 1, 0); private readonly axZ = v3(0, 0, 1);
  private readonly tmp = v3();

  private timerExt: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;

  /** `swarm`: the most other ships, bolts and particles a frame will bring (none: no swarm is drawn). */
  constructor(readonly canvas: HTMLCanvasElement, opts: { sync: boolean; swarm?: Capacity | null }) {
    this.sync = opts.sync;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;
    this.hdr = !!gl.getExtension('EXT_color_buffer_float');
    this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');

    this.pTile = this.prog(S.VS_TILE, S.FS_WORLD); this.pRock = this.prog(S.VS_ROCK, S.FS_WORLD);
    this.pResolve = this.prog(VS_FULLSCREEN, S.FS_RESOLVE); this.pShip = this.prog(S.VS_SHIP, S.FS_SHIP);
    this.pMatch = this.prog(VS_FULLSCREEN, FS_MATCH); this.pAscii = this.prog(VS_FULLSCREEN, S.FS_ASCII3);
    this.pDown = this.prog(VS_FULLSCREEN, FS_BLOOM_DOWN); this.pUp = this.prog(VS_FULLSCREEN, FS_BLOOM_UP);
    this.pComp = this.prog(VS_FULLSCREEN, FS_COMPOSITE); this.pGlyphs = this.prog(VS_FULLSCREEN, S.FS_GLYPHS);
    this.pHalo = this.prog(VS_FULLSCREEN, S.FS_HALO);
    const world = ['uVP', 'uOff', 'uPlanet', 'uR', 'uFC', 'uSpacing', 'uCellK', 'uRelief'];
    this.uTile = this.locs(this.pTile, world); this.uRock = this.locs(this.pRock, world);
    this.uResolve = this.locs(this.pResolve, ['uCol', 'uDep', 'uCells', 'uCamRot', 'uTan', 'uEye', 'uR', 'uAtmo', 'uTime', 'uSunK', 'uG', 'uFC', 'uDebug', 'uPrev', 'uDither', 'uHold']);
    this.uShip = this.locs(this.pShip, ['uVP', 'uRot', 'uOff', 'uFC', 'uDep', 'uSky']);
    this.uMatch = this.locs(this.pMatch, ['uSpr', 'uSig', 'uCand', 'uNC', 'uFill']);
    this.uAscii = this.locs(this.pAscii, ['uScene', 'uRamp', 'uAtlas', 'uMA', 'uMB', 'uCells', 'uOrigin', 'uCellPx', 'uExposure', 'uDither', 'uBgK', 'uFgBase', 'uFgGain', 'uTime', 'uReveal', 'uLayers', 'uQZ', 'uQN', 'uWorldCell', 'uHalo']);
    this.uDown = this.locs(this.pDown, ['uSrc', 'uTexel', 'uPre', 'uThr', 'uKnee']);
    this.uUp = this.locs(this.pUp, ['uSrc', 'uTexel', 'uGain']);
    this.uComp = this.locs(this.pComp, ['uScene', 'uBloom', 'uCanvas', 'uTime', 'uBloomK', 'uChroma', 'uCurve', 'uScan', 'uVig', 'uFlash', 'uHit', 'uGrain', 'uWarp']);
    this.uGlyphs = this.locs(this.pGlyphs, ['uScene', 'uMA', 'uRamp', 'uExposure']);
    this.uHalo = this.locs(this.pHalo, ['uMA', 'uCells']);
    this.vaoEmpty = gl.createVertexArray()!;
    this.swarmLayer = opts.swarm ? new SwarmLayer(gl, opts.swarm, (vs, fs) => this.prog(vs, fs)) : null;

    // planet tiles: one big buffer per attribute, one slot per cached tile, one VAO per slot (all made here, once)
    const idx = tileIndices(); this.nIdx = idx.length;
    const ibo = gl.createBuffer()!;
    this.tilePos = this.buffer(MAX_TILES * VERTS * 12); this.tileNrm = this.buffer(MAX_TILES * VERTS * 12);
    this.tileMat = this.buffer(MAX_TILES * VERTS);
    for (let s = 0; s < MAX_TILES; s++) {
      const vao = gl.createVertexArray()!; gl.bindVertexArray(vao);
      this.attr(0, this.tilePos, 3, gl.FLOAT, 0, s * VERTS * 12, 0);
      this.attr(1, this.tileNrm, 3, gl.FLOAT, 0, s * VERTS * 12, 0);
      this.attr(2, this.tileMat, 1, gl.UNSIGNED_BYTE, 0, s * VERTS, 0);
      if (s === 0) { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW); }
      else gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      this.tileVao.push(vao); this.freeSlots.push(MAX_TILES - 1 - s);
    }
    gl.bindVertexArray(null);

    // rocks: a few shapes, instanced
    this.rockInst = this.buffer(this.rockData.byteLength);
    for (let k = 0; k < ROCK_KINDS; k++) {
      const m = rockMesh(k + 1);
      this.rockVao.push(this.meshVao(m, () => {
        this.attr(3, this.rockInst, 4, gl.FLOAT, 32, k * ROCKS * 32, 1);
        this.attr(4, this.rockInst, 4, gl.FLOAT, 32, k * ROCKS * 32 + 16, 1);
      }));
      this.rockVerts.push(m.pos.length / 3);
    }
    const wren = wrenMesh();
    this.shipVao = this.meshVao(wren); this.shipVerts = wren.pos.length / 3;

    this.atlasTex = this.tex2d(); this.rampTex = this.tex2d(); this.sigTex = this.tex2d();
    this.G.set(GLYPHS3.map(c => gi(c) / 255));
    if (!this.sync) this.startWorkers();
  }

  // ------------------------------------------------------------------ setup helpers
  private prog(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const mk = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    return p;
  }
  private locs(p: WebGLProgram, names: string[]): Loc {
    const o: Loc = {};
    for (const n of names) o[n] = this.gl.getUniformLocation(p, n);
    return o;
  }
  private buffer(bytes: number): WebGLBuffer {
    const gl = this.gl, b = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.DYNAMIC_DRAW);
    return b;
  }
  private attr(loc: number, buf: WebGLBuffer, size: number, type: number, stride: number, off: number, div: number): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, type, false, stride, off); gl.vertexAttribDivisor(loc, div);
  }
  private meshVao(m: Mesh, extra?: () => void): WebGLVertexArrayObject {
    const gl = this.gl, vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    for (const [loc, data] of [[0, m.pos], [1, m.nrm], [2, m.col]] as const) {
      const b = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      this.attr(loc, b, 3, gl.FLOAT, 0, 0, 0);
    }
    extra?.();
    gl.bindVertexArray(null);
    return vao;
  }
  private tex2d(): WebGLTexture {
    const gl = this.gl, t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  /** A colour texture of the frame's format (half float where it can be rendered to). */
  private colorTex(w: number, h: number, linear = false, rgba8 = false): WebGLTexture {
    const gl = this.gl, t = this.tex2d();
    if (this.hdr && !rgba8) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    if (linear) { gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); }
    return t;
  }
  private target(w: number, h: number, linear = false, rgba8 = false): Target {
    const gl = this.gl, tex = this.colorTex(w, h, linear, rgba8), fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fbo, w, h };
  }
  private free(t: Target | null): void { if (t) { this.gl.deleteTexture(t.tex); this.gl.deleteFramebuffer(t.fbo); } }

  /** Rebuilds everything that depends on window size, display scale or cell size. */
  resize(cssW: number, cssH: number, dpr: number): void {
    const gl = this.gl;
    this.cwPx = Math.max(3, Math.round(settings.cellCss * (cssH >= 1300 ? 1.25 : 1) * dpr));
    this.chPx = this.cwPx * 2;
    this.W = Math.max(1, Math.round(cssW * dpr)); this.H = Math.max(1, Math.round(cssH * dpr));
    this.canvas.width = this.W; this.canvas.height = this.H;
    this.cols = Math.max(8, Math.floor(this.W / this.cwPx)); this.rows = Math.max(4, Math.floor(this.H / this.chPx));
    this.ox = Math.floor((this.W - this.cols * this.cwPx) / 2); this.oy = Math.floor((this.H - this.rows * this.chPx) / 2);
    const { cols, rows } = this;

    if (this.worldFbo) {
      gl.deleteFramebuffer(this.worldFbo); gl.deleteTexture(this.worldCol); gl.deleteTexture(this.worldNrm); gl.deleteTexture(this.worldDep);
      gl.deleteRenderbuffer(this.sprDepth); gl.deleteTexture(this.matchA); gl.deleteTexture(this.matchB); gl.deleteFramebuffer(this.matchFbo);
    }
    for (const t of [this.resolveT, this.sprT, this.compose, this.glyphT, this.haloT, ...this.bloom]) this.free(t);
    this.bloom = [];
    if (this.resolveFbo.length) gl.deleteFramebuffer(this.resolveFbo[1]); // [0] is resolveT's own, freed above
    for (const t of this.bandState) gl.deleteTexture(t);
    this.resolveFbo.length = 0; this.bandState.length = 0;
    this.hist = null; // new targets: no band history

    // pass 1: colour + material, normal, log depth (a texture, read by the resolve and the ship pass)
    this.worldCol = this.colorTex(cols * 2, rows * 4); this.worldNrm = this.colorTex(cols * 2, rows * 4, false, true);
    this.worldDep = this.tex2d();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT32F, cols * 2, rows * 4, 0, gl.DEPTH_COMPONENT, gl.FLOAT, null);
    this.worldFbo = gl.createFramebuffer()!; gl.bindFramebuffer(gl.FRAMEBUFFER, this.worldFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.worldCol, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.worldNrm, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.worldDep, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    this.checkFbo('world');

    this.resolveT = this.target(cols, rows);
    this.resolveFbo.push(this.resolveT.fbo, gl.createFramebuffer()!);
    for (let i = 0; i < 2; i++) {
      this.bandState.push(this.colorTex(cols, rows, false, true));
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.resolveFbo[i]);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.resolveT.tex, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.bandState[i], 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      this.checkFbo('resolve');
    }
    this.sprT = this.target(cols * 4, rows * 8);
    this.sprDepth = gl.createRenderbuffer()!; gl.bindRenderbuffer(gl.RENDERBUFFER, this.sprDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, cols * 4, rows * 8);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sprT.fbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.sprDepth);
    this.checkFbo('ship');
    this.swarmLayer?.resize(cols, rows, this.sprT.fbo);

    this.matchA = this.colorTex(cols, rows); this.matchB = this.colorTex(cols, rows);
    this.matchFbo = gl.createFramebuffer()!; gl.bindFramebuffer(gl.FRAMEBUFFER, this.matchFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.matchA, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.matchB, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

    this.compose = this.target(this.W, this.H, true);
    let w = this.W, h = this.H;
    for (let i = 0; i < BLOOM_LEVELS; i++) { w = Math.max(2, w >> 1); h = Math.max(2, h >> 1); this.bloom.push(this.target(w, h, true)); }
    this.glyphT = this.target(cols, rows, false, true);
    this.haloT = this.target(cols, rows, false, true);
    this.readBuf = new Uint8Array(cols * rows * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.refreshAtlas(true);
  }
  private checkFbo(name: string): void {
    const gl = this.gl, s = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (s !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`${name} framebuffer incomplete: 0x${s.toString(16)}`);
  }

  private refreshAtlas(force = false): void {
    const gl = this.gl;
    if (force || this.lastWeight !== settings.weight || this.lastCell !== this.cwPx) {
      const key = this.cwPx + ':' + settings.weight;
      this.atlas = this.atlasCache.get(key) ?? buildAtlas(this.cwPx, this.chPx, settings.weight);
      this.atlasCache.set(key, this.atlas);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, this.atlas.canvas);
      gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, this.sigTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 4, 8 * 256, 0, gl.RED, gl.UNSIGNED_BYTE, this.atlas.sig);
      this.lastWeight = settings.weight; this.lastCell = this.cwPx; this.lastRamp = -1;
    }
    if (this.lastRamp !== settings.ramp) {
      buildRampLut(settings.ramp, this.atlas.density, this.rampLut);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.rampTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 1, 0, gl.RED, gl.UNSIGNED_BYTE, this.rampLut);
      this.lastRamp = settings.ramp;
    }
  }

  // ------------------------------------------------------------------ tiles
  private startWorkers(): void {
    for (const w of this.workers) w.terminate();
    this.workers = []; this.inFlight.length = 0;
    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2));
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<TileReply>) => { this.inFlight[i]--; this.arrived.push(e.data); };
      w.onerror = e => { console.error('tile worker', e.message); };
      this.workers.push(w); this.inFlight.push(0);
    }
  }

  /** Starts over for another planet: empties the cache and builds the six roots here and now. */
  private setPlanet(p: Planet): void {
    for (const t of this.cache.values()) this.freeSlots.push(t.slot);
    this.cache.clear(); this.pendingKeys.clear(); this.arrived.length = 0; this.queue = [];
    if (!this.sync && this.planet) this.startWorkers();
    this.planet = p; this.wanted = []; this.wantedKeys = []; this.keep.clear(); this.dirty = true;
    this.lastSelect.x = Infinity;
    for (let face = 0; face < 6; face++) this.insert(this.buildHere({ face, depth: 0, ix: 0, iy: 0 }), { face, depth: 0, ix: 0, iy: 0 });
  }

  private buildHere(id: TileId): TileMesh {
    const t0 = performance.now();
    const m = buildTile(this.planet!, id);
    this.noteBuild(performance.now() - t0);
    this.stats.syncBuilt++;
    return m;
  }
  private noteBuild(ms: number): void {
    this.buildN++; this.buildSum += ms;
    this.stats.buildMsMean = this.buildSum / this.buildN;
    this.stats.buildMsMax = Math.max(this.stats.buildMsMax, ms);
  }

  /** Puts a mesh into a GPU slot, evicting the least recently used unprotected tile if the cache is full. */
  private insert(m: TileMesh, id: TileId): void {
    const gl = this.gl;
    if (this.cache.has(m.key)) return;
    if (this.freeSlots.length === 0) {
      const entries = [...this.cache.values()];
      for (const k of evictKeys(entries, this.keep, MAX_TILES - 1)) {
        const t = this.cache.get(k)!; this.cache.delete(k); this.freeSlots.push(t.slot);
      }
      if (this.freeSlots.length === 0) return; // everything cached is in use: drop it, it will be asked for again
    }
    const slot = this.freeSlots.pop()!;
    let r2 = 0;
    for (let i = 0; i < m.pos.length; i += 3) r2 = Math.max(r2, m.pos[i] ** 2 + m.pos[i + 1] ** 2 + m.pos[i + 2] ** 2);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.tilePos); gl.bufferSubData(gl.ARRAY_BUFFER, slot * VERTS * 12, m.pos);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.tileNrm); gl.bufferSubData(gl.ARRAY_BUFFER, slot * VERTS * 12, m.nrm);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.tileMat); gl.bufferSubData(gl.ARRAY_BUFFER, slot * VERTS, m.mat);
    this.cache.set(m.key, {
      id, key: m.key, slot, center: v3(m.center.x, m.center.y, m.center.z), radius: Math.sqrt(r2),
      spacing: this.planet!.radius * Math.PI / 2 / 2 ** id.depth / TILE_N, last: this.frameNo,
    });
    this.dirty = true;
  }

  private tileDist = (t: TileId): number => {
    const n = 2 ** t.depth, p = this.planet!;
    faceDir(this.tmp, t.face, -1 + 2 * (t.ix + 0.5) / n, -1 + 2 * (t.iy + 0.5) / n);
    add(this.tmp, p.center, scale(this.tmp, this.tmp, p.radius));
    return len(sub(this.tmp, this.tmp, this.camPos));
  };
  private camPos = v3();

  private updateTiles(f: Frame3): void {
    const p = f.planet;
    if (p !== this.planetSeen) { // another planet object: start over only if it describes another planet
      this.planetSeen = p;
      const key = [p.seed, p.radius, p.atmo, p.relief, p.center.x, p.center.y, p.center.z, JSON.stringify(SCALE)].join('|');
      if (key !== this.planetKey) { this.planetKey = key; this.setPlanet(p); }
      this.planet = p;
    }
    this.camPos.x = f.camPos.x; this.camPos.y = f.camPos.y; this.camPos.z = f.camPos.z;

    // wanted set, again only once the camera has moved a little
    const alt = Math.max(1, len(sub(this.tmp, f.camPos, p.center)) - p.radius);
    if (len(sub(this.tmp, f.camPos, this.lastSelect)) > Math.max(1, alt * 0.01)) {
      this.lastSelect.x = f.camPos.x; this.lastSelect.y = f.camPos.y; this.lastSelect.z = f.camPos.z;
      const wanted = selectTiles(p, f.camPos);
      const keys = wanted.map(tileKey);
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
        for (const k of this.keep) { const t = this.cache.get(k); if (t) t.last = this.frameNo; }
      }
    }

    const has = this.has;
    if (this.sync) {
      if (this.dirty) for (const id of requestOrder(this.wanted, has, never, this.tileDist, MAX_TILES)) this.insert(this.buildHere(id), id);
    } else {
      for (let n = 0; n < UPLOADS_PER_FRAME && this.arrived.length > 0; n++) {
        const m = this.arrived.shift()!;
        const k = m.key;
        if (!this.pendingKeys.delete(k)) continue; // stale: asked for another planet
        this.noteBuild(m.buildMs);
        this.stats.workerBuilt++;
        add(m.center, m.center, p.center);
        const id = this.pendingIds.get(k)!; this.pendingIds.delete(k);
        this.insert(m, id);
      }
      const capacity = this.workers.length * 2;
      let busy = 0;
      for (const n of this.inFlight) busy += n;
      if (busy < capacity) {
        if (this.queueDirty) this.queue = requestOrder(this.wanted, has, this.isPending, this.tileDist, MAX_TILES);
        this.queueDirty = false;
        while (busy < capacity && this.queue.length > 0) {
          const id = this.queue.shift()!, k = tileKey(id);
          if (this.cache.has(k) || this.pendingKeys.has(k)) continue;
          let w = 0;
          for (let i = 1; i < this.workers.length; i++) if (this.inFlight[i] < this.inFlight[w]) w = i;
          const msg: TileRequest = { seed: p.seed, radius2d: p.radius / SCALE.radiusK, scale: { ...SCALE }, id };
          this.workers[w].postMessage(msg);
          this.inFlight[w]++; busy++;
          this.pendingKeys.add(k); this.pendingIds.set(k, id);
        }
      }
    }

    if (this.dirty) {
      this.queueDirty = true;
      this.drawList = resolveDrawList(this.wanted, has, finestDepth(p)).map(t => this.cache.get(tileKey(t))!);
      this.listVersion++;
      this.dirty = false;
    }
    let missing = 0;
    for (const k of this.wantedKeys) if (!this.cache.has(k)) missing++;
    this.stats.pending = this.sync ? 0 : Math.max(missing, this.pendingKeys.size + this.arrived.length);
  }
  private readonly pendingIds = new Map<number, TileId>();
  private planetSeen: Planet | null = null;
  private readonly has = (k: number): boolean => this.cache.has(k);
  private readonly isPending = (k: number): boolean => this.pendingKeys.has(k);

  /** True once every wanted tile is drawn at its own detail and nothing is being built. */
  get settled(): boolean {
    return this.wantedKeys.length > 0 && this.stats.pending === 0 && this.wantedKeys.every(k => this.cache.has(k));
  }

  // ------------------------------------------------------------------ rocks
  private placeRocks(p: Planet): void {
    const d0 = this.rocksDir;
    if (this.rocksFor === this.planetKey && d0.x === this.rockDir.x && d0.y === this.rockDir.y && d0.z === this.rockDir.z) return;
    this.rocksFor = this.planetKey; d0.x = this.rockDir.x; d0.y = this.rockDir.y; d0.z = this.rockDir.z;
    const r = rand(p.seed * 7919 + 17), dir = scale(v3(), this.rockDir, 1 / len(this.rockDir));
    const [t, b] = tangents(dir);
    this.rocks = [];
    for (let i = 0; i < ROCKS; i++) {
      const alt = 400 * (25000 / 400) ** r();
      const spread = 300 + alt * 0.6, a = r() * Math.PI * 2, d = spread * Math.sqrt(r());
      const pos = add(v3(), p.center, scale(v3(), dir, p.radius + p.relief + alt));
      pos.x += (t.x * Math.cos(a) + b.x * Math.sin(a)) * d;
      pos.y += (t.y * Math.cos(a) + b.y * Math.sin(a)) * d;
      pos.z += (t.z * Math.cos(a) + b.z * Math.sin(a)) * d;
      const qx = r() - 0.5, qy = r() - 0.5, qz = r() - 0.5, qw = r() - 0.5, ql = Math.hypot(qx, qy, qz, qw) || 1;
      this.rocks.push({
        pos, size: (3 + alt * 0.0015) * (0.5 + r()), kind: i % ROCK_KINDS,
        q: { x: qx / ql, y: qy / ql, z: qz / ql, w: qw / ql },
      });
    }
  }

  // ------------------------------------------------------------------ frame
  render(f: Frame3): void {
    const gl = this.gl, st = settings, p = f.planet;
    if (f.swarm && !this.swarmLayer) throw new Error('this renderer was made without room for a swarm');
    const sw = f.swarm ? this.swarmLayer : null;
    this.shown = sw;
    this.frameNo++;
    this.timerBegin();
    this.refreshAtlas();
    this.updateTiles(f);
    this.placeRocks(p);

    const { cols, rows } = this;
    const aspect = cols / (rows * 2), tanY = Math.tan(FOV_Y / 2);
    viewProj(this.vp, f.camQ, FOV_Y, aspect);
    const fc = FC, cellK = 2 * tanY / rows;
    this.invQ.x = -f.camQ.x; this.invQ.y = -f.camQ.y; this.invQ.z = -f.camQ.z; this.invQ.w = f.camQ.w;
    sub(this.planetRel, p.center, f.camPos);
    if (sw) {
      const v = this.swarmView;
      v.camPos = f.camPos; v.camQ = f.camQ; v.cols = cols; v.rows = rows; v.tanY = tanY; v.planet = p;
      sw.prepare(f.swarm!, v, f.ship);
    }

    // ---- pass 1: world at 2x4 samples per cell
    this.mark(0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.worldFbo); gl.viewport(0, 0, cols * 2, rows * 4);
    gl.depthMask(true);
    gl.clearBufferfv(gl.COLOR, 0, ZERO4); gl.clearBufferfv(gl.COLOR, 1, ZERO4); gl.clearBufferfv(gl.DEPTH, 0, ONE1);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true);
    gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); gl.disable(gl.BLEND);

    let u = this.uTile;
    gl.useProgram(this.pTile);
    gl.uniformMatrix4fv(u.uVP, false, this.vp);
    gl.uniform3f(u.uPlanet, this.planetRel.x, this.planetRel.y, this.planetRel.z);
    gl.uniform1f(u.uR, p.radius); gl.uniform1f(u.uFC, fc); gl.uniform1f(u.uCellK, cellK); gl.uniform1f(u.uRelief, p.relief);
    let tiles = 0;
    for (const t of this.drawList) {
      t.last = this.frameNo;
      sub(this.rel, t.center, f.camPos);
      if (beyondHorizon(this.rel, t.radius, this.planetRel, p.radius)) continue;
      if (!inView(qRotate(this.view, this.invQ, this.rel), t.radius, tanY, aspect, NEAR)) continue;
      gl.uniform3f(u.uOff, this.rel.x, this.rel.y, this.rel.z);
      gl.uniform1f(u.uSpacing, t.spacing);
      gl.bindVertexArray(this.tileVao[t.slot]);
      gl.drawElements(gl.TRIANGLES, this.nIdx, gl.UNSIGNED_SHORT, 0);
      tiles++;
    }
    let tris = tiles * this.nIdx / 3;

    // rocks: cull on the processor, then one instanced draw per shape
    this.rockCount.fill(0);
    for (const r of this.rocks) {
      sub(this.rel, r.pos, f.camPos);
      const br = r.size * 1.6;
      if (beyondHorizon(this.rel, br, this.planetRel, p.radius)) continue;
      if (!inView(qRotate(this.view, this.invQ, this.rel), br, tanY, aspect, NEAR)) continue;
      const o = (r.kind * ROCKS + this.rockCount[r.kind]++) * 8, d = this.rockData;
      d[o] = this.rel.x; d[o + 1] = this.rel.y; d[o + 2] = this.rel.z; d[o + 3] = r.size;
      d[o + 4] = r.q.x; d[o + 5] = r.q.y; d[o + 6] = r.q.z; d[o + 7] = r.q.w;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rockInst); gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.rockData);
    gl.useProgram(this.pRock); u = this.uRock;
    gl.uniformMatrix4fv(u.uVP, false, this.vp); gl.uniform1f(u.uFC, fc); gl.uniform1f(u.uCellK, cellK);
    gl.uniform1f(u.uSpacing, 1.5); gl.uniform1f(u.uR, p.radius); gl.uniform1f(u.uRelief, p.relief);
    for (let k = 0; k < ROCK_KINDS; k++) {
      if (this.rockCount[k] === 0) continue;
      gl.bindVertexArray(this.rockVao[k]);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, this.rockVerts[k], this.rockCount[k]);
      tris += this.rockVerts[k] / 3 * this.rockCount[k];
    }

    // ---- pass 2: resolve, one pixel per cell
    this.mark(1);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    const hold = this.stepHistory(f);
    this.bandNow = 1 - this.bandNow;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.resolveFbo[this.bandNow]); gl.viewport(0, 0, cols, rows);
    gl.useProgram(this.pResolve); gl.bindVertexArray(this.vaoEmpty);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.worldCol);
    gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, this.worldDep);
    gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_2D, this.bandState[1 - this.bandNow]);
    u = this.uResolve;
    gl.uniform1i(u.uCol, 3); gl.uniform1i(u.uDep, 6); gl.uniform1i(u.uPrev, 8);
    gl.uniform1f(u.uDither, f.stab === 0 ? DITHER : 0); gl.uniform1f(u.uHold, f.stab === 2 && hold ? HOLD : 0);
    gl.uniform2i(u.uCells, cols, rows);
    qRotate(this.axX, f.camQ, v3x); qRotate(this.axY, f.camQ, v3y); qRotate(this.axZ, f.camQ, v3z);
    this.rot[0] = this.axX.x; this.rot[1] = this.axX.y; this.rot[2] = this.axX.z;
    this.rot[3] = this.axY.x; this.rot[4] = this.axY.y; this.rot[5] = this.axY.z;
    this.rot[6] = this.axZ.x; this.rot[7] = this.axZ.y; this.rot[8] = this.axZ.z;
    gl.uniformMatrix3fv(u.uCamRot, false, this.rot);
    gl.uniform2f(u.uTan, tanY * aspect, tanY);
    gl.uniform3f(u.uEye, -this.planetRel.x, -this.planetRel.y, -this.planetRel.z);
    gl.uniform1f(u.uR, p.radius); gl.uniform1f(u.uAtmo, p.atmo); gl.uniform1f(u.uTime, f.time);
    gl.uniform1f(u.uSunK, st.sun); gl.uniform1fv(u.uG, this.G); gl.uniform1f(u.uFC, fc); gl.uniform1i(u.uDebug, this.debug);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // ---- pass 3: ships at 4x8 samples per cell, behind-world fragments dropped; then glyph matching
    if (sw) { // the others first: the player's ship and the matching then share the target
      this.mark(PASS_SWARM_SHIPS);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sprT!.fbo); gl.viewport(0, 0, cols * 4, rows * 8);
      gl.clearBufferfv(gl.COLOR, 0, ZERO4); gl.clearBufferfv(gl.DEPTH, 0, ONE1);
      gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE);
      const dens = atmoDensity(p, f.camPos);
      tris += sw.drawShips(this.layerFrame(), 0.05 + 0.25 * dens, 0.06 + 0.4 * dens, 0.09 + 0.7 * dens);
    }
    this.mark(2);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.matchFbo); gl.viewport(0, 0, cols, rows);
    if (f.ship || sw) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sprT!.fbo); gl.viewport(0, 0, cols * 4, rows * 8);
      if (!sw) { gl.clearBufferfv(gl.COLOR, 0, ZERO4); gl.clearBufferfv(gl.DEPTH, 0, ONE1); }
      gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE);
      if (f.ship) {
        gl.useProgram(this.pShip); u = this.uShip;
        const q = f.ship.q;
        qRotate(this.axX, q, v3x); qRotate(this.axY, q, v3y); qRotate(this.axZ, q, v3z);
        const m = this.shipRot;
        m[0] = this.axX.x; m[1] = this.axX.y; m[2] = this.axX.z; m[3] = this.axY.x; m[4] = this.axY.y; m[5] = this.axY.z;
        m[6] = this.axZ.x; m[7] = this.axZ.y; m[8] = this.axZ.z;
        sub(this.rel, f.ship.pos, f.camPos);
        gl.uniformMatrix4fv(u.uVP, false, this.vp); gl.uniformMatrix3fv(u.uRot, false, m);
        gl.uniform3f(u.uOff, this.rel.x, this.rel.y, this.rel.z); gl.uniform1f(u.uFC, fc); gl.uniform1i(u.uDep, 6);
        const dens = atmoDensity(p, f.camPos);
        gl.uniform3f(u.uSky, 0.05 + 0.25 * dens, 0.06 + 0.4 * dens, 0.09 + 0.7 * dens);
        gl.bindVertexArray(this.shipVao);
        gl.drawArrays(gl.TRIANGLES, 0, this.shipVerts);
        tris += this.shipVerts / 3;
      }
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.matchFbo); gl.viewport(0, 0, cols, rows);
      gl.useProgram(this.pMatch); gl.bindVertexArray(this.vaoEmpty);
      gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, this.sprT!.tex);
      gl.uniform1i(this.uMatch.uSpr, 6); gl.uniform1i(this.uMatch.uSig, 7);
      gl.uniform1iv(this.uMatch.uCand, MATCH_IDX); gl.uniform1i(this.uMatch.uNC, MATCH_N); gl.uniform1iv(this.uMatch.uFill, this.fill);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else {
      gl.clearBufferfv(gl.COLOR, 0, ZERO4); gl.clearBufferfv(gl.COLOR, 1, ZERO4);
    }

    // ---- FS_ASCII: quiet zones off, dither off; the ship's halo first, once per cell
    this.mark(3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.haloT!.fbo); gl.viewport(0, 0, cols, rows);
    gl.useProgram(this.pHalo); gl.bindVertexArray(this.vaoEmpty);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.matchA);
    gl.uniform1i(this.uHalo.uMA, 4); gl.uniform2i(this.uHalo.uCells, cols, rows);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.compose!.fbo); gl.viewport(0, 0, this.W, this.H);
    gl.useProgram(this.pAscii); gl.bindVertexArray(this.vaoEmpty);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.resolveT!.tex);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.matchA);
    gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, this.matchB);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.haloT!.tex);
    const a = this.uAscii;
    gl.uniform1i(a.uScene, 0); gl.uniform1i(a.uAtlas, 1); gl.uniform1i(a.uRamp, 2); gl.uniform1i(a.uMA, 4); gl.uniform1i(a.uMB, 5);
    gl.uniform2i(a.uCells, cols, rows); gl.uniform2i(a.uOrigin, this.ox, this.oy); gl.uniform2i(a.uCellPx, this.cwPx, this.chPx);
    gl.uniform1f(a.uExposure, st.exposure); gl.uniform1f(a.uDither, 0); gl.uniform1f(a.uBgK, st.bgK);
    gl.uniform1f(a.uFgBase, st.fgBase); gl.uniform1f(a.uFgGain, st.fgGain); gl.uniform1f(a.uTime, f.time);
    gl.uniform3f(a.uReveal, -1, 4, 0); gl.uniform1i(a.uLayers, 0); gl.uniform2i(a.uWorldCell, 0, 0);
    gl.uniform4fv(a.uQZ, QZ_NONE); gl.uniform1i(a.uQN, 0); gl.uniform1i(a.uHalo, 3);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (sw) { // markers, bolts and particles over the characters, so that bloom takes them too
      this.mark(PASS_SWARM_CHARS);
      sw.drawPicture(this.layerFrame(), this.W, this.H, this.ox, this.oy, this.cwPx, this.chPx, this.resolveT!.tex, st.bgK);
      gl.bindVertexArray(this.vaoEmpty);
    }

    // ---- bloom (as the 2D renderer)
    this.mark(4);
    const bloomOn = st.bloom > 0.001, lv = Math.max(2, Math.min(BLOOM_LEVELS, st.bloomLevels | 0));
    if (bloomOn) {
      gl.useProgram(this.pDown);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(this.uDown.uSrc, 0); gl.uniform1f(this.uDown.uThr, st.bloomThr); gl.uniform1f(this.uDown.uKnee, 0.5);
      let src: Target = this.compose!;
      for (let i = 0; i < lv; i++) {
        const dst = this.bloom[i];
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo); gl.viewport(0, 0, dst.w, dst.h);
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        gl.uniform2f(this.uDown.uTexel, 1 / src.w, 1 / src.h); gl.uniform1f(this.uDown.uPre, i === 0 ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        src = dst;
      }
      gl.useProgram(this.pUp); gl.uniform1i(this.uUp.uSrc, 0); gl.uniform1f(this.uUp.uGain, 1.0);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = lv - 1; i > 0; i--) {
        const s = this.bloom[i], d = this.bloom[i - 1];
        gl.bindFramebuffer(gl.FRAMEBUFFER, d.fbo); gl.viewport(0, 0, d.w, d.h);
        gl.bindTexture(gl.TEXTURE_2D, s.tex);
        gl.uniform2f(this.uUp.uTexel, 1 / s.w, 1 / s.h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.BLEND);
    }

    // ---- composite to the screen
    this.mark(5);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.W, this.H);
    gl.useProgram(this.pComp);
    const c = this.uComp;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.compose!.tex);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.bloom[0].tex);
    gl.uniform1i(c.uScene, 0); gl.uniform1i(c.uBloom, 3);
    gl.uniform2f(c.uCanvas, this.W, this.H); gl.uniform1f(c.uTime, f.time);
    gl.uniform1f(c.uBloomK, bloomOn ? st.bloom * 0.55 : 0); gl.uniform1f(c.uChroma, st.chroma * 3.0); gl.uniform1f(c.uCurve, st.curve);
    gl.uniform1f(c.uScan, st.scan); gl.uniform1f(c.uVig, st.vig); gl.uniform1f(c.uFlash, 0); gl.uniform1f(c.uHit, 0);
    gl.uniform1f(c.uGrain, st.grain); gl.uniform4fv(c.uWarp, WARP_NONE);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    this.mark(SWARM_PASSES.length);
    this.timerEnd();

    this.stats.tiles = tiles; this.stats.tris = tris;
  }

  /** The next frame starts without band history: for a jump the frames themselves may not show. */
  resetHistory(): void { this.hist = null; }

  /** Whether this frame may hold the last one's bands, and remembers this frame for the next. */
  private stepHistory(f: Frame3): boolean {
    const now = this.keys[this.hist === this.keys[0] ? 1 : 0], v = now.view, p = f.camPos, q = f.camQ;
    now.stab = f.stab; now.time = f.time; now.planet = this.planetKey; now.tiles = this.listVersion;
    v[0] = p.x; v[1] = p.y; v[2] = p.z; v[3] = q.x; v[4] = q.y; v[5] = q.z; v[6] = q.w;
    const keep = keepsHistory(this.hist, now);
    this.hist = now;
    return keep;
  }

  /** The character index shown in each cell of the last frame, row by row from the top: the ship's or the
   *  world's explicit one, or for plain cells the luminance-ramp lookup FS_ASCII makes. `out` holds cols * rows. */
  readGlyphs(out: Uint8Array): void {
    const gl = this.gl, { cols, rows } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.glyphT!.fbo); gl.viewport(0, 0, cols, rows);
    gl.useProgram(this.pGlyphs); gl.bindVertexArray(this.vaoEmpty);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.resolveT!.tex);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.matchA);
    gl.uniform1i(this.uGlyphs.uScene, 0); gl.uniform1i(this.uGlyphs.uMA, 4); gl.uniform1i(this.uGlyphs.uRamp, 2);
    gl.uniform1f(this.uGlyphs.uExposure, settings.exposure);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.shown?.drawIndices(this.layerFrame()); // markers, bolts and particles, over what they cover
    gl.readPixels(0, 0, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, this.readBuf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.bindVertexArray(null);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) out[(rows - 1 - y) * cols + x] = this.readBuf[(y * cols + x) * 4];
  }

  // ------------------------------------------------------------------ swarm
  private readonly swarmView: SwarmView = { camPos: v3(), camQ: { x: 0, y: 0, z: 0, w: 1 }, cols: 0, rows: 0, tanY: 0, planet: null };
  private readonly forLayer = { vp: this.vp, fc: FC } as LayerFrame;
  private layerFrame(): LayerFrame { this.forLayer.worldDepth = this.worldDep!; return this.forLayer; }

  /** What of the last frame's swarm shows (null without one). Draws it again and reads it back: slow. */
  countSwarm(): SwarmCounts | null {
    if (!this.shown) return null;
    const counts = this.shown.count(this.layerFrame()), gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.bindVertexArray(null);
    return counts;
  }
  /** Processor ms the last frame spent on the swarm's lists and uploads; 0 without one. */
  get swarmBuildMs(): number { return this.shown?.buildMs ?? 0; }
  /** False: world and ships hide no marker, bolt or particle (the occlusion check's control). */
  set swarmOcclude(on: boolean) { if (this.swarmLayer) this.swarmLayer.occlude = on; }
  /** A rock of the field, for the occlusion check. */
  rockAt(i: number): { pos: Vec3; size: number } | null { return this.rocks[i] ?? null; }

  // ------------------------------------------------------------------ GPU timing
  /** Called once for each frame whose graphics time came back, with that frame's number (see `frame`) and ms.
   *  Frames whose query was dropped, lost or read during a disjoint event never get a call. */
  onGpu: ((frame: number, ms: number) => void) | null = null;
  /** Number of the last frame rendered, as passed to onGpu. */
  get frame(): number { return this.frameNo; }
  /** The whole-frame timer's counts: delivered, dropped (no free query), discarded (disjoint), lost (never came). */
  get gpuCounts(): { delivered: number; dropped: number; discarded: number; lost: number } {
    const t = this.frameTimer;
    return t ? { delivered: t.delivered, dropped: t.dropped, discarded: t.discarded, lost: t.lost } : { delivered: 0, dropped: 0, discarded: 0, lost: 0 };
  }
  /** Per-pass graphics timing instead of the whole frame (prototype measurement; needs the timer extension).
   *  Set before the first frame. While it is on, onGpu is not called and stats.gpuMs is the sum of the passes. */
  profile = false;
  /** Smoothed graphics ms per pass, in passNames order, while profiling. */
  readonly passMs = new Float64Array(SWARM_PASSES.length);
  /** The names that go with passMs: the swarm's two only if there is room for a swarm. */
  get passNames(): readonly string[] { return this.swarmLayer ? SWARM_PASSES : PASSES; }
  private frameTimer: FrameTimer<WebGLQuery> | null = null;
  private passTimers: FrameTimer<WebGLQuery>[] = [];
  private markOpen = -1; private disjointNow = false;
  private readonly takeFrame = (frame: number, ms: number): void => {
    this.stats.gpuMs += (ms - this.stats.gpuMs) * 0.1;
    this.onGpu?.(frame, ms);
  };
  private readonly takePass = Array.from(SWARM_PASSES, (_, i) => (_frame: number, ms: number): void => {
    this.passMs[i] += (ms - this.passMs[i]) * 0.1;
    this.stats.gpuMs = shownGpuMs(true, 0, this.passMs);
  });
  private queryApi(ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }): QueryApi<WebGLQuery> {
    const gl = this.gl;
    return {
      create: () => gl.createQuery()!,
      remove: q => gl.deleteQuery(q),
      begin: q => gl.beginQuery(ext.TIME_ELAPSED_EXT, q),
      end: () => gl.endQuery(ext.TIME_ELAPSED_EXT),
      available: q => gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) as boolean,
      resultNs: q => gl.getQueryParameter(q, gl.QUERY_RESULT) as number,
      disjoint: () => this.disjointNow, // read once per frame, shared by every timer
    };
  }
  private timerBegin(): void {
    const ext = this.timerExt;
    if (!ext) return;
    if (!this.frameTimer) {
      const api = this.queryApi(ext);
      this.frameTimer = new FrameTimer(api, 6);
      this.passTimers = this.passNames.map(() => new FrameTimer(api, 6));
    }
    if (!this.profile) this.frameTimer.begin(this.frameNo);
  }
  private timerEnd(): void {
    const ext = this.timerExt;
    if (!ext || !this.frameTimer) return;
    if (!this.profile) this.frameTimer.end();
    this.disjointNow = this.gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
    this.frameTimer.poll(this.takeFrame);
    for (let i = 0; i < this.passTimers.length; i++) this.passTimers[i].poll(this.takePass[i]);
  }
  /** Ends the running pass timer and starts the one for pass `i` (past the last one: none, end of frame). */
  private mark(i: number): void {
    if (!this.profile || this.passTimers.length === 0) return;
    if (this.markOpen >= 0) { this.passTimers[this.markOpen].end(); this.markOpen = -1; }
    if (i < this.passTimers.length) { this.passTimers[i].begin(this.frameNo); this.markOpen = i; }
  }
  get hasTimer(): boolean { return this.timerExt !== null; }
}

const never = (): boolean => false;
const v3x = v3(1, 0, 0), v3y = v3(0, 1, 0), v3z = v3(0, 0, 1);
const QZ_NONE = new Float32Array(64);
const WARP_NONE = new Float32Array(24);
