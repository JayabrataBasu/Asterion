/** All GLSL ES 3.00 sources. Kept in TS strings so Vite needs no loader plugin. */

export const VS_FULLSCREEN = `#version 300 es
out vec2 vUv;
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const NOISE = `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float vn2(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f*f*f*(f*(f*6.0-15.0)+10.0);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), f.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), f.x), f.y);
}
float vn3(vec3 p){
  vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  float a = mix(mix(hash13(i), hash13(i+vec3(1,0,0)), f.x), mix(hash13(i+vec3(0,1,0)), hash13(i+vec3(1,1,0)), f.x), f.y);
  float b = mix(mix(hash13(i+vec3(0,0,1)), hash13(i+vec3(1,0,1)), f.x), mix(hash13(i+vec3(0,1,1)), hash13(i+vec3(1,1,1)), f.x), f.y);
  return mix(a, b, f.z);
}
const mat2 ROT = mat2(0.8, 0.6, -0.6, 0.8);
float fbm2(vec2 p){ float a = 0.5, s = 0.0; p = mat2(0.8776,0.4794,-0.4794,0.8776) * p; for(int i=0;i<6;i++){ s += a*vn2(p); p = ROT*p*2.03 + 7.1; a *= 0.5; } return s; }
float fbm3(vec3 p){ float a = 0.5, s = 0.0; for(int i=0;i<5;i++){ s += a*vn3(p); p = p*2.07 + 3.7; a *= 0.5; } return s; }
`;

/** Pass 1 — one fragment per character cell. Sparse stars, rare nebulae, sun + spikes + flare ghosts, planets in glyph materials, set pieces. */
export const FS_SCENE = `#version 300 es
precision highp float; precision highp int;
uniform vec2 uRes; uniform vec2 uCam; uniform float uAspect; uniform float uTime;
uniform int uNP; uniform vec4 uPA[8]; uniform vec4 uPB[8]; uniform vec4 uPC[8];   // PC: x detail (resolve-on-approach), y scan rewrite
uniform float uG[24];    // glyph table, see GLYPHS in renderer.ts
uniform float uNeb; uniform float uSun; uniform vec3 uTint; uniform vec3 uStreak; uniform vec3 uShipL; uniform float uFlare; uniform float uStorm;
uniform vec3 uSunTint; uniform float uEcl; uniform float uMega; uniform float uCombat;
uniform vec4 uStyle;     // per-sector look: x palette hue, y cloud scale, z star density, w filament/dust strength
uniform vec3 uHyper;     // boost tunnel: xy heading (world), z amount 0..1
out vec4 o;
${NOISE}
const vec3 L = vec3(0.568, 0.5165, 0.640);
#define G_DASH uG[0]
#define G_SL uG[1]
#define G_BAR uG[2]
#define G_BS uG[3]
#define G_DOT uG[4]
#define G_COMMA uG[5]
#define G_COLON uG[6]
#define G_SEMI uG[7]
#define G_TILDE uG[8]
#define G_EQ uG[9]
#define G_HASH uG[10]
#define G_PCT uG[11]
#define G_STAR uG[12]
#define G_TICK uG[13]
#define G_AT uG[14]
#define G_PLUS uG[15]
#define G_O uG[16]
#define G_LP uG[17]
#define G_RP uG[18]

vec3 hueRgb(float h){ return clamp(abs(fract(h + vec3(0.0, 0.6667, 0.3333)) * 6.0 - 3.0) - 1.0, 0.0, 1.0); }
vec3 nebLayer(vec2 pl, float seed){
  vec2 q = pl * 0.0085 * uStyle.y + seed * 13.7;
  float t = uTime;
  float w = fbm2(q + vec2(t*0.010, -t*0.007));
  float n = fbm2(q*1.55 + w*2.5 + 11.3 + vec2(t*0.004, 0.0));
  float dens = smoothstep(0.40, 0.92, n);
  float h2 = smoothstep(0.38, 0.62, fbm2(q*0.35 - 30.0));
  float h3 = smoothstep(0.42, 0.62, fbm2(q*0.30 + 50.0));
  float core = smoothstep(0.60, 0.95, n);
  vec3 A = hueRgb(uStyle.x) * 0.72, B = hueRgb(uStyle.x - 0.23) * 0.72, C = hueRgb(uStyle.x + 0.19) * 0.9;   // palette rotates per sector (0.78 = the original violet / cyan / rose)
  vec3 col = mix(A, B, h2);
  col = mix(col, C, h3*0.75);
  col += core * vec3(0.55,0.28,0.18);
  float lane = smoothstep(0.52, 0.70, fbm2(q*2.6 + w*1.5 + 90.0));
  float rid = 1.0 - abs(fbm2(q*2.3 + w*1.2 + 40.0)*2.0 - 1.0); rid *= rid; rid *= rid;
  vec3 res = col * (dens*dens*0.55 + core*0.34) * (1.0 - 0.7*lane*(0.4 + uStyle.w)) + vec3(0.003,0.004,0.010);
  res += rid * dens * mix(hueRgb(uStyle.x - 0.2) * 0.8 + 0.15, hueRgb(uStyle.x + 0.2) * 0.8 + 0.15, h3) * (0.15 + 0.8 * uStyle.w);
  return res;
}

// stars: dense parallax field; near top speed they bunch toward the heading and shift blue ahead / red behind
vec4 starLayer(vec2 cell, vec2 camCell, float par, float dens, float seed){
  vec2 sc = floor(cell + floor(camCell * par));
  float clump = 0.45 + 1.4 * vn2(sc * 0.011 + seed * 5.0);          // stars cluster: rich lumps and quiet gaps
  float h = hash12(sc + seed * 17.0);
  if (h > dens * uStyle.z * clump) return vec4(0.0);
  float b = hash12(sc * 1.37 + seed * 3.1);
  float tw = 0.72 + 0.28 * sin(uTime * (1.0 + b*4.0) + b*60.0);
  float sc2 = hash12(sc*0.77 + 9.1);                                 // stellar class: blue-white, yellow, orange-red
  vec3 tint = sc2 < 0.5 ? mix(vec3(0.55,0.72,1.0), vec3(0.95,0.95,1.0), sc2 * 2.0) : sc2 < 0.85 ? mix(vec3(1.0,0.92,0.7), vec3(1.0,0.78,0.5), (sc2 - 0.5) * 2.86) : vec3(1.0,0.5,0.32);
  float br = (0.30 + 0.70*b) * tw * (0.55 + 0.45*par);
  return vec4(tint * br * 1.5, br);
}

vec3 galaxy(vec2 cell, vec2 camCell){
  vec2 p = cell + camCell * 0.06;
  vec2 g = floor(p / 120.0);
  if (hash12(g + 7.3) < 0.80) return vec3(0.0);
  vec2 c = (g + 0.25 + 0.5 * vec2(hash12(g + 1.1), hash12(g + 2.2))) * 120.0;
  vec2 d = (p - c) * vec2(1.0, uAspect);
  float ang = hash12(g + 3.3) * 3.14159;
  d = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * d;
  float tilt = 0.35 + 0.4 * hash12(g + 4.4);
  vec2 e = vec2(d.x / 15.0, d.y / (15.0 * tilt));
  float r = length(e), th = atan(e.y, e.x);
  float arm = 0.5 + 0.5 * cos(2.0 * th - 6.0 * log(r + 0.15));
  vec3 tint = mix(vec3(1.0, 0.78, 0.55), vec3(0.55, 0.7, 1.0), hash12(g + 5.5));
  return tint * (exp(-r * 2.3) * (0.18 + 0.7 * arm) * 0.55 + exp(-r * 8.0) * 0.9);
}

vec2 sunPos(vec2 camCell){ return uRes * vec2(0.66, 0.78) - camCell * 0.02; }

vec3 sunGlow(vec2 cell, vec2 sp, out float core){
  vec2 d = (cell + 0.5 - sp) * vec2(1.0, uAspect);
  float r = length(d);
  core = exp(-r * r / 10.0) * 6.0 + exp(-r / 3.5) * 1.1;
  float corona = 0.22 / (1.0 + r * r * 0.006);
  float ang = atan(d.y, d.x);
  float rays = pow(max(0.0, 0.5 + 0.5 * sin(ang * 9.0 + uTime * 0.08) * sin(ang * 5.0 - uTime * 0.05)), 3.0) * exp(-r * 0.05) * 0.55;
  float streak = exp(-abs(d.y) * 0.9) * exp(-abs(d.x) * 0.03) * 0.35;
  return uSunTint * (vec3(1.0, 0.86, 0.62) * (core + corona + rays) + vec3(1.0, 0.75, 0.5) * streak);
}

vec3 surface(vec3 n, int type, float seed, float detail, out float gloss, out vec3 emis){
  gloss = 0.0; emis = vec3(0.0);
  float spin = uTime * 0.10 * (0.5 + seed);
  float cs = cos(spin), sn = sin(spin);
  vec3 q = vec3(n.x*cs + n.z*sn, n.y, -n.x*sn + n.z*cs);
  vec3 s3 = q * 2.4 + seed * 40.0;
  float fine = smoothstep(0.65, 1.0, detail);           // clouds, storms, lightning, cities only up close
  vec3 col;
  if (type == 0) {
    float h = fbm3(s3 * 1.25);
    float lat = abs(q.y);
    if (h < 0.50) { col = mix(vec3(0.015,0.07,0.30), vec3(0.05,0.34,0.62), smoothstep(0.25,0.5,h)); gloss = 1.0; }
    else if (h < 0.545) col = vec3(0.82,0.76,0.48);
    else col = mix(vec3(0.07,0.40,0.10), vec3(0.50,0.38,0.22), smoothstep(0.55,0.80,h));
    float ice = smoothstep(0.80, 0.93, lat + (h-0.5)*0.25);
    col = mix(col, vec3(0.93,0.97,1.0), ice);
    float c = fbm3(vec3(q.x*cs, q.y, q.z) * 3.6 + vec3(uTime*0.07, 0.0, seed*9.0) + 7.0);
    float cl = smoothstep(0.54, 0.74, c) * fine;
    col = mix(col, vec3(1.0), cl * 0.9);
    gloss *= (1.0 - cl);
    emis = vec3(1.0, 0.72, 0.3) * step(0.548, h) * step(0.86, hash13(floor(q * 55.0))) * (1.0 - cl) * 1.7 * fine;
  } else if (type == 1) {
    float w = fbm3(vec3(q.x*1.6, q.y*5.0, q.z*1.6) + seed*20.0) * 0.45 * smoothstep(0.25, 0.6, detail);
    float b = sin((q.y + w) * 17.0 + seed*6.0) * 0.5 + 0.5;
    float b2 = sin((q.y + w) * 41.0 + seed*9.0) * 0.5 + 0.5;
    vec3 c1 = seed > 0.5 ? vec3(0.16,0.42,0.80) : vec3(0.82,0.48,0.20);
    vec3 c2 = seed > 0.5 ? vec3(0.72,0.88,0.97) : vec3(0.96,0.86,0.66);
    col = mix(c1, c2, mix(0.5, b, smoothstep(0.15, 0.45, detail)));
    col = mix(col, col*0.7, b2*0.35*fine);
    vec2 sp = vec2(q.x - 0.35, (q.y + 0.28) * 2.4);
    float rs = length(sp), ang = atan(sp.y, sp.x) + rs * 16.0 - uTime * 0.18;
    float spot = smoothstep(0.24, 0.08, rs) * step(0.0, q.z) * smoothstep(0.45, 0.75, detail);
    float swirl = 0.55 + 0.45 * sin(ang * 2.0 + rs * 26.0);
    vec3 stormC = seed > 0.5 ? vec3(0.86, 0.94, 1.0) : vec3(0.86, 0.28, 0.12);
    col = mix(col, stormC * (0.7 + 0.5 * swirl), spot * 0.88);
    vec2 sp2 = vec2(q.x + 0.5, (q.y - 0.42) * 3.0);
    float r2 = length(sp2), a2 = atan(sp2.y, sp2.x) - r2 * 12.0 + uTime * 0.22;
    float spot2 = smoothstep(0.14, 0.04, r2) * step(0.0, q.z) * fine;
    col = mix(col, vec3(0.95, 0.92, 0.85) * (0.75 + 0.25 * sin(a2 * 3.0)), spot2 * 0.8);
    float bolt = step(0.985, hash13(vec3(floor(q.xy * 14.0), floor(uTime * 5.0) + seed * 31.0))) * (spot + spot2) * fine;
    emis = vec3(0.65, 0.75, 1.0) * bolt * 2.2;
  } else if (type == 2) {
    float h = fbm3(s3);
    col = mix(vec3(0.62,0.82,0.95), vec3(0.97,0.99,1.0), h);
    float r = abs(fbm3(s3 * 2.6) * 2.0 - 1.0);
    col = mix(col, vec3(0.20,0.46,0.80), smoothstep(0.10, 0.0, r) * 0.9 * fine);
    gloss = 1.0;
  } else if (type == 3) {
    float h = fbm3(s3 * 1.5);
    col = vec3(0.10,0.055,0.045) * (0.4 + h * 1.4);
    float crack = smoothstep(0.075, 0.0, abs(h - 0.5)) + smoothstep(0.03, 0.0, abs(fbm3(s3*3.3) - 0.5)) * fine;
    emis = vec3(1.0,0.30,0.04) * crack * 1.4 * smoothstep(0.3, 0.7, detail) + vec3(0.6,0.12,0.02) * smoothstep(0.62, 0.8, h) * 0.5;
  } else {
    float h = fbm3(vec3(q.x*1.8, q.y*7.0, q.z*1.8) + seed*10.0);
    col = mix(vec3(0.70,0.36,0.13), vec3(0.95,0.70,0.38), h);
    float cr = smoothstep(0.62, 0.7, fbm3(s3*2.2 + 5.0));
    col = mix(col, vec3(0.42,0.20,0.08), cr*0.6*fine);
  }
  return col;
}

vec3 atmoColor(int type){
  if (type == 0) return vec3(0.30,0.58,1.0);
  if (type == 1) return vec3(0.95,0.72,0.42);
  if (type == 2) return vec3(0.55,0.85,1.0);
  if (type == 3) return vec3(1.0,0.32,0.10);
  return vec3(1.0,0.62,0.32);
}

/** Glyph material: each kind of matter has its own glyph family and motion. */
float matGlyph(int type, vec3 n, vec3 c, float lum, vec2 cell){
  float flow = uTime * 0.5;
  if (type == 1) {                                                    // gas giants flow in ~ - =
    float lat = abs(n.y);                                              // fewer, wider bands: ~ at the equator, - toward the poles, drifting slowly
    float k = fract(n.y * 2.2 + 0.08 * sin(n.x * 3.0 + flow) + flow * 0.02);
    return lat < 0.32 ? G_TILDE : lat > 0.72 ? G_DASH : (k < 0.5 ? G_TILDE : G_DASH);
  }
  if (type == 2 || min(c.r, min(c.g, c.b)) > 0.72) return lum > 0.55 ? G_STAR : lum > 0.25 ? G_TICK : G_DOT;   // ice . * '
  if (c.b > c.r * 1.25 && c.b > c.g) return fract(cell.x * 0.37 + cell.y * 0.21 + flow * 0.3) < 0.5 ? G_TILDE : G_DASH;   // oceans ripple
  return lum > 0.45 ? G_HASH : lum > 0.2 ? G_PCT : G_COLON;            // rock # % :
}

void main(){
  vec2 cell = floor(gl_FragCoord.xy);
  vec2 wp = uCam + (cell + 0.5 - uRes * 0.5) * vec2(1.0, uAspect);
  vec2 camCell = uCam / vec2(1.0, uAspect);

  // ---- rare nebulae (uNeb already carries the per-sector amount) and very rare galaxies
  vec3 rgb = (nebLayer(wp - uCam*0.80, 0.0) * 0.85 + nebLayer(wp - uCam*0.55, 1.0) * 0.55 + nebLayer(wp - uCam*0.25, 2.0) * 0.28) * uNeb * uTint;   // near clouds, mid clouds, far colour wash
  rgb += galaxy(cell, camCell) * uNeb * uTint;
  float glyph = 0.0;

  // ---- far set pieces: a ringed giant crossing the sun (uEcl) and a megastructure arc crossing the sky (uMega)
  vec2 sp = sunPos(camCell);
  float occl = 0.0;
  vec2 gc = sp + vec2(mix(-46.0, 46.0, uEcl), mix(5.0, -3.0, uEcl)), gd = (cell + 0.5 - gc) * vec2(1.0, uAspect);
  float gR = 30.0, gdist = length(gd);
  if (uEcl > 0.0) occl = 1.0 - smoothstep(gR - 4.0, gR + 1.0, length((sp - gc) * vec2(1.0, uAspect)));
  vec2 sunW = uCam + (sp - uRes * 0.5) * vec2(1.0, uAspect);
  for (int k = 0; k < 8; k++) { if (k >= uNP) break; if (length(sunW - uPA[k].xy) < uPA[k].z * 0.98) occl = 1.0; }   // a planet hides the sun
  float core;
  rgb += sunGlow(cell, sp, core) * uSun * (1.0 - 0.97 * occl);
  if (uStorm > 0.0) {
    float fr = floor(uTime * 7.0);
    float bolt = smoothstep(0.62, 0.9, fbm2(wp * 0.045 + vec2(fr * 3.7, fr * 1.3))) * step(0.55, hash12(vec2(fr, 7.0)));
    rgb += vec3(0.5, 0.65, 1.0) * bolt * uStorm * 1.6;
  }

  // ---- stars: thinned in a fight
  vec2 sc = cell;
  float thin = 1.0 - 0.6 * uCombat;
  vec4 s0 = starLayer(sc, camCell, 0.14, 0.020 * thin, 1.0);
  vec4 s1 = starLayer(sc, camCell, 0.34, 0.011 * thin, 2.0);
  vec4 s2 = starLayer(sc, camCell, 0.70, 0.0055 * thin, 3.0);
  vec4 st = s0;
  if (s1.a > st.a) st = s1;
  if (s2.a > st.a) st = s2;
  if (st.a > 0.0) {
    float k = st.a < 0.30 ? G_DOT : st.a < 0.48 ? G_COMMA : st.a < 0.66 ? G_COLON : G_SEMI;
    if (uStreak.z > 0.1 && st.a > 0.28) {
      float sa = mod(atan(uStreak.y, uStreak.x) + 3.14159265, 3.14159265);
      k = (sa < 0.3927 || sa > 2.7489) ? G_DASH : sa < 1.1781 ? G_SL : sa < 1.9635 ? G_BAR : G_BS;
    }
    rgb += st.rgb; glyph = k;
  } else {                                          // bright near stars get - | arms in the neighbouring cells
    vec4 nL = starLayer(sc + vec2(-1.0, 0.0), camCell, 0.70, 0.0055 * thin, 3.0);
    vec4 nR = starLayer(sc + vec2( 1.0, 0.0), camCell, 0.70, 0.0055 * thin, 3.0);
    vec4 nU = starLayer(sc + vec2(0.0,  1.0), camCell, 0.70, 0.0055 * thin, 3.0);
    vec4 nD = starLayer(sc + vec2(0.0, -1.0), camCell, 0.70, 0.0055 * thin, 3.0);
    float ah = max(nL.a, nR.a), av = max(nU.a, nD.a);
    if (max(ah, av) > 0.66) {
      glyph = ah >= av ? G_DASH : G_BAR;
      rgb += (ah >= av ? (nL.a > nR.a ? nL.rgb : nR.rgb) : (nU.a > nD.a ? nU.rgb : nD.rgb)) * 0.32;
    }
  }

  // ---- hyperspace: on boost, star-lines rush outward from a vanishing point ahead of the ship.
  // Polar rays with a continuous outward phase, so lines slide smoothly (no per-cell reshuffle).
  if (uHyper.z > 0.01) {
    vec2 vp = uRes * 0.5 + vec2(uHyper.x, uHyper.y / uAspect) * uRes.y * 0.22;
    vec2 d = (cell + 0.5 - vp) * vec2(1.0, uAspect);
    float r = length(d), ang = atan(d.y, d.x);
    const float NR = 150.0;
    float fa = (ang / 6.28318 + 0.5) * NR, ai = floor(fa);
    float hr = hash12(vec2(ai, 3.1));
    float off = abs(fract(fa) - 0.5) * 6.28318 / NR * r;               // distance from the ray centre, in world units
    if (hr > 0.72 && off < 0.5) {
      float sp = 0.7 + 1.3 * hash12(vec2(ai, 7.7));
      float ph = fract(log(r + 2.0) * 1.6 - uTime * sp * (0.6 + 1.6 * uHyper.z) + hr * 13.0);
      float len = 0.06 + 0.30 * uHyper.z;
      if (ph < len && r > 6.0) {
        float k = ph / len;                                               // 0 tail .. 1 head (outer end)
        float br = uHyper.z * (0.15 + 0.8 * k * k) * smoothstep(8.0, 40.0, r);
        rgb = rgb * (1.0 - 0.35 * uHyper.z) + mix(mix(vec3(0.35, 0.55, 1.2), hueRgb(uStyle.x - 0.23) * 1.3 + 0.2, 0.5), vec3(1.2, 1.3, 1.6), k) * br;   // tunnel takes the sector's palette
        float a = mod(ang + 3.14159265, 3.14159265);
        glyph = (a < 0.3927 || a > 2.7489) ? G_DASH : a < 1.1781 ? G_SL : a < 1.9635 ? G_BAR : G_BS;
      }
    }
    rgb += vec3(0.10, 0.18, 0.45) * uHyper.z * exp(-length((cell + 0.5 - vp) * vec2(1.0, uAspect)) / 30.0);   // tunnel glow at the vanishing point
  }

  // ---- far ringed giant (eclipse event)
  if (uEcl > 0.0 && gdist < gR * 2.3) {
    float ra = 0.35, ca = cos(ra), sa = sin(ra);
    vec2 e = gd / gR;
    vec2 v = vec2(e.x*ca + e.y*sa, (-e.x*sa + e.y*ca) / 0.28);
    float rd = length(v), band = smoothstep(1.45, 1.55, rd) * smoothstep(2.2, 2.1, rd);
    bool front = (-e.x*sa + e.y*ca) < 0.0;
    vec2 tosun = normalize((sp - gc) * vec2(1.0, uAspect) + 1e-3);
    if (gdist < gR) {
      vec3 n = vec3(e, sqrt(max(0.0, 1.0 - dot(e, e))));
      float lit = max(0.0, dot(n.xy, tosun)) * 0.35 + 0.03;
      float b = sin(n.y * 14.0 + 1.3) * 0.5 + 0.5;
      rgb = mix(vec3(0.25, 0.20, 0.14), vec3(0.45, 0.36, 0.24), b) * lit;
      glyph = fract(n.y * 4.5 + uTime * 0.02) < 0.5 ? G_TILDE : G_DASH;
      float rim = smoothstep(0.9, 1.0, length(e)) * (0.4 + 2.5 * occl);
      rgb += vec3(1.0, 0.85, 0.6) * uSunTint * rim * 1.6 * uSun;
      if (rim > 0.5) glyph = G_STAR;
    } else if (gdist < gR * 1.25 && occl > 0.2) {                       // corona while the sun hides behind it
      float cor = exp(-(gdist - gR) / 2.5) * occl * uSun;
      rgb += vec3(1.0, 0.9, 0.7) * uSunTint * cor * 2.2;
      if (cor > 0.25) glyph = cor > 0.8 ? G_STAR : G_PLUS;
    }
    if (band > 0.0 && (front || gdist > gR)) { rgb = mix(rgb, vec3(0.55, 0.48, 0.40) * 0.35, band * 0.9); glyph = G_EQ; }
  }

  // ---- megastructure: a broken orbital ring arc crossing the sky over ~90 s
  if (uMega > 0.0) {
    vec2 mc = vec2(mix(-0.7, 1.7, uMega) * uRes.x, -uRes.y * 1.1) - camCell * 0.03;
    vec2 md = (cell + 0.5 - mc) * vec2(1.0, uAspect);
    float R = uRes.y * 2.6, dist = length(md), th = atan(md.y, md.x);
    float gap = step(0.18, fract(th * 6.0 + 0.3));
    float band = abs(dist - R);
    if (band < 4.5 && gap > 0.5) {
      float seg = floor(th * 220.0);
      float top = smoothstep(4.5, 0.0, band) * (md.y > 0.0 ? 1.0 : 0.6);
      rgb = vec3(0.22, 0.24, 0.28) * (0.35 + 0.65 * top) + vec3(0.08, 0.06, 0.04) * step(0.5, fract(th * 110.0));
      glyph = band < 1.0 ? G_EQ : (fract(th * 220.0) < 0.5 ? G_HASH : G_PCT);
      if (band < 3.0 && hash12(vec2(seg, floor(band))) > 0.86) { rgb += vec3(1.6, 1.1, 0.5) * 0.5; glyph = G_DOT; }
    } else if (band < 9.0 && gap > 0.5 && fract(th * 36.0) < 0.06) { rgb = vec3(0.12, 0.13, 0.15); glyph = G_BAR; }
  }

  // ---- planets: glyph materials, resolve on approach, atmosphere rims, eclipse corona, ring shadows
  vec2 cs4[4] = vec2[4](vec2(-0.25,-0.25), vec2(0.25,-0.25), vec2(-0.25,0.25), vec2(0.25,0.25));
  for (int k = 0; k < 8; k++) {
    if (k >= uNP) break;
    vec4 A = uPA[k], B = uPB[k], C = uPC[k];
    float R = A.z; int type = int(A.w + 0.5); float seed = B.x, detail = C.x;
    vec2 d = wp - A.xy;
    float dist = length(d);
    vec3 ac = atmoColor(type);
    float thick = 2.2 + R * 0.10;
    if (dist > R + thick * 5.0 && B.y < 0.5) continue;
    int cov = 0;
    for (int i = 0; i < 4; i++) cov += (length(d + cs4[i] * vec2(1.0, uAspect)) < R) ? 1 : 0;
    float sunSide = dot(normalize(d + 1e-4), L.xy) * 0.5 + 0.5;
    float ecl = 1.0 - smoothstep(R * 0.6, R * 1.02, length(sunW - A.xy));      // sun behind this body
    float resolve = step(hash12(cell + seed * 91.0 + float(k)), 0.12 + detail * 1.1);   // cells load in as you approach

    if (cov > 0) {
      vec2 e = d / R;
      float le = length(e);
      if (le > 0.985) e *= 0.985 / le;
      vec3 n = vec3(e, sqrt(max(1.0 - dot(e, e), 0.0)));
      float gloss; vec3 emis;
      vec3 sc = mix(ac * 0.45, surface(n, type, seed, detail, gloss, emis), smoothstep(0.0, 0.3, detail));
      float ndl = dot(n, L);
      float diff = smoothstep(-0.12, 0.9, ndl);
      if (type == 0) emis *= 1.0 - smoothstep(-0.12, 0.2, ndl);
      vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
      float spec = pow(max(dot(n, H), 0.0), 55.0) * gloss;
      float rim = pow(1.0 - n.z, 2.6);
      if (B.y > 0.5) {                                              // ring shadow cast across the disc
        float ra = seed * 3.14159, ca = cos(ra), sa = sin(ra);
        vec2 ep = e + L.xy * n.z * 0.9;
        float rdd = length(vec2(ep.x*ca + ep.y*sa, (-ep.x*sa + ep.y*ca) / 0.30));
        diff *= 1.0 - 0.6 * smoothstep(1.5, 1.6, rdd) * smoothstep(2.4, 2.3, rdd);
      }
      vec3 col = sc * (0.025 + 1.05 * diff) + emis + vec3(spec) * 1.5 + ac * rim * (0.12 + 0.95 * diff) * 0.9 * (1.0 + uFlare * 1.6);
      if ((type == 0 || type == 2) && detail > 0.7) {
        float polar = smoothstep(0.78, 0.93, abs(n.y));
        float cur = 0.5 + 0.5 * sin(n.x * 22.0 + uTime * 1.3 + sin(n.y * 40.0 + uTime * 0.7) * 2.0);
        vec3 aur = mix(vec3(0.15, 1.0, 0.5), vec3(0.6, 0.3, 1.0), 0.5 + 0.5 * sin(uTime * 0.4 + n.x * 3.0));
        col += aur * polar * cur * (1.0 - diff * 0.7) * 0.9;
      }
      if (uShipL.z > 0.0 && gloss > 0.0) {
        vec2 sd = uShipL.xy - A.xy;
        vec3 Ls = normalize(vec3(sd, 70.0));
        float att = 1.0 / (1.0 + dot(sd, sd) / 30000.0);
        float g2 = pow(max(dot(n, normalize(Ls + vec3(0.0, 0.0, 1.0))), 0.0), 26.0);
        col += vec3(0.45, 0.75, 1.0) * g2 * gloss * att * uShipL.z * 2.2;
      }
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      rgb = col * resolve;
      glyph = resolve > 0.5 && lum > 0.05 ? matGlyph(type, n, sc, lum, cell) : 0.0;   // night side falls back to the plain ramp
      if (resolve > 0.5 && cov == 4) {
        float term = 1.0 - smoothstep(0.0, 0.12, abs(ndl));         // terminator: a soft band of : at the day / night edge
        if (term > 0.5) { glyph = G_COLON; rgb += ac * 0.08 * term; }
        if (type == 0 && emis.r > 0.4 && ndl < 0.0) glyph = G_DOT;   // city lights on the night side
      }
      if (C.y > 0.0) glyph = 0.0;                                   // scan view rewrites this body as data strings (glyph pass)
      if (cov < 4 && resolve > 0.5) {                               // limb cell -> directional glyph
        vec2 nn = normalize(d + 1e-4);
        vec2 tg = vec2(-nn.y, nn.x);
        float a = mod(atan(tg.y, tg.x) + 3.14159265, 3.14159265);
        glyph = (a < 0.3927 || a > 2.7489) ? G_DASH : a < 1.1781 ? G_SL : a < 1.9635 ? G_BAR : G_BS;
        rgb = col * 1.15 + ac * (0.18 + 0.5 * sunSide);
      }
    } else if (dist < R + thick * 5.0) {
      float f = exp(-(dist - R) / thick);
      float a = f * (0.10 + 0.85 * sunSide) * 0.85 * (0.3 + 0.7 * detail);
      rgb += ac * a;
      if (a > 0.32 && resolve > 0.5) glyph = a > 0.55 ? G_SEMI : a > 0.42 ? G_COLON : G_COMMA;   // atmosphere: the light family
      if (sunSide > 0.55 && dist < R + 1.6 && resolve > 0.5 && abs(d.x) > 0.25 * R) glyph = d.x < 0.0 ? G_LP : G_RP;   // lit limb: a coloured ( ) rim
      if (ecl > 0.0) {                                              // eclipse: corona ring around the occluding body
        float cor = exp(-(dist - R) / 2.0) * ecl * uSun;
        rgb += vec3(1.0, 0.9, 0.72) * uSunTint * cor * 2.4;
        if (cor > 0.3) glyph = cor > 0.9 ? G_STAR : G_PLUS;
      }
    }

    if (B.y > 0.5) {
      float ra = seed * 3.14159;
      float ca = cos(ra), sa = sin(ra);
      vec2 e = d / R;
      vec2 v = vec2(e.x*ca + e.y*sa, (-e.x*sa + e.y*ca) / 0.30);
      float rd = length(v);
      float band = smoothstep(1.50, 1.60, rd) * smoothstep(2.38, 2.28, rd) * (1.0 - 0.8 * smoothstep(0.03, 0.0, abs(rd - 1.98)));
      float front = (-e.x*sa + e.y*ca) < 0.0 ? 1.0 : 0.0;
      bool visible = (front > 0.5) || (cov == 0);
      if (band > 0.0 && visible && resolve > 0.5) {
        float b = 0.55 + 0.45 * sin(rd * 58.0 + seed * 10.0) * sin(rd * 13.0);
        vec3 rc = mix(vec3(0.85,0.74,0.58), vec3(0.55,0.48,0.46), b) * (0.45 + 0.7 * smoothstep(-0.4, 0.8, e.x*L.x*-1.0 + 0.2));
        rgb = mix(rgb, rc * 1.15, band * 0.85); glyph = b > 0.6 ? G_EQ : G_DASH;
      }
    }
  }

  o = vec4(rgb, glyph);
}`;


/** Additive soft glow sprites into the scene buffer (bullets, engines, explosions...). */
export const VS_GLOW = `#version 300 es
in vec2 aC; in vec4 aG0; in vec4 aG1;
uniform vec2 uRes; uniform vec2 uCam; uniform float uAspect;
out vec2 vC; out vec3 vCol;
void main(){
  float rad = max(aG0.z, 1.25);
  float comp = (aG0.z * aG0.z) / (rad * rad);
  vec2 w = aG0.xy + aC * rad;
  vec2 cc = (w - uCam) / vec2(1.0, uAspect) + uRes * 0.5;
  gl_Position = vec4(cc / uRes * 2.0 - 1.0, 0.0, 1.0);
  vC = aC; vCol = aG1.rgb * comp;
}`;
export const FS_GLOW = `#version 300 es
precision highp float; precision highp int;
in vec2 vC; in vec3 vCol;
out vec4 o;
void main(){
  float d = length(vC);
  float f = max(1.0 - d, 0.0); f *= f;
  o = vec4(vCol * f, 0.0);
}`;

const GLYPH_COV = `
uniform sampler2D uAtlas;
uniform ivec2 uCellPx;
float glyphCov(int g, ivec2 loc){
  ivec2 ap = ivec2((g & 15) * uCellPx.x + loc.x, (g >> 4) * uCellPx.y + (uCellPx.y - 1 - loc.y));
  return texelFetch(uAtlas, ap, 0).a;
}`;

/** Pass 2 — ASCII: one fragment per device pixel, picks glyph by scene luminance and draws it. */
export const FS_ASCII = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uScene; uniform sampler2D uRamp; uniform sampler2D uMA; uniform sampler2D uMB;
uniform ivec2 uCells; uniform ivec2 uOrigin;
uniform float uExposure, uDither, uBgK, uFgBase, uFgGain, uTime;
uniform vec3 uReveal;      // typed arrival: x = revealed radius (cells), y = front width, z = on
uniform int uLayers;       // debug: tint cells by layer
uniform vec4 uQZ[16]; uniform int uQN;   // ship quiet zones: xy = centre (cells), z = hull radius (cell widths), w = allegiance (0 player, 1 hostile, 2 neutral)
out vec4 o;
${GLYPH_COV}
float bayer4(ivec2 c){
  int x = c.x & 3, y = c.y & 3;
  int m[16] = int[16](0,8,2,10, 12,4,14,6, 3,11,1,9, 15,7,13,5);
  return (float(m[y*4 + x]) + 0.5) / 16.0;
}
void main(){
  ivec2 px = ivec2(gl_FragCoord.xy) - uOrigin;
  ivec2 cell = ivec2(floor(vec2(px) / vec2(uCellPx)));
  if (px.x < 0 || px.y < 0 || cell.x >= uCells.x || cell.y >= uCells.y) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  ivec2 loc = px - cell * uCellPx;
  vec4 s = texelFetch(uScene, cell, 0);
  vec4 ma = texelFetch(uMA, cell, 0);
  vec3 fg, bg;
  int g;
  float qa = 1.0, qal = 0.0;                          // quiet zone: 0 right at a ship, 1 beyond ~3 cells; graded in between
  { vec2 cc = vec2(cell) + 0.5;
    for (int i = 0; i < 16; i++) {
      if (i >= uQN) break;
      vec4 z = uQZ[i];
      float d = length((cc - z.xy) * vec2(1.0, 2.0)) - z.z * 0.7;
      float a = clamp(d / (3.0 + 0.25 * z.z), 0.0, 1.0); a = a * a * (3.0 - 2.0 * a);
      if (a < qa) { qa = a; qal = z.w; }
    }
    qa = mix(0.35, 1.0, qa); }   // never fully black: the sky stays visible around a ship, just calmer
  if (ma.a > 0.0) {                                   // sprite cell: shape-matched glyph
    vec4 mb = texelFetch(uMB, cell, 0);
    g = int(ma.a * 255.0 + 0.5);
    fg = ma.rgb;
    if (qa < 1.0) { float ll = dot(fg, vec3(0.2126, 0.7152, 0.0722)); fg *= clamp(1.1 / max(ll, 0.02), 1.0, 5.0); }   // adaptive contrast: a ship cell never goes darker than a floor
    bg = mix(s.rgb * uBgK * (s.a > 0.0 ? 0.04 : 1.0) * qa, mb.rgb, mb.a);
    if (qa < 1.0) bg = max(bg, fg * 0.4 * mb.a);     // hull tile never sinks into the dark zone
  } else {
    float lum = dot(s.rgb, vec3(0.2126, 0.7152, 0.0722));
    float l = 1.0 - exp(-lum * uExposure);
    if (s.a > 0.0) { g = int(s.a * 255.0 + 0.5); l = max(l, 0.14); }
    else {
      float dth = (bayer4(cell + ivec2(int(uTime * 3.0) & 1, 0)) - 0.5) * uDither * 0.09;
      float li = clamp(l + dth, 0.0, 1.0);
      g = int(texelFetch(uRamp, ivec2(int(li * 255.0), 0), 0).r * 255.0 + 0.5);
    }
    float mx = max(max(s.r, s.g), s.b) + 1e-4;
    vec3 hue = s.rgb / mx;
    hue = mix(vec3(dot(hue, vec3(0.333))), hue, 1.15);
    fg = hue * (uFgBase + uFgGain * l);
    bg = s.rgb * uBgK;
    if (s.a > 0.0) {                                  // glyph cell: borrow the backdrop from a plain neighbour (no black box, no filled slab)
      vec3 acc = vec3(0.0); float na = 0.0;
      for (int i = 0; i < 4; i++) {
        ivec2 o4 = i == 0 ? ivec2(-2, 0) : i == 1 ? ivec2(2, 0) : i == 2 ? ivec2(0, 2) : ivec2(0, -2);
        vec4 nb = texelFetch(uScene, clamp(cell + o4, ivec2(0), uCells - 1), 0);
        if (nb.a <= 0.0) { acc += nb.rgb; na += 1.0; }
      }
      bg = (na > 0.0 ? acc / na : min(s.rgb * 0.25, vec3(0.05))) * uBgK;
    }
  }
  if (ma.a <= 0.0) {                                  // dark halo around sprites so ships separate from the backdrop
    float h = 0.0;
    h += texelFetch(uMA, min(cell + ivec2(1, 0), uCells - 1), 0).a > 0.0 ? 1.0 : 0.0;
    h += texelFetch(uMA, max(cell - ivec2(1, 0), ivec2(0)), 0).a > 0.0 ? 1.0 : 0.0;
    h += texelFetch(uMA, min(cell + ivec2(0, 1), uCells - 1), 0).a > 0.0 ? 1.0 : 0.0;
    h += texelFetch(uMA, max(cell - ivec2(0, 1), ivec2(0)), 0).a > 0.0 ? 1.0 : 0.0;
    h += texelFetch(uMA, min(cell + ivec2(1, 1), uCells - 1), 0).a > 0.0 ? 0.5 : 0.0;     // diagonals too, so no gap leaks backdrop to the hull edge
    h += texelFetch(uMA, clamp(cell + ivec2(-1, 1), ivec2(0), uCells - 1), 0).a > 0.0 ? 0.5 : 0.0;
    h += texelFetch(uMA, clamp(cell + ivec2(1, -1), ivec2(0), uCells - 1), 0).a > 0.0 ? 0.5 : 0.0;
    h += texelFetch(uMA, max(cell - ivec2(1, 1), ivec2(0)), 0).a > 0.0 ? 0.5 : 0.0;
    float dim = (1.0 - 0.9 * min(1.0, h)) * qa;      // dark ring + graded quiet zone: ships always sit in darkness
    bg *= dim; fg *= dim;
  }
  if (uReveal.z > 0.0) {                              // typed arrival: the scene writes itself in outward from the centre
    float rd = length((vec2(cell) - vec2(uCells) * 0.5) * vec2(1.0, 2.0));
    if (rd > uReveal.x) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
    if (rd > uReveal.x - uReveal.y) {
      float hh = fract(sin(dot(vec2(cell) + floor(uTime * 24.0), vec2(12.9898, 78.233))) * 43758.5453);
      g = int(texelFetch(uRamp, ivec2(int(40.0 + hh * 200.0), 0), 0).r * 255.0 + 0.5);
      fg = vec3(0.3, 0.9, 0.8) * (0.4 + 0.6 * hh); bg *= 0.3;
    }
  }
  if (uLayers == 1) {                                 // debug: background blue, bodies green, ships red
    vec3 t = ma.a > 0.0 ? vec3(1.6, 0.3, 0.3) : s.a > 0.0 ? vec3(0.3, 1.5, 0.4) : vec3(0.3, 0.5, 1.6);
    fg = t * max(0.25, dot(fg, vec3(0.333))); bg = t * 0.03;
  }
  float cov = g == 0 ? 0.0 : glyphCov(g, loc);
  o = vec4(mix(bg, fg, cov), 1.0);
}`;

/** Entities / particles / HUD: instanced glyph quads. */
export const VS_GLYPH = `#version 300 es
in vec2 aC; in vec4 aI0; in vec4 aI1;
uniform ivec2 uCellPx; uniform ivec2 uOrigin; uniform vec2 uCanvas;
flat out vec4 fI0; flat out vec3 fCol;
void main(){
  vec2 p = vec2(uOrigin) + (aI0.xy + aC) * vec2(uCellPx);
  gl_Position = vec4(p / uCanvas * 2.0 - 1.0, 0.0, 1.0);
  fI0 = aI0; fCol = aI1.rgb;
}`;
export const FS_GLYPH = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uScene;
uniform ivec2 uOrigin; uniform float uBgK;
flat in vec4 fI0; flat in vec3 fCol;
out vec4 o;
${GLYPH_COV}
void main(){
  ivec2 cell = ivec2(fI0.xy);
  ivec2 loc = ivec2(gl_FragCoord.xy) - uOrigin - cell * uCellPx;
  float cov = glyphCov(int(fI0.z + 0.5), loc);
  int mode = int(fI0.w + 0.5);
  if (mode == 2) { o = vec4(fCol, cov); return; }
  vec3 bg = mode == 1 ? vec3(0.010, 0.017, 0.030) : texelFetch(uScene, cell, 0).rgb * uBgK;
  o = vec4(mix(bg, fCol, cov), 1.0);
}`;

/** Dual-Kawase bloom. */
export const FS_BLOOM_DOWN = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uPre; uniform float uThr, uKnee;
in vec2 vUv; out vec4 o;
vec3 pre(vec3 c){
  if (uPre < 0.5) return c;
  float l = max(c.r, max(c.g, c.b));
  float soft = clamp(l - uThr + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  return c * (max(soft, l - uThr) / max(l, 1e-4));
}
void main(){
  vec3 s = pre(texture(uSrc, vUv).rgb) * 4.0;
  s += pre(texture(uSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb);
  s += pre(texture(uSrc, vUv + uTexel * vec2( 1.0, -1.0)).rgb);
  s += pre(texture(uSrc, vUv + uTexel * vec2(-1.0,  1.0)).rgb);
  s += pre(texture(uSrc, vUv + uTexel * vec2( 1.0,  1.0)).rgb);
  o = vec4(s / 8.0, 1.0);
}`;
export const FS_BLOOM_UP = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uGain;
in vec2 vUv; out vec4 o;
void main(){
  vec2 h = uTexel * 0.5;
  vec3 s = texture(uSrc, vUv + vec2(-h.x * 2.0, 0.0)).rgb;
  s += texture(uSrc, vUv + vec2(-h.x,  h.y)).rgb * 2.0;
  s += texture(uSrc, vUv + vec2(0.0,  h.y * 2.0)).rgb;
  s += texture(uSrc, vUv + vec2( h.x,  h.y)).rgb * 2.0;
  s += texture(uSrc, vUv + vec2( h.x * 2.0, 0.0)).rgb;
  s += texture(uSrc, vUv + vec2( h.x, -h.y)).rgb * 2.0;
  s += texture(uSrc, vUv + vec2(0.0, -h.y * 2.0)).rgb;
  s += texture(uSrc, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
  o = vec4(s / 12.0 * uGain, 1.0);
}`;

/** Final composite: bloom + chromatic aberration + CRT curvature/scanlines + vignette + tonemap + damage flash. */
export const FS_COMPOSITE = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uScene; uniform sampler2D uBloom;
uniform vec2 uCanvas; uniform float uTime;
uniform float uBloomK, uChroma, uCurve, uScan, uVig, uFlash, uHit, uGrain;
uniform vec4 uWarp[6];     // 0-3: shock rings (uv.xy, radius in height units, strength); 4-5: heat shimmer (uv.xy, 0, strength)
in vec2 vUv; out vec4 o;
float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main(){
  vec2 uv = vUv;
  vec2 c = uv - 0.5;
  if (uCurve > 0.0) { uv = c * (1.0 + uCurve * dot(c, c) * 2.2) + 0.5; }
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float asp = uCanvas.x / uCanvas.y;
  for (int i = 0; i < 4; i++) {
    vec4 w = uWarp[i];
    if (w.w <= 0.0) continue;
    vec2 dd = (uv - w.xy) * vec2(asp, 1.0);
    float d = length(dd);
    float wave = exp(-pow((d - w.z) / 0.035, 2.0)) * w.w;
    uv += normalize(dd + 1e-5) / vec2(asp, 1.0) * wave * 0.012;
  }
  for (int i = 4; i < 6; i++) {
    vec4 w = uWarp[i];
    if (w.w <= 0.0) continue;
    vec2 dd = (uv - w.xy) * vec2(asp, 1.0);
    float f = exp(-dot(dd, dd) / 0.0016) * w.w;
    uv += vec2(sin(uv.y * 420.0 + uTime * 33.0), cos(uv.x * 310.0 + uTime * 29.0)) * 0.0016 * f;
  }
  vec2 cc = uv - 0.5;
  vec2 off = cc * dot(cc, cc) * uChroma;
  vec3 col;
  col.r = texture(uScene, uv + off).r;
  col.g = texture(uScene, uv).g;
  col.b = texture(uScene, uv - off).b;
  col += texture(uBloom, uv).rgb * uBloomK;
  float row = gl_FragCoord.y;
  col *= 1.0 - uScan * (0.5 + 0.5 * sin(row * 3.14159265));
  float vig = 1.0 - uVig * smoothstep(0.25, 0.95, length(cc) * 1.35);
  col *= vig;
  col += vec3(1.0, 0.95, 0.85) * uFlash * 0.35;
  col = mix(col, col * vec3(1.4, 0.55, 0.55) + vec3(0.12, 0.0, 0.0), uHit * smoothstep(0.1, 0.8, length(cc) * 1.4) * 0.7);
  col = 1.0 - exp(-col * 1.25);                       // soft filmic shoulder
  col = pow(col, vec3(0.93));
  col += (h12(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5) * uGrain;
  o = vec4(col, 1.0);
}`;
