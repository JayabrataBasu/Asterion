/** The graphics side of the combat load test, made only when a scene is asked for. Renderer3 calls it between its own
 *  passes: the other ships into the ship target (before the player's, and before matching), then markers, bolts and
 *  particles over the character picture, before bloom. Everything is made once, or again at a resize. */
import { gi } from '../../src/gfx/atlas';
import type { Capacity, Swarm } from './combat';
import { GLYPH_FLOATS, SHIP_FLOATS, type SwarmCounts, SwarmList, type SwarmView } from './combatDraw';
import * as C from './combatShaders';
import type { Quat, Vec3 } from './math';
import { wrenMesh } from './meshes';
import { FS_SHIP } from './shaders';

/** Hull colours of the other ships are the player's times this; glowing parts keep theirs. */
const TINT = [1.0, 0.42, 0.34] as const;
const COUNT_W = 256;
// texture units no pass of the renderer uses
const UNIT_DEPTH = 9, UNIT_SHIP_DEPTH = 10, UNIT_SCENE = 11;
const UNIT_ATLAS = 1; // where the renderer keeps it

type Loc = Record<string, WebGLUniformLocation | null>;
interface Buf { tex: WebGLTexture; fbo: WebGLFramebuffer }

/** What the renderer's frame gives the layer. */
export interface LayerFrame {
  /** The renderer's view-projection and depth factor. */
  vp: Float32Array; fc: number;
  worldDepth: WebGLTexture;
}

export class SwarmLayer {
  readonly list: SwarmList;
  /** Processor ms the last frame's lists and uploads took. */
  buildMs = 0;
  /** False only for the occlusion check's control: nothing hides the characters. */
  occlude = true;

  private readonly pShip: WebGLProgram; private readonly pId: WebGLProgram; private readonly pGlyph: WebGLProgram;
  private readonly uShip: Loc; private readonly uId: Loc; private readonly uGlyph: Loc;
  private readonly shipBuf: WebGLBuffer; private readonly drawBuf: WebGLBuffer; private readonly candBuf: WebGLBuffer;
  private readonly shipVao: WebGLVertexArrayObject; private readonly shipVerts: number;
  private readonly drawVao: WebGLVertexArrayObject; private readonly candVao: WebGLVertexArrayObject;
  private shipDepth: WebGLTexture | null = null;
  private ids: Buf | null = null; private idDepth: WebGLRenderbuffer | null = null;
  private counts: Buf | null = null;
  private cols = 0; private rows = 0;
  private idRead = new Uint8Array(0);
  private readonly countRows: number;
  private readonly countRead: Uint8Array; private readonly candSeen: Uint8Array; private readonly meshSeen: Uint8Array;

  constructor(private readonly gl: WebGL2RenderingContext, cap: Capacity,
    prog: (vs: string, fs: string) => WebGLProgram) {
    this.list = new SwarmList(cap, gi);
    const locs = (p: WebGLProgram, names: string[]): Loc => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(p, n)]));
    this.pShip = prog(C.VS_SWARM_SHIP, FS_SHIP); this.pId = prog(C.VS_SWARM_SHIP, C.FS_SWARM_ID);
    this.pGlyph = prog(C.VS_SWARM_GLYPH, C.FS_SWARM_GLYPH);
    this.uShip = locs(this.pShip, ['uVP', 'uTint', 'uFC', 'uDep', 'uSky']);
    this.uId = locs(this.pId, ['uVP', 'uTint', 'uFC', 'uDep']);
    this.uGlyph = locs(this.pGlyph, ['uDep', 'uShipDep', 'uFC', 'uMode', 'uOcclude', 'uViewport', 'uOrigin', 'uCellPx', 'uAtlas', 'uScene', 'uBgK']);

    const buffer = (bytes: number): WebGLBuffer => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, Math.max(4, bytes), gl.DYNAMIC_DRAW);
      return b;
    };
    this.shipBuf = buffer(this.list.shipData.byteLength);
    this.drawBuf = buffer(this.list.draw.byteLength);
    this.candBuf = buffer(this.list.cand.byteLength);

    const attr = (loc: number, buf: WebGLBuffer, size: number, stride: number, off: number, divisor: number): void => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off); gl.vertexAttribDivisor(loc, divisor);
    };
    const mesh = wrenMesh();
    this.shipVerts = mesh.pos.length / 3;
    this.shipVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.shipVao);
    [mesh.pos, mesh.nrm, mesh.col].forEach((data, loc) => {
      const b = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      attr(loc, b, 3, 0, 0, 0);
    });
    for (let k = 0; k < 4; k++) attr(3 + k, this.shipBuf, 3, SHIP_FLOATS * 4, k * 12, 1);
    const cells = (buf: WebGLBuffer): WebGLVertexArrayObject => {
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      attr(0, buf, 4, GLYPH_FLOATS * 4, 0, 1); attr(1, buf, 4, GLYPH_FLOATS * 4, 16, 1);
      return vao;
    };
    this.drawVao = cells(this.drawBuf);
    this.candVao = cells(this.candBuf);
    gl.bindVertexArray(null);

    this.countRows = Math.max(1, Math.ceil(this.list.capacity / COUNT_W));
    this.countRead = new Uint8Array(COUNT_W * this.countRows * 4);
    this.candSeen = new Uint8Array(this.list.capacity);
    this.meshSeen = new Uint8Array(cap.ships + 1);
  }

  private texture(internal: number, w: number, h: number): WebGLTexture {
    const gl = this.gl, t = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + UNIT_SCENE); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return t;
  }
  private target(w: number, h: number): Buf {
    const gl = this.gl, tex = this.texture(gl.RGBA8, w, h), fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fbo };
  }
  private check(name: string): void {
    const gl = this.gl, s = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (s !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`${name} framebuffer incomplete: 0x${s.toString(16)}`);
  }

  /** After the renderer has made its targets: the ship target's depth becomes a texture the characters can read. */
  resize(cols: number, rows: number, shipFbo: WebGLFramebuffer): void {
    const gl = this.gl;
    if (this.shipDepth) {
      gl.deleteTexture(this.shipDepth); gl.deleteRenderbuffer(this.idDepth);
      for (const t of [this.ids!, this.counts!]) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
    }
    this.cols = cols; this.rows = rows;
    this.shipDepth = this.texture(gl.DEPTH_COMPONENT24, cols * 4, rows * 8);
    gl.bindFramebuffer(gl.FRAMEBUFFER, shipFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shipDepth, 0);
    this.check('ship');
    this.ids = this.target(cols * 4, rows * 8);
    this.idDepth = gl.createRenderbuffer()!; gl.bindRenderbuffer(gl.RENDERBUFFER, this.idDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, cols * 4, rows * 8);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.idDepth);
    this.check('ship count');
    this.counts = this.target(COUNT_W, this.countRows);
    this.check('count');
    this.idRead = new Uint8Array(cols * 4 * rows * 8 * 4);
  }

  /** Builds this frame's lists and hands them to the chip. */
  prepare(swarm: Swarm, view: SwarmView, player: { pos: Vec3; q: Quat } | null): void {
    const t0 = performance.now(), gl = this.gl, l = this.list;
    l.build(swarm, view, player);
    // a length of 0 would mean "all of it"
    if (l.countShips > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.shipBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, l.shipData, 0, l.countShips * SHIP_FLOATS);
    }
    if (l.drawCount > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.drawBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, l.draw, 0, l.drawCount * GLYPH_FLOATS);
    }
    this.buildMs = performance.now() - t0;
  }

  /** The other ships, into the bound ship target (cleared, depth test on). Returns the triangles drawn. */
  drawShips(f: LayerFrame, skyR: number, skyG: number, skyB: number): number {
    const gl = this.gl, u = this.uShip, n = this.list.meshCount;
    if (n === 0) return 0;
    gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, f.worldDepth);
    gl.useProgram(this.pShip);
    gl.uniformMatrix4fv(u.uVP, false, f.vp); gl.uniform3f(u.uTint, TINT[0], TINT[1], TINT[2]);
    gl.uniform1f(u.uFC, f.fc); gl.uniform1i(u.uDep, 6); gl.uniform3f(u.uSky, skyR, skyG, skyB);
    gl.bindVertexArray(this.shipVao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, this.shipVerts, n);
    return this.shipVerts / 3 * n;
  }

  private glyphs(f: LayerFrame, mode: number, vao: WebGLVertexArrayObject, n: number, w: number, h: number,
    ox: number, oy: number, cw: number, ch: number, scene: WebGLTexture | null, bgK: number): void {
    if (n === 0) return;
    const gl = this.gl, u = this.uGlyph;
    gl.useProgram(this.pGlyph); gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0 + UNIT_DEPTH); gl.bindTexture(gl.TEXTURE_2D, f.worldDepth);
    gl.activeTexture(gl.TEXTURE0 + UNIT_SHIP_DEPTH); gl.bindTexture(gl.TEXTURE_2D, this.shipDepth);
    gl.activeTexture(gl.TEXTURE0 + UNIT_SCENE); gl.bindTexture(gl.TEXTURE_2D, scene);
    gl.uniform1i(u.uDep, UNIT_DEPTH); gl.uniform1i(u.uShipDep, UNIT_SHIP_DEPTH); gl.uniform1i(u.uScene, UNIT_SCENE);
    gl.uniform1i(u.uAtlas, UNIT_ATLAS);
    gl.uniform1f(u.uFC, f.fc); gl.uniform1i(u.uMode, mode); gl.uniform1i(u.uOcclude, this.occlude ? 1 : 0);
    gl.uniform2f(u.uViewport, w, h); gl.uniform2i(u.uOrigin, ox, oy); gl.uniform2i(u.uCellPx, cw, ch); gl.uniform1f(u.uBgK, bgK);
    if (mode === 2) gl.drawArraysInstanced(gl.POINTS, 0, 1, n);
    else gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    // let go of the depth textures: they are drawn into again next frame
    gl.activeTexture(gl.TEXTURE0 + UNIT_DEPTH); gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0 + UNIT_SHIP_DEPTH); gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** The characters, onto the bound full-size picture. `scene` is the resolve's colour, for their backdrop. */
  drawPicture(f: LayerFrame, W: number, H: number, ox: number, oy: number, cw: number, ch: number, scene: WebGLTexture, bgK: number): void {
    this.glyphs(f, 0, this.drawVao, this.list.drawCount, W, H, ox, oy, cw, ch, scene, bgK);
  }

  /** The indices of the characters that show, into the bound one-pixel-per-cell target. */
  drawIndices(f: LayerFrame): void {
    this.glyphs(f, 1, this.drawVao, this.list.drawCount, this.cols, this.rows, 0, 0, 1, 1, null, 0);
  }

  /** Counts what of the last prepared frame shows, by drawing it again and reading it back. Slow: not for timed
   *  frames. */
  count(f: LayerFrame): SwarmCounts {
    const gl = this.gl, l = this.list;
    gl.disable(gl.BLEND);

    // mesh ships: which instances are left in any sample, with the player in front of those behind it
    this.meshSeen.fill(0);
    if (l.meshCount > 0) {
      const w = this.cols * 4, h = this.rows * 8, u = this.uId;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.ids!.fbo); gl.viewport(0, 0, w, h);
      gl.clearBufferfv(gl.COLOR, 0, ZERO4); gl.depthMask(true); gl.clearBufferfv(gl.DEPTH, 0, ONE1);
      gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE);
      gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, f.worldDepth);
      gl.useProgram(this.pId);
      gl.uniformMatrix4fv(u.uVP, false, f.vp); gl.uniform3f(u.uTint, 1, 1, 1); gl.uniform1f(u.uFC, f.fc); gl.uniform1i(u.uDep, 6);
      gl.bindVertexArray(this.shipVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, this.shipVerts, l.countShips);
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.idRead);
      for (let i = 0; i < this.idRead.length; i += 4) {
        const id = this.idRead[i] + this.idRead[i + 1] * 256;
        if (id > 0 && id <= l.meshCount) this.meshSeen[id - 1] = 1;
      }
    }

    // characters: one pixel each
    this.candSeen.fill(0);
    if (l.candCount > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.candBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, l.cand, 0, l.candCount * GLYPH_FLOATS);
      const rows = Math.ceil(l.candCount / COUNT_W);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.counts!.fbo); gl.viewport(0, 0, COUNT_W, this.countRows);
      gl.clearBufferfv(gl.COLOR, 0, ZERO4);
      this.glyphs(f, 2, this.candVao, l.candCount, COUNT_W, this.countRows, 0, 0, 1, 1, null, 0);
      gl.readPixels(0, 0, COUNT_W, rows, gl.RGBA, gl.UNSIGNED_BYTE, this.countRead);
      for (let i = 0; i < l.candCount; i++) {
        const v = this.countRead[i * 4];
        if (v === 0) throw new Error(`count: entry ${i} of ${l.candCount} was not written`);
        this.candSeen[i] = v > 200 ? 1 : 0;
      }
    }
    return l.tally(this.meshSeen, this.candSeen);
  }
}

const ZERO4 = new Float32Array(4), ONE1 = new Float32Array([1]);
