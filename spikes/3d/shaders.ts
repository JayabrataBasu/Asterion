/** GLSL for the 3D passes: world geometry, the per-cell resolve (character choice and sky), the ship, and the glyph
 *  read-back. Everything is drawn relative to the camera; every geometry shader writes logarithmic depth,
 *  log2(1 + w) * uFC with w the view depth, so that near ships and far planets sort in one buffer. */
import { FS_ASCII, NOISE } from '../../src/gfx/shaders';

/** Sun direction, as FS_SCENE's L. */
export const SUN = [0.568, 0.5165, 0.640] as const;

const LOGDEPTH = `
uniform float uFC;
float logDepth(float w){ return log2(1.0 + max(w, 0.0)) * uFC; }`;

/** Planet tiles. Positions are relative to the tile's centre; uOff moves them to the camera. */
export const VS_TILE = `#version 300 es
layout(location = 0) in vec3 aPos; layout(location = 1) in vec3 aNrm; layout(location = 2) in float aMat;
uniform mat4 uVP; uniform vec3 uOff; uniform vec3 uPlanet; uniform float uR;
out vec3 vN; out vec3 vRad; out vec3 vRel; out vec3 vCol; out float vW; out float vH; flat out int vMat;
void main(){
  vec3 p = aPos + uOff;
  vec3 q = p - uPlanet;
  float r = length(q);
  vRad = q / r; vH = r - uR; vN = aNrm; vRel = p; vMat = int(aMat + 0.5); vCol = vec3(0.0);
  gl_Position = uVP * vec4(p, 1.0);
  vW = gl_Position.w;
}`;

/** Rocks, instanced: aI0 = centre relative to the camera + scale, aI1 = rotation quaternion. */
export const VS_ROCK = `#version 300 es
layout(location = 0) in vec3 aPos; layout(location = 1) in vec3 aNrm; layout(location = 2) in vec3 aCol;
layout(location = 3) in vec4 aI0; layout(location = 4) in vec4 aI1;
uniform mat4 uVP;
out vec3 vN; out vec3 vRad; out vec3 vRel; out vec3 vCol; out float vW; out float vH; flat out int vMat;
vec3 rot(vec4 q, vec3 v){ vec3 t = 2.0 * cross(q.xyz, v); return v + q.w * t + cross(q.xyz, t); }
void main(){
  vec3 local = rot(aI1, aPos);
  vec3 p = aI0.xyz + local * aI0.w;
  vN = rot(aI1, aNrm); vRad = normalize(local); vRel = p; vCol = aCol; vH = 0.0; vMat = 4;
  gl_Position = uVP * vec4(p, 1.0);
  vW = gl_Position.w;
}`;

/** World surfaces at 2x4 samples per cell. Out 0: lit colour + material/255. Out 1: normal * 0.5 + 0.5.
 *  uSpacing is the size of the smallest shape the normals carry (tile grid step, or a rock's facet); once a cell
 *  is larger, the normal fades to the radial one, so sub-cell detail cannot sparkle. */
export const FS_WORLD = `#version 300 es
precision highp float; precision highp int;
in vec3 vN; in vec3 vRad; in vec3 vRel; in vec3 vCol; in float vW; in float vH; flat in int vMat;
uniform float uSpacing, uCellK, uRelief, uR;
layout(location = 0) out vec4 oC;
layout(location = 1) out vec4 oN;
${NOISE}
${LOGDEPTH}
const vec3 L = vec3(${SUN.join(', ')});
const float RELIEF_GAIN = 6.0;   // hillshade exaggeration: the terrain's median slope is under 3 degrees
void main(){
  float cell = max(vW * uCellK, 1e-3);
  float k = smoothstep(0.35, 0.7, uSpacing / cell);   // tile LOD keeps the grid step above ~0.7 cell
  vec3 nd = normalize(vN);
  vec3 n = normalize(vRad + (nd - vRad * dot(nd, vRad)) * RELIEF_GAIN * k);
  vec3 alb;
  float spec = 0.0;
  vec3 view = normalize(-vRel);
  if (vMat == 4) alb = vCol;
  else {
    vec3 wp = vRad * uR;                                       // planet-relative point, for colour variation
    float t = vH / uRelief;
    float nz = vn3(wp * 0.004) * 0.6 + vn3(wp * 0.017) * 0.4;  // large and medium patches
    if (vMat == 1) {
      alb = vec3(0.07, 0.26, 0.62);
      vec3 h = normalize(L + view);
      spec = pow(max(dot(n, h), 0.0), 40.0) * 0.9;
    } else if (vMat == 3) {
      alb = vec3(0.80, 0.86, 0.96);
    } else {
      float slope = 1.0 - dot(nd, vRad);
      vec3 sand = vec3(0.86, 0.78, 0.52), grass = vec3(0.42, 0.74, 0.26), dry = vec3(0.74, 0.64, 0.38);
      vec3 rock = vec3(0.62, 0.58, 0.55), snow = vec3(0.90, 0.92, 0.96);
      alb = mix(grass, dry, smoothstep(0.25, 0.55, t + (nz - 0.5) * 0.35));
      alb = mix(sand, alb, smoothstep(0.012, 0.035, t));
      alb = mix(alb, rock, smoothstep(0.03, 0.09, slope * k) * 0.8);
      alb = mix(alb, rock, smoothstep(0.55, 0.7, t));
      alb = mix(alb, snow, smoothstep(0.72, 0.8, t + (nz - 0.5) * 0.1));
      alb *= 0.7 + 0.55 * smoothstep(0.25, 0.75, vn3(wp * 0.011 + 7.0));   // fields and woods
    }
  }
  float diff = max(dot(n, L), 0.0);
  float day = vMat == 4 ? 1.0 : smoothstep(-0.12, 0.12, dot(vRad, L));   // relief cannot light the night side
  vec3 c = alb * (0.02 + 1.05 * diff * day) + vec3(spec * day);
  oC = vec4(c, float(vMat) / 255.0);
  oN = vec4(n * 0.5 + 0.5, 1.0);
  gl_FragDepth = logDepth(vW);
}`;

/** Glyph table order for the resolve; see GLYPHS3 in render.ts. */
const G = `
#define G_DASH uG[0]
#define G_SL uG[1]
#define G_BAR uG[2]
#define G_BS uG[3]
#define G_TILDE uG[4]
#define G_EQ uG[5]
#define G_COLON uG[6]
#define G_PCT uG[7]
#define G_HASH uG[8]
#define G_DOT uG[9]
#define G_TICK uG[10]
#define G_STAR uG[11]
#define G_COMMA uG[12]
#define G_SEMI uG[13]`;

/** One fragment per cell: reads the cell's 2x4 world samples (and a ring of one around them) and writes rgb +
 *  glyph/255 as FS_ASCII expects. Glyph 0 leaves the choice to FS_ASCII's luminance ramp (sky, night side). */
export const FS_RESOLVE = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uCol; uniform sampler2D uDep;
uniform ivec2 uCells;
uniform mat3 uCamRot;    // view to world: columns right, up, back
uniform vec2 uTan;       // tangent of the half field of view: x, y
uniform vec3 uEye;       // camera relative to the planet's centre
uniform float uR, uAtmo, uTime, uSunK;
uniform int uDebug;      // 1: terrain red, no fog (prototype check)
uniform float uG[16];
out vec4 o;
${NOISE}
${LOGDEPTH}
${G}
const vec3 L = vec3(${SUN.join(', ')});
const vec3 SKY = vec3(0.30, 0.55, 1.0);
const float STAR_N = 30.0;     // star direction cells per unit of cube face
const float EDGE_JUMP = 0.04;    // depth step, as a share of distance, that makes an edge

float viewDepth(float d){ return exp2(d / uFC) - 1.0; }

/** Optical depth along o + d t, 0 < t < tmax (opt), and the part of it in sunlight (returned). One unit of
 *  optical depth is OPT_LEN of sea-level air. */
const float OPT_LEN = 2.5;   // in atmosphere heights
float scatter(vec3 o, vec3 d, float tmax, out float opt){
  opt = 0.0;
  float Ra = uR + uAtmo;
  float b = dot(o, d), c = dot(o, o) - Ra * Ra, disc = b * b - c;
  if (disc <= 0.0) return 0.0;
  float s = sqrt(disc);
  float t0 = max(0.0, -b - s), t1 = min(tmax, -b + s);
  if (t1 <= t0) return 0.0;
  float dt = (t1 - t0) / 10.0, lit = 0.0;
  for (int i = 0; i < 10; i++) {
    vec3 p = o + d * (t0 + (float(i) + 0.5) * dt);
    float r = length(p);
    float h = clamp((r - uR) / uAtmo, 0.0, 1.0);
    float dd = exp(-h * 3.0) * (1.0 - h) * dt / (uAtmo * OPT_LEN);
    lit += dd * smoothstep(-0.18, 0.3, dot(p / r, L));
    opt += dd;
  }
  return lit;
}

/** Character for an edge whose screen tangent is t (y up): - / | \\ */
float edgeGlyph(vec2 t){
  float a = mod(atan(t.y, t.x) + 3.14159265, 3.14159265);
  return (a < 0.3927 || a > 2.7489) ? G_DASH : a < 1.1781 ? G_SL : a < 1.9635 ? G_BAR : G_BS;
}

/** Darkest to brightest by luminance, band edges 0.18 and 0.45. */
float band(float lum, float a, float b, float c){ return lum < 0.18 ? a : lum < 0.45 ? b : c; }

/** The star whose direction cell is gc on the cube face, if it lands in this character cell. */
vec3 star(vec2 gc, vec3 face, int axis, ivec2 cell){
  vec3 seed = vec3(gc, dot(face, vec3(1.0, 2.0, 3.0)) * 101.0);
  if (hash13(seed) > 0.1) return vec3(0.0);
  vec2 sp = (gc + vec2(hash13(seed + 1.7), hash13(seed + 3.1))) / STAR_N;
  float sg = dot(face, vec3(1.0));
  vec3 sd = axis == 0 ? vec3(sg, sp) : axis == 1 ? vec3(sp.x, sg, sp.y) : vec3(sp, sg);
  vec3 v = transpose(uCamRot) * normalize(sd);
  if (v.z >= 0.0) return vec3(0.0);
  ivec2 sc = ivec2(floor((v.xy / -v.z / uTan * 0.5 + 0.5) * vec2(uCells)));
  if (sc != cell) return vec3(0.0);
  float b = hash13(seed + 5.3), k = hash13(seed + 7.9);
  vec3 tint = k < 0.5 ? vec3(0.65, 0.78, 1.0) : k < 0.85 ? vec3(1.0, 0.92, 0.72) : vec3(1.0, 0.6, 0.4);
  return tint * (0.05 + 0.45 * b * b * b);
}

vec3 sky(vec3 d, ivec2 cell, out vec3 stars){
  // stars: one candidate per direction cell of the cube, each shown in exactly the character cell it falls in
  vec3 ad = abs(d);
  int axis = ad.x >= ad.y && ad.x >= ad.z ? 0 : ad.y >= ad.z ? 1 : 2;
  vec3 face = axis == 0 ? vec3(sign(d.x), 0.0, 0.0) : axis == 1 ? vec3(0.0, sign(d.y), 0.0) : vec3(0.0, 0.0, sign(d.z));
  vec2 uv = axis == 0 ? d.yz / ad.x : axis == 1 ? d.xz / ad.y : d.xy / ad.z;
  vec2 gc = floor(uv * STAR_N);
  stars = vec3(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) stars += star(gc + vec2(i, j), face, axis, cell);
  vec3 col = vec3(0.0);
  // nebula: faint, large, two colours
  float neb = smoothstep(0.5, 0.8, fbm3(d * 2.2 + 3.0));
  col += mix(vec3(0.35, 0.12, 0.45), vec3(0.10, 0.25, 0.45), fbm3(d * 1.3 + 11.0)) * neb * 0.07;
  // sun
  float sa = acos(clamp(dot(d, L), -1.0, 1.0));
  col += vec3(1.0, 0.9, 0.7) * (exp(-sa * sa / 0.0004) * 8.0 + exp(-sa / 0.05) * 0.4) * uSunK;
  return col;
}

void main(){
  ivec2 cell = ivec2(gl_FragCoord.xy);
  ivec2 base = cell * ivec2(2, 4);
  ivec2 lim = uCells * ivec2(2, 4) - 1;
  vec2 ndc = (vec2(cell) + 0.5) / vec2(uCells) * 2.0 - 1.0;
  vec3 vd = vec3(ndc * uTan, -1.0);
  float vlen = length(vd);
  vec3 dir = uCamRot * (vd / vlen);

  // window of samples: x -1..2, y -1..4 around the cell's own 2x4; view depth, or -1 for sky
  float W[24];
  for (int y = 0; y < 6; y++) for (int x = 0; x < 4; x++) {
    float d = texelFetch(uDep, clamp(base + ivec2(x - 1, y - 1), ivec2(0), lim), 0).r;
    W[y * 4 + x] = d >= 1.0 ? -1.0 : viewDepth(d);
  }
  vec3 csum = vec3(0.0); int n = 0;
  int mcount[5] = int[5](0, 0, 0, 0, 0);
  vec2 cov = vec2(0.0), sk = vec2(0.0); float wsum = 0.0;
  for (int y = 0; y < 4; y++) for (int x = 0; x < 2; x++) {
    float w = W[(y + 1) * 4 + x + 1];
    vec2 sp = vec2(float(x) - 0.5, float(y) - 1.5);
    if (w < 0.0) { sk += sp; continue; }
    vec4 c = texelFetch(uCol, base + ivec2(x, y), 0);
    csum += c.rgb; n++; cov += sp; wsum += w;
    int m = clamp(int(c.a * 255.0 + 0.5), 0, 4);
    mcount[m]++;
  }

  if (n == 0) {                                                // sky
    float opt, lit = scatter(uEye, dir, 1e9, opt);
    float a = smoothstep(0.12, 0.65, lit);
    vec3 air = SKY * a * 0.42;                                 // dark toward the zenith, haze at the horizon
    vec3 stars, rgb = sky(dir, cell, stars);
    float hide = exp(-lit * 25.0 - opt * 2.0);                 // a sunlit sky hides the stars
    stars *= hide;
    rgb = rgb * hide + air;
    float sl = dot(stars, vec3(0.2126, 0.7152, 0.0722));
    float glyph = 0.0;
    if (sl > 0.03) { glyph = sl > 0.2 ? G_STAR : sl > 0.09 ? G_TICK : G_DOT; rgb += stars * 1.5; }
    if (a > 0.8) glyph = band(dot(rgb, vec3(0.2126, 0.7152, 0.0722)), G_COMMA, G_COLON, G_SEMI);   // dense haze
    o = vec4(rgb, glyph);
    return;
  }

  vec3 rgb = csum / float(n);
  float w = wsum / float(n);
  float opt, lit = scatter(uEye, dir, w * vlen, opt);
  float fog = 1.0 - exp(-opt * 2.0);
  if (uDebug == 1) { o = vec4(1.0, 0.1, 0.1, G_HASH); return; }
  rgb = mix(rgb, SKY * 0.42 * (lit / max(opt, 1e-6)), fog);
  float lum = dot(rgb, vec3(0.2126, 0.7152, 0.0722));

  int mat = 1;
  for (int i = 2; i <= 4; i++) if (mcount[i] > mcount[mat]) mat = i;
  float glyph;
  if (fog > 0.6) glyph = band(lum, G_COMMA, G_COLON, G_SEMI);
  else if (mat == 1) glyph = band(lum, G_DASH, G_TILDE, G_EQ);
  else if (mat == 3) glyph = band(lum, G_DOT, G_TICK, G_STAR);
  else glyph = band(lum, G_COLON, G_PCT, G_HASH);
  if (lum < 0.02) glyph = 0.0;                                  // night: the plain ramp, which is blank this dark

  // edges: part sky, or a step in depth whose near side is in this cell
  vec2 edge = vec2(0.0);
  if (n < 8) edge = sk / float(8 - n) - cov / float(n);         // from the covered part toward the sky
  else {
    float jump = 0.0;
    for (int y = 1; y <= 4; y++) for (int x = 1; x <= 2; x++) {
      float c = W[y * 4 + x];
      float l = W[y * 4 + x - 1], r = W[y * 4 + x + 1], d = W[(y - 1) * 4 + x], u = W[(y + 1) * 4 + x];
      if (l > 0.0 && r > 0.0) jump = max(jump, (l + r - 2.0 * c) / c);
      if (d > 0.0 && u > 0.0) jump = max(jump, (d + u - 2.0 * c) / c);
      if (l < 0.0 || r < 0.0 || d < 0.0 || u < 0.0) jump = max(jump, 1.0);   // sky right beside a full cell
    }
    if (jump > EDGE_JUMP) {
      // from the near samples toward the far ones, over the whole window
      float lo = 1e30, hi = 0.0;
      for (int i = 0; i < 24; i++) { float v = W[i] < 0.0 ? 1e30 : W[i]; lo = min(lo, v); hi = max(hi, v); }
      float mid = hi >= 1e29 ? lo * 2.0 : (lo + hi) * 0.5;
      vec2 fa = vec2(0.0), ne = vec2(0.0); float nf = 0.0, nn = 0.0;
      for (int y = 0; y < 6; y++) for (int x = 0; x < 4; x++) {
        float v = W[y * 4 + x] < 0.0 ? 1e30 : W[y * 4 + x];
        vec2 sp = vec2(float(x) - 1.5, float(y) - 2.5);
        if (v > mid) { fa += sp; nf += 1.0; } else { ne += sp; nn += 1.0; }
      }
      if (nf > 0.0 && nn > 0.0) edge = fa / nf - ne / nn;
    }
  }
  if (dot(edge, edge) > 1e-4 && lum >= 0.02) {
    glyph = edgeGlyph(vec2(-edge.y, edge.x));
    rgb *= 1.15;
  }
  o = vec4(rgb, glyph);
}`;

/** The ship at 4x8 samples per cell. Fragments behind the world (pass 1 depth, 2x4 per cell) are dropped. */
export const VS_SHIP = `#version 300 es
layout(location = 0) in vec3 aPos; layout(location = 1) in vec3 aNrm; layout(location = 2) in vec3 aCol;
uniform mat4 uVP; uniform mat3 uRot; uniform vec3 uOff;
out vec3 vN; out vec3 vCol; out vec3 vRel; out float vW;
void main(){
  vec3 p = uRot * aPos + uOff;
  vN = uRot * aNrm; vCol = aCol; vRel = p;
  gl_Position = uVP * vec4(p, 1.0);
  vW = gl_Position.w;
}`;

export const FS_SHIP = `#version 300 es
precision highp float; precision highp int;
in vec3 vN; in vec3 vCol; in vec3 vRel; in float vW;
uniform sampler2D uDep;
uniform vec3 uSky;      // light from the sky / planet below, for the shadow side
out vec4 o;
${LOGDEPTH}
const vec3 L = vec3(${SUN.join(', ')});
void main(){
  float z = logDepth(vW);
  float world = texelFetch(uDep, ivec2(gl_FragCoord.xy) / 2, 0).r;
  if (world < z) discard;
  vec3 n = normalize(vN);
  vec3 col;
  if (max(vCol.r, max(vCol.g, vCol.b)) > 1.0) col = vCol;        // glowing part
  else {
    float diff = max(dot(n, L), 0.0);
    float rim = pow(1.0 - abs(dot(n, normalize(-vRel))), 2.0);
    col = vCol * (0.16 + 0.9 * diff) + uSky * (0.5 + 0.5 * n.y) * 0.1 + vec3(0.1) * rim;
  }
  o = vec4(col, 1.0);
  gl_FragDepth = z;
}`;

/** Read-back: the character index FS_ASCII shows in each cell, in the red channel (index / 255). */
export const FS_GLYPHS = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uScene; uniform sampler2D uMA; uniform sampler2D uRamp;
uniform float uExposure;
out vec4 o;
void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uScene, c, 0), ma = texelFetch(uMA, c, 0);
  int g;
  if (ma.a > 0.0) g = int(ma.a * 255.0 + 0.5);
  else if (s.a > 0.0) g = int(s.a * 255.0 + 0.5);
  else {
    float l = 1.0 - exp(-dot(s.rgb, vec3(0.2126, 0.7152, 0.0722)) * uExposure);
    g = int(texelFetch(uRamp, ivec2(int(clamp(l, 0.0, 1.0) * 255.0), 0), 0).r * 255.0 + 0.5);
  }
  o = vec4(float(g) / 255.0, 0.0, 0.0, 1.0);
}`;

/** The ship's dark halo per cell, as FS_ASCII computes it per pixel: in red, 0..1. */
export const FS_HALO = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uMA; uniform ivec2 uCells;
out vec4 o;
void main(){
  ivec2 cell = ivec2(gl_FragCoord.xy);
    float h = 0.0;                                     // round falloff to the nearest sprite cell (cells are ~2x taller than wide, so dy counts double)
    for (int dy = -2; dy <= 2; dy++) for (int dx = -3; dx <= 3; dx++) {
      if (texelFetch(uMA, clamp(cell + ivec2(dx, dy), ivec2(0), uCells - 1), 0).a > 0.0) h = max(h, 1.0 - length(vec2(float(dx), float(dy) * 2.0)) / 4.5);
    }
  o = vec4(h, 0.0, 0.0, 1.0);
}`;

/** FS_ASCII with two changes.
 *  1. A cell with an explicit character keeps a dim backdrop of its own colour instead of borrowing one from plain
 *     cells two away: in 3D whole regions are explicit (terrain, haze), and the borrowed backdrop turned every band
 *     edge into a bright or dark block.
 *  2. The ship's halo comes from FS_HALO (one value per cell) instead of 35 fetches per pixel: about 3.5 ms of
 *     graphics time at 1920x1080 on Iris Xe. */
export const FS_ASCII3 = (() => {
  const swap = (text: string, from: string, to: string): string => {
    if (!text.includes(from)) throw new Error('FS_ASCII changed: update FS_ASCII3');
    return text.replace(from, to);
  };
  let t = swap(FS_ASCII, `    if (s.a > 0.0) {                                  // glyph cell: borrow the backdrop from a plain neighbour (no black box, no filled slab)
      vec3 acc = vec3(0.0); float na = 0.0;
      for (int i = 0; i < 4; i++) {
        ivec2 o4 = i == 0 ? ivec2(-2, 0) : i == 1 ? ivec2(2, 0) : i == 2 ? ivec2(0, 2) : ivec2(0, -2);
        vec4 nb = texelFetch(uScene, clamp(cell + o4, ivec2(0), uCells - 1), 0);
        if (nb.a <= 0.0) { acc += nb.rgb; na += 1.0; }
      }
      bg = (na > 0.0 ? acc / na : min(s.rgb * 0.25, vec3(0.05))) * uBgK;
    }`,
    '    if (s.a > 0.0) bg = s.rgb * uBgK * BG_EXPLICIT;   // explicit character: a dim backdrop of its own colour');
  t = swap(t, `    float h = 0.0;                                     // round falloff to the nearest sprite cell (cells are ~2x taller than wide, so dy counts double)
    for (int dy = -2; dy <= 2; dy++) for (int dx = -3; dx <= 3; dx++) {
      if (texelFetch(uMA, clamp(cell + ivec2(dx, dy), ivec2(0), uCells - 1), 0).a > 0.0) h = max(h, 1.0 - length(vec2(float(dx), float(dy) * 2.0)) / 4.5);
    }`, '    float h = texelFetch(uHalo, cell, 0).r;           // see FS_HALO');
  return swap(t, 'out vec4 o;', 'out vec4 o;\nuniform sampler2D uHalo;\nconst float BG_EXPLICIT = 0.65;');
})();
