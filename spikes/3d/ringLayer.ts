/** Draws the ring: in pass 1 the rocks near the camera, instanced, from the streamed field (rockField.ts); in the
 *  resolve pass the far haze that makes it a banded disc from afar (sceneShaders.ts). Everything is made once. */
import { VS_FULLSCREEN } from '../../src/gfx/shaders';
import { rockMesh } from './meshes';
import { KINDS, type Ring } from './ring';
import { BUCKETS, CAPACITY, LODS, RockField } from './rockField';
import { type LayerKit, type Loc, RESOLVE_UNIFORMS, type SceneFrame, type SceneLayer } from './sceneLayer';
import { FS_RESOLVE_RING, FS_RING_ROCK, VS_RING_ROCK } from './sceneShaders';

/** Icosahedron splits of each level of detail, finest first: 320, 80 and 20 triangles. */
const SPLITS = [2, 1, 0];
const DENSITY_TEXELS = 1024;
const UNIT = 9; // a texture unit nothing else uses

export class RingLayer implements SceneLayer {
  readonly planetTiles = true;
  readonly pending = 0; readonly settled = true;
  readonly resolve: { program: WebGLProgram; u: Loc };
  private readonly program: WebGLProgram; private readonly u: Loc;
  private readonly field: RockField;
  private readonly instances: WebGLBuffer;
  private readonly vaos: WebGLVertexArrayObject[] = []; private readonly verts: number[] = [];
  private readonly density: WebGLTexture;

  constructor(private readonly kit: LayerKit, private readonly ring: Ring) {
    const gl = kit.gl;
    this.program = kit.prog(VS_RING_ROCK, FS_RING_ROCK);
    this.u = kit.locs(this.program, ['uVP', 'uFC', 'uCellK', 'uR', 'uRelief', 'uCentre']);
    const resolve = kit.prog(VS_FULLSCREEN, FS_RESOLVE_RING);
    this.resolve = { program: resolve, u: kit.locs(resolve, [...RESOLVE_UNIFORMS, 'uDens', 'uRingN', 'uRingIn', 'uRingOut', 'uCellK']) };

    // a rock's mesh is scaled so that its farthest vertex lies on its collision ball
    const scales = new Float32Array(KINDS);
    for (let k = 0; k < KINDS; k++) {
      const pos = rockMesh(k + 1).pos;
      let far = 0;
      for (let i = 0; i < pos.length; i += 3) far = Math.max(far, Math.hypot(pos[i], pos[i + 1], pos[i + 2]));
      scales[k] = 1 / far;
    }
    this.field = new RockField(ring, scales);
    this.instances = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    gl.bufferData(gl.ARRAY_BUFFER, this.field.data.byteLength, gl.DYNAMIC_DRAW);
    for (let bucket = 0; bucket < BUCKETS; bucket++) {
      const mesh = rockMesh(Math.floor(bucket / LODS) + 1, SPLITS[bucket % LODS]);
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      for (const [loc, data] of [[0, mesh.pos], [1, mesh.nrm], [2, mesh.col]] as const) {
        const b = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
      for (const [loc, off] of [[3, 0], [4, 16]] as const) {
        gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 32, bucket * CAPACITY * 32 + off);
        gl.vertexAttribDivisor(loc, 1);
      }
      this.vaos.push(vao); this.verts.push(mesh.pos.length / 3);
    }
    gl.bindVertexArray(null);

    const texels = new Uint8Array(DENSITY_TEXELS);
    for (let i = 0; i < DENSITY_TEXELS; i++) {
      texels[i] = Math.round(255 * ring.density(ring.inner + (ring.outer - ring.inner) * (i + 0.5) / DENSITY_TEXELS));
    }
    this.density = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + UNIT); gl.bindTexture(gl.TEXTURE_2D, this.density);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, DENSITY_TEXELS, 1, 0, gl.RED, gl.UNSIGNED_BYTE, texels);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
  }

  draw(f: SceneFrame): number {
    const gl = this.kit.gl, u = this.u, field = this.field;
    field.update(f.camPos, f.invQ, f.tanY, f.aspect, f.cellK, true);
    if (field.total === 0) return 0;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(u.uVP, false, f.vp);
    gl.uniform1f(u.uFC, f.fc); gl.uniform1f(u.uCellK, f.cellK); gl.uniform1f(u.uR, f.planet.radius);
    gl.uniform1f(u.uRelief, f.planet.relief);
    gl.uniform3f(u.uCentre, f.planetRel.x, f.planetRel.y, f.planetRel.z);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    let tris = 0;
    for (let b = 0; b < BUCKETS; b++) {
      const n = field.count[b];
      if (n === 0) continue;
      gl.bufferSubData(gl.ARRAY_BUFFER, b * CAPACITY * 32, field.data, b * CAPACITY * 8, n * 8);
      gl.bindVertexArray(this.vaos[b]);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, this.verts[b], n);
      tris += this.verts[b] / 3 * n;
    }
    return tris;
  }

  resolveUniforms(f: SceneFrame): void {
    const gl = this.kit.gl, u = this.resolve.u, ring = this.ring;
    gl.activeTexture(gl.TEXTURE0 + UNIT); gl.bindTexture(gl.TEXTURE_2D, this.density);
    gl.uniform1i(u.uDens, UNIT);
    gl.uniform3f(u.uRingN, ring.n.x, ring.n.y, ring.n.z);
    gl.uniform1f(u.uRingIn, ring.inner); gl.uniform1f(u.uRingOut, ring.outer); gl.uniform1f(u.uCellK, f.cellK);
  }
}
