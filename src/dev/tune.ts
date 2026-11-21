import type { Sim } from '../sim/sim';
import { FIELDS, RATING_KEYS, ROSTER, bar, derive, getField, setField, shipById, validate, type Hardpoint } from '../sim/ships';

/**
 * Live tuning panel (?tune=1): a slider for every ShipDef field acting on the flown ship in place, derived readouts,
 * category ratings, validator issues, reset and copy-as-JSON. Developer overlay (DOM, like ?perf=1): never shown in normal play.
 */
export function mountTuner(sim: Sim, onSwap: (id: string) => void): void {
  const root = document.createElement('div');
  root.id = 'tune';
  root.style.cssText = 'position:fixed;right:0;top:0;bottom:0;width:380px;overflow:auto;background:#020608e6;color:#9cd;font:11px/1.3 monospace;z-index:3;padding:6px 8px;box-sizing:border-box';
  document.body.appendChild(root);
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement, text = '', css = ''): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag); e.textContent = text; if (css) e.style.cssText = css; parent.appendChild(e); return e;
  };
  const head = el('div', root, '', 'display:flex;gap:6px;align-items:center;margin-bottom:4px');
  el('b', head, 'TUNE', 'color:#fd6');
  const sel = el('select', head, '', 'background:#012;color:#9cd;border:1px solid #345;font:inherit');
  for (const s of ROSTER) { const o = el('option', sel, s.name); o.value = s.id; }
  sel.value = sim.ship.id;
  const btn = (t: string, f: () => void): void => { const b = el('button', head, t, 'background:#023;color:#9cd;border:1px solid #345;font:inherit;cursor:pointer'); b.onclick = f; };
  btn('reset', () => { sim.setShip(shipById(sim.ship.id)); sync(); });
  btn('copy JSON', () => { void navigator.clipboard?.writeText(JSON.stringify(sim.ship, null, 2)).then(() => { info.textContent = 'copied'; }, () => { info.textContent = 'clipboard unavailable'; }); });
  const info = el('span', head, '', 'color:#6a8');
  sel.onchange = () => { onSwap(sel.value); sync(); };

  const out = el('pre', root, '', 'margin:4px 0;white-space:pre;color:#bdf');
  const rows: { key: string; input: HTMLInputElement; val: HTMLSpanElement }[] = [];
  let group = '';
  for (const f of FIELDS) {
    if (f.group !== group) { group = f.group; el('div', root, group.toUpperCase(), 'color:#fd6;margin-top:6px'); }
    const row = el('div', root, '', 'display:flex;align-items:center;gap:4px');
    row.title = f.doc + (f.wired !== 'M1' ? `  (used from ${f.wired})` : '');
    el('span', row, f.key, 'width:120px;overflow:hidden');
    const input = el('input', row, '', 'flex:1;min-width:0');
    input.type = 'range'; input.min = String(f.min); input.max = String(f.max); input.step = String(f.step);
    const val = el('span', row, '', 'width:56px;text-align:right');
    input.oninput = () => { setField(sim.ship, f.key, parseFloat(input.value)); val.textContent = input.value; readout(); };
    rows.push({ key: f.key, input, val });
  }
  el('div', root, 'HARDPOINTS', 'color:#fd6;margin-top:6px');
  const hpRow = el('div', root, '', 'display:flex;gap:8px');
  const num = (label: string): HTMLInputElement => { el('span', hpRow, label); const i = el('input', hpRow, '', 'width:40px'); i.type = 'number'; i.min = '0'; i.max = '6'; return i; };
  const nFixed = num('fixed'), nTur = num('turret');
  const setHp = (): void => {
    const a: Hardpoint[] = [];
    for (let i = 0; i < (parseInt(nFixed.value, 10) || 0); i++) a.push('fixed');
    for (let i = 0; i < (parseInt(nTur.value, 10) || 0); i++) a.push('turret');
    if (a.length === 0) a.push('fixed');
    sim.ship.hardpoints.length = 0; for (const h of a) sim.ship.hardpoints.push(h);
    readout();
  };
  nFixed.oninput = setHp; nTur.oninput = setHp;

  function readout(): void {
    const d = derive(sim.ship), iss = validate(sim.ship);
    let t = `${sim.ship.name}  ${sim.ship.role}\n${sim.ship.quirk}\n\n`;
    t += `accel ${d.accel.toFixed(1)} u/s2   boost ${d.boostAccel.toFixed(1)}\n`;
    t += `top ${d.topSpeed.toFixed(0)}   boost top ${d.boostTop.toFixed(0)} u/s\n`;
    t += `0-95% ${d.timeToTop.toFixed(2)} s   stop ${d.stopDist.toFixed(0)} u\n`;
    t += `turn circle ${d.turnCircle.toFixed(0)} u   P/W ${d.ptw.toFixed(2)} g\n`;
    t += `EHP ${d.ehp.toFixed(0)}   DPS ${d.dps.toFixed(1)}\n\n`;
    for (const k of RATING_KEYS) t += (k + '         ').slice(0, 10) + bar(d.ratings[k], 20) + ' ' + String(d.ratings[k] | 0).padStart(3) + '\n';
    t += `BUDGET    ${d.budget.toFixed(0)}\n`;
    for (const i of iss) t += `\n${i.level === 'error' ? '!!' : ' !'} ${i.field}: ${i.msg}`;
    out.textContent = t;
  }
  function sync(): void {
    sel.value = sim.ship.id;
    for (const r of rows) { const v = getField(sim.ship, r.key); r.input.value = String(v); r.val.textContent = String(+v.toFixed(3)); }
    nFixed.value = String(sim.ship.hardpoints.filter(h => h === 'fixed').length);
    nTur.value = String(sim.ship.hardpoints.filter(h => h === 'turret').length);
    readout();
  }
  sync();
}
