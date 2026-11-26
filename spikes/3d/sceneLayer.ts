/** What a world scene adds to the renderer: its own geometry in pass 1 and, where needed, its own resolve program.
 *  Made once; nothing is created while drawing. */
import { VS_FULLSCREEN } from '../../src/gfx/shaders';
import { FLOOR_K, cloudAltitude } from './gas';
import { type Quat, type Vec3, copy, qRotate, sub, v3 } from './math';
import type { Planet } from './planet';
import { FS_GAS, FS_RESOLVE_GAS } from './sceneShaders';
import type { World } from './world';
import { MoonLayer } from './moonLayer';
import type { evictKeys, requestOrder } from './render';

export type Loc = Record<string, WebGLUniformLocation | null>;

/** The renderer's helpers a layer builds its programs with. */
export interface LayerKit {
  gl: WebGL2RenderingContext;
  /** Meshes are built here and now, not in workers. */
  sync: boolean;
  /** The planet tile cache's rules (render.ts). */
  requestOrder: typeof requestOrder;
  evictKeys: typeof evictKeys;
  prog(vs: string, fs: string): WebGLProgram;
  locs(p: WebGLProgram, names: string[]): Loc;
}

/** One picture, as the renderer sees it. */
export interface SceneFrame {
  vp: Float32Array; camPos: Vec3; camQ: Quat; invQ: Quat;
  /** The planet's centre relative to the camera. */
  planetRel: Vec3;
  planet: Planet; time: number; cols: number; rows: number; tanY: number; aspect: number; fc: number; cellK: number;
}

export interface SceneLayer {
  /** Whether the planet's terrain tiles are streamed and drawn. */
  readonly planetTiles: boolean;
  /** The resolve program that replaces the default one, with the default uniforms among its locations. */
  readonly resolve: { program: WebGLProgram; u: Loc } | null;
  /** Draws the scene's geometry into pass 1 (depth test and back-face culling are on); returns the triangles. */
  draw(f: SceneFrame): number;
  /** Sets the replacing resolve program's own uniforms; it is in use. */
  resolveUniforms(f: SceneFrame): void;
  /** Meshes still being built, and whether the picture shows all it should. */
  readonly pending: number; readonly settled: boolean;
}

export const RESOLVE_UNIFORMS = ['uCol', 'uDep', 'uCells', 'uCamRot', 'uTan', 'uEye', 'uR', 'uAtmo', 'uTime', 'uSunK', 'uG', 'uFC', 'uDebug', 'uPrev', 'uDither', 'uHold'];

const X = v3(1, 0, 0), Y = v3(0, 1, 0), Z = v3(0, 0, 1);

/** The camera's right, up and back axes as the columns of a matrix. */
class CameraBasis {
  readonly m = new Float32Array(9);
  private readonly a = v3();
  set(q: Quat): Float32Array {
    this.column(0, qRotate(this.a, q, X)); this.column(3, qRotate(this.a, q, Y)); this.column(6, qRotate(this.a, q, Z));
    return this.m;
  }
  private column(at: number, a: Vec3): void { this.m[at] = a.x; this.m[at + 1] = a.y; this.m[at + 2] = a.z; }
}

class GasLayer implements SceneLayer {
  readonly planetTiles = false;
  readonly pending = 0; readonly settled = true;
  readonly resolve: { program: WebGLProgram; u: Loc };
  private readonly program: WebGLProgram; private readonly u: Loc;
  private readonly vao: WebGLVertexArrayObject;
  private readonly basis = new CameraBasis();
  private readonly up = v3(); private readonly zero = v3();

  constructor(private readonly kit: LayerKit) {
    this.program = kit.prog(VS_FULLSCREEN, FS_GAS);
    this.u = kit.locs(this.program, ['uRes', 'uCamRot', 'uTan', 'uUp', 'uH', 'uR', 'uTime', 'uCellK', 'uFC']);
    const resolve = kit.prog(VS_FULLSCREEN, FS_RESOLVE_GAS);
    this.resolve = { program: resolve, u: kit.locs(resolve, [...RESOLVE_UNIFORMS, 'uDeep']) };
    this.vao = kit.gl.createVertexArray()!;
  }

  draw(f: SceneFrame): number {
    const gl = this.kit.gl, u = this.u, p = f.planet;
    // the camera relative to the centre, in double precision
    copy(this.up, sub(this.up, this.zero, f.planetRel));
    const r = Math.sqrt(this.up.x * this.up.x + this.up.y * this.up.y + this.up.z * this.up.z) || 1;
    gl.useProgram(this.program); gl.bindVertexArray(this.vao);
    gl.uniform2f(u.uRes, f.cols * 2, f.rows * 4);
    gl.uniformMatrix3fv(u.uCamRot, false, this.basis.set(f.camQ));
    gl.uniform2f(u.uTan, f.tanY * f.aspect, f.tanY);
    gl.uniform3f(u.uUp, this.up.x / r, this.up.y / r, this.up.z / r);
    gl.uniform1f(u.uH, r - p.radius); gl.uniform1f(u.uR, p.radius); gl.uniform1f(u.uTime, f.time);
    gl.uniform1f(u.uCellK, f.cellK); gl.uniform1f(u.uFC, f.fc);
    gl.disable(gl.CULL_FACE);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.CULL_FACE);
    return 1;
  }

  resolveUniforms(f: SceneFrame): void {
    const deep = -cloudAltitude(f.planet, f.camPos) / (FLOOR_K * f.planet.radius);
    this.kit.gl.uniform1f(this.resolve.u.uDeep, Math.min(1, Math.max(0, deep)));
  }
}

export function makeSceneLayer(world: World, kit: LayerKit): SceneLayer | null {
  if (world.moon) return new MoonLayer(kit, world.moon);
  return world.scene === 'gas' ? new GasLayer(kit) : null;
}
