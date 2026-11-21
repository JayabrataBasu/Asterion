/** Live-tunable render settings (mutated by key bindings; read every frame by the renderer). */
export interface Settings {
  cellCss: number;     // cell width in CSS px (height is always 2x)
  weight: number;      // font weight for the atlas
  ramp: number;        // index into RAMPS
  bloom: number;       // 0 = off
  bloomThr: number;
  bloomLevels: number;
  auto: boolean;
  chroma: number;
  curve: number;
  scan: number;
  vig: number;
  grain: number;
  exposure: number;
  dither: number;
  bgK: number;
  fgBase: number;
  fgGain: number;
  nebula: number;
  sun: number;
  perf: boolean;
  hud: boolean;
  cb: boolean;         // colour-blind-safe palette
  reduceFx: boolean;   // reduced shake / flashes
}

export const settings: Settings = {
  cellCss: 8, weight: 600, ramp: 0, bloom: 1.0, bloomThr: 0.8, bloomLevels: 5, auto: true, chroma: 0.005, curve: 0.0, scan: 0.07, vig: 0.55,
  grain: 0.025, exposure: 2.1, dither: 1, bgK: 0.5, fgBase: 0.55, fgGain: 1.3, nebula: 1.0, sun: 1.0, perf: false, hud: true, cb: false, reduceFx: false,
};

export const PRESETS: Record<string, Partial<Settings>> = {
  low:    { cellCss: 12, bloom: 0, chroma: 0, scan: 0, grain: 0, curve: 0 },
  medium: { cellCss: 10, bloom: 0.7, chroma: 0.004, scan: 0.04, grain: 0.02, curve: 0 },
  high:   { cellCss: 8, bloom: 1.0, chroma: 0.005, scan: 0.07, grain: 0.03, curve: 0 },
  ultra:  { cellCss: 6, bloom: 1.25, chroma: 0.014, scan: 0.09, grain: 0.04, curve: 0.04 },
};
