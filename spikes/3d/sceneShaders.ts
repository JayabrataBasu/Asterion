/** GLSL for the world scenes. The default planet's shaders are not touched: a scene's resolve pass is a copy of
 *  FS_RESOLVE with a few lines changed, as FS_ASCII3 is of FS_ASCII. */
import { NOISE } from '../../src/gfx/shaders';
import { FS_RESOLVE, FS_WORLD, SUN, VS_ROCK } from './shaders';

const LOGDEPTH = `
uniform float uFC;
float logDepth(float w){ return log2(1.0 + max(w, 0.0)) * uFC; }`;

/** `text` with the one occurrence of `from` replaced; throws if the source no longer has it. */
export function swap(text: string, from: string, to: string): string {
  if (text.split(from).length !== 2) throw new Error(`the shader changed: expected exactly one "${from}"`);
  return text.replace(from, () => to);
}

// ------------------------------------------------------------------ gas giant

/** Cloud decks: height above the cloud tops (share of the radius), opacity, wind (units a second at the equator of
 *  the shell), brightness. The last is the opaque murk under the floor. */
export const GAS_LAYERS = [
  [0.046, 0.55, 70, 1.10],
  [0.019, 0.80, 45, 1.04],
  [0.000, 0.96, 22, 0.98],
  [-0.017, 0.80, -26, 0.68],
  [-0.042, 0.75, 14, 0.46],
  [-0.072, 1.00, 6, 0.30],
] as const;

const f = (x: number): string => x.toFixed(4);

/** The gas giant, one ray per world sample: the cloud decks are spheres, composed front to back. Written like any
 *  surface: colour + material/255 (1 light zone, 2 dark belt), the radial normal and logarithmic depth where the
 *  clouds first hide half of what is behind. */
export const FS_GAS = `#version 300 es
precision highp float; precision highp int;
uniform vec2 uRes;        // of the world target
uniform mat3 uCamRot; uniform vec2 uTan;
uniform vec3 uUp;         // unit, from the giant's centre to the camera
uniform float uH, uR, uTime, uCellK;   // uH: camera height above the cloud tops
layout(location = 0) out vec4 oC;
layout(location = 1) out vec4 oN;
${NOISE}
${LOGDEPTH}
const vec3 L = vec3(${SUN.join(', ')});
#define LAYERS ${GAS_LAYERS.length}
const vec4 DECK[LAYERS] = vec4[LAYERS](${GAS_LAYERS.map(d => `vec4(${d.map(f).join(', ')})`).join(', ')});
const vec3 SPOT = normalize(vec3(-0.02, -0.02, 1.0));   // on the side the scene starts over

/** Noise of features about \`size\` units long (and \`flat_\` times narrower across the bands), replaced by its mean as
 *  they near the size of a character cell \`cell\`, so that nothing sparkles. */
float octave(vec3 m, float size, float flat_, float cell){
  float k = smoothstep(1.5, 4.0, size / cell);
  return k > 0.0 ? mix(0.5, vn3(m * vec3(1.0, flat_, 1.0) / size), k) : 0.5;
}

/** One deck where the ray meets it: colour and opacity. */
vec4 deck(int i, vec3 q, float t, out float zone, out float body){
  vec4 d = DECK[i];
  float cell = max(t * uCellK, 1e-3);
  float a = d.z * uTime / uR, c = cos(a), s = sin(a);
  vec3 m = vec3(c * q.x + s * q.z, q.y, c * q.z - s * q.x) * uR;   // planet-relative, drifted with the wind
  vec3 mq = m / uR;
  float warp = vn3(mq * 6.0 + float(i) * 3.1) - 0.5 + 0.5 * (vn3(mq * 17.0) - 0.5);
  float lat = q.y + 0.055 * warp;
  zone = smoothstep(-0.35, 0.35, sin(lat * 27.0 + 2.2 * sin(lat * 11.0)) + 0.35 * sin(lat * 71.0));
  vec3 o = m + float(i) * 917.0;
  float n1 = octave(o, 2400.0, 3.0, cell), n2 = octave(o, 760.0, 2.2, cell);
  float n3 = octave(o, 240.0, 1.3, cell), n4 = octave(o, 80.0, 1.0, cell);
  float n = 0.34 * n1 + 0.31 * n2 + 0.22 * n3 + 0.13 * n4;
  body = smoothstep(0.40, 0.61, n);                              // thick and thin parts of the cloud
  float alpha = d.y;
  if (i < LAYERS - 1) {
    float lo = i == 0 ? 0.52 : i == 1 ? 0.48 : i == 2 ? 0.36 : 0.43;
    alpha *= smoothstep(lo, lo + 0.14, n + 0.07 * (zone - 0.5)) * smoothstep(8.0, 90.0, t);
  }
  if (alpha <= 0.0) return vec4(0.0);
  vec3 col = mix(vec3(0.66, 0.37, 0.20), vec3(1.0, 0.90, 0.68), zone);
  // the great storm
  vec3 off = (q - SPOT) * vec3(1.0, 2.1, 1.0);
  float r = length(off) / 0.17;
  if (r < 1.3) {
    float swirl = 0.5 + 0.5 * sin(r * 14.0 + 5.0 * n2);
    col = mix(col, mix(vec3(0.75, 0.22, 0.10), vec3(1.0, 0.62, 0.40), swirl), 1.0 - smoothstep(0.85, 1.3, r));
  }
  // the side of a cloud toward the sun is lit: the same noise, a step toward the sun
  float step = 90.0;
  float toSun = n2 - octave(o + L * step, 760.0, 2.2, cell) + 0.6 * (n3 - octave(o + L * step * 0.5, 240.0, 1.3, cell));
  float sun = dot(q, L);
  float light = 0.015 + smoothstep(-0.12, 0.25, sun) * (0.30 + 0.62 * max(sun, 0.0) + clamp(toSun * 2.6, -0.32, 0.55));
  // from above, thick parts stand brighter; from below (a deck overhead) they are the dark ones
  float shade = uH < d.x * uR ? mix(0.80, 0.10, body) : mix(0.22, 1.30, body);
  col *= d.w * light * shade;
  return vec4(col, alpha);
}

void main(){
  vec2 ndc = gl_FragCoord.xy / uRes * 2.0 - 1.0;
  vec3 vd = vec3(ndc * uTan, -1.0);
  float vlen = length(vd);
  vec3 dir = uCamRot * (vd / vlen);
  float up = dot(uUp, dir), rc = uR + uH, b = rc * up;

  float T[LAYERS];
  for (int i = 0; i < LAYERS; i++) {
    float h = DECK[i].x * uR;
    float c = (uH - h) * (uR + uR + uH + h);       // |eye|^2 - radius^2, without cancellation
    float disc = b * b - c;
    T[i] = -1.0;
    if (disc <= 0.0) continue;
    float s = sqrt(disc);
    if (c > 0.0) { if (b < 0.0) T[i] = c / (s - b); }
    else T[i] = b < 0.0 ? s - b : -c / (s + b);
  }
  vec3 acc = vec3(0.0);
  float cover = 0.0, first = -1.0, half_ = -1.0, zoneSum = 0.0;
  vec3 qAt = uUp;
  for (int k = 0; k < LAYERS; k++) {
    int i = -1; float t = 1e30;
    for (int j = 0; j < LAYERS; j++) if (T[j] >= 0.0 && T[j] < t) { t = T[j]; i = j; }
    if (i < 0) break;
    T[i] = -1.0;
    vec3 q = normalize(uUp * rc + dir * t);
    float zone, body;
    vec4 c = deck(i, q, t, zone, body);
    if (c.a <= 0.0) continue;
    float w = (1.0 - cover) * c.a;
    // the character family: by band from far off; close by, by cloud thickness, so that shapes show in the text
    float near_ = 1.0 - smoothstep(1500.0, 6000.0, t);
    acc += w * c.rgb; zoneSum += w * mix(zone, body, near_); cover += w;
    if (first < 0.0 && c.a > 0.15) first = t;
    if (half_ < 0.0 && cover > 0.5) { half_ = t; qAt = q; }
    if (cover > 0.97) break;
  }
  if (cover < 0.4) discard;
  float t = half_ > 0.0 ? half_ : max(first, 0.0);
  float w = t / vlen;
  oC = vec4(acc / cover, (zoneSum / cover > 0.5 ? 1.0 : 2.0) / 255.0);
  oN = vec4(qAt * 0.5 + 0.5, 1.0);
  gl_FragDepth = logDepth(w);
}`;

/** FS_RESOLVE for the gas giant: a tan sky instead of a blue one, thinner haze so the decks stay readable, and a
 *  darker, redder sky the deeper the camera is (uDeep: 0 at the cloud tops, 1 at the floor). */
export const FS_RESOLVE_GAS = (() => {
  let t = FS_RESOLVE;
  t = swap(t, 'const vec3 SKY = vec3(0.30, 0.55, 1.0);', `const vec3 SKY = vec3(0.92, 0.66, 0.42);
uniform float uDeep;
const float HAZE_K = 0.45;`);
  t = swap(t, 'vec3 air = SKY * a * 0.42;', 'vec3 air = SKY * a * 0.36 * mix(vec3(1.0), vec3(0.62, 0.34, 0.26), uDeep);');
  t = swap(t, 'float fog = 1.0 - exp(-opt * 2.0);', 'float fog = 1.0 - exp(-opt * HAZE_K);');
  return swap(t, 'rgb = mix(rgb, SKY * 0.42 * (lit / max(opt, 1e-6)), fog);',
    'rgb = mix(rgb, SKY * 0.36 * (lit / max(opt, 1e-6)) * mix(vec3(1.0), vec3(0.62, 0.34, 0.26), uDeep), fog);');
})();

// ------------------------------------------------------------------ moon

/** The moon's ground: FS_WORLD with grey regolith. Albedo follows height (dark floors, pale rims) and patches that
 *  stay on the moon; the hillshade is far less exaggerated, as crater walls are steep already. */
export const FS_MOON = swap(swap(FS_WORLD,
  'const float RELIEF_GAIN = 6.0;', 'const float RELIEF_GAIN = 3.2;'),
  '  if (vMat == 4) alb = vCol;\n', `  if (vMat != 4) {
    vec3 wp = vRad * uR;                                       // moon-relative point
    float t = vH / uRelief;                                    // about -0.8 in the deepest floors, 0.35 on high rims
    float seas = smoothstep(0.38, 0.62, vn3(wp * 0.0027 + 3.0));
    float patches = vn3(wp * 0.011) * 0.6 + vn3(wp * 0.037) * 0.4;
    float grain = mix(0.5, vn3(wp * 0.13), 1.0 - smoothstep(1.5, 5.0, cell));   // fades before it would sparkle
    float steep = 1.0 - dot(nd, vRad);
    float v = mix(0.18, 0.29, seas) * (0.82 + 0.36 * patches) * (0.76 + 0.48 * grain);
    v *= mix(0.22, 1.90, smoothstep(-0.20, 0.15, t));
    v += 0.35 * smoothstep(0.015, 0.09, steep) * k;
    alb = vec3(v) * vec3(1.03, 1.0, 0.94);
  }
  else if (vMat == 4) alb = vCol;
`);

// ------------------------------------------------------------------ rings

/** Ring rocks: VS_ROCK, passing on the rock's size. */
export const VS_RING_ROCK = swap(swap(VS_ROCK,
  'uniform mat4 uVP;\n', 'uniform mat4 uVP;\nflat out float vSize;\n'),
  '  vec3 local = rot(aI1, aPos);\n', '  vSize = aI0.w;\n  vec3 local = rot(aI1, aPos);\n');

/** Ring rocks: FS_WORLD with facets shown while a rock is large enough on screen, paler stone, and the planet's
 *  shadow. uCentre is the planet's centre relative to the camera. */
export const FS_RING_ROCK = swap(swap(swap(swap(swap(FS_WORLD,
  'vec3 c = alb * (0.02 + 1.05 * diff * day)', 'vec3 c = alb * (0.16 + 1.05 * diff * day)'), // light off the ring around
  'const float RELIEF_GAIN = 6.0;', 'const float RELIEF_GAIN = 1.0;\nflat in float vSize;\nuniform vec3 uCentre;'),
  'float k = smoothstep(0.35, 0.7, uSpacing / cell);', 'float k = smoothstep(0.35, 0.7, vSize * 0.6 / cell);'),
  'if (vMat == 4) alb = vCol;', 'if (vMat == 4) alb = vCol * vec3(1.45, 1.42, 1.35);'),
  'float day = vMat == 4 ? 1.0 : smoothstep(-0.12, 0.12, dot(vRad, L));',
  `vec3 rp = vRel - uCentre; float along = dot(rp, L);
  float day = along > 0.0 ? 1.0 : smoothstep(uR * 0.99, uR * 1.01, length(rp - L * along));`);

/** The ring's haze, added to the resolve: a thin slab between two cylinders, its density across the width from a
 *  mipmapped texture, so that far bands average instead of sparkling. It is kept at least as thick as a cell is wide
 *  at the ring's distance, so that it shows edge-on, and fades out near the camera, where the rocks stand. */
const RING_HAZE = `
uniform sampler2D uDens;
uniform vec3 uRingN;
uniform float uRingIn, uRingOut, uCellK;
#define FAM_RING 6
const float DEPTH_LEN = 45.0;              // units of full density that hide all but 1/e of what is behind
const vec2 RING_NEAR = vec2(600.0, 1800.0);  // the haze fades in over these distances

float sunlit(vec3 p){                       // 0 in the planet's shadow
  float along = dot(p, L);
  return along > 0.0 ? 1.0 : smoothstep(uR * 0.99, uR * 1.01, length(p - L * along));
}

/** How much of the ray along d, up to tmax, the haze covers; its colour in col. */
float ringHaze(vec3 d, float tmax, out vec3 col){
  col = vec3(0.0);
  float h0 = dot(uEye, uRingN), dh = dot(d, uRingN);
  vec3 foot0 = uEye - uRingN * h0, dp = d - uRingN * dh;
  float thick = max(50.0, 0.45 * max(length(foot0) - uRingOut, abs(h0)) * uCellK);
  float a = 0.0, b = tmax;
  if (abs(dh) < 1e-7) { if (abs(h0) > thick) return 0.0; }
  else {
    float t0 = (-thick - h0) / dh, t1 = (thick - h0) / dh;
    a = max(a, min(t0, t1)); b = min(b, max(t0, t1));
  }
  float A = dot(dp, dp), B = dot(foot0, dp);
  if (A < 1e-9) return 0.0;
  float disc = B * B - A * (dot(foot0, foot0) - uRingOut * uRingOut);
  if (disc <= 0.0) return 0.0;
  a = max(a, (-B - sqrt(disc)) / A); b = min(b, (-B + sqrt(disc)) / A);
  if (b <= a) return 0.0;
  vec2 near_ = vec2(a, b), far_ = vec2(1.0, 0.0);   // the hole inside the inner radius leaves two pieces
  disc = B * B - A * (dot(foot0, foot0) - uRingIn * uRingIn);
  if (disc > 0.0) { near_ = vec2(a, min(b, (-B - sqrt(disc)) / A)); far_ = vec2(max(a, (-B + sqrt(disc)) / A), b); }
  float through = 1.0, texel = (uRingOut - uRingIn) / 1024.0;
  float side = h0 * dot(uRingN, L) > 0.0 ? 1.0 : 0.55;   // the side away from the sun is dimmer
  for (int piece = 0; piece < 2; piece++) {
    vec2 s = piece == 0 ? near_ : far_;
    if (s.y <= s.x) continue;
    float ds = (s.y - s.x) / 4.0;
    for (int i = 0; i < 4; i++) {
      float t = s.x + (float(i) + 0.5) * ds;
      vec3 p = uEye + d * t;
      float rho = length(p - uRingN * dot(p, uRingN)), share = (rho - uRingIn) / (uRingOut - uRingIn);
      // the width one sample stands for: a cell's footprint, stretched at a grazing angle, or the step along the ray
      float wide = max(t * uCellK / max(abs(dh), 0.25), min(ds * sqrt(A), 600.0));
      float dens = textureLod(uDens, vec2(share, 0.5), log2(max(wide / texel, 1.0))).r;
      float tau = dens * ds * (50.0 / thick) / DEPTH_LEN * smoothstep(RING_NEAR.x, RING_NEAR.y, t);
      float cover = 1.0 - exp(-tau);
      vec3 tint = mix(vec3(0.55, 0.40, 0.30), vec3(0.95, 0.84, 0.62), smoothstep(0.05, 0.6, share));
      tint = mix(tint, vec3(0.62, 0.66, 0.74), smoothstep(0.72, 0.95, share));
      col += through * cover * tint * (0.10 + 0.80 * dens) * side * mix(0.10, 1.0, sunlit(p));
      through *= 1.0 - cover;
    }
  }
  float cover = 1.0 - through;
  col *= mix(0.45, 1.0, smoothstep(60.0, 700.0, abs(h0))) / max(cover, 1e-4);   // dimmer seen from within
  return cover;
}

/** Lays the haze over a resolved cell. */
void overRing(inout vec3 rgb, inout float glyph, vec3 d, float tmax, ivec2 cell){
  vec3 col;
  float cover = ringHaze(d, tmax, col);
  if (cover <= 0.0) return;
  rgb = mix(rgb, col, cover);
  if (cover > 0.3) {
    float lum = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    glyph = lum >= 0.02 ? banded(FAM_RING, lum, cell) : 0.0;
  }
}
`;

/** The resolve for the ring scene: FS_RESOLVE with the haze laid over sky and surfaces, in its own character
 *  family. */
export const FS_RESOLVE_RING = swap(swap(swap(swap(FS_RESOLVE,
  'vec3 g = fam == FAM_HAZE ? vec3(G_COMMA, G_COLON, G_SEMI) :',
  'vec3 g = fam == 6 ? vec3(G_DOT, G_DASH, G_EQ) : fam == FAM_HAZE ? vec3(G_COMMA, G_COLON, G_SEMI) :'),
  '\nvoid main(){', RING_HAZE + '\nvoid main(){'),
  '// dense haze\n    o = vec4(rgb, glyph);', '// dense haze\n    overRing(rgb, glyph, dir, 1e9, cell);\n    o = vec4(rgb, glyph);'),
  '    rgb *= 1.15;\n  }\n', '    rgb *= 1.15;\n  }\n  overRing(rgb, glyph, dir, w * vlen, cell);\n');
