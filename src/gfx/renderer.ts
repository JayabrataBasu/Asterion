import { settings } from '../core/config';
import { FILL_CHARS, MATCH_IDX, MATCH_N, RAMPS, buildAtlas, buildRampLut, gi, type AtlasInfo } from './atlas';
import { GLOW_STRIDE, GLYPH_STRIDE, GlowBatch, GlyphBatch, MAX_GLOWS, MAX_GLYPHS, MAX_SPRITES, SPRITE_STRIDE, SpriteBatch } from './batch';
import { FS_MATCH, FS_SPRITE, SPR_X, SPR_Y, VS_SPRITE } from './spriteShaders';
import * as S from './shaders';

type Loc = Record<string, WebGLUniformLocation | null>;
interface Target { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number; }

export interface FrameParams {
  camX: number; camY: number; time: number;
  planets: Float32Array; nPlanets: number;       // stride 8 (x,y,r,type,seed,ring,hue,spin)
  flash: number; hit: number;
  streakX: number; streakY: number; streak: number; ship?: [number, number, number]; combat?: number; hyper?: [number, number, number]; flare?: number; storm?: number; warp?: Float32Array; tint?: [number, number, number];
  /** Star colour of the current system, eclipse / megastructure progress (0 = off), heading + speed factor for star aberration. */
  sunTint?: [number, number, number]; style?: [number, number, number, number]; ecl?: number; mega?: number;
  /** Typed-arrival reveal radius in cells (<0 = off); planet index being rewritten by the scan view (-1 none); layer debug. */
  reveal?: number; scanPlanet?: number; layers?: boolean;
}
/** Scene glyph table (index order must match the G_* defines in FS_SCENE). */
const GLYPHS = ['-', '/', '|', String.fromCharCode(92), '.', ',', ':', ';', '~', '=', '#', '%', '*', "'", '@', '+', 'o', '(', ')'];

const BLOOM_LEVELS = 5;
const ZERO4 = new Float32Array(4);

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly glyphs = new GlyphBatch();
  readonly glows = new GlowBatch();
  readonly sprites = new SpriteBatch();
  private readonly noWarp = new Float32Array(24);
  /** Camera zoom: cell width is reduced by this many CSS px (main tweens the step with a CSS scale). */
  cols = 0; rows = 0; cwPx = 8; chPx = 16; aspect = 2; W = 0; H = 0; ox = 0; oy = 0; dpr = 1;
  drawCalls = 0; gpuMs = 0; hdr = false;

  private pScene!: WebGLProgram; private pGlow!: WebGLProgram; private pAscii!: WebGLProgram;
  private pSprite!: WebGLProgram; private pMatch!: WebGLProgram; private uSprite!: Loc; private uMatch!: Loc;
  private vaoSprite!: WebGLVertexArrayObject; private spriteBuf!: WebGLBuffer;
  private sprT!: Target; private matchFbo!: WebGLFramebuffer; private matchA!: WebGLTexture; private matchB!: WebGLTexture;
  private sigTex!: WebGLTexture;
  private pGlyph!: WebGLProgram; private pDown!: WebGLProgram; private pUp!: WebGLProgram; private pComp!: WebGLProgram;
  private uScene!: Loc; private uGlow!: Loc; private uAscii!: Loc; private uGlyph!: Loc; private uDown!: Loc; private uUp!: Loc; private uComp!: Loc;
  private vaoEmpty!: WebGLVertexArrayObject; private vaoGlow!: WebGLVertexArrayObject; private vaoGlyph!: WebGLVertexArrayObject;
  private glowBuf!: WebGLBuffer; private glyphBuf!: WebGLBuffer;
  private scene!: Target; private compose!: Target; private bloom: Target[] = [];
  private atlasTex!: WebGLTexture; private rampTex!: WebGLTexture;
  private atlas!: AtlasInfo;
  private readonly atlasCache = new Map<string, AtlasInfo>();
  private readonly rampLut = new Uint8Array(256);
  private lastRamp = -1; private lastWeight = -1; private lastCell = -1;
  private readonly pa = new Float32Array(32); private readonly pb = new Float32Array(32);
  private readonly G = new Float32Array(24);
  private readonly pc = new Float32Array(32);
  /** Ship quiet zones for this frame (cell units): x, y, hull radius, allegiance. */
  private readonly qz = new Float32Array(64); private qn = 0;
  private readonly fill = Int32Array.from(Array.from(FILL_CHARS, c => gi(c)));
  private timerExt: any = null; private queries: WebGLQuery[] = []; private qIdx = 0; private qPending: boolean[] = [false, false, false];

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false, desynchronized: true });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;
    this.hdr = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (this.timerExt) for (let i = 0; i < 3; i++) this.queries.push(gl.createQuery()!);
    this.pScene = this.prog(S.VS_FULLSCREEN, S.FS_SCENE);
    this.pGlow = this.prog(S.VS_GLOW, S.FS_GLOW);
    this.pAscii = this.prog(S.VS_FULLSCREEN, S.FS_ASCII);
    this.pGlyph = this.prog(S.VS_GLYPH, S.FS_GLYPH);
    this.pSprite = this.prog(VS_SPRITE, FS_SPRITE);
    this.pMatch = this.prog(S.VS_FULLSCREEN, FS_MATCH);
    this.pDown = this.prog(S.VS_FULLSCREEN, S.FS_BLOOM_DOWN);
    this.pUp = this.prog(S.VS_FULLSCREEN, S.FS_BLOOM_UP);
    this.pComp = this.prog(S.VS_FULLSCREEN, S.FS_COMPOSITE);
    this.uScene = this.locs(this.pScene, ['uRes', 'uCam', 'uAspect', 'uTime', 'uNP', 'uPA', 'uPB', 'uPC', 'uG', 'uNeb', 'uSun', 'uStreak', 'uTint', 'uShipL', 'uFlare', 'uStorm', 'uSunTint', 'uEcl', 'uMega', 'uCombat', 'uHyper', 'uStyle']);
    this.uGlow = this.locs(this.pGlow, ['uRes', 'uCam', 'uAspect']);
    this.uAscii = this.locs(this.pAscii, ['uScene', 'uRamp', 'uAtlas', 'uMA', 'uMB', 'uCells', 'uOrigin', 'uCellPx', 'uExposure', 'uDither', 'uBgK', 'uFgBase', 'uFgGain', 'uTime', 'uReveal', 'uLayers', 'uQZ', 'uQN', 'uWorldCell']);
    this.uGlyph = this.locs(this.pGlyph, ['uCellPx', 'uOrigin', 'uCanvas', 'uScene', 'uAtlas', 'uBgK']);
    this.uSprite = this.locs(this.pSprite, ['uRes', 'uCam', 'uAspect', 'uTime']);
    this.uMatch = this.locs(this.pMatch, ['uSpr', 'uSig', 'uCand', 'uNC', 'uFill']);
    this.uDown = this.locs(this.pDown, ['uSrc', 'uTexel', 'uPre', 'uThr', 'uKnee']);
    this.uUp = this.locs(this.pUp, ['uSrc', 'uTexel', 'uGain']);
    this.uComp = this.locs(this.pComp, ['uScene', 'uBloom', 'uCanvas', 'uTime', 'uBloomK', 'uChroma', 'uCurve', 'uScan', 'uVig', 'uFlash', 'uHit', 'uGrain', 'uWarp']);

    this.vaoEmpty = gl.createVertexArray()!;
    // static unit quad (triangle strip), shared by glow (-1..1) and glyph (0..1) via different attrib data
    const quadGlow = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, quadGlow);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const quadGlyph = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, quadGlyph);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.glowBuf = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, this.glowBuf);
    gl.bufferData(gl.ARRAY_BUFFER, MAX_GLOWS * GLOW_STRIDE * 4, gl.DYNAMIC_DRAW);
    this.glyphBuf = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphBuf);
    gl.bufferData(gl.ARRAY_BUFFER, MAX_GLYPHS * GLYPH_STRIDE * 4, gl.DYNAMIC_DRAW);

    this.vaoGlow = gl.createVertexArray()!; gl.bindVertexArray(this.vaoGlow);
    this.attrib(this.pGlow, 'aC', quadGlow, 2, 8, 0, 0);
    this.attrib(this.pGlow, 'aG0', this.glowBuf, 4, GLOW_STRIDE * 4, 0, 1);
    this.attrib(this.pGlow, 'aG1', this.glowBuf, 4, GLOW_STRIDE * 4, 16, 1);
    this.spriteBuf = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteBuf);
    gl.bufferData(gl.ARRAY_BUFFER, MAX_SPRITES * SPRITE_STRIDE * 4, gl.DYNAMIC_DRAW);
    this.vaoSprite = gl.createVertexArray()!; gl.bindVertexArray(this.vaoSprite);
    this.attrib(this.pSprite, 'aC', quadGlow, 2, 8, 0, 0);
    this.attrib(this.pSprite, 'aA', this.spriteBuf, 4, SPRITE_STRIDE * 4, 0, 1);
    this.attrib(this.pSprite, 'aB', this.spriteBuf, 4, SPRITE_STRIDE * 4, 16, 1);
    this.attrib(this.pSprite, 'aT', this.spriteBuf, 4, SPRITE_STRIDE * 4, 32, 1);
    this.vaoGlyph = gl.createVertexArray()!; gl.bindVertexArray(this.vaoGlyph);
    this.attrib(this.pGlyph, 'aC', quadGlyph, 2, 8, 0, 0);
    this.attrib(this.pGlyph, 'aI0', this.glyphBuf, 4, GLYPH_STRIDE * 4, 0, 1);
    this.attrib(this.pGlyph, 'aI1', this.glyphBuf, 4, GLYPH_STRIDE * 4, 16, 1);
    gl.bindVertexArray(null);

    this.atlasTex = gl.createTexture()!; this.rampTex = gl.createTexture()!; this.sigTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, this.sigTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.rampTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.G.set(GLYPHS.map(c => gi(c) / 255));
  }

  // ------------------------------------------------------------------ setup helpers
  private prog(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const mk = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s) + '\n' + src.split('\n').map((l, i) => (i + 1) + ': ' + l).join('\n'));
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
  private attrib(p: WebGLProgram, name: string, buf: WebGLBuffer, size: number, stride: number, off: number, div: number): void {
    const gl = this.gl, l = gl.getAttribLocation(p, name);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(l);
    gl.vertexAttribPointer(l, size, gl.FLOAT, false, stride, off); gl.vertexAttribDivisor(l, div);
  }
  private target(w: number, h: number, hdr: boolean, linear: boolean): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, tex);
    if (hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const f = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!; gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fbo, w, h };
  }
  private makeMatchTargets(): void {
    const gl = this.gl;
    if (this.matchA) { gl.deleteTexture(this.matchA); gl.deleteTexture(this.matchB); gl.deleteFramebuffer(this.matchFbo); }
    const mk = (): WebGLTexture => {
      const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, t);
      if (this.hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, this.cols, this.rows, 0, gl.RGBA, gl.HALF_FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.cols, this.rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.matchA = mk(); this.matchB = mk();
    this.matchFbo = gl.createFramebuffer()!; gl.bindFramebuffer(gl.FRAMEBUFFER, this.matchFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.matchA, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.matchB, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
  }
  private free(t: Target | undefined): void { if (t) { this.gl.deleteTexture(t.tex); this.gl.deleteFramebuffer(t.fbo); } }

  /** (Re)build everything that depends on window size, DPR or cell size. */
  resize(cssW: number, cssH: number, dpr: number): void {
    
    this.dpr = dpr;
    this.cwPx = Math.max(3, Math.round(settings.cellCss * (cssH >= 1300 ? 1.25 : 1) * dpr));   // 1440p+: bigger cells keep the HUD readable
    this.chPx = this.cwPx * 2; this.aspect = 2;
    this.W = Math.max(1, Math.round(cssW * dpr)); this.H = Math.max(1, Math.round(cssH * dpr));
    this.canvas.width = this.W; this.canvas.height = this.H;
    this.cols = Math.max(8, Math.floor(this.W / this.cwPx)); this.rows = Math.max(4, Math.floor(this.H / this.chPx));
    this.ox = Math.floor((this.W - this.cols * this.cwPx) / 2); this.oy = Math.floor((this.H - this.rows * this.chPx) / 2);

    this.free(this.scene); this.free(this.compose); for (const b of this.bloom) this.free(b); this.bloom.length = 0;
    this.scene = this.target(this.cols, this.rows, this.hdr, false);
    this.compose = this.target(this.W, this.H, this.hdr, true);
    this.free(this.sprT);
    this.sprT = this.target(this.cols * SPR_X, this.rows * SPR_Y, this.hdr, false);
    this.makeMatchTargets();
    let w = this.W, h = this.H;
    for (let i = 0; i < BLOOM_LEVELS; i++) { w = Math.max(2, w >> 1); h = Math.max(2, h >> 1); this.bloom.push(this.target(w, h, this.hdr, true)); }
    this.refreshAtlas(true);
  }

  /** Rebuild atlas / ramp when font weight, cell size or ramp changed. */
  refreshAtlas(force = false): void {
    const gl = this.gl;
    if (force || this.lastWeight !== settings.weight || this.lastCell !== this.cwPx) {
      const key = this.cwPx + ':' + settings.weight;          // cache: zoom steps switch cell size often
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
  get rampName(): string { return RAMPS[settings.ramp % RAMPS.length].name; }

  // ------------------------------------------------------------------ frame
  beginFrame(): void { this.glyphs.reset(this.cols, this.rows); this.glows.reset(); this.sprites.reset(); this.qn = 0; }
  /** Register a ship: the backdrop fades to black around (cx, cy) so the hull always sits in darkness. al: 0 player, 1 hostile, 2 neutral. */
  quiet(cx: number, cy: number, radius: number, al: number): void {
    if (this.qn >= 16 || cx < -40 || cy < -20 || cx > this.cols + 40 || cy > this.rows + 20) return;
    const o = this.qn++ * 4; this.qz[o] = cx; this.qz[o + 1] = cy; this.qz[o + 2] = radius; this.qz[o + 3] = al;
  }

  render(f: FrameParams): void {
    const gl = this.gl, st = settings;
    this.refreshAtlas();
    this.drawCalls = 0;
    this.timerBegin();

    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND);

    // ---- pass 1: scene, 1 texel per cell
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo); gl.viewport(0, 0, this.cols, this.rows);
    gl.useProgram(this.pScene); gl.bindVertexArray(this.vaoEmpty);
    const u = this.uScene;
    gl.uniform2f(u.uRes, this.cols, this.rows); gl.uniform2f(u.uCam, f.camX, f.camY);
    gl.uniform1f(u.uAspect, this.aspect); gl.uniform1f(u.uTime, f.time); gl.uniform1f(u.uNeb, st.nebula * (1 - 0.45 * (f.combat ?? 0))); gl.uniform1f(u.uSun, st.sun * (1 - 0.55 * (f.combat ?? 0)) * (1 + 1.6 * (f.flare ?? 0))); gl.uniform1f(u.uFlare, f.flare ?? 0); gl.uniform1f(u.uStorm, f.storm ?? 0);
    const np = Math.min(8, f.nPlanets);
    this.pa.fill(0); this.pb.fill(0); this.pc.fill(0);
    for (let i = 0; i < np; i++) {
      const o = i * 8;
      const dd = Math.max(0, Math.hypot(f.planets[o] - f.camX, f.planets[o + 1] - f.camY) - f.planets[o + 2]);
      const t = Math.min(1, Math.max(0, (dd - this.cols * 0.1) / (this.cols * 0.5)));
      this.pc[i * 4] = 1 - t * t * (3 - 2 * t);                 // detail: resolve-on-approach
      this.pc[i * 4 + 1] = f.scanPlanet === i ? 1 : 0;
      this.pa[i * 4] = f.planets[o]; this.pa[i * 4 + 1] = f.planets[o + 1]; this.pa[i * 4 + 2] = f.planets[o + 2]; this.pa[i * 4 + 3] = f.planets[o + 3];
      this.pb[i * 4] = f.planets[o + 4]; this.pb[i * 4 + 1] = f.planets[o + 5]; this.pb[i * 4 + 2] = f.planets[o + 6]; this.pb[i * 4 + 3] = f.planets[o + 7];
    }
    gl.uniform1i(u.uNP, np); gl.uniform4fv(u.uPA, this.pa); gl.uniform4fv(u.uPB, this.pb); gl.uniform4fv(u.uPC, this.pc); gl.uniform1fv(u.uG, this.G); gl.uniform3f(u.uStreak, f.streakX, f.streakY, f.streak); const sl = f.ship; gl.uniform3f(u.uShipL, sl ? sl[0] : 0, sl ? sl[1] : 0, sl ? sl[2] : 0); const tn = f.tint; gl.uniform3f(u.uTint, tn ? tn[0] : 1, tn ? tn[1] : 1, tn ? tn[2] : 1);
    const sn = f.sunTint;
    gl.uniform3f(u.uSunTint, sn ? sn[0] : 1, sn ? sn[1] : 1, sn ? sn[2] : 1); gl.uniform1f(u.uEcl, f.ecl ?? 0); gl.uniform1f(u.uMega, f.mega ?? 0);
    const sy = f.style; gl.uniform4f(u.uStyle, sy ? sy[0] : 0.78, sy ? sy[1] : 1, sy ? sy[2] : 1, sy ? sy[3] : 0.5); gl.uniform1f(u.uCombat, f.combat ?? 0); const hy = f.hyper; gl.uniform3f(u.uHyper, hy ? hy[0] : 0, hy ? hy[1] : 0, hy ? hy[2] : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3); this.drawCalls++;

    // ---- glow sprites (additive, alpha channel untouched)
    if (this.glows.n > 0) {
      gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
      gl.useProgram(this.pGlow); gl.bindVertexArray(this.vaoGlow);
      gl.uniform2f(this.uGlow.uRes, this.cols, this.rows); gl.uniform2f(this.uGlow.uCam, f.camX, f.camY); gl.uniform1f(this.uGlow.uAspect, this.aspect);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.glowBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.glows.data, 0, this.glows.n * GLOW_STRIDE);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.glows.n); this.drawCalls++;
      gl.disable(gl.BLEND);
    }

    // ---- sprite layer (SDF ships/asteroids/bolts at 4x8 samples per cell) + glyph matching
    const nSpr = this.sprites.n;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.matchFbo); gl.viewport(0, 0, this.cols, this.rows);
    if (nSpr > 0) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sprT.fbo); gl.viewport(0, 0, this.sprT.w, this.sprT.h);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.pSprite); gl.bindVertexArray(this.vaoSprite);
      gl.uniform2f(this.uSprite.uRes, this.cols, this.rows); gl.uniform2f(this.uSprite.uCam, f.camX, f.camY);
      gl.uniform1f(this.uSprite.uAspect, this.aspect); gl.uniform1f(this.uSprite.uTime, f.time);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.sprites.data, 0, nSpr * SPRITE_STRIDE);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nSpr); this.drawCalls++;
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.matchFbo); gl.viewport(0, 0, this.cols, this.rows);
      gl.useProgram(this.pMatch); gl.bindVertexArray(this.vaoEmpty);
      gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, this.sprT.tex);
      gl.uniform1i(this.uMatch.uSpr, 6); gl.uniform1i(this.uMatch.uSig, 7);
      gl.uniform1iv(this.uMatch.uCand, MATCH_IDX); gl.uniform1i(this.uMatch.uNC, MATCH_N); gl.uniform1iv(this.uMatch.uFill, this.fill);
      gl.drawArrays(gl.TRIANGLES, 0, 3); this.drawCalls++;
    } else {
      gl.clearBufferfv(gl.COLOR, 0, ZERO4); gl.clearBufferfv(gl.COLOR, 1, ZERO4);
    }

    // ---- pass 2: ASCII
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.compose.fbo); gl.viewport(0, 0, this.W, this.H);
    gl.useProgram(this.pAscii); gl.bindVertexArray(this.vaoEmpty);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.scene.tex);
    const a = this.uAscii;
    gl.uniform1i(a.uScene, 0); gl.uniform1i(a.uAtlas, 1); gl.uniform1i(a.uRamp, 2); gl.uniform1i(a.uMA, 4); gl.uniform1i(a.uMB, 5);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.matchA); gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, this.matchB); gl.activeTexture(gl.TEXTURE0);
    gl.uniform2i(a.uCells, this.cols, this.rows); gl.uniform2i(a.uOrigin, this.ox, this.oy); gl.uniform2i(a.uCellPx, this.cwPx, this.chPx);
    gl.uniform1f(a.uExposure, st.exposure); gl.uniform1f(a.uDither, st.dither); gl.uniform1f(a.uBgK, st.bgK);
    gl.uniform1f(a.uFgBase, st.fgBase); gl.uniform1f(a.uFgGain, st.fgGain); gl.uniform1f(a.uTime, f.time);
    gl.uniform3f(a.uReveal, f.reveal ?? -1, 4, f.reveal !== undefined && f.reveal >= 0 ? 1 : 0); gl.uniform1i(a.uLayers, f.layers ? 1 : 0); gl.uniform2i(a.uWorldCell, Math.floor(f.camX), Math.floor(f.camY / this.aspect)); gl.uniform4fv(a.uQZ, this.qz); gl.uniform1i(a.uQN, this.qn);
    gl.drawArrays(gl.TRIANGLES, 0, 3); this.drawCalls++;

    // ---- pass 3: instanced glyphs (entities, particles, HUD)
    if (this.glyphs.n > 0) {
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.pGlyph); gl.bindVertexArray(this.vaoGlyph);
      const g = this.uGlyph;
      gl.uniform2i(g.uCellPx, this.cwPx, this.chPx); gl.uniform2i(g.uOrigin, this.ox, this.oy); gl.uniform2f(g.uCanvas, this.W, this.H);
      gl.uniform1i(g.uScene, 0); gl.uniform1i(g.uAtlas, 1); gl.uniform1f(g.uBgK, st.bgK);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.glyphs.data, 0, this.glyphs.n * GLYPH_STRIDE);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.glyphs.n); this.drawCalls++;
      gl.disable(gl.BLEND);
    }

    // ---- bloom (dual Kawase)
    const bloomOn = st.bloom > 0.001;
    const lv = Math.max(2, Math.min(BLOOM_LEVELS, st.bloomLevels | 0));
    if (bloomOn) {
      gl.useProgram(this.pDown);
      gl.uniform1i(this.uDown.uSrc, 0); gl.uniform1f(this.uDown.uThr, st.bloomThr); gl.uniform1f(this.uDown.uKnee, 0.5);
      let src: Target = this.compose;
      for (let i = 0; i < lv; i++) {
        const dst = this.bloom[i];
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo); gl.viewport(0, 0, dst.w, dst.h);
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        gl.uniform2f(this.uDown.uTexel, 1 / src.w, 1 / src.h); gl.uniform1f(this.uDown.uPre, i === 0 ? 1 : 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3); this.drawCalls++;
        src = dst;
      }
      gl.useProgram(this.pUp); gl.uniform1i(this.uUp.uSrc, 0); gl.uniform1f(this.uUp.uGain, 1.0);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = lv - 1; i > 0; i--) {
        const s = this.bloom[i], d = this.bloom[i - 1];
        gl.bindFramebuffer(gl.FRAMEBUFFER, d.fbo); gl.viewport(0, 0, d.w, d.h);
        gl.bindTexture(gl.TEXTURE_2D, s.tex);
        gl.uniform2f(this.uUp.uTexel, 1 / s.w, 1 / s.h);
        gl.drawArrays(gl.TRIANGLES, 0, 3); this.drawCalls++;
      }
      gl.disable(gl.BLEND);
    }

    // ---- composite to screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.W, this.H);
    gl.useProgram(this.pComp);
    const c = this.uComp;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.compose.tex);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.bloom[0].tex);
    gl.uniform1i(c.uScene, 0); gl.uniform1i(c.uBloom, 3);
    gl.uniform2f(c.uCanvas, this.W, this.H); gl.uniform1f(c.uTime, f.time);
    gl.uniform1f(c.uBloomK, bloomOn ? st.bloom * 0.55 * (1 + 0.5 * (f.flare ?? 0)) : 0); gl.uniform1f(c.uChroma, st.chroma * 3.0); gl.uniform1f(c.uCurve, st.curve);
    gl.uniform1f(c.uScan, st.scan); gl.uniform1f(c.uVig, st.vig); gl.uniform1f(c.uFlash, f.flash); gl.uniform1f(c.uHit, f.hit); gl.uniform1f(c.uGrain, st.grain); gl.uniform4fv(c.uWarp, f.warp ?? this.noWarp);
    gl.drawArrays(gl.TRIANGLES, 0, 3); this.drawCalls++;
    gl.bindVertexArray(null);
    this.timerEnd();
  }

  // ------------------------------------------------------------------ GPU timing
  private timerBegin(): void {
    if (!this.timerExt || this.qPending[this.qIdx]) return;
    this.gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, this.queries[this.qIdx]);
  }
  private timerEnd(): void {
    const gl = this.gl;
    if (!this.timerExt) return;
    if (!this.qPending[this.qIdx]) { gl.endQuery(this.timerExt.TIME_ELAPSED_EXT); this.qPending[this.qIdx] = true; }
    this.qIdx = (this.qIdx + 1) % 3;
    for (let i = 0; i < 3; i++) {
      if (!this.qPending[i]) continue;
      if (gl.getQueryParameter(this.queries[i], gl.QUERY_RESULT_AVAILABLE)) {
        const disjoint = gl.getParameter(this.timerExt.GPU_DISJOINT_EXT);
        if (!disjoint) { const ns = gl.getQueryParameter(this.queries[i], gl.QUERY_RESULT) as number; this.gpuMs += (ns / 1e6 - this.gpuMs) * 0.1; }
        this.qPending[i] = false;
      }
    }
  }
}
