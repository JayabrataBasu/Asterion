import { Ev, type Sim } from '../sim/sim';

/**
 * Zero-asset WebAudio: SFX synth (positional pan + shared reverb send) and a small generative score that
 * follows the wave phase / boss fight. Created lazily on the first user gesture (browser autoplay policy).
 */
const CHORDS: { root: number; third: number }[] = [
  { root: 110.0, third: 3 },    // Am
  { root: 87.31, third: 4 },    // F
  { root: 130.81, third: 4 },   // C
  { root: 98.0, third: 4 },     // G
];
const semi = (n: number): number => Math.pow(2, n / 12);

export class Audio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private reverb!: ConvolverNode;
  private noise!: AudioBuffer;
  private engGain!: GainNode;
  private engFilt!: BiquadFilterNode;
  private engOsc!: OscillatorNode;
  private voices = 0;
  private alarmT = 0;
  // music
  private nextT = 0; private step = 0; private inten = 0.1;
  muted = false;
  volume = 0.7;

  /** Call from a key/mouse handler. Safe to call repeatedly. */
  unlock(): void {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 6;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(comp); comp.connect(ctx.destination);

    const len = ctx.sampleRate * 1.5;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let s = 1;
    for (let i = 0; i < len; i++) { s = (s * 1664525 + 1013904223) >>> 0; d[i] = (s / 4294967296) * 2 - 1; }

    // reverb: decaying-noise impulse response
    this.reverb = ctx.createConvolver();
    const il = Math.floor(ctx.sampleRate * 1.8), imp = ctx.createBuffer(2, il, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const ch = imp.getChannelData(c);
      for (let i = 0; i < il; i++) { s = (s * 1664525 + 1013904223) >>> 0; ch[i] = ((s / 4294967296) * 2 - 1) * Math.pow(1 - i / il, 2.6); }
    }
    this.reverb.buffer = imp;
    const rg = ctx.createGain(); rg.gain.value = 0.45;
    this.reverb.connect(rg); rg.connect(this.master);

    this.musicBus = ctx.createGain(); this.musicBus.gain.value = 0.0;
    this.musicBus.connect(this.master);
    const mrev = ctx.createGain(); mrev.gain.value = 0.5; this.musicBus.connect(mrev); mrev.connect(this.reverb);

    // engine: detuned saw through lowpass
    this.engGain = ctx.createGain(); this.engGain.gain.value = 0;
    this.engFilt = ctx.createBiquadFilter(); this.engFilt.type = 'lowpass'; this.engFilt.frequency.value = 220;
    this.engOsc = ctx.createOscillator(); this.engOsc.type = 'sawtooth'; this.engOsc.frequency.value = 46;
    this.engOsc.connect(this.engFilt); this.engFilt.connect(this.engGain); this.engGain.connect(this.master);
    this.engOsc.start();
    this.nextT = ctx.currentTime + 0.2;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.03);
  }
  setVolume(v: number): void { this.volume = v; if (this.ctx && !this.muted) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03); }

  /** Per-frame: engine, alarm, music intensity, and drain the sim event ring. */
  update(sim: Sim, dt: number, active = true): void {
    const ctx = this.ctx;
    if (!ctx) { sim.evTail = sim.evHead; return; }
    const t = ctx.currentTime;
    const sp = Math.hypot(sim.svx, sim.svy);
    const thr = active && sim.alive && sim.thrusting ? (sim.boosting ? 1 : 0.6) : 0;
    this.engGain.gain.setTargetAtTime(0.03 + thr * 0.09, t, 0.08);
    this.engOsc.frequency.setTargetAtTime(40 + sp * 0.18 + thr * 26, t, 0.1);
    this.engFilt.frequency.setTargetAtTime(160 + thr * 520 + (sim.boosting ? 500 : 0), t, 0.1);

    if (active && sim.alive && sim.hp < 30) {
      this.alarmT -= dt;
      if (this.alarmT <= 0) { this.alarmT = 0.9; this.tone(880, 880, 0.12, 'square', 0.05, 0, 0); }
    } else this.alarmT = 0;

    // ---- music
    const target = !sim.alive ? 0.04 : !active ? 0.12 : sim.nBoss > 0 ? 1.0 : [0.12, 0.4, 0.75, 0.25][sim.phase];
    this.inten += (target - this.inten) * (1 - Math.exp(-0.6 * dt));
    this.musicBus.gain.setTargetAtTime(0.32 * (0.35 + 0.65 * this.inten), t, 0.3);
    this.scheduleMusic();

    // ---- events
    const px = sim.sx;
    for (; sim.evTail < sim.evHead; sim.evTail++) {
      const i = sim.evTail & 255;
      const dx = sim.evX[i] - px, dy = sim.evY[i] - sim.sy;
      const att = 1 / (1 + (dx * dx + dy * dy) / 20000);
      const pan = Math.max(-1, Math.min(1, dx / 140));
      const m = sim.evM[i];
      switch (sim.evT[i]) {
        case Ev.PlayerShot: this.tone(1250, 280, 0.11, 'sawtooth', 0.07, 0, 0); break;
        case Ev.EnemyShot: this.tone(520, 160, 0.14, 'square', 0.05 * att + 0.01, pan, 0.1); break;
        case Ev.Hit: this.burst(2400, 0.05, 0.06 * att + 0.01, 'bandpass', pan, 0); break;
        case Ev.Explosion: this.boom(m, att, pan); break;
        case Ev.ShipHit: this.tone(150, 55, 0.25, 'sawtooth', 0.12, 0, 0.15); this.burst(900, 0.18, 0.12, 'lowpass', 0, 0.1); break;
        case Ev.Kill: this.tone(660, 990, 0.08, 'triangle', 0.04, pan, 0); break;
        case Ev.Pickup: this.tone(1100 + Math.min(m, 10) * 60, 1700, 0.07, 'triangle', 0.035, pan, 0.1); break;
        case Ev.Heal: this.tone(520, 520, 0.1, 'sine', 0.06, 0, 0.2); this.tone(780, 780, 0.18, 'sine', 0.06, 0, 0.2); break;
        case Ev.Dash: this.burst(1800, 0.22, 0.1, 'bandpass', 0, 0.1); this.tone(300, 900, 0.18, 'sine', 0.05, 0, 0); break;
        case Ev.Missile: this.burst(1400, 0.5, 0.09, 'bandpass', 0, 0.25); this.tone(180, 700, 0.45, 'sawtooth', 0.05, 0, 0.15); break;
        case Ev.Boss: this.tone(70, 55, 1.4, 'sawtooth', 0.14, 0, 0.5); this.tone(105, 80, 1.4, 'square', 0.06, 0, 0.5); break;
        case Ev.Objective: this.tone(520, 520, 0.12, 'triangle', 0.06, 0, 0.2); this.tone(780, 780, 0.2, 'triangle', 0.06, 0, 0.3); break;
        case Ev.Dock: this.tone(440, 440, 0.15, 'sine', 0.07, 0, 0.3); this.tone(660, 660, 0.3, 'sine', 0.07, 0, 0.3); break;
        case Ev.Charge: this.tone(300, 900, 0.5, 'sine', 0.045 * att + 0.01, pan, 0.1); break;
      }
    }
  }

  // ---- score ---------------------------------------------------------------------------------
  /** Generative score on an eighth-note grid: pad per chord, bass + arpeggio as intensity rises, drums for peaks / boss. */
  private scheduleMusic(): void {
    const ctx = this.ctx!;
    const eighth = 60 / 92 / 2;
    if (this.nextT < ctx.currentTime - 0.5) this.nextT = ctx.currentTime + 0.05;
    let guard = 0;
    while (this.nextT < ctx.currentTime + 0.3 && guard++ < 8) {
      const t = this.nextT, s = this.step, ch = CHORDS[((s / 16) | 0) % 4], I = this.inten;
      const third = semi(ch.third), fifth = semi(7);
      if (s % 16 === 0) {
        for (const r of [2, 2 * third, 2 * fifth]) this.mNote('triangle', ch.root * r, ch.root * r, t, eighth * 16.5, 0.03 + 0.02 * I, 1.2, 900 + 900 * I);
      }
      if (I > 0.25 && s % 4 === 0) this.mNote('sawtooth', ch.root, ch.root, t, eighth * 3, 0.05 + 0.03 * I, 0.01, 260);
      if (I > 0.35 && ((s * 7 + ((s / 16) | 0)) % 3 !== 0 || I > 0.8)) {
        const notes = [1, third, fifth, 2, 2 * third, 2 * fifth];
        const n = notes[(s * 5 + (s >> 2)) % notes.length];
        this.mNote('triangle', ch.root * 2 * n, ch.root * 2 * n, t, eighth * 1.6, 0.02 + 0.03 * I, 0.004, 3000, ((s & 1) ? 0.4 : -0.4));
      }
      if (I > 0.6) {
        if (s % 2 === 0) this.mNote('sine', 120, 38, t, 0.2, 0.22, 0.002, 400);
        else this.mHat(t, 0.025 + 0.02 * I);
      }
      if (I > 0.9) this.mNote('sawtooth', ch.root * 0.5, ch.root * 0.5, t, eighth * 0.9, 0.05, 0.005, 200);
      this.nextT += eighth; this.step++;
    }
  }

  private mNote(type: OscillatorType, f0: number, f1: number, at: number, dur: number, vol: number, attack: number, cutoff: number, pan = 0): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
    o.type = type; o.frequency.setValueAtTime(f0, at);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), at + dur);
    f.type = 'lowpass'; f.frequency.value = cutoff;
    g.gain.setValueAtTime(0.0001, at); g.gain.linearRampToValueAtTime(vol, at + Math.max(0.003, attack));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(f); f.connect(g);
    if (pan !== 0 && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); p.connect(this.musicBus); } else g.connect(this.musicBus);
    o.start(at); o.stop(at + dur + 0.05);
  }

  private mHat(at: number, vol: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
    const g = ctx.createGain(); g.gain.setValueAtTime(vol, at); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    src.connect(f); f.connect(g); g.connect(this.musicBus);
    src.start(at, Math.random() * 0.8); src.stop(at + 0.07);
  }

  // ---- sfx voices ----------------------------------------------------------------------------
  private out(node: AudioNode, pan: number, wet: number): void {
    const ctx = this.ctx!;
    let last: AudioNode = node;
    if (pan !== 0 && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; node.connect(p); last = p; }
    last.connect(this.master);
    if (wet > 0) { const w = ctx.createGain(); w.gain.value = wet; last.connect(w); w.connect(this.reverb); }
  }

  private tone(f0: number, f1: number, dur: number, type: OscillatorType, vol: number, pan: number, wet: number): void {
    const ctx = this.ctx; if (!ctx || this.voices > 28) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); this.out(g, pan, wet);
    this.voices++; o.onended = () => { this.voices--; };
    o.start(t); o.stop(t + dur + 0.02);
  }

  private burst(freq: number, dur: number, vol: number, type: BiquadFilterType, pan: number, wet: number): void {
    const ctx = this.ctx; if (!ctx || this.voices > 28) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); this.out(g, pan, wet);
    this.voices++; src.onended = () => { this.voices--; };
    src.start(t, Math.random() * 0.8); src.stop(t + dur + 0.02);
  }

  private boom(power: number, att: number, pan: number): void {
    const v = Math.min(1, 0.25 + power * 0.18) * (0.25 + 0.75 * att);
    this.burst(500 + 700 / (1 + power), 0.25 + power * 0.18, 0.22 * v, 'lowpass', pan, 0.35);
    this.tone(90, 34, 0.3 + power * 0.1, 'sine', 0.26 * v, pan, 0.2);
  }
}
