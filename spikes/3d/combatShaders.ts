/** GLSL for the combat load test: the other ships (instanced), and the characters of markers, bolts and particles,
 *  hidden by world or ships cell by cell. */

/** A character is hidden once this many of its cell's 8 world samples lie nearer than it. */
export const WORLD_HIDE = 4;
/** ... or this many of its cell's 32 ship samples: the share (a tenth) at which the matcher gives the cell to the
 *  ship, so that no character is drawn over a nearer ship's. */
export const SHIP_HIDE = 4;

/** As VS_SHIP, one instance per ship: aOff its place relative to the camera, then its right, up and back axes. */
export const VS_SWARM_SHIP = `#version 300 es
layout(location = 0) in vec3 aPos; layout(location = 1) in vec3 aNrm; layout(location = 2) in vec3 aCol;
layout(location = 3) in vec3 aOff; layout(location = 4) in vec3 aRight; layout(location = 5) in vec3 aUp; layout(location = 6) in vec3 aBack;
uniform mat4 uVP; uniform vec3 uTint;
out vec3 vN; out vec3 vCol; out vec3 vRel; out float vW; flat out int vId;
void main(){
  mat3 rot = mat3(aRight, aUp, aBack);
  vec3 p = rot * aPos + aOff;
  vN = rot * aNrm; vRel = p; vId = gl_InstanceID;
  vCol = max(aCol.r, max(aCol.g, aCol.b)) > 1.0 ? aCol : aCol * uTint;
  gl_Position = uVP * vec4(p, 1.0);
  vW = gl_Position.w;
}`;

/** For counting only: which instance shows in each ship sample, as number + 1 in red (low byte) and green. */
export const FS_SWARM_ID = `#version 300 es
precision highp float; precision highp int;
in float vW; flat in int vId;
uniform highp sampler2D uDep;
uniform float uFC;
out vec4 o;
void main(){
  float z = log2(1.0 + max(vW, 0.0)) * uFC;
  if (texelFetch(uDep, ivec2(gl_FragCoord.xy) / 2, 0).r < z) discard;
  int id = vId + 1;
  o = vec4(float(id & 255), float(id >> 8), 0.0, 255.0) / 255.0;
  gl_FragDepth = z;
}`;

/** One instance per character cell: aCell = column, row from the bottom, view depth, character; aCol = colour, 1 for
 *  crisp. The vertex shader decides for the whole cell whether the world or a ship hides it.
 *  uMode 0: the character on screen (a quad over its cell). 1: its index into a one-pixel-per-cell target.
 *  2: one pixel per instance, white if it shows and grey if hidden, for counting. */
export const VS_SWARM_GLYPH = `#version 300 es
precision highp float; precision highp int;
layout(location = 0) in vec4 aCell; layout(location = 1) in vec4 aCol;
uniform highp sampler2D uDep; uniform highp sampler2D uShipDep;
uniform float uFC;
uniform int uMode, uOcclude;
uniform vec2 uViewport;
uniform ivec2 uOrigin, uCellPx;
flat out ivec2 fCell; flat out int fGlyph; flat out vec4 fCol; flat out float fSeen;
void main(){
  ivec2 cell = ivec2(aCell.xy);
  bool seen = true;
  if (uOcclude == 1) {
    float z = log2(1.0 + aCell.z) * uFC;
    int n = 0;
    for (int y = 0; y < 4; y++) for (int x = 0; x < 2; x++) if (texelFetch(uDep, cell * ivec2(2, 4) + ivec2(x, y), 0).r < z) n++;
    seen = n < ${WORLD_HIDE};
    if (seen) {
      n = 0;
      for (int y = 0; y < 8; y++) for (int x = 0; x < 4; x++) if (texelFetch(uShipDep, cell * ivec2(4, 8) + ivec2(x, y), 0).r < z) n++;
      seen = n < ${SHIP_HIDE};
    }
  }
  fCell = cell; fGlyph = int(aCell.w + 0.5); fCol = aCol; fSeen = seen ? 1.0 : 0.5;
  vec2 px;
  if (uMode == 2) {
    int w = int(uViewport.x);
    px = vec2(float(gl_InstanceID % w), float(gl_InstanceID / w)) + 0.5;
  } else {
    vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
    px = vec2(uOrigin) + (aCell.xy + corner) * vec2(uCellPx);
  }
  gl_PointSize = 1.0;
  gl_Position = !seen && uMode != 2 ? vec4(2.0, 2.0, 2.0, 1.0) : vec4(px / uViewport * 2.0 - 1.0, 0.0, 1.0);
}`;

/** The cell's character in its colour, over a dim backdrop of the world behind (as FS_ASCII3 gives explicit cells).
 *  Alpha 0 marks a crisp cell, which bloom and grain leave alone. */
export const FS_SWARM_GLYPH = `#version 300 es
precision highp float; precision highp int;
uniform highp sampler2D uAtlas; uniform highp sampler2D uScene;
uniform int uMode;
uniform ivec2 uOrigin, uCellPx;
uniform float uBgK;
flat in ivec2 fCell; flat in int fGlyph; flat in vec4 fCol; flat in float fSeen;
out vec4 o;
void main(){
  if (uMode == 1) { o = vec4(float(fGlyph) / 255.0, 0.0, 0.0, 1.0); return; }
  if (uMode == 2) { o = vec4(fSeen, 0.0, 0.0, 1.0); return; }
  ivec2 loc = ivec2(gl_FragCoord.xy) - uOrigin - fCell * uCellPx;
  ivec2 ap = ivec2((fGlyph & 15) * uCellPx.x + loc.x, (fGlyph >> 4) * uCellPx.y + (uCellPx.y - 1 - loc.y));
  float cov = texelFetch(uAtlas, ap, 0).a;
  vec3 bg = texelFetch(uScene, fCell, 0).rgb * uBgK * 0.65;
  o = vec4(mix(bg, fCol.rgb, cov), 1.0 - fCol.a);
}`;
