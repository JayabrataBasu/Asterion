import { TAU, hash2 } from '../core/util';
import { settings } from '../core/config';
import { DT, Kind, MAX_B, MAX_E, MAX_P, MAX_M, MAX_R, MAX_S, PK, Sim } from '../sim/sim';
import { PLANET_STRIDE, gravReach, sectorOf } from '../sim/world';
import { gi } from './atlas';
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
  lb: gi('['), rb: gi(']'),
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
const EVT_NAME = ['', 'COMET INBOUND', 'METEOR SHOWER', 'SOLAR FLARE', 'ION STORM'];
const OBJ_LABEL = ['HOSTILES', 'SCRAP', 'ASTEROIDS', 'SECONDS', 'DEFEND STATION (STAY CLOSE)', 'ESCORT THE FREIGHTER (STAY CLOSE)'];
const WAVES = ['CALM', 'BUILDING', 'PEAK', 'LULL'];

function dir8(a: number): number { return ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8; }

const HINT = 'W / ^  THRUST      A D / < >  TURN      S  BRAKE      SPACE  FIRE      SHIFT  BOOST';
const TITLE = 'A S T E R I O N';
const BOX_TOP = '╔════════════════════════════╗';
const BOX_MID = '║                            ║';
const BOX_BOT = '╚════════════════════════════╝';
const LOST = 'S I G N A L   L O S T';
const RELAUNCH = 'R / ENTER  RELAUNCH      C  COPY RESULT';

export class FrameBuilder {
  camX = 0; camY = 0; alpha = 0;
  fx = 1; private rtime = 0;
  prompt = ''; dockKey = 'E'; hiScore = 0; showReticle = true;
  private sScrap = ''; private sObj = ''; private sWave = ''; private sMsl = ''; private sOver1 = ''; private sOver2 = ''; private sOver3 = '';
  private cols = 0; private rows = 0; private asp = 2;
  private thrS = 0.1;
  private hudT = -9; private sStat1 = ''; private sStat2 = ''; private sScore = ''; private sKills = '';
  // radar frame
  private rdX0 = 0; private rdTop = 0; private rdSx = 0; private rdMx = 0; private rdMy = 0; private rdW = 0; private rdH = 0;

  constructor(private sim: Sim, private r: Renderer) {}

  private cx(wx: number): number { return wx - this.camX + this.cols * 0.5; }
  private cy(wy: number): number { return (wy - this.camY) / this.asp + this.rows * 0.5; }
  /** Planet shadow: objects behind a planet (opposite the sun) are darkened, matching the planet shader's light direction. */
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
    return f;
  }
  private visible(wx: number, wy: number, size: number): boolean {
    const cx = this.cx(wx), cy = this.cy(wy);
    return cx > -size && cx < this.cols + size && cy > -size / this.asp && cy < this.rows + size / this.asp;
  }

  build(camX: number, camY: number, alpha: number, time: number, showHud: boolean): void {
    const r = this.r;
    this.camX = camX; this.camY = camY; this.alpha = alpha;
    this.cols = r.cols; this.rows = r.rows; this.asp = r.aspect;
    this.sprites(time);
    this.scraps(time);
    this.dust(time);
    this.particles();
    this.rings();
    this.lifeEnts(time);
    if (showHud) this.hud(time);
  }

  // ------------------------------------------------------------------ sprites (SDF layer)
  private sprites(time: number): void {
    const s = this.sim, sp = this.r.sprites, gl = this.r.glows;
    const back = DT * (1 - this.alpha);
    for (let i = 0; i < MAX_E; i++) {
      const k = s.ek[i];
      if (k !== Kind.Asteroid && k !== Kind.Station) continue;
      const x = s.ex[i] - s.evx[i] * back, y = s.ey[i] - s.evy[i] * back;
      if (k === Kind.Station) {
        if (this.visible(x, y, 24)) sp.add(x, y, 0, 24, Spr.Station, s.eseed[i], 0, 0, 0.75, this.shade(x, y));
      } else {
        const R = s.er[i];
        if (this.visible(x, y, R * 1.6)) sp.add(x, y, 0, R * 1.5, Spr.Asteroid, s.eseed[i], s.eflash[i] > 0 ? s.eflash[i] * 0.6 : 0, R, 1, this.shade(x, y));
      }
    }
    for (let i = 0; i < MAX_E; i++) {
      if (s.ek[i] !== Kind.Mine) continue;
      const x = s.ex[i], y = s.ey[i];
      if (!this.visible(x, y, 8)) continue;
      const armed = s.et[i] > 1.0;
      sp.add(x, y, 0, 5, Spr.Mine, s.eseed[i], 0, armed ? 1 : 0, 0.8);
      const blink = armed ? (Math.sin(time * 9 + i) > 0 ? 1 : 0.3) : 0.2;
      gl.add(x, y, armed ? 5 : 3, 0.5 * blink, 0.07 * blink, 0.05 * blink);
    }
    for (let i = 0; i < MAX_E; i++) {
      if (s.ek[i] !== Kind.Freighter) continue;
      const x = s.ex[i], y = s.ey[i];
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
      const x = s.ex[i] - s.evx[i] * back, y = s.ey[i] - s.evy[i] * back, a = s.ea[i];
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
      const x = s.spx + (s.sx - s.spx) * al, y = s.spy + (s.sy - s.spy) * al;
      let da = s.sa - s.spa; da = Math.atan2(Math.sin(da), Math.cos(da));
      const a = s.spa + da * al;
      const target = s.thrusting ? (s.boosting ? 1.35 : 0.9) : 0.12;
      this.thrS += (target - this.thrS) * 0.22;
      const S = s.ship, rk = S.radius / 2.4;
      sp.add(x, y, a, S.artSize, S.art, this.hullState(), s.hitFlash * 0.8, this.thrS, 0.72, this.shade(x, y) * (S.darkSig < 1 ? 1 - 0.6 * this.dark : 1));
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
      const x = s.ex[i] - s.evx[i] * back, y = s.ey[i] - s.evy[i] * back;
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
    // bolts on top
    for (let i = 0; i < MAX_B; i++) {
      if (s.blife[i] <= 0) continue;
      const x = s.bx[i] - s.bvx[i] * back, y = s.by[i] - s.bvy[i] * back;
      if (!this.visible(x, y, 6)) continue;
      const a = Math.atan2(s.bvy[i], s.bvx[i]);
      const cb = settings.cb ? 1 : 0;
      if (s.bown[i] === 0) { sp.add(x, y, a, 4, Spr.Bolt, 0, 0, cb, 0.8); if (cb) gl.add(x, y, 4.5, 0.05, 0.2, 0.6); else gl.add(x, y, 4.5, 0.55, 0.07, 0.05); }
      else { sp.add(x, y, a, 3.5, Spr.EBolt, 0, 0, cb, 0.8); if (cb) gl.add(x, y, 4.5, 0.6, 0.3, 0.04); else gl.add(x, y, 4.5, 0.08, 0.5, 0.12); }
    }
  }

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
      const x = s.ex[i], y = s.ey[i], a = s.ea[i];
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
  private bar(label: string, v: number, row: number, r: number, g: number, b: number): void {
    const bt = this.r.glyphs, w = 14, filled = Math.max(0, Math.min(w, Math.round(v * w)));
    bt.text(label, 3, row, 0.45, 0.6, 0.7);
    const x0 = 3 + label.length + 1, cy = this.rows - 1 - row;
    bt.put(x0 - 1, cy, G.lb, 0.3, 0.5, 0.6, 1);
    bt.put(x0 + w, cy, G.rb, 0.3, 0.5, 0.6, 1);
    for (let i = 0; i < w; i++) {
      const on = i < filled;
      bt.put(x0 + i, cy, on ? G.full : G.light, on ? r : 0.12, on ? g : 0.16, on ? b : 0.2, 1);
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
    for (let r = 1; r <= 4; r++) bt.text(BOX_MID, 1, r, 0.25, 0.5, 0.65);
    bt.text(BOX_BOT, 1, 5, 0.25, 0.5, 0.65);
    const hpv = s.hp / s.hpMax;
    this.bar('HULL ', hpv, 1, hpv > 0.5 ? 0.3 : 1.4, hpv > 0.25 ? 1.2 : 0.35, 0.45);
    this.bar('BOOST', s.boostE / s.boostMax, 2, 0.3, 0.9, 1.5);
    bt.text(this.sStat1, 3, 3, 0.55, 0.8, 0.9);
    bt.text(this.sStat2, 3, 4, 0.55, 0.8, 0.9);
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
      const w = 46, x0 = (cols - w) >> 1, y0 = (rows >> 1) - 5;
      const pad = ' '.repeat(w);
      for (let r = 0; r < 10; r++) bt.text(pad, x0, y0 + r, 0, 0, 0, 1);
      if (s.deadT < 1.1 || this.sOver1.length === 0) {
        const acc = s.shots > 0 ? Math.round(100 * s.hits / s.shots) : 0, m = (s.time / 60) | 0, sec = (s.time | 0) % 60;
        this.sOver1 = this.sScore + '    BEST ' + String(Math.max(this.hiScore, s.score)).padStart(7, '0');
        this.sOver2 = 'TIME ' + m + ':' + String(sec).padStart(2, '0') + '   KILLS ' + s.kills + '   ACC ' + acc + '%';
        this.sOver3 = 'SCRAP COLLECTED ' + s.scrapTotal + (s.score > this.hiScore ? '   NEW BEST!' : '');
      }
      const ctr = (m: string): number => x0 + ((w - m.length) >> 1);
      bt.text(LOST, ctr(LOST), y0 + 1, 1.6, 0.35, 0.3);
      bt.text(this.sOver1, ctr(this.sOver1), y0 + 3, 1.3, 1.1, 0.5);
      bt.text(this.sOver2, ctr(this.sOver2), y0 + 5, 0.7, 1.0, 1.1);
      bt.text(this.sOver3, ctr(this.sOver3), y0 + 6, 1.2, 1.0, 0.4);
      const bl = 0.6 + 0.4 * Math.sin(time * 5);
      bt.text(RELAUNCH, ctr(RELAUNCH), y0 + 8, 0.5 * bl + 0.3, 1.0 * bl + 0.3, 1.2 * bl + 0.3);
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
