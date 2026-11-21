import { TAU, hash2 } from '../core/util';
import { settings } from '../core/config';
import { BAND_NAME, DT, Kind, V_TOL, MAX_B, MAX_E, MAX_P, MAX_M, MAX_R, MAX_S, PK, Sim } from '../sim/sim';
import { PLANET_STRIDE, designation, gravReach, sectorOf } from '../sim/world';
import { gi, glyphOfCode } from './atlas';
import { Spr } from './batch';
import type { Renderer } from './renderer';

/**
 * Turns sim state into instances: SDF sprites (ships/rocks/bolts), glyph quads (particles, rings, HUD) and glow sprites.
 * Only writes into preallocated buffers; strings are cached so the steady state allocates nothing.
 */

const G = {
  dot: gi('·'), dotA: gi('.'), colon: gi(':'), plus: gi('+'), star: gi('*'), eq: gi('='), hash: gi('#'), at: gi('@'),
  pct: gi('%'), amp: gi('&'), x: gi('x'), tri: gi('▲'), ring: gi('○'), disc: gi('●'), dia: gi('◆'), full: gi('█'), light: gi('░'),
  tl: gi('╔'), tr: gi('╗'), bl: gi('╚'), br: gi('╝'), h2: gi('═'), v2: gi('║'), pipe: gi('|'), dash: gi('-'), sl: gi('/'), bs: gi('\\'),
  lb: gi('['), rb: gi(']'), o: gi('o'), bul: gi('•'),
};
const LINE8 = [G.dash, G.sl, G.pipe, G.bs, G.dash, G.sl, G.pipe, G.bs];
const DEBRIS = [G.pct, G.amp, G.hash, G.eq, G.x];
const FIRE_G = [G.dotA, G.colon, G.star, G.hash, G.at];

// HDR palette per Col index
const PAL = new Float32Array([
  1.30, 0.55, 0.14,   // Fire
  0.35, 0.95, 1.30,   // Cyan
  1.35, 0.22, 0.20,   // Red
  1.40, 1.40, 1.40,   // White
  0.52, 0.50, 0.55,   // Gray
  0.30, 1.20, 0.50,   // Green
  1.20, 0.30, 1.10,   // Magenta
  1.35, 0.90, 0.20,   // Amber
]);
const GRAY3 = 12;
/** The player's accent colour: nothing else on screen uses it. */
const ACCENT = [0.3, 2.0, 1.35];
/** Nose / tail distances (world units) per entity kind for the heading marks; null = no heading. */
const NOSE: ([number, number] | null)[] = [null, [6.5, 4.6], [9.8, 8.7], [7.8, 7.6], null, null, null, [19, 21], [10, 7.4], [5, 5.5], [6, 7.8], [6.6, 5.2], [8.4, 9.7], null, [8.4, 9.7], [2.5, 2]];
/** Player hull nose / tail by sprite art id. */
const SIG_LABEL = ['B', 'D', 'P', 'R', 'W', 'S', 'O', 'C', 'N', 'M', '?'];
const PNOSE: Record<number, [number, number]> = { 0: [10.8, 7.9], 14: [10.8, 9.2], 15: [9.7, 8.6], 16: [6.5, 11.6], 17: [8.6, 10.3], 18: [6.5, 2.2], 19: [7.6, 7.2], 20: [5.5, 8.4] };
const EVT_NAME = ['', 'COMET INBOUND', 'METEOR SHOWER', 'SOLAR FLARE', 'ION STORM', 'ECLIPSE', 'MEGASTRUCTURE IN VIEW'];
const OBJ_LABEL = ['HOSTILES', 'SCRAP', 'ASTEROIDS', 'SECONDS', 'DEFEND STATION (STAY CLOSE)', 'ESCORT THE FREIGHTER (STAY CLOSE)'];
const WAVES = ['CALM', 'BUILDING', 'PEAK', 'LULL'];

function dir8(a: number): number { return ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8; }

const HINT = 'W / ^  THRUST      A D / < >  TURN      S  BRAKE      SPACE  FIRE      SHIFT  BOOST';
const TITLE = 'A S T E R I O N';
const BOX_TOP = '╔══════════════════════════════════╗';
const BOX_MID = '║                                  ║';
const BOX_BOT = '╚══════════════════════════════════╝';
const LOST = 'S I G N A L   L O S T';
const RELAUNCH = 'R / ENTER  RELAUNCH      C  COPY RESULT';

export class FrameBuilder {
  camX = 0; camY = 0; alpha = 0;
  fx = 1; private rtime = 0;
  prompt = ''; dockKey = 'E'; hiScore = 0; showReticle = true;
  private sScrap = ''; private sObj = ''; private sWave = ''; private sMsl = ''; private sOver1 = ''; private sOver2 = ''; private sOver3 = ''; private sOver4 = '';
  /** Notable events of the run (game-over summary), shared with the exploration layer. */
  notable: string[] = [];
  private cols = 0; private rows = 0; private asp = 2;
  private thrS = 0.1;
  private hudT = -9; private sStat1 = ''; private sStat2 = ''; private sScore = ''; private sKills = '';
  // radar frame
  private rdX0 = 0; private rdTop = 0; private rdSx = 0; private rdMx = 0; private rdMy = 0; private rdW = 0; private rdH = 0;

  constructor(private sim: Sim, private r: Renderer) {}

  private cx(wx: number): number { return wx - this.camX + this.cols * 0.5; }
  private cy(wy: number): number { return (wy - this.camY) / this.asp + this.rows * 0.5; }
  /** Planet shadow: objects behind a planet (opposite the sun) are darkened, matching the planet shader's light direction. */
  // ------------------------------------------------------------------ verticality (M4): oblique offset, band dimming, shadows
  /** World-units of screen lift per band (oblique projection). */
  static readonly OBL = 6;
  /** Player's interpolated altitude this frame. */
  private pz = 0;
  zoff = 0; bandF = 1;
  private zy(z: number): number { return this.sim.vert ? z * FrameBuilder.OBL : 0; }
  /** Set the altitude of the entity about to be drawn: screen lift, sprite sort key, and dimming when it is on another band. */
  private zE(z: number): void {
    const s = this.sim;
    if (!s.vert) { this.zoff = 0; this.bandF = 1; this.r.sprites.z = 0; return; }
    this.zoff = z * FrameBuilder.OBL; this.r.sprites.z = z;
    this.bandF = (Math.abs(z - this.pz) <= V_TOL ? 1 : 0.38) * (0.85 + 0.15 * z);
  }
  /** Shadow '.' on the Low-band ground plane and a ':' stalk up to the craft, for everything above the ground. */
  private stalk(x: number, y: number, z: number, own: boolean): void {
    if (z < -0.95) return;
    const b = this.r.glyphs, cx = this.cx(x), g0 = this.cy(y - FrameBuilder.OBL), g1 = this.cy(y + z * FrameBuilder.OBL);
    if (cx < 0 || cx >= this.cols) return;
    const k = own ? 0.5 : 0.28;
    b.put(cx, g0, G.dotA, 0.25 * k + 0.05, 0.3 * k + 0.05, 0.35 * k + 0.05, 0);
    for (let r = Math.ceil(g0 + 1); r < g1 - 1.5; r++) b.put(cx, r, G.colon, 0.18 * k, 0.24 * k, 0.3 * k, 0);
  }
  private shadows(): void {
    const s = this.sim;
    if (!s.vert) return;
    for (let i = 0; i < MAX_E; i++) {
      const k = s.ek[i];
      if (k === Kind.None || k === Kind.Station || k === Kind.Mine || k === Kind.Comet) continue;
      if (k === Kind.Asteroid && s.er[i] < 3) continue;
      if (this.visible(s.ex[i], s.ey[i], 20)) this.stalk(s.ex[i], s.ey[i], s.ez[i], false);
    }
    if (s.alive) { const al = this.alpha; this.stalk(s.spx + (s.sx - s.spx) * al, s.spy + (s.sy - s.spy) * al, this.pz, true); }
  }

  private shade(x: number, y: number): number {
    const s = this.sim; let f = 1;
    for (let k = 0; k < s.nPl; k++) {
      const o = k * PLANET_STRIDE, dx = x - s.pl[o], dy = y - s.pl[o + 1], R = s.pl[o + 2];
      const t = dx * 0.568 + dy * 0.5165;
      if (t > 0 || t < -R * 9) continue;
      const perp = Math.abs(dx * 0.5165 - dy * 0.568) / 0.768;
      const sh = 1 - 0.75 * Math.min(1, Math.max(0, (R * 1.05 - perp) / (R * 0.35)));
      if (sh < f) f = sh;
    }
    return f * this.bandF;
  }
  private visible(wx: number, wy: number, size: number): boolean {
    const cx = this.cx(wx), cy = this.cy(wy);
    return cx > -size && cx < this.cols + size && cy > -size / this.asp && cy < this.rows + size / this.asp;
  }

  build(camX: number, camY: number, alpha: number, time: number, showHud: boolean): void {
    const r = this.r;
    this.camX = camX; this.camY = camY; this.alpha = alpha;
    this.cols = r.cols; this.rows = r.rows; this.asp = r.aspect;
    this.pz = this.sim.spz + (this.sim.sz - this.sim.spz) * alpha;
    this.shadows();
    this.sprites(time);
    if (this.sim.vert) this.r.sprites.sortByZ();
    this.r.sprites.z = 0; this.zoff = 0; this.bandF = 1;
    this.dust(time);
    this.particles();
    this.rings();
    this.scanView();
    this.pois(time);
    this.marks(time);
    this.scraps(time);
    this.lifeEnts(time);
    this.discoveries(time);
    this.announcements(time);
    if (this.showLayers) this.layersLegend();
    const h0 = this.r.glyphs.n;
    if (showHud) { this.hud(time); this.signals(); if (this.sim.alive) this.exploreHud(time); this.glitch(h0); }
  }

  // ------------------------------------------------------------------ sprites (SDF layer)
  private sprites(time: number): void {
    const s = this.sim, sp = this.r.sprites, gl = this.r.glows;
    const back = DT * (1 - this.alpha);
    for (let i = 0; i < MAX_E; i++) {
      const k = s.ek[i];
      if (k !== Kind.Asteroid && k !== Kind.Station) continue;
      this.zE(s.ez[i]); const x = s.ex[i] - s.evx[i] * back, y = s.ey[i] - s.evy[i] * back + this.zoff;
      if (k === Kind.Station) {
        if (this.visible(x, y, 24)) sp.add(x, y, 0, 24, Spr.Station, s.eseed[i], 0, 0, 0.75, this.shade(x, y));
      } else {
        const R = s.er[i];
        if (this.visible(x, y, R * 1.6)) sp.add(x, y, 0, R * 1.5, Spr.Asteroid, s.eseed[i], s.eflash[i] > 0 ? s.eflash[i] * 0.6 : 0, R, 1, this.shade(x, y));
      }
    }
    for (let i = 0; i < MAX_E; i++) {
      if (s.ek[i] !== Kind.Mine) continue;
      this.zE(s.ez[i]); const x = s.ex[i], y = s.ey[i] + this.zoff;
      if (!this.visible(x, y, 8)) continue;
      const armed = s.et[i] > 1.0;
      sp.add(x, y, 0, 5, Spr.Mine, s.eseed[i], 0, armed ? 1 : 0, 0.8);
      const blink = armed ? (Math.sin(time * 9 + i) > 0 ? 1 : 0.3) : 0.2;
      gl.add(x, y, armed ? 5 : 3, 0.5 * blink, 0.07 * blink, 0.05 * blink);
    }
    for (let i = 0; i < MAX_E; i++) {
      if (s.ek[i] !== Kind.Freighter) continue;
      this.zE(s.ez[i]); const x = s.ex[i], y = s.ey[i] + this.zoff;
      if (this.visible(x, y, 22)) {
        const f = s.eflash[i] > 0 ? s.eflash[i] * 0.7 : 0;
        sp.add(x, y, s.ea[i], 22, Spr.Tender, s.eseed[i], f, 0.5, 0.95, this.shade(x, y));
        gl.add(x, y, 14, 0.05, 0.3, 0.45);
        const ex = x - Math.cos(s.ea[i]) * 6, ey = y - Math.sin(s.ea[i]) * 6;
        gl.add(ex, ey, 6, 0.3, 0.6, 1.0);
      }
    }
    for (let i = 0; i < MAX_E; i++) {
      const k = s.ek[i];
      if (k !== Kind.Drone && k !== Kind.Gunship && k !== Kind.Minelayer && k !== Kind.Boss && k !== Kind.Sniper && k !== Kind.Splitter && k !== Kind.Tender && k !== Kind.Rammer) continue;
      this.zE(s.ez[i]); const x = s.ex[i] - s.evx[i] * back, y = s.ey[i] - s.evy[i] * back + this.zoff, a = s.ea[i];
      const ch = s.echarge[i] > 0 ? 1 - s.echarge[i] / (k === Kind.Sniper ? 1.0 : 0.5) : 0;           // gunship charge-up 0..1
      const f = Math.max(s.eflash[i] > 0 ? s.eflash[i] * 0.7 : 0, ch * 0.35);
      const sp2 = Math.sqrt(s.evx[i] * s.evx[i] + s.evy[i] * s.evy[i]);
      const thr = Math.min(1, sp2 / (k === Kind.Drone ? 64 : k === Kind.Gunship ? 42 : 34)) * 0.8 + 0.1;
      if (k === Kind.Drone) {
        if (this.visible(x, y, 12)) { sp.add(x, y, a, 10, Spr.Drone, s.eseed[i], f, thr, 0.72, this.shade(x, y)); gl.add(x, y, 6, 0.32, 0.05, 0.05); }
      } else if (k === Kind.Gunship) {
        if (this.visible(x, y, 25)) {
          sp.add(x, y, a, 17, Spr.Gunship, s.eseed[i], f, thr * (s.es[i] === 2 && s.eaux[i] > 0 ? 1 : 0.9), 0.65, this.shade(x, y));
          gl.add(x, y, 8, 0.30, 0.16, 0.04);
          if (s.eshield[i] > 0) gl.add(x, y, 15, 0.05, 0.25 * Math.min(1, s.eshield[i] / 4), 0.6 * Math.min(1, s.eshield[i] / 4));
          if (ch > 0) gl.add(x + Math.cos(a) * 9, y + Math.sin(a) * 9, 3 + ch * 6, 0.2 + ch * 0.8, 0.1 + ch * 0.5, 0.02);
        }
      } else if (k === Kind.Boss) {
        if (this.visible(x, y, 34)) {
          sp.add(x, y, a, 32, Spr.Boss, s.eseed[i], f, 0.5 + 0.5 * thr, 0.8, this.shade(x, y));
          gl.add(x, y, 22, 0.3, 0.08, 0.04);
          gl.add(x - Math.cos(a) * 19, y - Math.sin(a) * 19, 9, 0.9, 0.35, 0.1);
        }
      } else if (k === Kind.Sniper) {
        if (this.visible(x, y, 18)) {
          sp.add(x, y, a, 17, Spr.Sniper, s.eseed[i], f, thr, 0.62, this.shade(x, y));
          gl.add(x, y, 6, 0.08, 0.2, 0.32);
          if (ch > 0) gl.add(x + Math.cos(a) * 10, y + Math.sin(a) * 10, 3 + ch * 7, 0.6 * ch, 0.9 * ch, 1.4 * ch);
        }
      } else if (k === Kind.Splitter) {
        if (this.visible(x, y, 12)) { sp.add(x, y, a, 12, Spr.Splitter, s.eseed[i], f, thr, 0.8, this.shade(x, y)); gl.add(x, y, 7, 0.4, 0.28, 0.04); }
      } else if (k === Kind.Rammer) {
        if (this.visible(x, y, 10)) {
          const pz = 0.6 + 0.4 * Math.sin(time * 14 + i);
          sp.add(x, y, a, 12, Spr.Rammer, s.eseed[i], Math.max(f, 0.15 * pz), thr, 0.62, this.shade(x, y)); gl.add(x, y, 6, 0.9 * pz, 0.45 * pz, 0.1);
        }
      } else if (k === Kind.Tender) {
        if (this.visible(x, y, 14)) {
          sp.add(x, y, a, 15, Spr.Tender, s.eseed[i], f, thr * 0.5, 0.7, this.shade(x, y));
          gl.add(x, y, 8, 0.08, 0.45, 0.18);
          gl.add(x, y, 28, 0.02, 0.09 + 0.04 * Math.sin(time * 4), 0.04);
        }
      } else if (this.visible(x, y, 18)) {
        sp.add(x, y, a, 12, Spr.Minelayer, s.eseed[i], f, thr * 0.7, 0.65, this.shade(x, y));
        gl.add(x, y, 7, 0.26, 0.06, 0.24);
      }
    }
    // player
    if (s.alive && !(s.invuln > 0 && Math.sin(time * 40) > 0)) {
      const al = this.alpha;
      this.zE(this.pz); const x = s.spx + (s.sx - s.spx) * al, y = s.spy + (s.sy - s.spy) * al + this.zoff;
      let da = s.sa - s.spa; da = Math.atan2(Math.sin(da), Math.cos(da));
      const a = s.spa + da * al;
      const target = s.thrusting ? (s.boosting ? 1.35 : 0.9) : 0.12;
      this.thrS += (target - this.thrS) * 0.22;
      const S = s.ship, rk = S.radius / 2.4;
      sp.add(x, y, a, S.artSize, S.art, this.hullState() + 2 * ((s.up[6] > 0 ? 1 : 0) | (s.up[8] >= 2 ? 2 : 0) | (s.up[1] >= 3 ? 4 : 0)), s.hitFlash * 0.8, this.thrS, 0.72, this.shade(x, y) * (S.darkSig < 1 ? 1 - 0.6 * this.dark : 1));
      if (S.darkSig >= 1 || this.dark < 0.5) gl.add(x, y, 9, 0.16, 0.18, 0.24);
      if (s.thrusting) {
        const ca = Math.cos(a), sa = Math.sin(a);
        const rad = (s.boosting ? 8 : 5.5) * (S.darkSig < 1 ? 0.6 : 1);
        gl.add(x - ca * 7 * rk - sa * 2 * rk, y - sa * 7 * rk + ca * 2 * rk, rad, s.boosting ? 0.2 : 0.55, s.boosting ? 0.8 : 0.28, s.boosting ? 1.3 : 0.06);
        gl.add(x - ca * 7 * rk + sa * 2 * rk, y - sa * 7 * rk - ca * 2 * rk, rad, s.boosting ? 0.2 : 0.55, s.boosting ? 0.8 : 0.28, s.boosting ? 1.3 : 0.06);
      }
      if (s.muzzleT > 0) gl.add(x + Math.cos(a) * 9.5 * rk, y + Math.sin(a) * 9.5 * rk, 5, 0.6, 0.12, 0.08);
    } else this.thrS = 0.12;
    for (let i = 0; i < MAX_E; i++) {
      if (s.ek[i] !== Kind.Wing) continue;
      this.zE(s.ez[i]); const x = s.ex[i] - s.evx[i] * back, y = s.ey[i] - s.evy[i] * back + this.zoff;
      if (!this.visible(x, y, 6)) continue;
      sp.add(x, y, s.ea[i], 5, Spr.Wing, 0, 0, 0.6, 0.9);
      gl.add(x, y, 3, 0.05, 0.4, 0.25);
    }
    for (let m = 0; m < MAX_M; m++) {
      if (s.mlife[m] <= 0) continue;
      const x = s.mx[m], y = s.my[m];
      if (!this.visible(x, y, 8)) continue;
      sp.add(x, y, s.mang[m], 6, Spr.Bolt, 0, 0, settings.cb ? 1 : 0, 1.1);
      gl.add(x, y, 5, 0.9, 0.5, 0.12);
    }
  }

  // ------------------------------------------------------------------ readability marks: bolts, dark halos, nose + tail on every ship
  /** Blank dark cells around a point so bolts / pickups never blend into the backdrop. */
  private halo(cx: number, cy: number): void {
    const b = this.r.glyphs; cx = Math.floor(cx); cy = Math.floor(cy);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) b.put(cx + dx, cy + dy, 0, 0, 0, 0, 1);
  }
  private marks(time: number): void {
    const s = this.sim, b = this.r.glyphs, back = DT * (1 - this.alpha), cb = settings.cb;
    // halos first, so the marks below sit in clean black cells
    for (let i = 0; i < MAX_B; i++) {
      if (s.blife[i] <= 0) continue;
      const x = s.bx[i] - s.bvx[i] * back, y = s.by[i] - s.bvy[i] * back + this.zy(s.bz[i]);
      this.halo(this.cx(x), this.cy(y));
    }
    for (let i = 0; i < MAX_S; i++) if (s.scl[i] > 0) this.halo(this.cx(s.scx[i]), this.cy(s.scy[i]));
    // player bolts: two cells, one bright colour; enemy bolts: a different glyph and hue that blinks slowly
    for (let i = 0; i < MAX_B; i++) {
      if (s.blife[i] <= 0) continue;
      this.zE(s.bz[i]); const x = s.bx[i] - s.bvx[i] * back, y = s.by[i] - s.bvy[i] * back + this.zoff, bk = this.bandF;
      const cx = this.cx(x), cy = this.cy(y);
      if (cx < -2 || cx > this.cols + 2 || cy < -2 || cy > this.rows + 2) continue;
      if (s.bown[i] === 0) {
        const a = Math.atan2(s.bvy[i] / this.asp, s.bvx[i]), g = LINE8[dir8(a)], l = Math.hypot(s.bvx[i], s.bvy[i] / this.asp) + 1e-6;
        const r = (cb ? 0.4 : 2.2) * bk, gg = (cb ? 1.2 : 0.45) * bk, bb = (cb ? 2.4 : 0.25) * bk;
        b.put(cx, cy, g, r, gg, bb, 1);
        b.put(cx - s.bvx[i] / l, cy - s.bvy[i] / this.asp / l, g, r * 0.7, gg * 0.7, bb * 0.7, 1);
      } else {
        const k = (0.6 + 0.4 * Math.sin(time * 5 + i)) * bk;
        b.put(cx, cy, G.o, (cb ? 2.0 : 0.35) * k, (cb ? 1.3 : 1.9) * k, (cb ? 0.2 : 0.45) * k, 1);
      }
    }
    // heading: bright nose glyph + flickering tail on every ship
    const flick = (time * 14) & 1;
    for (let i = 0; i < MAX_E; i++) {
      const k = s.ek[i], n = NOSE[k];
      if (!n) continue;
      this.zE(s.ez[i]); const x = s.ex[i] - s.evx[i] * back, y = s.ey[i] - s.evy[i] * back + this.zoff, ca = Math.cos(s.ea[i]), sa = Math.sin(s.ea[i]);
      if (!this.visible(x, y, 30)) continue;
      const neutral = k === Kind.Hauler || k === Kind.Freighter, friend = k === Kind.Wing;
      const r = (friend ? 0.3 : neutral ? 1.6 : 2.0) * this.bandF, g = (friend ? 1.9 : neutral ? 1.1 : cb ? 1.2 : 0.35) * this.bandF, bb = (friend ? 1.3 : neutral ? 0.3 : 0.2) * this.bandF;
      b.put(this.cx(x + ca * n[0]), this.cy(y + sa * n[0]), G.bul, r, g, bb, 1);
      if (Math.hypot(s.evx[i], s.evy[i]) > 8) b.put(this.cx(x - ca * n[1]), this.cy(y - sa * n[1]), flick ? G.colon : G.dotA, r * 0.5, g * 0.5, bb * 0.5, 0);
    }
    this.zE(0); this.bandF = 1;
    if (s.alive) {
      const al = this.alpha, x = s.spx + (s.sx - s.spx) * al, y = s.spy + (s.sy - s.spy) * al + this.zy(this.pz);
      let da = s.sa - s.spa; da = Math.atan2(Math.sin(da), Math.cos(da));
      const a = s.spa + da * al, ca = Math.cos(a), sa = Math.sin(a), n = PNOSE[s.ship.art] ?? PNOSE[0];
      const fade = s.ship.darkSig < 1 ? 1 - 0.75 * this.dark : 1;
      b.put(this.cx(x + ca * n[0]), this.cy(y + sa * n[0]), G.bul, ACCENT[0] * fade, ACCENT[1] * fade, ACCENT[2] * fade, 1);
      if (s.thrusting) b.put(this.cx(x - ca * n[1]), this.cy(y - sa * n[1]), flick ? G.colon : G.dotA, ACCENT[0] * 0.5 * fade, ACCENT[1] * 0.5 * fade, ACCENT[2] * 0.5 * fade, 0);
    }
  }

  // ------------------------------------------------------------------ discovery names, scan view, layer legend
  private named = new Set<number>(); private nameKey = -1; private nameT = 0; private nameStr = ''; private nameX = 0; private nameY = 0; private nameR = 0;
  /** First sight of a body prints its catalogue designation in the sky, letter by letter. */
  private discoveries(time: number): void {
    const s = this.sim;
    for (let k = 0; k < s.nPl; k++) {
      const o = k * PLANET_STRIDE, x = s.pl[o], y = s.pl[o + 1], R = s.pl[o + 2];
      const key = (Math.round(x) * 73856093) ^ (Math.round(y / 8) * 19349663);
      if (this.named.has(key) || Math.hypot(x - this.camX, y - this.camY) - R > this.cols * 0.45) continue;
      this.named.add(key); const nm = this.designate(x, y, R); if (!nm) continue;
      this.nameKey = key; this.nameT = time; this.nameStr = nm; this.nameX = x; this.nameY = y; this.nameR = R;
      break;
    }
    const age = time - this.nameT;
    if (this.nameKey === -1 || age > 6) return;
    for (let k = 0; k < s.nPl; k++) { const o = k * PLANET_STRIDE; if (Math.abs(s.pl[o + 2] - this.nameR) < 0.01) { this.nameX = s.pl[o]; this.nameY = s.pl[o + 1]; } }
    const n = Math.min(this.nameStr.length, Math.floor(age * 18)), fade = Math.min(1, (6 - age) / 1.5);
    const row = Math.round(this.rows - 1 - this.cy(this.nameY + this.nameR + 6)), col = Math.round(this.cx(this.nameX)) - (this.nameStr.length >> 1);
    const rr = Math.max(8, Math.min(this.rows - 10, row)), cc = Math.max(2, Math.min(this.cols - this.nameStr.length - 2, col));
    this.r.glyphs.text(this.nameStr.slice(0, n), cc, rr, 0.5 * fade, 1.3 * fade, 1.1 * fade, 2);
    if (n < this.nameStr.length && Math.sin(time * 20) > 0) this.r.glyphs.text('_', cc + n, rr, 0.5, 1.3, 1.1, 2);
  }
  designate: (x: number, y: number, r: number) => string = (x, y, r) => designation(x, y, r);

  /** Scan view: a scanned body's glyphs rewrite into its data strings for a moment (planet index `k`, envelope 0..1). */
  scanX = 0; scanY = 0; scanR = 0; scanEnv = 0; scanText = '';
  /** Planets in view (set by main each frame) and the index of the scan target among them (-1 none). */
  view: Float32Array = new Float32Array(0); nView = 0; scanIdx = -1;
  private scanView(): void {
    this.scanIdx = -1;
    if (this.scanEnv <= 0 || this.scanText.length === 0 || this.scanR === 0) return;
    let best = 1e9;
    for (let i = 0; i < this.nView; i++) {
      const o = i * PLANET_STRIDE, d = this.scanR < 0 ? Math.hypot(this.view[o] - this.camX, this.view[o + 1] - this.camY) - this.view[o + 2]   // debug: nearest body
        : Math.abs(this.view[o + 2] - this.scanR) * 100 + Math.hypot(this.view[o] - this.scanX, this.view[o + 1] - this.scanY);
      if (d < best && (this.scanR < 0 || d < this.scanR * 3 + 40)) { best = d; this.scanIdx = i; }
    }
    if (this.scanIdx < 0) return;
    const o = this.scanIdx * PLANET_STRIDE, px = this.view[o], py = this.view[o + 1], R = this.view[o + 2], b = this.r.glyphs, txt = this.scanText, L = txt.length;
    this.scanX = px; this.scanY = py; this.scanR = R;
    const c0 = Math.max(0, Math.floor(this.cx(px - R))), c1 = Math.min(this.cols - 1, Math.ceil(this.cx(px + R)));
    const r0 = Math.max(0, Math.floor(this.cy(py - R))), r1 = Math.min(this.rows - 1, Math.ceil(this.cy(py + R)));
    const e = this.scanEnv;
    for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) {
      const wx = cx + 0.5 - this.cols * 0.5 + this.camX - px, wy = (cy + 0.5 - this.rows * 0.5) * this.asp + this.camY - py;
      const d = Math.sqrt(wx * wx + wy * wy) / R;
      if (d > 1 || hash2(cx, cy) > e * 1.3) continue;
      const ch = txt.charCodeAt(((cy * 7 + cx) % L + L) % L), k2 = 0.5 + 0.8 * (1 - d) * e;
      b.put(cx, cy, glyphOfCode(ch), 0.35 * k2, 1.3 * k2, 1.1 * k2, 0);
    }
  }

  showLayers = false;
  private layersLegend(): void {
    const lines = ['LAYER GLYPH BUDGET', 'BACKGROUND  . , : ;   (DIM ONLY)  BLUE', 'BODIES      ~ - = # % : . * \' @ * +  GREEN', 'SHIPS       SHAPE-MATCHED, HEAVY  RED', 'BOLTS       PLAYER - / | \\  ENEMY o', 'PLAYER      ACCENT • (MINT)'];
    for (let i = 0; i < lines.length; i++) this.r.glyphs.text(lines[i], 2, 8 + i, 0.8, 1.2, 1.0, 1);
  }

  // ------------------------------------------------------------------ exploration HUD + POI visuals (M5/M6)
  sysName = ''; sunTint: [number, number, number] = [1, 1, 1]; surveyPct = 0; data = 0;
  scanTargetI = -1; scanTargetX = 0; scanTargetY = 0;
  ticker = ''; tickerT = 0;
  readonly sigX = new Float32Array(6); readonly sigY = new Float32Array(6); readonly sigK = new Int8Array(6); nSig = 0;
  private annStr = ''; private annT = -1; private annStyle = 0; private annPending = false;
  /** Type a line into the sky: style 0 = system arrival (top centre), 1 = a discovery near the scanned body. */
  announce(text: string, style: number): void { this.annStr = text; this.annStyle = style; this.annPending = true; }
  private announcements(time: number): void {
    if (this.annPending) { this.annPending = false; this.annT = time; }
    if (this.annT < 0 || this.annStr.length === 0) return;
    const age = time - this.annT;
    if (age > 7) { this.annT = -1; return; }
    const n = Math.min(this.annStr.length, Math.floor(age * 22)), fade = Math.min(1, (7 - age) / 1.5);
    let row = 9, col = (this.cols - this.annStr.length) >> 1;
    if (this.annStyle === 1 && this.scanR > 0) {
      row = Math.round(this.rows - 1 - this.cy(this.scanY + this.scanR + 8));
      col = Math.round(this.cx(this.scanX)) - (this.annStr.length >> 1);
    }
    row = Math.max(9, Math.min(this.rows - 10, row)); col = Math.max(2, Math.min(this.cols - this.annStr.length - 2, col));
    const k = this.annStyle === 0 ? 1.3 : 1;
    this.r.glyphs.text(this.annStr.slice(0, n), col, row, 0.45 * fade * k, 1.35 * fade * k, 1.15 * fade * k, 2);
    if (n < this.annStr.length && Math.sin(time * 20) > 0) this.r.glyphs.text('_', col + n, row, 0.5, 1.3, 1.1, 2);
  }

  /** POI set pieces in glyphs: derelict capital hull (SDF), pulsar beams, wormhole swirl, beacon / signal blips. */
  private pois(time: number): void {
    const s = this.sim, b = this.r.glyphs, sp = this.r.sprites, gl = this.r.glows;
    for (let p = 0; p < s.nPoi; p++) {
      const x = s.poiX[p], y = s.poiY[p], k = s.poiK[p];
      if (!this.visible(x, y, k === 1 ? 130 : k === 2 ? 60 : 30)) continue;
      if (k === 1) { sp.z = -0.5; sp.add(x, y, s.poiS[p] * 6.28, 118, 22, s.poiS[p], 0, 0, 1, 0.9); sp.z = 0; continue; }
      if (k === 2) {                                                       // pulsar: a hot point with two sweeping beams
        const a = time * 2.6 + s.poiS[p] * 6, pulse = 0.5 + 0.5 * Math.sin(time * 18);
        gl.add(x, y, 10 + 6 * pulse, 0.6 + pulse, 0.7 + pulse, 1.4 + pulse);
        b.put(this.cx(x), this.cy(y), G.at, 2.4, 2.4, 2.8, 1);
        for (let j = 1; j < 40; j++) for (let sgn = -1; sgn <= 1; sgn += 2) {
          const bx = x + Math.cos(a) * j * 3 * sgn, by = y + Math.sin(a) * j * 3 * sgn, f = (1 - j / 40) * (0.4 + 0.6 * pulse);
          b.put(this.cx(bx), this.cy(by), LINE8[dir8(a)], 1.0 * f + 0.2, 1.5 * f + 0.25, 2.6 * f + 0.4, 2);
        }
        continue;
      }
      if (k === 4) {                                                       // wormhole: rotating rings of glyphs
        for (let ring = 0; ring < 3; ring++) {
          const rad = 5 + ring * 4, n = 10 + ring * 8;
          for (let j = 0; j < n; j++) {
            const a = (j / n) * TAU + time * (1.4 - ring * 0.4) * (ring & 1 ? -1 : 1), f = 0.5 + 0.5 * Math.sin(a * 3 + time * 4);
            b.put(this.cx(x + Math.cos(a) * rad), this.cy(y + Math.sin(a) * rad), ring === 0 ? G.star : G.dotA, (0.6 + f) * 0.8, 0.3 * f, (1.2 + f) * 0.9, 2);
          }
        }
        gl.add(x, y, 14, 0.4, 0.1, 0.6);
        continue;
      }
      if (s.poiDone[p]) continue;
      const blink = Math.sin(time * 3 + p) > 0 ? 1 : 0.4;                 // beacons and signals: a slow blip
      b.put(this.cx(x), this.cy(y), k === 0 ? G.dia : G.ring, 0.4 * blink, 1.4 * blink, 1.2 * blink, 1);
    }
  }

  /** Signal bearings: dim arrows at the screen edge toward untouched points of interest, before anything is visible. */
  private signals(): void {
    const s = this.sim, b = this.r.glyphs, cxm = this.cols * 0.5, cym = this.rows * 0.5;
    for (let i = 0; i < this.nSig; i++) {
      const dx = this.sigX[i] - this.camX, dy = (this.sigY[i] - this.camY) / this.asp;
      if (Math.abs(dx) < cxm - 2 && Math.abs(dy) < cym - 2) continue;
      const t = Math.min((cxm - 3) / Math.max(1e-3, Math.abs(dx)), (cym - 9) / Math.max(1e-3, Math.abs(dy)));
      const ex = cxm + dx * t, ey = cym + dy * t, d = Math.hypot(this.sigX[i] - s.sx, this.sigY[i] - s.sy);
      const k = Math.max(0.25, 1 - d / (s.sensorR * 6));
      b.put(ex, ey, LINE8[dir8(Math.atan2(dy, dx))], 0.3 * k, 0.9 * k, 0.8 * k, 1);
      const lab = SIG_LABEL[this.sigK[i]] ?? '?';
      b.put(ex - Math.sign(dx), ey - Math.sign(dy), glyphOfCode(lab.charCodeAt(0)), 0.25 * k, 0.7 * k, 0.65 * k, 1);
    }
  }

  /** Ion storms glitch the HUD: scramble a few HUD glyphs (allocation-free, in place). */
  private glitch(from: number): void {
    const s = this.sim, st = Math.max(s.storm, s.zoneStorm);
    if (st < 0.3) return;
    const d = this.r.glyphs.data, n = this.r.glyphs.n;
    for (let i = from; i < n; i++) if (hash2(i * 7 + (s.tick >> 2), i) < 0.06 * st) d[i * 8 + 2] = 33 + ((i * 13 + s.tick) % 60);
  }

  private exploreHud(time: number): void {
    const s = this.sim, bt = this.r.glyphs, cols = this.cols, rows = this.rows;
    // fuel + survey + system under the main box
    this.bar(s.fuel <= 0 ? 'FUEL!' : 'FUEL ', s.fuel / s.fuelMax, 9, s.fuel < s.fuelMax * 0.2 ? 1.8 : 1.3, s.fuel < s.fuelMax * 0.2 ? 0.4 : 1.1, 0.3, 12);
    if (this.sysName) {
      if (time - this.sysT > 0.5) { this.sysT = time; this.sSys = this.sysName + '  SURVEY ' + Math.round(this.surveyPct * 100) + '%  DATA ' + (this.data | 0); }
      bt.text(this.sSys, 3, 10, 0.45, 0.85, 0.8);
    }
    if (s.cruise) bt.text('>> CRUISE <<', (cols - 12) >> 1, rows - 7, 0.4, 1.4, 1.2, 1);
    if (s.jumpT > 0) {
      const f = 1 - s.jumpT / Math.max(0.01, s.jumpLen), w = 30, x0 = (cols - w) >> 1;
      bt.text('JUMP DRIVE', (cols - 10) >> 1, rows - 8, 0.7, 1.2, 1.8, 1);
      for (let i = 0; i < w; i++) bt.put(x0 + i, 6, i < f * w ? G.hash : G.dotA, i < f * w ? 0.6 : 0.15, i < f * w ? 1.0 : 0.2, i < f * w ? 2.0 : 0.3, 1);
      const al = this.alpha, px = s.spx + (s.sx - s.spx) * al, py = s.spy + (s.sy - s.spy) * al, rad = 14 - 10 * f;   // charge ring tightening
      for (let j = 0; j < 36; j++) { const a = j / 36 * TAU + time * 3; this.r.glyphs.put(this.cx(px + Math.cos(a) * rad), this.cy(py + Math.sin(a) * rad), G.colon, 0.5 + f, 0.8 + f, 1.6, 2); }
    }
    if (s.scanP > 0 && this.scanTargetI >= 0) {
      const w = 20, x0 = (cols - w) >> 1, cy = rows - 1 - (rows - 6);
      bt.text('SCANNING', (cols - 8) >> 1, rows - 6 - 1 + 0, 0.4, 1.3, 1.1, 1);
      for (let i = 0; i < w; i++) bt.put(x0 + i, cy, i < s.scanP * w ? G.hash : G.dotA, i < s.scanP * w ? 0.4 : 0.12, i < s.scanP * w ? 1.6 : 0.2, i < s.scanP * w ? 1.3 : 0.2, 1);
      const tx = this.cx(this.scanTargetX), ty = this.cy(this.scanTargetY);       // bracket the target
      bt.put(tx - 3, ty, G.lb, 0.4, 1.4, 1.2, 2); bt.put(tx + 3, ty, G.rb, 0.4, 1.4, 1.2, 2);
    }
    if (this.ticker && this.tickerT > 0) {                                 // news ticker: dim, scrolls once, skippable (K)
      const msg = '// ' + this.ticker + ' //', x = Math.round(cols - (9 - this.tickerT) * (cols + msg.length) / 9);
      for (let i = 0; i < msg.length; i++) { const c = x + i; if (c >= 2 && c < cols - 34) bt.put(c, 0, glyphOfCode(msg.charCodeAt(i)), 0.32, 0.42, 0.45, 1); }
    }
  }
  private sysT = -9; private sSys = '';

  private dark = 0; private arm = 0; private bay = 0;
  /** Ship-specific live state for the hull shader (one float): barrel flash, petal unfold, hold fill, dark fade, arm reach, bays. */
  private hullState(): number {
    const s = this.sim, S = s.ship;
    this.dark += ((S.darkSig < 1 && s.sigNow < S.signature * 0.3 ? 1 : 0) - this.dark) * 0.08;
    switch (S.art) {
      case Spr.Anvil: return s.muzzleT > 0 && S.muzzle ? (S.muzzle[s.hpIdx] + 5) / 10 : 0;
      case Spr.Sextant: return s.scanP;
      case Spr.Mule: return Math.min(1, s.cargoUsed / Math.max(1, S.cargo));
      case Spr.Shade: return this.dark;
      case Spr.Magpie: {
        let want = 0; const r2 = s.tractorR * s.tractorR;
        for (let i = 0; i < MAX_S; i++) if (s.scl[i] > 0) { const dx = s.scx[i] - s.sx, dy = s.scy[i] - s.sy; if (dx * dx + dy * dy < r2) { want = 1; break; } }
        this.arm += (want - this.arm) * 0.1; return this.arm;
      }
      case Spr.Hive: { const want = s.wingCd > 5 || (s.nEnemy > 0 && s.nWing < S.wingmen && s.wingCd < 1.2) ? 1 : 0; this.bay += (want - this.bay) * 0.12; return this.bay; }
      default: return 0.5;
    }
  }

  private scraps(time: number): void {
    const s = this.sim, b = this.r.glyphs, gl = this.r.glows;
    const back = DT * (1 - this.alpha);
    for (let i = 0; i < MAX_S; i++) {
      if (s.scl[i] <= 0) continue;
      if (s.scl[i] < 5 && Math.sin(time * 18) > 0) continue;               // blink before despawn
      const x = s.scx[i] - s.scvx[i] * back, y = s.scy[i] - s.scvy[i] * back;
      const cx = this.cx(x), cy = this.cy(y);
      if (cx < -2 || cx > this.cols + 2 || cy < -2 || cy > this.rows + 2) continue;
      const p = 0.75 + 0.25 * Math.sin(time * 6 + i);
      const ck = s.sck[i];
      if (ck === 1) { b.put(cx, cy, G.plus, 0.4 * p, 1.6 * p, 0.6 * p, 0); gl.add(x, y, 3.5, 0.05, 0.35 * p, 0.12); }
      else if (ck === 2) { b.put(cx, cy, G.tri, 1.6 * p, 0.8 * p, 0.2 * p, 0); gl.add(x, y, 3.5, 0.35 * p, 0.16 * p, 0.03); }
      else { b.put(cx, cy, G.dia, 1.5 * p, 1.2 * p, 0.3 * p, 0); gl.add(x, y, 3, 0.3 * p, 0.22 * p, 0.04); }
    }
  }

  // ------------------------------------------------------------------ particles
  private particles(): void {
    const s = this.sim, b = this.r.glyphs, gl = this.r.glows;
    const back = DT * (1 - this.alpha);
    for (let i = 0; i < MAX_P; i++) {
      const life = s.plife[i];
      if (life <= 0) continue;
      const x = s.px[i] - s.pvx[i] * back, y = s.py[i] - s.pvy[i] * back;
      const cx = this.cx(x), cy = this.cy(y);
      if (cx < -6 || cx > this.cols + 6 || cy < -6 || cy > this.rows + 6) continue;
      const t = life / s.pmax[i], kind = s.pkind[i], c = s.pcol[i] * 3;
      const pr = PAL[c], pg = PAL[c + 1], pb = PAL[c + 2];
      switch (kind) {
        case PK.Spark: {
          const g = t > 0.6 ? G.star : t > 0.3 ? G.plus : G.dotA;
          const k = 0.35 + t * 1.3, w = t > 0.7 ? 0.5 : 0;
          b.put(cx, cy, g, (pr + w) * k, (pg + w) * k, (pb + w) * k, 0);
          if ((i & 1) === 0) gl.add(x, y, 2.4, pr * t * 0.30, pg * t * 0.30, pb * t * 0.30);
          break;
        }
        case PK.Exhaust: {
          const idx = Math.min(4, Math.floor((1 - t) * 5));
          const hot = t > 0.7 ? (t - 0.7) * 3.3 : 0;
          const k = 0.25 + t * 1.2;
          b.put(cx, cy, FIRE_G[4 - idx], (pr + hot) * k, (pg + hot * 0.9) * k, (pb + hot * 0.7) * k, 0);
          if ((i & 3) === 0) gl.add(x, y, 2.6, pr * t * 0.22, pg * t * 0.22, pb * t * 0.22);
          break;
        }
        case PK.Debris: {
          if (s.psize[i] > 1.5) {                     // hull chunk: hot, cools as it tumbles
            const hk = 0.45 + 0.9 * t;
            b.put(cx, cy, DEBRIS[(i + (s.tick >> 2)) % DEBRIS.length], (pr * 0.8 + 0.2) * hk, (pg * 0.6 + 0.1) * hk * (0.3 + t), pb * 0.3 * hk * t, 0);
            gl.add(x, y, 3.4, pr * 0.45 * t, pg * 0.22 * t, pb * 0.08 * t);
            break;
          }
          const k = 0.35 + 0.65 * t;
          b.put(cx, cy, DEBRIS[(i + (s.tick >> 3)) % DEBRIS.length], pr * k * 0.9, pg * k * 0.9, pb * k * 0.9, 0);
          if (t > 0.5 && c !== GRAY3) gl.add(x, y, 1.6, pr * 0.15 * t, pg * 0.15 * t, pb * 0.15 * t);
          break;
        }
        case PK.Smoke: {
          const k = t * 0.5;
          b.put(cx, cy, t > 0.5 ? G.colon : G.dotA, 0.55 * k + 0.08, 0.52 * k + 0.08, 0.58 * k + 0.08, 0);
          break;
        }
        default: {
          const sz = s.psize[i] * (0.4 + 0.6 * t);
          gl.add(x, y, sz * 1.7, pr * t * 0.95, pg * t * 0.95, pb * t * 0.95);
          break;
        }
      }
    }
  }

  /** Parallax dust motes that stretch into dashes with speed: cheap depth and a sense of motion. */
  private dust(time: number): void {
    const s = this.sim, b = this.r.glyphs, n = Math.round(72 * this.fx), W = this.cols * 1.7, H = this.rows * 1.7;
    const spd = Math.hypot(s.svx, s.svy), len = spd > 60 ? Math.min(4, 1 + Math.floor(spd / 50)) : 1;
    const dir = dir8(Math.atan2(s.svy / this.asp, s.svx)), vl = Math.hypot(s.svx, s.svy / this.asp) + 1e-6, ux = s.svx / vl, uy = s.svy / this.asp / vl;
    for (let i = 0; i < n; i++) {
      const pz = 0.25 + 0.9 * hash2(i, 11);
      const x = ((hash2(i, 3) * W - this.camX * pz) % W + W) % W - (W - this.cols) * 0.5;
      const y = ((hash2(i, 5) * H - (this.camY / this.asp) * pz) % H + H) % H - (H - this.rows) * 0.5;
      const k = (0.10 + 0.16 * pz) * (0.7 + 0.3 * Math.sin(time * 1.3 + i));
      for (let j = 0; j < len; j++) {
        const cx = Math.floor(x + ux * j * pz), cy = Math.floor(y + uy * j * pz);
        if (cx < 0 || cx >= this.cols || cy < 0 || cy >= this.rows) continue;
        b.put(cx, cy, len > 1 ? LINE8[dir] : (pz > 0.9 ? G.dot : G.dotA), 0.55 * k * (1 - j / (len + 1)), 0.7 * k * (1 - j / (len + 1)), 1.0 * k * (1 - j / (len + 1)), 0);
      }
    }
  }

  /** Comets (glowing head + tail) and neutral haulers. */
  private lifeEnts(time: number): void {
    const s = this.sim, sp = this.r.sprites, gl = this.r.glows, b = this.r.glyphs;
    for (let i = 0; i < MAX_E; i++) {
      const k = s.ek[i];
      if (k !== Kind.Comet && k !== Kind.Hauler) continue;
      this.zE(s.ez[i]); const x = s.ex[i], y = s.ey[i] + this.zoff, a = s.ea[i];
      if (k === Kind.Comet) {
        if (!this.visible(x, y, 40)) continue;
        const ca = Math.cos(a), sa = Math.sin(a);
        gl.add(x, y, 12, 1.8, 2.0, 2.4); gl.add(x, y, 26, 0.25, 0.55, 1.0);
        for (let j = 1; j <= 7; j++) gl.add(x - ca * j * 6, y - sa * j * 6, 11 - j, 0.7 / j, 1.0 / j, 1.5 / j);
        b.put(this.cx(x), this.cy(y), G.at, 2.2, 2.3, 2.6, 0);
        b.put(this.cx(x - ca * 2), this.cy(y - sa * 2), G.star, 1.2, 1.6, 2.0, 0);
      } else if (this.visible(x, y, 20)) {
        sp.add(x, y, a, 18, Spr.Tender, s.eseed[i] + 30, s.eflash[i] > 0 ? s.eflash[i] * 0.7 : 0, 0.35, 0.95, this.shade(x, y));
        gl.add(x, y, 10, 0.35, 0.22, 0.06);
        gl.add(x - Math.cos(a) * 7, y - Math.sin(a) * 7, 5, 0.45 + 0.1 * Math.sin(time * 6 + i), 0.3, 0.08);
      }
    }
  }

  private rings(): void {
    const s = this.sim, b = this.r.glyphs;
    for (let i = 0; i < MAX_R; i++) {
      if (s.rlife[i] <= 0) continue;
      const t = s.rlife[i] / 0.5, rad = s.rrad[i], c = s.rcol[i] * 3;
      this.r.glows.add(s.rx[i], s.ry[i], rad * 1.8 + 6, PAL[c] * 0.32 * t * t, PAL[c + 1] * 0.32 * t * t, PAL[c + 2] * 0.32 * t * t);   // explosion light pulse: feeds bloom
      const n = Math.min(110, Math.floor(rad * 5) + 8), k = 0.25 + t * 1.1;
      for (let j = 0; j < n; j++) {
        const a = (j / n) * TAU;
        b.put(this.cx(s.rx[i] + Math.cos(a) * rad), this.cy(s.ry[i] + Math.sin(a) * rad), LINE8[dir8(a + Math.PI / 2)], PAL[c] * k, PAL[c + 1] * k, PAL[c + 2] * k, 2);
      }
    }
  }

  // ------------------------------------------------------------------ HUD
  /** HUD bar in bright # and dim . cells (w cells wide). */
  private bar(label: string, v: number, row: number, r: number, g: number, b: number, w = 24): void {
    const bt = this.r.glyphs, filled = Math.max(0, Math.min(w, Math.round(v * w)));
    bt.text(label, 3, row, 0.5, 0.7, 0.8);
    const x0 = 3 + label.length + 1, cy = this.rows - 1 - row;
    bt.put(x0 - 1, cy, G.lb, 0.3, 0.5, 0.6, 1);
    bt.put(x0 + w, cy, G.rb, 0.3, 0.5, 0.6, 1);
    for (let i = 0; i < w; i++) {
      const on = i < filled;
      bt.put(x0 + i, cy, on ? G.hash : G.dotA, on ? r : 0.16, on ? g : 0.22, on ? b : 0.28, 1);
    }
  }

  private refreshHud(time: number): void {
    if (time >= this.hudT && time - this.hudT < 0.1) return;
    this.hudT = time;
    const s = this.sim;
    this.sStat1 = 'SPD ' + String(Math.sqrt(s.svx * s.svx + s.svy * s.svy) | 0).padStart(3, '0') + '   SECTOR ' + sectorOf(s.sx) + ',' + sectorOf(s.sy);
    this.sStat2 = 'GRAV ' + (this.nearGrav() ? '▲ WELL' : '· ----') + '   HOSTILE ' + String(s.nEnemy).padStart(2, '0');
    this.sScore = 'SCORE ' + String(s.score).padStart(7, '0');
    this.sKills = 'KILLS ' + String(s.kills).padStart(3, '0');
    this.sScrap = 'SCRAP ' + String(s.scrap).padStart(5, '0');
    this.sObj = 'OBJ ' + (s.objKills | 0) + '/' + s.objTarget + ' ' + OBJ_LABEL[s.objType];
    this.sMsl = s.missileCap > 0 ? 'MISSILES ' + Math.floor(s.missiles) + '/' + s.missileCap : '';
    this.sWave = 'WAVE ' + WAVES[s.phase];
  }

  private hud(time: number): void {
    const s = this.sim, bt = this.r.glyphs, cols = this.cols, rows = this.rows;
    this.refreshHud(time);
    bt.text(BOX_TOP, 1, 0, 0.25, 0.5, 0.65);
    for (let r = 1; r <= 10; r++) bt.text(BOX_MID, 1, r, 0.25, 0.5, 0.65);
    bt.text(BOX_BOT, 1, 11, 0.25, 0.5, 0.65);
    const hpv = s.hp / s.hpMax, sm = s.ship.shieldMax;
    this.bar('HULL ', hpv, 1, hpv > 0.5 ? 0.4 : 1.8, hpv > 0.25 ? 1.7 : 0.4, 0.5);
    this.bar('BOOST', s.boostE / s.boostMax, 2, 0.4, 1.2, 2.0);
    if (sm > 0) this.bar('SHLD ', s.storm > 0.3 ? 0 : s.shield / sm, 3, 0.5, 0.8, 1.9, 12);
    this.bar(s.overheat ? 'HEAT!' : 'HEAT ', s.heat / s.ship.heatMax, 4, s.overheat ? 2.0 : 1.4, s.overheat ? 0.3 : 0.7, 0.2, 12);
    bt.text(this.sStat1, 3, 5, 0.55, 0.8, 0.9);
    if (s.vert) {                                                        // altitude readout + three-notch indicator
      const b = s.szBand + 1, x0 = 26;
      bt.text('ALT', x0, 3, 0.5, 0.7, 0.8);
      for (let n = 0; n < 3; n++) bt.text(n === b ? '#' : '.', x0 + 4 + n * 2, 3, n === b ? ACCENT[0] : 0.25, n === b ? ACCENT[1] : 0.35, n === b ? ACCENT[2] : 0.4);
      bt.text(BAND_NAME[b], x0, 4, ACCENT[0] * 0.8, ACCENT[1] * 0.8, ACCENT[2] * 0.8);
    }
    bt.text(this.sStat2, 3, 6, 0.55, 0.8, 0.9);
    bt.text(this.sScore, cols - this.sScore.length - 2, 1, 1.4, 1.2, 0.5);
    bt.text(this.sKills, cols - this.sKills.length - 2, 2, 0.8, 0.8, 0.9);
    bt.text(this.sScrap, cols - this.sScrap.length - 2, 3, 1.4, 1.1, 0.3);
    bt.text(this.sObj, cols - this.sObj.length - 2, 4, 0.5, 0.85, 0.7);
    bt.text(this.sWave, cols - this.sWave.length - 2, 5, s.phase === 2 ? 1.5 : 0.5, s.phase === 2 ? 0.4 : 0.7, s.phase === 2 ? 0.3 : 0.8);
    if (this.sMsl.length > 0) bt.text(this.sMsl, cols - this.sMsl.length - 2, 6, 1.4, 0.8, 0.3);
    if (s.nBoss > 0 && s.alive) this.bossBar(time);
    if (s.alive) { this.hitArc(); if (this.showReticle) this.reticle(); }
    if (s.alive && s.dockable >= 0) {
      const m = 'PRESS  ' + this.dockKey + '  TO DOCK';
      const bl = 0.7 + 0.3 * Math.sin(time * 6);
      bt.text(m, (cols - m.length) >> 1, (rows >> 1) + 10, 0.4 * bl, 1.2 * bl, 1.5 * bl, 1);
    }
    if (this.prompt.length > 0 && s.alive) {
      bt.text(this.prompt, (cols - this.prompt.length) >> 1, 8, 1.2, 1.2, 0.6, 1);
    }
    this.radar(time);
    if (s.warn > 0 && s.alive) {
      const msg = '!! ' + EVT_NAME[s.warn] + ' ' + Math.ceil(s.warnT) + ' !!', on = Math.sin(time * 9) > -0.2;
      bt.text(msg, (cols - msg.length) >> 1, 10, on ? 1.6 : 0.7, on ? 0.7 : 0.3, 0.2, 1);
    }

    if (s.alive && s.time < 14) {
      const a = Math.min(1, (14 - s.time) / 3) * Math.min(1, s.time / 1.2);
      bt.text(HINT, (cols - HINT.length) >> 1, rows - 4, 0.6 * a + 0.05, 0.95 * a + 0.05, 1.2 * a + 0.05, a > 0.3 ? 1 : 2);
      bt.text(TITLE, (cols - TITLE.length) >> 1, (rows >> 1) - 10, 1.0 * a, 2.4 * a, 3.2 * a, 2);
    }
    if (!s.alive && s.deadT > 1.0) {
      const w = 60, x0 = (cols - w) >> 1, y0 = (rows >> 1) - 7, nn = Math.min(4, this.notable.length);
      const pad = ' '.repeat(w);
      for (let r = 0; r < 12 + nn; r++) bt.text(pad, x0, y0 + r, 0, 0, 0, 1);
      if (s.deadT < 1.1 || this.sOver1.length === 0) {
        const acc = s.shots > 0 ? Math.round(100 * s.hits / s.shots) : 0, m = (s.time / 60) | 0, sec = (s.time | 0) % 60;
        this.sOver1 = this.sScore + '    BEST ' + String(Math.max(this.hiScore, s.score)).padStart(7, '0');
        this.sOver2 = 'TIME ' + m + ':' + String(sec).padStart(2, '0') + '   KILLS ' + s.kills + '   ACC ' + acc + '%';
        this.sOver3 = 'SCRAP COLLECTED ' + s.scrapTotal + (s.score > this.hiScore ? '   NEW BEST!' : '');
        this.sOver4 = s.ship.name + '   DISTANCE ' + (s.dist / 1000).toFixed(1) + ' KU   SURVEY ' + Math.round(this.surveyPct * 100) + '%';
      }
      const ctr = (m: string): number => x0 + ((w - m.length) >> 1);
      bt.text(LOST, ctr(LOST), y0 + 1, 1.6, 0.35, 0.3);
      bt.text(this.sOver1, ctr(this.sOver1), y0 + 3, 1.3, 1.1, 0.5);
      bt.text(this.sOver2, ctr(this.sOver2), y0 + 5, 0.7, 1.0, 1.1);
      bt.text(this.sOver3, ctr(this.sOver3), y0 + 6, 1.2, 1.0, 0.4);
      bt.text(this.sOver4, ctr(this.sOver4), y0 + 7, ACCENT[0] * 0.8, ACCENT[1] * 0.8, ACCENT[2] * 0.8);
      for (let i = 0; i < nn; i++) { const l = this.notable[this.notable.length - nn + i]; bt.text(l, ctr(l), y0 + 9 + i, 0.5, 0.75, 0.8); }
      const bl = 0.6 + 0.4 * Math.sin(time * 5);
      bt.text(RELAUNCH, ctr(RELAUNCH), y0 + 10 + nn, 0.5 * bl + 0.3, 1.0 * bl + 0.3, 1.2 * bl + 0.3);
    }
  }

  private bossBar(time: number): void {
    const s = this.sim, bt = this.r.glyphs, w = 36, x0 = (this.cols - w) >> 1, cy = this.rows - 3;
    const f = Math.max(0, s.bossHp / s.bossMax), n = Math.round(f * w), p = 0.8 + 0.2 * Math.sin(time * 8);
    bt.text('D R E A D N O U G H T', (this.cols - 21) >> 1, 1, 1.6 * p, 0.35, 0.25);
    bt.put(x0 - 1, cy, G.lb, 0.8, 0.3, 0.3, 1); bt.put(x0 + w, cy, G.rb, 0.8, 0.3, 0.3, 1);
    for (let i = 0; i < w; i++) bt.put(x0 + i, cy, i < n ? G.full : G.light, i < n ? 1.5 : 0.2, i < n ? 0.3 : 0.1, i < n ? 0.25 : 0.1, 1);
  }

  /** Directional damage arc: bright glyphs on an ellipse around the ship toward whatever hit you. */
  private hitArc(): void {
    const s = this.sim; if (s.hitT <= 0) return;
    const bt = this.r.glyphs, k = s.hitT;
    for (let j = -1; j <= 1; j++) {
      const a = s.hitAng + j * 0.13;
      bt.put(this.cols * 0.5 + Math.cos(a) * 20, this.rows * 0.5 + Math.sin(a) * 10, j === 0 ? G.at : G.hash, 1.9 * k, 0.25 * k, 0.2 * k, 0);
    }
  }

  /** Lead-aim reticle on the nearest hostile (bolts travel ~215 u/s, so aim where it will be). */
  private reticle(): void {
    const s = this.sim; let best = -1, bd = 300 * 300;
    if (s.aimAssist >= 2 && s.assistTarget >= 0) {            // lead / homing: mark the enemy the assist is working on
      best = s.assistTarget; const dx = s.ex[best] - s.sx, dy = s.ey[best] - s.sy; bd = dx * dx + dy * dy;
    } else for (let i = 0; i < MAX_E; i++) {
      const k = s.ek[i];
      if (k === Kind.None || k === Kind.Mine || k === Kind.Asteroid || k === Kind.Station || k === Kind.Freighter || k === Kind.Comet || k === Kind.Hauler) continue;
      const dx = s.ex[i] - s.sx, dy = s.ey[i] - s.sy, d2 = dx * dx + dy * dy;
      if (d2 < bd) { bd = d2; best = i; }
    }
    if (best < 0) return;
    const t = Math.sqrt(bd) / 215;
    const lx = s.ex[best] + (s.evx[best] - s.svx * 0.5) * t, ly = s.ey[best] + (s.evy[best] - s.svy * 0.5) * t;
    const cx = this.cx(lx), cy = this.cy(ly);
    if (cx < 1 || cx > this.cols - 1 || cy < 1 || cy > this.rows - 1) return;
    this.r.glyphs.put(cx, cy, G.plus, 1.5, 1.4, 0.4, 0);
    this.r.glyphs.put(cx - 2, cy, G.lb, 1.0, 0.9, 0.3, 0); this.r.glyphs.put(cx + 2, cy, G.rb, 1.0, 0.9, 0.3, 0);
  }

  private nearGrav(): boolean {
    const s = this.sim;
    for (let k = 0; k < s.nPl; k++) {
      const o = k * PLANET_STRIDE, dx = s.pl[o] - s.sx, dy = s.pl[o + 1] - s.sy;
      if (Math.sqrt(dx * dx + dy * dy) < s.pl[o + 2] + gravReach(s.pl[o + 2])) return true;
    }
    return false;
  }

  private blip(wx: number, wy: number, g: number, r: number, gg: number, b: number): void {
    const s = this.sim;
    if (s.flare > 0.3 && Math.sin(wx * 12.9 + wy * 78.2 + this.rtime * 37) > 0.2) return;      // solar flare jams the radar
    const c = this.rdMx + Math.round((wx - s.sx) * this.rdSx), rr = this.rdMy - Math.round((wy - s.sy) * this.rdSx);
    if (c <= this.rdX0 || c >= this.rdX0 + this.rdW - 1 || rr <= this.rdTop || rr >= this.rdTop + this.rdH - 1) return;
    this.r.glyphs.put(c, this.rows - 1 - rr, g, r, gg, b, 1);
  }

  private radar(time: number): void {
    const s = this.sim, bt = this.r.glyphs; this.rtime = time;
    const w = 31, h = 13, x0 = this.cols - w - 2, top = this.rows - h - 1;
    const range = 330, sweep = (time * 1.1) % TAU;
    this.rdX0 = x0; this.rdTop = top; this.rdW = w; this.rdH = h;
    this.rdSx = (w - 2) / (2 * range); this.rdMx = x0 + (w >> 1); this.rdMy = top + (h >> 1);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const border = r === 0 || r === h - 1 || c === 0 || c === w - 1;
      let g = G.dotA, cr = 0.05, cg = 0.12, cb = 0.12;
      if (border) {
        g = r === 0 ? (c === 0 ? G.tl : c === w - 1 ? G.tr : G.h2) : r === h - 1 ? (c === 0 ? G.bl : c === w - 1 ? G.br : G.h2) : G.v2;
        cr = 0.25; cg = 0.5; cb = 0.65;
      } else {
        const rx = (c - (w >> 1)) / (w * 0.5), ry = (r - (h >> 1)) / (h * 0.5);
        const ang = Math.atan2(-ry, rx), dd = (sweep - ang + TAU * 4) % TAU;
        const glow = dd < 1.1 ? (1 - dd / 1.1) : 0;
        if (rx * rx + ry * ry > 1.0) g = 0;
        cg += glow * 0.45; cb += glow * 0.3;
      }
      bt.put(x0 + c, this.rows - 1 - (top + r), g, cr, cg, cb, 1);
    }
    for (let k = 0; k < s.nPl; k++) {
      const o = k * PLANET_STRIDE;
      this.blip(s.pl[o], s.pl[o + 1], s.pl[o + 2] * this.rdSx > 2.2 ? G.disc : G.ring, 0.3, 1.0, 0.55);
    }
    for (let i = 0; i < MAX_E; i++) {
      const k = s.ek[i];
      if (k === Kind.None) continue;
      if (k === Kind.Asteroid) this.blip(s.ex[i], s.ey[i], G.dot, 0.45, 0.45, 0.5);
      else if (k === Kind.Station) this.blip(s.ex[i], s.ey[i], G.dia, 0.4, 0.9, 1.5);
      else if (k === Kind.Comet) this.blip(s.ex[i], s.ey[i], G.star, 1.8, 2.0, 2.4);
      else if (k === Kind.Hauler) this.blip(s.ex[i], s.ey[i], G.dotA, 1.4, 0.9, 0.3);
      else if (k === Kind.Freighter) this.blip(s.ex[i], s.ey[i], G.dia, 0.4, 1.6, 0.6);
      else if (k === Kind.Mine) this.blip(s.ex[i], s.ey[i], G.dotA, 1.5, 0.4, 0.2);
      else this.blip(s.ex[i], s.ey[i], G.tri, 1.6, 0.3, 0.25);
    }
    for (let i = 0; i < MAX_S; i++) if (s.scl[i] > 1000) this.blip(s.scx[i], s.scy[i], G.dia, 1.5, 1.2, 0.3);   // derelict caches
    bt.put(this.rdMx, this.rows - 1 - this.rdMy, G.plus, 1.4, 1.8, 1.8, 1);
  }
}
