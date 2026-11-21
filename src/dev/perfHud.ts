/** Rolling perf stats + a DOM readout refreshed ~4x/s (DOM string building is off the hot path). */
export class PerfHud {
  cpuMs = 0; simMs = 0; frameMs = 16.7; fps = 60; maxCpu = 0;
  private lastText = 0; private fpsAcc = 0; private fpsN = 0; private worst = 0;
  constructor(private el: HTMLElement) {}
  frame(dtMs: number, cpuMs: number, simMs: number): void {
    this.cpuMs += (cpuMs - this.cpuMs) * 0.08; this.simMs += (simMs - this.simMs) * 0.08;
    this.frameMs += (dtMs - this.frameMs) * 0.08;
    this.fpsAcc += dtMs; this.fpsN++;
    if (dtMs > this.worst) this.worst = dtMs;
  }
  show(on: boolean): void { this.el.style.display = on ? 'block' : 'none'; }
  update(now: number, lines: () => string): void {
    if (now - this.lastText < 250) return;
    this.lastText = now;
    this.fps = this.fpsN / (this.fpsAcc / 1000 || 1); this.fpsAcc = 0; this.fpsN = 0;
    const w = this.worst; this.worst = 0;
    this.el.textContent = `${this.fps.toFixed(0)} fps  frame ${this.frameMs.toFixed(1)}ms (worst ${w.toFixed(1)})\n` + lines();
  }
}
