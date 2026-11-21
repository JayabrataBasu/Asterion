import { NOISE } from './shaders';

/** Sub-samples per cell used by the sprite layer and the glyph matcher (must match glyph signature grid). */
export const SPR_X = 4;
export const SPR_Y = 8;

/** Instanced SDF sprites rendered at SPR_X x SPR_Y samples per character cell. */
export const VS_SPRITE = `#version 300 es
in vec2 aC; in vec4 aA; in vec4 aB; in vec4 aT;
uniform vec2 uRes; uniform vec2 uCam; uniform float uAspect;
out vec2 vOff; flat out vec4 fB; flat out vec4 fT; flat out vec2 fRot;
void main(){
  vec2 off = aC * aA.w;
  vec2 w = aA.xy + off;
  vec2 cc = (w - uCam) / vec2(1.0, uAspect) + uRes * 0.5;
  gl_Position = vec4(cc / uRes * 2.0 - 1.0, 0.0, 1.0);
  vOff = off; fB = aB; fT = aT; fRot = vec2(cos(aA.z), sin(aA.z));
}`;

export const FS_SPRITE = `#version 300 es
precision highp float; precision highp int;
in vec2 vOff; flat in vec4 fB; flat in vec4 fT; flat in vec2 fRot;
uniform float uTime;
out vec4 o;
${NOISE}
const vec2 LW = vec2(0.568, 0.5165);
const float PX = 0.25;

float bev(float x, float b){ float t = clamp(x / b, 0.0, 1.0); return t * (2.0 - t); }
float sdSeg(vec2 p, vec2 a, vec2 b){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
float sdUneven(vec2 p, vec2 a, vec2 b, float ra, float rb){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h) - mix(ra, rb, h); }
float sdBox(vec2 p, vec2 b){ vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float sdEll(vec2 p, vec2 r){ float k0 = length(p / r), k1 = length(p / (r * r)); return k0 * (k0 - 1.0) / max(k1, 1e-5); }
float sdTri(vec2 p, vec2 p0, vec2 p1, vec2 p2){
  vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
  vec2 v0 = p - p0, v1 = p - p1, v2 = p - p2;
  vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                   vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                   vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}
mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

// ===================================================================== fields
// Each field(q) returns the silhouette distance, writes a bevelled height h (0..~1.2),
// a material flag mt (1 = flame/emissive, no lighting) and three part distances dp for material picking.

// ---- player hull state (set per instance in main): gS = ship-specific state 0..1, gP = unmirrored local position
float gS = 0.0; vec2 gP = vec2(0.0);

// ---- wren: original all-rounder. Swept delta wings with raked feather tips, canards, one engine pod per side, split tail. ~26 units
float fPlayer(vec2 q, float thr, out float h, out float mt, out vec3 dp){
  float dF = min(sdUneven(q, vec2(-9.0, 0.0), vec2(15.0, 0.0), 2.0, 0.15), sdEll(q - vec2(-3.0, 0.0), vec2(6.0, 2.3)));
  float dW = min(sdTri(q, vec2(4.0, 1.4), vec2(-7.5, 10.5), vec2(-6.5, 1.4)) - 0.15, sdSeg(q, vec2(-7.5, 10.5), vec2(-3.5, 11.6)) - 0.35);
  float dC = sdTri(q, vec2(9.5, 1.0), vec2(5.5, 3.8), vec2(5.0, 1.0));
  float dN = min(sdBox(q - vec2(-8.6, 2.6), vec2(2.0, 1.25)) - 0.3, sdSeg(q, vec2(-7.5, 0.9), vec2(-12.0, 4.4)) - 0.45);
  float dH = min(min(dF, dW), min(dC, dN));
  float L = 1.2 + 9.0 * thr;
  float dFl = sdUneven(q, vec2(-10.9, 2.6), vec2(-10.9 - L, 2.6), 0.95, 0.03);
  h = max(max(bev(-dF, 1.8), bev(-dW, 0.6) * 0.5), max(bev(-dN, 1.0) * 0.85, bev(-dC, 0.5) * 0.6));
  dp = vec3(dF, min(dW, dC), dN);
  mt = dFl < dH ? 1.0 : 0.0;
  return min(dH, dFl);
}

// ---- needle: interceptor dart, one spine, swept fins, very light, long bright tail
float fNeedle(vec2 q, float thr, out float h, out float mt, out vec3 dp){
  float dS = sdUneven(q, vec2(-11.0, 0.0), vec2(15.0, 0.0), 1.15, 0.05);
  float dF = sdTri(q, vec2(-1.5, 0.6), vec2(-10.0, 6.5), vec2(-7.5, 0.6)) - 0.05;
  float dC = sdTri(q, vec2(7.0, 0.5), vec2(3.5, 2.6), vec2(3.0, 0.5));
  float dE = sdBox(q - vec2(-11.5, 0.0), vec2(1.3, 0.85)) - 0.2;
  float dH = min(min(dS, dF), min(dC, dE));
  float L = 3.0 + 16.0 * thr;
  float dFl = sdUneven(q, vec2(-12.8, 0.0), vec2(-12.8 - L, 0.0), 0.8, 0.02);
  h = max(max(bev(-dS, 1.1), bev(-dF, 0.4) * 0.4), max(bev(-dC, 0.4) * 0.4, bev(-dE, 0.8) * 0.7));
  dp = vec3(dS, min(dF, dC), dE);
  mt = dFl < dH ? 1.0 : 0.0;
  return min(dH, dFl);
}

// ---- anvil: squat armoured wedge, side sponsons, four forward barrels
float fAnvil(vec2 q, float thr, out float h, out float mt, out vec3 dp){
  float dB = min(sdBox(q - vec2(-2.5, 0.0), vec2(6.5, 5.2)) - 0.6, sdTri(q, vec2(9.0, 0.0), vec2(3.0, 5.8), vec2(3.0, 0.0)));
  float dP = sdBox(q - vec2(-1.0, 6.4), vec2(5.5, 1.3)) - 0.3;
  float dBr = min(sdSeg(q, vec2(4.0, 1.1), vec2(13.5, 1.1)) - 0.45, sdSeg(q, vec2(2.5, 3.4), vec2(12.0, 3.4)) - 0.5);
  float dE = sdBox(q - vec2(-10.0, 3.0), vec2(1.6, 1.8)) - 0.3;
  float dH = min(min(dB, dP), min(dBr, dE));
  float L = 1.0 + 6.0 * thr;
  float dFl = sdUneven(q, vec2(-11.9, 3.0), vec2(-11.9 - L, 3.0), 1.2, 0.04);
  h = max(max(bev(-dB, 2.4) * 1.1, bev(-dP, 1.0) * 0.9), max(bev(-dBr, 0.45) * 0.8, bev(-dE, 1.0) * 0.8));
  dp = vec3(dB, dBr, min(dP, dE));
  mt = dFl < dH ? 1.0 : 0.0;
  return min(dH, dFl);
}

// ---- sextant: kite hull, long tail boom, lens core; sensor petals unfold while scanning (gS)
float fSext(vec2 q, float thr, out float h, out float mt, out vec3 dp){
  float dK = sdTri(q, vec2(9.0, 0.0), vec2(0.5, 6.5), vec2(-6.0, 0.0)) - 0.2;
  float dBm = min(sdSeg(q, vec2(-5.0, 0.0), vec2(-16.0, 0.0)) - 0.55, sdTri(q, vec2(-13.0, 0.4), vec2(-17.0, 3.6), vec2(-16.5, 0.4)));
  float dL = length(q - vec2(1.5, 0.0)) - 2.4;
  float dPt = 1e3;
  if (gS > 0.01) for (int i = 0; i < 3; i++) {
    float a = 0.7 + float(i) * 0.75; vec2 dir = vec2(cos(a), sin(a));
    dPt = min(dPt, sdUneven(q, vec2(1.5, 0.0) + dir * 2.0, vec2(1.5, 0.0) + dir * (2.5 + 7.0 * gS), 0.9 * gS + 0.2, 0.1));
  }
  float dE = sdBox(q - vec2(-6.5, 1.6), vec2(1.2, 0.9)) - 0.2;
  float dH = min(min(dK, dBm), min(min(dL, dPt), dE));
  float L = 1.0 + 6.0 * thr;
  float dFl = sdUneven(q, vec2(-7.9, 1.6), vec2(-7.9 - L, 1.6), 0.75, 0.03);
  h = max(max(bev(-dK, 2.0), bev(-dBm, 0.5) * 0.6), max(bev(-dL, 2.4) * 1.3, bev(-dPt, 0.4) * 0.5));
  dp = vec3(dK, min(dL, dPt), min(dBm, dE));
  mt = dFl < dH ? 1.0 : 0.0;
  return min(dH, dFl);
}

// ---- mule: catamaran hauler, two hulls joined by a container lattice; containers shown = hold fill (gS); rear turret
float fMule(vec2 q, float thr, out float h, out float mt, out vec3 dp){
  float dHu = sdUneven(q, vec2(-12.0, 6.2), vec2(12.0, 6.2), 2.0, 1.0);
  float dLat = abs(sdBox(q, vec2(8.6, 4.6))) - 0.3;
  dLat = min(dLat, sdSeg(q, vec2(-8.6, 0.0), vec2(8.6, 0.0)) - 0.25);
  for (int i = 0; i < 3; i++) dLat = min(dLat, sdSeg(q, vec2(-4.3 + float(i) * 4.3, 0.0), vec2(-4.3 + float(i) * 4.3, 4.6)) - 0.25);
  float n = floor(gS * 8.0 + 0.5), side = gP.y >= 0.0 ? 0.0 : 4.0, dCt = 1e3;
  for (int i = 0; i < 4; i++) if (float(i) + side < n) dCt = min(dCt, sdBox(q - vec2(-6.45 + float(i) * 4.3, 2.3), vec2(1.75, 1.85)) - 0.15);
  float dT = min(length(q - vec2(-10.0, 0.0)) - 1.8, sdSeg(q, vec2(-10.0, 0.0), vec2(-13.5, 0.6)) - 0.4);
  float dE = sdBox(q - vec2(-12.8, 6.2), vec2(1.3, 1.4)) - 0.2;
  float dH = min(min(dHu, dLat), min(min(dCt, dT), dE));
  float L = 1.0 + 5.0 * thr;
  float dFl = sdUneven(q, vec2(-14.3, 6.2), vec2(-14.3 - L, 6.2), 1.0, 0.04);
  h = max(max(bev(-dHu, 2.0), bev(-dLat, 0.3) * 0.5), max(bev(-dCt, 0.8) * 0.9, bev(-dT, 1.2) * 1.1));
  dp = vec3(dHu, dCt, min(dLat, min(dT, dE)));
  mt = dFl < dH ? 1.0 : 0.0;
  return min(dH, dFl);
}

// ---- shade: flat chevron manta, very low glyph density, fades out while running dark (gS)
float fShade(vec2 q, float thr, out float h, out float mt, out vec3 dp){
  float dW = max(sdTri(q, vec2(9.0, 0.0), vec2(-7.0, 11.5), vec2(-7.0, 0.0)), -sdTri(q, vec2(-2.5, 0.0), vec2(-8.5, 8.0), vec2(-8.5, 0.0)));
  float dSp = sdSeg(q, vec2(-6.5, 10.8), vec2(-10.5, 12.5)) - 0.25;
  float dC = sdEll(q - vec2(2.0, 0.0), vec2(4.0, 1.4));
  float dH = min(min(dW, dSp), dC);
  float L = 0.8 + 4.0 * thr;
  float dFl = sdUneven(q, vec2(-3.0, 1.2), vec2(-3.0 - L, 1.2), 0.6, 0.02);
  h = max(bev(-dW, 1.2) * 0.45, bev(-dC, 1.0) * 0.8);
  dp = vec3(dC, dW, dSp);
  mt = dFl < dH ? 1.0 : 0.0;
  return min(dH, dFl);
}

// ---- magpie: asymmetric patchwork salvager with one articulated grabber arm (gS = reach 0..1). Not mirrored.
float fMagpie(vec2 q, float thr, out float h, out float mt, out vec3 dp){
  float dB = min(sdBox(q - vec2(-0.5, 0.3), vec2(7.0, 3.3)) - 0.5, sdTri(q, vec2(10.5, 0.6), vec2(6.0, 3.4), vec2(6.0, -2.4)));
  float dPa = min(sdBox(q - vec2(-2.5, -4.1), vec2(4.2, 1.5)) - 0.3, sdBox(q - vec2(2.5, 4.2), vec2(2.6, 1.0)) - 0.25);
  vec2 sh = vec2(3.5, 4.8), el = sh + vec2(2.0 + 4.0 * gS, 2.0 + 1.5 * gS), cl = el + vec2(3.0 + 6.0 * gS, -1.0 - 2.5 * gS);
  float dA = min(sdSeg(q, sh, el) - 0.45, sdSeg(q, el, cl) - 0.35);
  float dCl = abs(length(q - cl) - 1.2) - 0.3;
  float dE = min(sdBox(q - vec2(-8.6, 1.6), vec2(1.3, 1.1)) - 0.2, sdBox(q - vec2(-8.0, -3.4), vec2(1.0, 0.9)) - 0.2);
  float dH = min(min(dB, dPa), min(min(dA, dCl), dE));
  float L = 0.8 + 5.0 * thr;
  float dFl = min(sdUneven(q, vec2(-10.0, 1.6), vec2(-10.0 - L, 1.6), 0.8, 0.03), sdUneven(q, vec2(-9.1, -3.4), vec2(-9.1 - L * 0.8, -3.4), 0.65, 0.03));
  h = max(max(bev(-dB, 2.0), bev(-dPa, 1.0) * 0.8), max(bev(-min(dA, dCl), 0.4) * 0.7, bev(-dE, 0.8) * 0.7));
  dp = vec3(dB, dPa, min(min(dA, dCl), dE));
  mt = dFl < dH ? 1.0 : 0.0;
  return min(dH, dFl);
}

// ---- hive: hex-cell cluster of pods; rear bays iris open (gS) to release drones
float sdHex(vec2 p, float r){ const vec3 k = vec3(-0.866025404, 0.5, 0.577350269); p = abs(p); p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy; p -= vec2(clamp(p.x, -k.z * r, k.z * r), r); return length(p) * sign(p.y); }
float hivePods(vec2 q){
  float d = sdHex(q, 2.6);
  d = min(d, sdHex(q - vec2(5.0, 0.0), 2.6)); d = min(d, sdHex(q - vec2(-5.0, 0.0), 2.6));
  d = min(d, sdHex(q - vec2(2.5, 4.33), 2.6)); d = min(d, sdHex(q - vec2(-2.5, 4.33), 2.6)); d = min(d, sdHex(q - vec2(-7.5, 4.33), 2.2));
  return d;
}
float fHive(vec2 q, float thr, out float h, out float mt, out vec3 dp){
  float dC = hivePods(q) - 0.3;
  float dE = sdBox(q - vec2(-10.0, 1.6), vec2(1.4, 1.2)) - 0.2;
  float dH = min(dC, dE);
  float L = 0.8 + 4.0 * thr;
  float dFl = sdUneven(q, vec2(-11.6, 1.6), vec2(-11.6 - L, 1.6), 0.9, 0.04);
  h = max(bev(-dC, 1.6) * 1.1, bev(-dE, 0.8) * 0.7);
  dp = vec3(dC, dE, dC + 0.4);
  mt = dFl < dH ? 1.0 : 0.0;
  return min(dH, dFl);
}

// ---- derelict capital hull (set piece): ~230 units of broken plating with a few lit windows. Ship stays tiny beside it.
float fDerelict(vec2 q, float thr, out float h, out float mt, out vec3 dp){
  float dB = min(sdBox(q - vec2(-6.0, 0.0), vec2(88.0, 10.0)) - 1.0, sdTri(q, vec2(112.0, 0.0), vec2(80.0, 10.5), vec2(80.0, 0.0)));
  float dS = sdBox(q - vec2(-28.0, 12.5), vec2(34.0, 4.0)) - 0.6;
  float dT = sdBox(q - vec2(10.0, 15.0), vec2(6.0, 4.5)) - 0.4;
  float dE = sdBox(q - vec2(-100.0, 0.0), vec2(9.0, 13.0)) - 0.8;
  float dH = min(min(dB, dS), min(dT, dE));
  float gap = sdBox(q - vec2(32.0 + 3.0 * sin(q.y * 0.9), 0.0), vec2(2.5, 20.0));       // the hull is broken in two
  dH = max(dH, -gap);
  h = max(max(bev(-dB, 4.0), bev(-dS, 2.0) * 1.2), max(bev(-dT, 1.5) * 1.3, bev(-dE, 3.0)));
  dp = vec3(dB, dS, min(dT, dE));
  mt = 0.0;
  return dH;
}

// ---- wingman drone (Hive): tiny friendly dart
float fWing(vec2 q, float thr, out float h, out float mt, out vec3 dp){
  float dB = sdTri(q, vec2(3.5, 0.0), vec2(-2.5, 2.4), vec2(-1.5, 0.0));
  h = bev(-dB, 0.8); dp = vec3(dB, 1e3, 1e3); mt = 0.0;
  return dB;
}

// ---- drone: insectoid scout, ~14 units
float fDrone(vec2 q, float thr, out float h, out float mt, out vec3 dp){
  float dC = length(q) - 2.3;
  float dA = min(sdSeg(q, vec2(1.6, 1.3), vec2(6.0, 3.8)) - 0.6, sdSeg(q, vec2(6.0, 3.8), vec2(9.0, 1.8)) - 0.4);
  float dB = min(sdSeg(q, vec2(-0.8, 1.8), vec2(-4.2, 4.6)) - 0.45, sdSeg(q, vec2(-1.8, 0.0), vec2(-6.5, 0.0)) - 0.55);
  float dT = sdSeg(q, vec2(-4.2, 4.6), vec2(-6.2, 4.0)) - 0.35;
  float dH = min(dC, min(dA, min(dB, dT)));
  h = max(bev(-dC, 2.3) * 1.1, max(bev(-dA, 0.6) * 0.7, bev(-dB, 0.5) * 0.6));
  dp = vec3(dC, dA, dB);
  mt = 0.0;
  return dH;
}

// ---- gunship: heavy twin-cannon wedge, ~32 units
float fGun(vec2 q, float thr, out float h, out float mt, out vec3 dp){
  float dB = min(sdBox(q - vec2(-1.5, 0.0), vec2(8.5, 3.0)) - 0.5, sdTri(q, vec2(7.0, 3.5), vec2(15.0, 0.0), vec2(7.0, 0.0)));
  float dBr = sdEll(q - vec2(1.0, 0.0), vec2(4.2, 2.1));
  float dP = sdBox(q - vec2(-0.5, 6.2), vec2(6.8, 1.8)) - 0.4;
  float dS = sdBox(q - vec2(-3.0, 4.2), vec2(0.9, 1.6));
  float dC = sdSeg(q, vec2(6.0, 6.2), vec2(17.0, 6.2)) - 0.5;
  float dR = sdBox(q - vec2(-11.0, 2.0), vec2(2.4, 3.4)) - 0.3;
  float dH = min(min(min(dB, dP), min(dC, dR)), dS);
  float L = 1.0 + 7.0 * thr;
  float dFl = min(sdUneven(q, vec2(-13.4, 0.0), vec2(-13.4 - L, 0.0), 1.1, 0.03), sdUneven(q, vec2(-13.4, 3.4), vec2(-13.4 - L * 0.8, 3.4), 0.9, 0.03));
  h = max(max(bev(-dB, 1.8), bev(-dBr, 1.0) * 1.25), max(max(bev(-dP, 1.2) * 0.75, bev(-dC, 0.4) * 0.8), bev(-dR, 1.0) * 0.9));
  dp = vec3(dB, dP, dR);
  mt = dFl < dH ? 1.0 : 0.0;
  return min(dH, dFl);
}

// ---- minelayer: bulbous hauler with mine racks, ~26 units
float fMine(vec2 q, float thr, out float h, out float mt, out vec3 dp){
  float dB = sdEll(q, vec2(9.5, 4.5));
  float dRk = length(q - vec2(-2.0, 5.8)) - 2.7;
  float dD = abs(length(q - vec2(9.6, 0.0)) - 2.4) - 0.5;
  float dE = sdBox(q - vec2(-10.5, 0.0), vec2(2.0, 2.8)) - 0.3;
  float dH = min(min(dB, dRk), min(dD, dE));
  h = max(max(bev(-dB, 2.4) * 1.0, bev(-dRk, 1.4) * 0.8), max(bev(-dD, 0.5) * 0.9, bev(-dE, 1.0) * 0.8));
  dp = vec3(dB, dRk, dE);
  mt = 0.0;
  return dH;
}

// ---- ring station: p unfolded, slowly rotating, ~44 units
float fStation(vec2 p, float t, out float h, out float mt, out vec3 dp){
  vec2 pr = rot(t * 0.12) * p;
  float r = length(p);
  float dRing = abs(r - 15.5) - 1.9;
  float dHub = r - 5.0;
  float a = atan(pr.y, pr.x);
  float ak = mod(a + 0.7853982, 1.5707963) - 0.7853982;
  vec2 ps = length(pr) * vec2(cos(ak), sin(ak));
  float dSp = sdBox(ps - vec2(10.0, 0.0), vec2(5.4, 0.55));
  vec2 pa = abs(p);
  float dArm = min(sdBox(pa - vec2(0.0, 22.0), vec2(1.0, 2.0)), sdBox(pa - vec2(22.0, 0.0), vec2(2.0, 1.0)));
  float dSolar = min(sdBox(pa - vec2(0.0, 19.5), vec2(7.0, 0.5)), sdBox(pa - vec2(19.5, 0.0), vec2(0.5, 5.0)));
  float d = min(min(dRing, dHub), min(min(dSp, dArm), dSolar));
  h = max(max(bev(-dRing, 1.6) * 0.9, bev(-dHub, 2.4) * 1.3), max(bev(-dSp, 0.5) * 0.6, bev(-dArm, 0.8) * 0.8));
  h = max(h, bev(-dSolar, 0.4) * 0.25);
  dp = vec3(dRing, dHub, dSolar);
  mt = 0.0;
  return d;
}

// ---- dreadnought (boss): crimson capital ship with twin gun pods, ~46 units
float fBoss(vec2 q, float thr, out float h, out float mt, out vec3 dp){
  float dB = sdUneven(q, vec2(-19.0, 0.0), vec2(21.0, 0.0), 7.0, 1.6);
  float dT = sdBox(q - vec2(-5.0, 0.0), vec2(5.5, 3.0)) - 0.6;
  float dP = sdBox(q - vec2(-6.0, 10.5), vec2(12.0, 2.4)) - 0.6;
  float dSt = sdSeg(q, vec2(-6.0, 5.0), vec2(-6.0, 10.5)) - 1.3;
  float dBar = min(sdSeg(q, vec2(5.0, 10.5), vec2(24.0, 10.5)) - 0.75, sdSeg(q, vec2(9.0, 2.6), vec2(22.0, 2.6)) - 0.55);
  float dE = sdBox(q - vec2(-23.0, 3.6), vec2(3.2, 3.2)) - 0.4;
  float dE2 = sdBox(q - vec2(-23.5, 0.0), vec2(2.8, 2.0)) - 0.3;
  float dH = min(min(min(dB, dT), min(dP, dSt)), min(dBar, min(dE, dE2)));
  float L = 2.0 + 11.0 * thr;
  float dFl = min(sdUneven(q, vec2(-26.0, 3.6), vec2(-26.0 - L, 3.6), 2.2, 0.05), sdUneven(q, vec2(-26.0, 0.0), vec2(-26.0 - L * 0.8, 0.0), 1.8, 0.05));
  h = max(max(bev(-dB, 6.0) * 1.0, bev(-dT, 2.2) * 1.5), max(max(bev(-dP, 1.8) * 0.8, bev(-dBar, 0.7) * 0.9), bev(-min(dE, dE2), 1.2) * 0.9));
  dp = vec3(dB, dP, min(dE, dE2));
  mt = dFl < dH ? 1.0 : 0.0;
  return min(dH, dFl);
}

// ---- sniper: long-barrel railship, ~24 units
float fSniper(vec2 q, float thr, out float h, out float mt, out vec3 dp){
  float dB = sdUneven(q, vec2(-7.0, 0.0), vec2(7.0, 0.0), 2.0, 0.8);
  float dBr = sdSeg(q, vec2(3.0, 0.0), vec2(16.0, 0.0)) - 0.5;
  float dF = sdTri(q, vec2(-3.0, 1.5), vec2(-9.0, 6.0), vec2(-9.5, 1.5));
  float dS = sdEll(q - vec2(1.0, 1.4), vec2(3.0, 1.0));
  float dE = sdBox(q - vec2(-9.0, 2.3), vec2(2.0, 1.1)) - 0.3;
  float dH = min(min(dB, dBr), min(dF, min(dS, dE)));
  float L = 1.0 + 6.0 * thr;
  float dFl = sdUneven(q, vec2(-11.0, 2.3), vec2(-11.0 - L, 2.3), 0.8, 0.03);
  h = max(max(bev(-dB, 2.0) * 1.0, bev(-dBr, 0.5) * 0.8), max(bev(-dF, 0.8) * 0.5, max(bev(-dS, 0.9) * 0.9, bev(-dE, 0.9) * 0.8)));
  dp = vec3(dB, dF, dE);
  mt = dFl < dH ? 1.0 : 0.0;
  return min(dH, dFl);
}

// ---- splitter: twin-lobed brood pod, ~14 units
float fSplit(vec2 q, float thr, out float h, out float mt, out vec3 dp){
  float dL = length(q - vec2(2.2, 2.4)) - 3.0;
  float dC = sdEll(q, vec2(4.8, 2.4));
  float dT = sdSeg(q, vec2(-3.0, 1.4), vec2(-6.5, 3.4)) - 0.5;
  float dH = min(min(dL, dC), dT);
  float L = 0.8 + 4.0 * thr;
  float dFl = sdUneven(q, vec2(-5.0, 0.6), vec2(-5.0 - L, 0.6), 0.7, 0.03);
  h = max(max(bev(-dL, 2.6) * 1.1, bev(-dC, 2.0) * 0.8), bev(-dT, 0.5) * 0.6);
  dp = vec3(dL, dC, dT);
  mt = dFl < dH ? 1.0 : 0.0;
  return min(dH, dFl);
}

// ---- rammer: armoured dart, ~15 units
float fRam(vec2 q, float thr, out float h, out float mt, out vec3 dp){
  float dB = sdTri(q, vec2(8.5, 0.0), vec2(-5.5, 3.6), vec2(-5.5, 0.0));
  float dE = sdBox(q - vec2(-6.2, 1.2), vec2(1.6, 1.5)) - 0.3;
  float dN = sdSeg(q, vec2(5.5, 0.0), vec2(10.5, 0.0)) - 0.7;
  float dH = min(min(dB, dE), dN);
  float L = 1.0 + 6.0 * thr;
  float dFl = sdUneven(q, vec2(-8.0, 1.2), vec2(-8.0 - L, 1.2), 0.9, 0.03);
  h = max(max(bev(-dB, 2.2) * 1.0, bev(-dE, 1.0) * 0.8), bev(-dN, 0.6) * 0.9);
  dp = vec3(dB, dE, dN);
  mt = dFl < dH ? 1.0 : 0.0;
  return min(dH, dFl);
}

// ---- tender: medical support hull, ~20 units
float fTend(vec2 q, float thr, out float h, out float mt, out vec3 dp){
  float dB = sdEll(q - vec2(0.0, 0.0), vec2(8.0, 4.4));
  float dA = sdSeg(q, vec2(4.0, 3.0), vec2(8.5, 6.5)) - 0.4;
  float dD = abs(length(q - vec2(8.8, 6.9)) - 1.6) - 0.35;
  float dE = sdBox(q - vec2(-8.6, 1.8), vec2(1.6, 1.6)) - 0.3;
  float dH = min(min(dB, dA), min(dD, dE));
  float L = 0.8 + 4.0 * thr;
  float dFl = sdUneven(q, vec2(-10.2, 1.8), vec2(-10.2 - L, 1.8), 0.8, 0.03);
  h = max(max(bev(-dB, 4.0) * 1.0, bev(-dA, 0.4) * 0.6), max(bev(-dD, 0.5) * 0.7, bev(-dE, 1.0) * 0.8));
  dp = vec3(dB, dD, dE);
  mt = dFl < dH ? 1.0 : 0.0;
  return min(dH, dFl);
}

float field(int ty, vec2 q, float thr, out float h, out float mt, out vec3 dp){
  if (ty == 0) return fPlayer(q, thr, h, mt, dp);
  if (ty == 1) return fDrone(q, thr, h, mt, dp);
  if (ty == 2) return fGun(q, thr, h, mt, dp);
  if (ty == 3) return fMine(q, thr, h, mt, dp);
  if (ty == 9) return fBoss(q, thr, h, mt, dp);
  if (ty == 10) return fSniper(q, thr, h, mt, dp);
  if (ty == 11) return fSplit(q, thr, h, mt, dp);
  if (ty == 12) return fRam(q, thr, h, mt, dp);
  if (ty == 13) return fTend(q, thr, h, mt, dp);
  if (ty == 14) return fNeedle(q, thr, h, mt, dp);
  if (ty == 15) return fAnvil(q, thr, h, mt, dp);
  if (ty == 16) return fSext(q, thr, h, mt, dp);
  if (ty == 17) return fMule(q, thr, h, mt, dp);
  if (ty == 18) return fShade(q, thr, h, mt, dp);
  if (ty == 19) return fMagpie(q, thr, h, mt, dp);
  if (ty == 20) return fHive(q, thr, h, mt, dp);
  if (ty == 21) return fWing(q, thr, h, mt, dp);
  if (ty == 22) return fDerelict(q, thr, h, mt, dp);
  return fStation(q, thr, h, mt, dp);
}

// ===================================================================== painting
float panel(float x, float w){ return smoothstep(w, 0.0, abs(fract(x) - 0.5) - (0.5 - w)); }

vec3 paint(int ty, vec2 q, vec2 p, vec3 dp, float h, float thr, float seed, out vec3 emis, out float spec){
  emis = vec3(0.0); spec = 0.35;
  float blink = 0.5 + 0.5 * sin(uTime * 5.0 + seed * 20.0);
  vec3 col;
  if (ty == 0) {                       // wren: cream hull, grey wings, mint accent (the player's colour)
    vec3 hullC = vec3(0.90, 0.90, 0.86), wingC = vec3(0.70, 0.72, 0.76), nacC = vec3(0.46, 0.48, 0.52), mint = vec3(0.20, 0.95, 0.70);
    float m = min(dp.x, min(dp.y, dp.z));
    col = m == dp.x ? hullC : (m == dp.y ? wingC : nacC);
    if (m == dp.y) { col = mix(col, mint, smoothstep(0.55, 0.25, abs(q.y - (1.4 + (4.0 - q.x) * 0.79)))); col *= 1.0 - 0.22 * panel(q.x * 0.35, 0.06); }
    if (m == dp.x) { col *= 1.0 - 0.22 * panel(q.x * 0.28 + 0.1, 0.05); col = mix(col, mint, smoothstep(0.3, 0.12, abs(q.y - 1.1)) * step(-4.0, q.x) * step(q.x, 6.0)); }
    float dc = sdEll(vec2(q.x, p.y) - vec2(3.0, 0.0), vec2(3.2, 1.0));
    float glass = smoothstep(0.1, -0.1, dc);
    col = mix(col, vec3(0.04, 0.20, 0.30) + vec3(0.4, 1.0, 0.9) * smoothstep(0.15, 0.9, -dc) * 0.45, glass);
    emis += glass * vec3(0.04, 0.26, 0.22) * (0.6 + 0.4 * blink) * 0.6;
    emis += smoothstep(1.0, 0.0, length((q - vec2(-10.7, 2.6)) / vec2(0.9, 1.0))) * mix(vec3(1.4, 0.7, 0.25), vec3(0.8, 1.3, 2.0), clamp(thr - 0.9, 0.0, 1.0)) * (0.35 + thr);
    emis += smoothstep(0.7, 0.0, length(q - vec2(-3.5, 11.6))) * (p.y > 0.0 ? vec3(2.0, 0.2, 0.15) : vec3(0.2, 2.0, 0.4)) * blink * 1.5;
    emis += smoothstep(0.8, 0.0, length(q - vec2(15.0, 0.0))) * mint * 1.4;
    spec = m == dp.x ? 0.7 : 0.3;
  } else if (ty == 14) {               // needle: dim silver (light glyph mass), bright spine and tip
    float m = min(dp.x, min(dp.y, dp.z));
    col = m == dp.x ? vec3(0.42, 0.46, 0.54) : (m == dp.y ? vec3(0.30, 0.34, 0.42) : vec3(0.24, 0.24, 0.28));
    col = mix(col, vec3(0.75, 0.85, 1.0), smoothstep(0.35, 0.1, abs(q.y)) * step(-9.0, q.x) * step(q.x, 12.0) * 0.6);
    emis += smoothstep(0.9, 0.0, length(q - vec2(14.5, 0.0))) * vec3(0.5, 1.4, 2.0) * (0.6 + 0.4 * blink);
    emis += smoothstep(1.0, 0.0, length((q - vec2(-12.6, 0.0)) / vec2(0.8, 1.0))) * vec3(1.0, 1.4, 2.2) * (0.4 + thr);
    spec = 0.8;
  } else if (ty == 15) {               // anvil: bright gunmetal plating rows (heavy glyphs), hazard stripes, per-barrel muzzle flash
    float m = min(dp.x, min(dp.y, dp.z));
    col = m == dp.x ? vec3(0.62, 0.60, 0.58) : (m == dp.y ? vec3(0.30, 0.30, 0.33) : vec3(0.48, 0.44, 0.38));
    col *= 1.0 - 0.35 * panel(q.x * 0.55, 0.07) - 0.25 * panel(q.y * 0.6 + 0.25, 0.07);
    col = mix(col, vec3(0.95, 0.62, 0.10), step(0.5, fract((q.x + q.y) * 0.5)) * smoothstep(0.6, 0.3, abs(q.y - 6.4)) * step(m, dp.z + 0.001));
    emis += smoothstep(0.6, 0.2, abs(q.x - 5.0)) * smoothstep(0.5, 0.2, abs(q.y - 2.2)) * vec3(1.6, 0.2, 0.1) * (0.5 + 0.5 * blink);
    if (gS > 0.0) { float lat = gS * 10.0 - 5.0; vec2 tip = vec2(abs(lat) < 2.0 ? 13.5 : 12.0, lat); emis += smoothstep(1.8, 0.0, length(p - tip)) * vec3(2.6, 1.8, 0.7) * 1.5; }
    emis += smoothstep(1.2, 0.0, length((q - vec2(-11.7, 3.0)) / vec2(1.0, 1.3))) * vec3(1.6, 0.6, 0.2) * (0.4 + thr);
    spec = 0.45;
  } else if (ty == 16) {               // sextant: pale teal kite, glass lens that pulses while scanning, gold petals
    float m = min(dp.x, min(dp.y, dp.z));
    col = m == dp.x ? vec3(0.70, 0.84, 0.84) : (m == dp.y ? vec3(0.90, 0.80, 0.50) : vec3(0.40, 0.48, 0.50));
    col *= 1.0 - 0.2 * panel(q.x * 0.4, 0.05);
    float lens = length(q - vec2(1.5, 0.0));
    float pulse = 0.5 + 0.5 * sin(uTime * (3.0 + 6.0 * gS));
    col = mix(col, vec3(0.04, 0.16, 0.28), smoothstep(2.4, 2.0, lens));
    emis += smoothstep(2.2, 0.0, lens) * vec3(0.3, 1.2, 1.6) * (0.35 + gS * 1.4 * pulse);
    emis += smoothstep(0.35, 0.0, abs(lens - 2.2)) * vec3(0.8, 1.6, 1.8) * 0.4;
    emis += smoothstep(0.9, 0.0, length((q - vec2(-7.8, 1.6)) / vec2(0.8, 1.0))) * vec3(0.4, 1.2, 1.4) * (0.3 + thr);
    spec = 0.6;
  } else if (ty == 17) {               // mule: olive hulls, coloured containers, grey lattice, rear turret light
    float m = min(dp.x, min(dp.y, dp.z));
    float ci = floor((q.x + 8.6) / 4.3) + (p.y >= 0.0 ? 0.0 : 4.0);
    vec3 cc = mix(vec3(0.75, 0.38, 0.12), vec3(0.18, 0.40, 0.70), step(0.5, hash12(vec2(ci, 3.0))));
    cc = mix(cc, vec3(0.70, 0.18, 0.15), step(0.75, hash12(vec2(ci, 9.0))));
    col = m == dp.x ? vec3(0.44, 0.46, 0.32) : (m == dp.y ? cc : vec3(0.38, 0.38, 0.40));
    col *= 1.0 - 0.3 * panel(q.x * 0.5, 0.06) * (m == dp.y ? 1.0 : 0.4);
    emis += smoothstep(0.7, 0.0, length(q - vec2(-10.0, 0.0))) * vec3(1.8, 0.3, 0.2) * blink;
    emis += smoothstep(1.0, 0.0, length((q - vec2(-14.1, 6.2)) / vec2(0.9, 1.1))) * vec3(1.5, 0.7, 0.25) * (0.4 + thr);
    spec = 0.35;
  } else if (ty == 18) {               // shade: near-black violet with faint edge light
    float m = min(dp.x, min(dp.y, dp.z));
    col = m == dp.x ? vec3(0.22, 0.16, 0.32) : vec3(0.12, 0.09, 0.18);
    emis += smoothstep(0.5, 0.0, abs(dp.y + 0.3)) * vec3(0.35, 0.22, 0.75) * 0.6;
    emis += smoothstep(0.8, 0.0, length((q - vec2(-2.8, 1.2)) / vec2(0.7, 0.9))) * vec3(0.7, 0.4, 1.4) * (0.2 + thr);
    spec = 0.9;
  } else if (ty == 19) {               // magpie: rust patchwork with teal / grey panels and a yellow arm
    float m = min(dp.x, min(dp.y, dp.z));
    vec3 patchC = mix(vec3(0.25, 0.45, 0.45), vec3(0.50, 0.50, 0.52), step(0.5, hash12(floor(q * 0.35) + 7.0)));
    col = m == dp.x ? mix(vec3(0.52, 0.32, 0.20), patchC, step(0.62, hash12(floor(q * 0.3)))) : (m == dp.y ? patchC : vec3(0.82, 0.70, 0.20));
    col *= 1.0 - 0.3 * panel(q.x * 0.3 + 0.1, 0.06) - 0.2 * panel(q.y * 0.3, 0.06);
    emis += smoothstep(1.4, 0.0, length(q - (vec2(3.5, 4.8) + vec2(5.0 + 10.0 * gS, 1.0 - 1.0 * gS)))) * vec3(0.4, 1.6, 0.9) * gS;
    emis += smoothstep(0.9, 0.0, length((q - vec2(-9.8, 1.6)) / vec2(0.8, 1.0))) * vec3(1.6, 0.8, 0.3) * (0.4 + thr);
    spec = 0.35;
  } else if (ty == 20) {               // hive: honey hex pods, dark seams; rear bays glow as they iris open
    col = vec3(0.78, 0.56, 0.18) * (0.75 + 0.25 * smoothstep(0.0, -1.2, dp.x));
    col *= 1.0 - 0.6 * smoothstep(-0.5, -0.05, dp.x);
    float bay = min(length(q - vec2(-5.0, 0.0)), length(q - vec2(-7.5, 4.33)));
    col = mix(col, vec3(0.05, 0.03, 0.02), smoothstep(1.6 * gS, 1.4 * gS - 0.1, bay) * step(0.05, gS));
    emis += smoothstep(0.4, 0.0, abs(bay - 1.6 * gS)) * vec3(1.8, 0.9, 0.2) * gS;
    emis += smoothstep(0.9, 0.0, length((q - vec2(-11.4, 1.6)) / vec2(0.8, 1.0))) * vec3(1.6, 0.9, 0.3) * (0.4 + thr);
    spec = 0.4;
  } else if (ty == 22) {               // derelict: dark plating rows, scorch, tiny lit windows
    float m = min(dp.x, min(dp.y, dp.z));
    col = m == dp.x ? vec3(0.34, 0.34, 0.37) : (m == dp.y ? vec3(0.28, 0.27, 0.30) : vec3(0.22, 0.21, 0.23));
    col *= 1.0 - 0.45 * panel(q.x * 0.22, 0.06) - 0.3 * panel(q.y * 0.35 + 0.2, 0.06);
    col *= 0.6 + 0.4 * vn2(q * 0.08 + seed * 20.0);
    vec2 wc = floor(q * vec2(0.5, 0.6));
    float win = step(0.94, hash12(wc + seed * 13.0)) * step(abs(q.y), 9.0) * step(-90.0, q.x) * step(q.x, 80.0);
    emis += win * vec3(1.7, 1.25, 0.6) * (0.6 + 0.4 * sin(uTime * 0.7 + wc.x));
    emis += smoothstep(3.0, 0.0, abs(q.x - 32.0)) * vec3(0.6, 0.2, 0.05) * (0.4 + 0.3 * sin(uTime * 3.0));   // the break still glows
    spec = 0.25;
  } else if (ty == 21) {               // wingman drone: friendly mint
    col = vec3(0.30, 0.80, 0.60);
    emis += smoothstep(1.5, 0.0, length(q - vec2(-1.8, 0.0))) * vec3(0.3, 1.6, 1.0);
    spec = 0.5;
  } else if (ty == 1) {
    col = mix(vec3(0.30, 0.08, 0.12), vec3(0.55, 0.14, 0.16), smoothstep(0.0, 1.0, h));
    float eye = length(vec2(p.x - 1.1, p.y) / vec2(1.2, 1.0));
    emis += smoothstep(1.0, 0.1, eye) * vec3(2.2, 0.35, 0.25) * (0.7 + 0.5 * blink);
    float ringc = abs(length(q) - 1.5);
    col *= 1.0 - 0.35 * smoothstep(0.15, 0.0, ringc);
    emis += smoothstep(0.5, 0.0, length(q - vec2(9.0, 1.8))) * vec3(1.8, 0.5, 0.2);
  } else if (ty == 2) {
    vec3 hullC = vec3(0.50, 0.36, 0.16), podC = vec3(0.30, 0.22, 0.14), rearC = vec3(0.16, 0.14, 0.15);
    float m = min(dp.x, min(dp.y, dp.z));
    col = m == dp.x ? hullC : (m == dp.y ? podC : rearC);
    col *= 1.0 - 0.3 * panel(q.x * 0.3 + 0.2, 0.05) * (m == dp.z ? 0.0 : 1.0);
    col = mix(col, vec3(0.95, 0.65, 0.12), smoothstep(0.3, 0.1, abs(q.y - 2.3)) * step(m, dp.x + 0.001) * step(-5.0, q.x) * step(q.x, 4.0));
    float br = length(vec2(q.x - 1.0, p.y) / vec2(3.4, 1.5));
    col = mix(col, vec3(0.35, 0.12, 0.05), smoothstep(1.0, 0.8, br));
    emis += smoothstep(1.0, 0.0, br) * vec3(1.6, 0.4, 0.15) * (0.4 + 0.4 * blink);
    emis += smoothstep(0.9, 0.0, length(q - vec2(17.0, 6.2))) * vec3(2.0, 0.9, 0.3) * thr * 0.8;
    emis += (smoothstep(1.2, 0.0, length((q - vec2(-13.0, 0.0)) / vec2(1.0, 1.1))) + smoothstep(1.0, 0.0, length((q - vec2(-13.0, 3.4)) / vec2(0.9, 1.0)))) * vec3(1.6, 0.55, 0.15) * (0.4 + thr);
    spec = 0.5;
  } else if (ty == 3) {
    float m = min(dp.x, min(dp.y, dp.z));
    col = m == dp.x ? vec3(0.34, 0.16, 0.42) : (m == dp.y ? vec3(0.22, 0.14, 0.28) : vec3(0.16, 0.14, 0.18));
    col *= 1.0 - 0.3 * panel(q.x * 0.22, 0.05);
    for (int i = 0; i < 3; i++) {
      vec2 c = vec2(-4.0 + float(i) * 2.2, 5.8);
      float dm = length(q - c);
      emis += smoothstep(0.65, 0.0, dm) * vec3(1.9, 0.3, 1.5) * (0.5 + 0.5 * sin(uTime * 4.0 + float(i) * 2.0));
    }
    float dish = abs(length(q - vec2(9.6, 0.0)) - 2.4);
    col = mix(col, vec3(0.65, 0.5, 0.75), smoothstep(0.5, 0.2, dish));
    emis += smoothstep(0.9, 0.0, length(q - vec2(9.6, 0.0))) * vec3(1.2, 0.3, 1.4) * blink;
    emis += smoothstep(1.0, 0.0, length((q - vec2(-12.0, 0.0)) / vec2(0.9, 2.0))) * vec3(1.2, 0.4, 1.4) * (0.3 + thr);
  } else if (ty == 9) {
    vec3 hullC = vec3(0.34, 0.11, 0.14), podC = vec3(0.24, 0.22, 0.27), engC = vec3(0.14, 0.13, 0.16);
    float m = min(dp.x, min(dp.y, dp.z));
    col = m == dp.x ? hullC : (m == dp.y ? podC : engC);
    col *= 1.0 - 0.3 * panel(q.x * 0.16 + 0.3, 0.05) - 0.15 * panel(q.y * 0.3, 0.05);
    col = mix(col, vec3(0.95, 0.12, 0.08), smoothstep(0.5, 0.2, abs(q.y - 4.6)) * step(m, dp.x + 0.001) * step(-14.0, q.x) * step(q.x, 12.0));
    float win = step(0.5, fract(q.x * 0.9)) * smoothstep(0.7, 0.4, abs(q.y)) * step(-9.5, q.x) * step(q.x, -0.5);
    emis += win * vec3(2.0, 1.0, 0.3);
    emis += smoothstep(0.35, 0.0, abs(q.y)) * step(-16.0, q.x) * step(q.x, 18.0) * vec3(1.6, 0.2, 0.15) * (0.4 + 0.5 * blink);
    emis += (smoothstep(1.2, 0.0, length(q - vec2(24.0, 10.5))) + smoothstep(1.0, 0.0, length(q - vec2(22.0, 2.6)))) * vec3(2.2, 0.8, 0.25) * (0.5 + 0.9 * blink);
    emis += (smoothstep(1.8, 0.0, length((q - vec2(-26.0, 3.6)) / vec2(1.0, 1.4))) + smoothstep(1.5, 0.0, length((q - vec2(-26.0, 0.0)) / vec2(1.0, 1.4)))) * vec3(1.8, 0.7, 0.25) * (0.4 + thr);
    spec = 0.6;
  } else if (ty == 11) {
    float m = min(dp.x, min(dp.y, dp.z));
    col = m == dp.x ? vec3(0.62, 0.46, 0.10) : (m == dp.y ? vec3(0.40, 0.30, 0.08) : vec3(0.22, 0.18, 0.10));
    col *= 1.0 - 0.3 * panel(q.x * 0.4, 0.06);
    emis += smoothstep(0.9, 0.0, length(q - vec2(2.2, 2.4))) * vec3(2.0, 1.2, 0.2) * (0.5 + 0.6 * blink);
    emis += smoothstep(0.35, 0.0, abs(q.x - 4.6)) * smoothstep(1.4, 0.0, q.y) * vec3(2.0, 0.6, 0.1);
    spec = 0.4;
  } else if (ty == 12) {
    float m = min(dp.x, min(dp.y, dp.z));
    col = m == dp.x ? vec3(0.45, 0.14, 0.10) : (m == dp.y ? vec3(0.20, 0.18, 0.20) : vec3(0.85, 0.80, 0.70));
    col = mix(col, vec3(0.95, 0.75, 0.15), smoothstep(0.25, 0.1, abs(q.y - 1.7)) * step(m, dp.x + 0.001) * step(-3.0, q.x) * step(q.x, 4.0));
    emis += smoothstep(1.2, 0.0, length(q - vec2(10.5, 0.0))) * vec3(2.4, 0.7, 0.2) * (0.6 + 0.8 * blink);
    emis += smoothstep(0.9, 0.0, length((q - vec2(-7.8, 1.2)) / vec2(0.8, 1.0))) * vec3(1.8, 0.9, 0.3) * (0.4 + thr);
    spec = 0.5;
  } else if (ty == 13) {
    float m = min(dp.x, min(dp.y, dp.z));
    col = m == dp.x ? vec3(0.78, 0.82, 0.78) : (m == dp.y ? vec3(0.55, 0.62, 0.58) : vec3(0.28, 0.30, 0.30));
    col *= 1.0 - 0.2 * panel(q.x * 0.25 + 0.2, 0.05);
    float cr = min(sdBox(vec2(q.x, p.y) - vec2(0.5, 0.0), vec2(3.0, 0.9)), sdBox(vec2(q.x, p.y) - vec2(0.5, 0.0), vec2(0.9, 3.0)));
    col = mix(col, vec3(0.1, 0.6, 0.25), smoothstep(0.15, -0.15, cr));
    emis += smoothstep(0.15, -0.3, cr) * vec3(0.1, 1.2, 0.4) * (0.5 + 0.6 * blink);
    emis += smoothstep(0.8, 0.0, length(q - vec2(8.8, 6.9))) * vec3(0.3, 1.5, 0.6) * blink;
    emis += smoothstep(0.9, 0.0, length((q - vec2(-10.2, 1.8)) / vec2(0.8, 1.0))) * vec3(0.5, 1.4, 0.6) * (0.3 + thr);
    spec = 0.5;
  } else if (ty == 10) {
    vec3 bodyC = vec3(0.20, 0.34, 0.42), finC = vec3(0.12, 0.20, 0.30), engC = vec3(0.16, 0.18, 0.22);
    float m = min(dp.x, min(dp.y, dp.z));
    col = m == dp.x ? bodyC : (m == dp.y ? finC : engC);
    col *= 1.0 - 0.25 * panel(q.x * 0.3, 0.05);
    float sc2 = length((q - vec2(1.0, 1.4)) / vec2(3.0, 1.0));
    col = mix(col, vec3(0.05, 0.22, 0.34), smoothstep(1.0, 0.75, sc2));
    emis += smoothstep(1.0, 0.0, sc2) * vec3(0.1, 0.5, 0.8) * 0.5;
    emis += smoothstep(1.0, 0.0, length(q - vec2(16.0, 0.0))) * vec3(0.5, 1.5, 2.2) * (0.5 + 0.8 * blink);
    emis += smoothstep(0.9, 0.0, length((q - vec2(-11.0, 2.3)) / vec2(0.8, 1.1))) * vec3(0.5, 1.0, 1.8) * (0.4 + thr);
    spec = 0.6;
  } else {
    vec3 ringC = vec3(0.42, 0.46, 0.54), hubC = vec3(0.55, 0.58, 0.62), solC = vec3(0.10, 0.22, 0.42);
    float m = min(dp.x, min(dp.y, dp.z));
    col = m == dp.x ? ringC : (m == dp.y ? hubC : solC);
    float r = length(p);
    float a = atan(p.y, p.x) + uTime * 0.12;
    if (m == dp.x) {
      float seg = floor((a + 3.14159) * 22.0 / 6.28318);
      float lit = step(0.35, hash12(vec2(seg, seed * 91.0)));
      float win = smoothstep(0.45, 0.2, abs(r - 15.5)) * lit * step(0.15, fract((a + 3.14159) * 22.0 / 6.28318) * (1.0 - fract((a + 3.14159) * 22.0 / 6.28318)) );
      emis += win * vec3(1.9, 1.3, 0.55) * 0.8;
      col *= 1.0 - 0.3 * panel((a) * 22.0 / 6.28318, 0.04);
    }
    if (m == dp.z) col *= 0.8 + 0.4 * panel(p.x * 0.5 + p.y * 0.5, 0.2);
    emis += smoothstep(0.9, 0.0, length(p - vec2(0.0, 0.0))) * vec3(0.2, 1.8, 0.5) * blink;
    emis += smoothstep(0.7, 0.0, length(abs(p) - vec2(0.0, 24.2))) * vec3(2.0, 0.2, 0.2) * (1.0 - blink);
    spec = 0.5;
  }
  return col;
}

void main(){
  int ty = int(fB.x + 0.5);
  float seed = fB.y, flash = fB.z, aux = fB.w;
  float sc = fT.y > 0.0 ? fT.y : 1.0;
  float px = PX / sc;
  vec2 p = vec2(dot(vOff, vec2(fRot.x, fRot.y)), dot(vOff, vec2(-fRot.y, fRot.x))) / sc;
  if (dot(vOff, vOff) > fT.x * fT.x) discard;
  vec2 Ll = vec2(dot(LW, vec2(fRot.x, fRot.y)), dot(LW, vec2(-fRot.y, fRot.x)));
  vec3 L3 = normalize(vec3(Ll, 0.64));
  vec3 col; float cov;

  if (ty <= 3 || ty == 8 || ty >= 9) {
    bool isSt = ty == 8, noMir = isSt || ty == 19;
    float thr = aux;
    gS = seed; gP = p;
    vec2 q = noMir ? p : vec2(p.x, abs(p.y));
    float h, mt; vec3 dp;
    float d = isSt ? fStation(q, uTime, h, mt, dp) : field(ty, q, thr, h, mt, dp);
    cov = clamp(0.5 - d / px, 0.0, 1.0);
    if (cov <= 0.0) discard;
    if (mt > 0.5) {   // flame: emissive, no lighting
      float fx0 = ty == 14 ? 12.8 : ty == 18 ? 3.0 : ty == 17 ? 14.3 : 9.0, fln = ty == 14 ? 19.0 : ty == 0 ? 11.0 : 14.0;
      float u = clamp((-p.x - fx0) / fln, 0.0, 1.0);
      float boost = clamp(thr - 0.9, 0.0, 1.0);
      vec3 hot = mix(vec3(2.4, 1.9, 1.2), vec3(1.0, 1.7, 2.6), boost);
      vec3 cool = mix(vec3(1.5, 0.45, 0.1), vec3(0.15, 0.5, 1.6), boost);
      if (ty == 10) { hot = vec3(1.4, 1.9, 2.4); cool = vec3(0.2, 0.6, 1.4); }
      else if (ty == 11) { hot = vec3(2.2, 1.6, 0.5); cool = vec3(1.2, 0.5, 0.1); }
      else if (ty == 13) { hot = vec3(0.8, 2.0, 1.2); cool = vec3(0.1, 0.8, 0.4); }
      else if (ty == 14) { hot = vec3(2.0, 2.2, 2.6); cool = mix(vec3(0.4, 0.8, 2.0), vec3(0.3, 1.2, 2.4), boost); }
      else if (ty == 16) { hot = vec3(1.2, 2.2, 2.2); cool = vec3(0.1, 0.8, 1.0); }
      else if (ty == 18) { hot = vec3(0.8, 0.5, 1.4); cool = vec3(0.25, 0.1, 0.5); }
      else if (ty == 20) { hot = vec3(2.2, 1.5, 0.5); cool = vec3(1.2, 0.5, 0.1); }
      else if (ty != 0 && ty != 2 && ty != 9 && ty != 12 && ty != 15 && ty != 17 && ty != 19) { hot = vec3(1.6, 0.4, 1.2); cool = vec3(0.6, 0.1, 0.5); }
      col = mix(hot, cool, clamp(u * 1.4, 0.0, 1.0)) * (1.1 - 0.7 * u);
      float fl = 0.75 + 0.25 * sin(uTime * 60.0 + q.x * 3.0);
      col *= fl; cov *= 0.95 - 0.35 * u;
    } else {
      float h1, h2, m1; vec3 d1;
      float e = 0.35;
      if (isSt) { fStation(q + vec2(e, 0.0), uTime, h1, m1, d1); fStation(q + vec2(0.0, e), uTime, h2, m1, d1); }
      else { field(ty, q + vec2(e, 0.0), thr, h1, m1, d1); field(ty, q + vec2(0.0, e), thr, h2, m1, d1); }
      float sgn = noMir ? 1.0 : (p.y >= 0.0 ? 1.0 : -1.0);
      vec3 n = normalize(vec3(-(h1 - h) / e * 1.6, -(h2 - h) / e * 1.6 * sgn, 1.0));
      vec3 emis; float spec;
      vec3 al = paint(ty, q, p, dp, h, thr, seed, emis, spec);
      float diff = clamp(dot(n, L3), 0.0, 1.0);
      float sp = pow(max(dot(n, normalize(L3 + vec3(0.0, 0.0, 1.0))), 0.0), 22.0) * spec;
      float rim = pow(1.0 - n.z, 2.2);
      float ao = 0.55 + 0.45 * smoothstep(0.0, 0.35, h);
      float lit = fT.z;
      col = (al * (0.20 + 0.95 * diff) * ao + sp * 0.8) * lit + rim * vec3(0.18, 0.32, 0.6) * 0.55 + emis;
    }
  } else if (ty == 4) {         // mine
    float r = length(p), a = atan(p.y, p.x);
    float rad = 1.7 + 1.6 * pow(abs(cos(a * 4.0 + uTime * 0.4)), 12.0);
    float d = r - rad;
    cov = clamp(0.5 - d / px, 0.0, 1.0);
    if (cov <= 0.0) discard;
    float z = sqrt(max(1.0 - (r / rad) * (r / rad), 0.0));
    vec3 n = normalize(vec3(p / rad * 0.9, z + 0.2));
    float diff = clamp(dot(n, L3), 0.0, 1.0);
    col = vec3(0.30, 0.30, 0.34) * (0.22 + diff);
    float blink = aux > 0.5 ? (sin(uTime * 9.0 + seed * 7.0) > 0.0 ? 1.0 : 0.25) : 0.2;
    col += smoothstep(1.0, 0.0, r) * vec3(2.2, 0.25, 0.18) * blink;
    col += pow(max(dot(n, normalize(L3 + vec3(0, 0, 1))), 0.0), 20.0) * 0.5;
  } else if (ty == 5) {         // asteroid; aux = radius
    float R = aux;
    float sp = (seed - 0.5) * 0.35 * uTime;
    vec2 pr = rot(sp) * p;
    float a = atan(pr.y, pr.x);
    vec2 ad = vec2(cos(a), sin(a));
    float rad = R * (0.78 + 0.30 * vn2(ad * 1.7 + seed * 31.0) + 0.14 * vn2(ad * 4.3 + seed * 7.0));
    float r = length(pr);
    float d = r - rad;
    cov = clamp(0.5 - d / px, 0.0, 1.0);
    if (cov <= 0.0) discard;
    float z = sqrt(max(1.0 - (r / rad) * (r / rad), 0.0));
    float bump = vn2(pr * 0.55 + seed * 17.0) * 0.8 + vn2(pr * 1.7 + seed * 5.0) * 0.4;
    vec3 n = normalize(vec3(pr / rad * 0.85 + (bump - 0.6) * 0.5, z * 1.0 + 0.15));
    float crater = 0.0;
    for (int i = 0; i < 3; i++) {
      vec2 cc = (vec2(hash12(vec2(seed * 13.0, float(i))), hash12(vec2(float(i) * 3.0, seed * 7.0))) - 0.5) * rad * 1.1;
      float cr = (0.18 + 0.22 * hash12(vec2(float(i), seed))) * rad;
      float cd = length(pr - cc);
      crater += smoothstep(cr, cr * 0.6, cd) * 0.45 - smoothstep(cr * 1.25, cr * 0.95, cd) * smoothstep(cr * 0.9, cr * 1.2, cd) * 0.25;
    }
    vec3 base = mix(vec3(0.34, 0.30, 0.27), vec3(0.55, 0.40, 0.28), hash12(vec2(seed, 3.3)));
    base *= 0.85 + 0.3 * bump - crater;
    float diff = clamp(dot(n, L3), 0.0, 1.0);
    col = base * (0.12 + 1.0 * diff) * fT.z + pow(1.0 - z, 3.0) * vec3(0.05, 0.08, 0.12);
  } else if (ty == 6) {         // player bolt
    float d = sdSeg(p, vec2(-3.0, 0.0), vec2(3.0, 0.0)) - 0.42;
    cov = clamp(0.5 - d / px, 0.0, 1.0);
    if (cov <= 0.0) discard;
    float core = smoothstep(0.35, 0.0, abs(p.y)) * smoothstep(3.5, 0.0, abs(p.x));
    col = mix(aux > 0.5 ? vec3(0.15, 0.55, 1.9) : vec3(1.7, 0.10, 0.06), vec3(2.3, 1.2, 0.9), core);
  } else {                      // enemy bolt (plasma)
    float d = length(p / vec2(1.5, 1.0)) - 0.95;
    cov = clamp(0.5 - d / px, 0.0, 1.0);
    if (cov <= 0.0) discard;
    float core = smoothstep(0.9, 0.0, length(p / vec2(1.4, 1.0)));
    col = mix(aux > 0.5 ? vec3(1.9, 0.95, 0.1) : vec3(0.2, 1.7, 0.3), vec3(1.7, 2.3, 1.6), core);
  }
  if (ty == 18) { cov *= 0.72 - 0.62 * seed; col *= 1.0 - 0.7 * seed; }      // shade: sparse glyphs, near-invisible running dark
  col += vec3(1.3) * flash;
  o = vec4(col * cov, cov);
}`;

/** Glyph matcher: one fragment per cell. Picks the glyph whose 4x8 ink signature best fits the sprite sub-samples. */
export const FS_MATCH = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D uSpr; uniform sampler2D uSig;
uniform int uCand[48]; uniform int uNC; uniform int uFill[8];
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
void main(){
  ivec2 cell = ivec2(gl_FragCoord.xy);
  ivec2 base = cell * ivec2(${SPR_X}, ${SPR_Y});
  float T[${SPR_X * SPR_Y}];
  vec3 csum = vec3(0.0); float asum = 0.0, amin = 1.0;
  for (int y = 0; y < ${SPR_Y}; y++) for (int x = 0; x < ${SPR_X}; x++) {
    vec4 s = texelFetch(uSpr, base + ivec2(x, y), 0);
    asum += s.a; csum += s.rgb; amin = min(amin, s.a);
    T[y * ${SPR_X} + x] = s.a;
  }
  float cov = asum / float(${SPR_X * SPR_Y});
  if (cov < 0.10) { oA = vec4(0.0); oB = vec4(0.0); return; }
  vec3 avg = csum / max(asum, 1e-3);
  float lum = dot(avg, vec3(0.2126, 0.7152, 0.0722));
  int bg = 0;
  if (amin > 0.72) {
    // solid interior: shade with a density ramp so panels / cockpit / lighting read as texture
    float li = clamp(1.0 - exp(-lum * 1.7), 0.0, 0.999);
    bg = uFill[int(li * 8.0)];
  } else {
    float best = 1e9;
    for (int i = 0; i < uNC; i++) {
      int g = uCand[i];
      float e = 0.0;
      for (int k = 0; k < ${SPR_X * SPR_Y}; k++) {
        float G = texelFetch(uSig, ivec2(k & ${SPR_X - 1}, g * ${SPR_Y} + (k >> 2)), 0).r;
        float d = T[k] - G;
        e += d * d;
      }
      if (e < best) { best = e; bg = g; }
    }
  }
  oA = vec4(avg * 1.7 + 0.08, float(bg) / 255.0);
  oB = vec4(avg * 0.34, smoothstep(0.35, 0.9, cov));
}`;
