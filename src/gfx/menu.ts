import { gi } from './atlas';
import type { GlyphBatch } from './batch';

const TL = gi('╔'), TR = gi('╗'), BL = gi('╚'), BR = gi('╝'), H = gi('═'), V = gi('║');

/**
 * Centered glyph panel with a title, selectable lines and a footer. Menus are cold paths (only drawn while paused/docked),
 * so building a few strings per frame here is fine.
 */
/** Top-left cell (in row-from-top coordinates) of the panel `panel()` would draw, so callers can overlay coloured glyphs. */
export function panelOrigin(cols: number, rows: number, title: string, lines: string[], footer: string): { x: number; y: number } {
  let w = Math.max(title.length, footer.length);
  for (const l of lines) w = Math.max(w, l.length + 4);
  w += 6;
  const h = lines.length + 6;
  return { x: (cols - w) >> 1, y: Math.max(1, (rows - h) >> 1) };
}

export function panel(bt: GlyphBatch, cols: number, rows: number, title: string, lines: string[], sel: number, footer: string, tone = 0, dx = 0): void {
  let w = Math.max(title.length, footer.length);
  for (const l of lines) w = Math.max(w, l.length + 4);
  w += 6;
  const h = lines.length + 6, x0 = ((cols - w) >> 1) + dx, y0 = Math.max(1, (rows - h) >> 1);
  const br = tone === 1 ? 1.0 : 0.25, bg = tone === 1 ? 0.7 : 0.5, bb = tone === 1 ? 0.3 : 0.65;
  const blank = ' '.repeat(w - 2);
  for (let r = 0; r < h; r++) {
    const y = y0 + r;
    if (r === 0 || r === h - 1) {
      bt.put(x0, rows - 1 - y, r === 0 ? TL : BL, br, bg, bb, 1);
      bt.put(x0 + w - 1, rows - 1 - y, r === 0 ? TR : BR, br, bg, bb, 1);
      for (let c = 1; c < w - 1; c++) bt.put(x0 + c, rows - 1 - y, H, br, bg, bb, 1);
    } else {
      bt.put(x0, rows - 1 - y, V, br, bg, bb, 1); bt.put(x0 + w - 1, rows - 1 - y, V, br, bg, bb, 1);
      bt.text(blank, x0 + 1, y, 0, 0, 0, 1);
    }
  }
  bt.text(title, x0 + ((w - title.length) >> 1), y0 + 1, 0.9, 2.0, 2.6);
  for (let i = 0; i < lines.length; i++) {
    const on = i === sel;
    bt.text((on ? '> ' : '  ') + lines[i], x0 + 3, y0 + 3 + i, on ? 1.6 : 0.5, on ? 1.5 : 0.75, on ? 0.5 : 0.85);
  }
  bt.text(footer, x0 + ((w - footer.length) >> 1), y0 + h - 2, 0.45, 0.6, 0.7);
}
