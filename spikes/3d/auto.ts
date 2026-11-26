/** The two reports in the browser. ?auto=perf flies the scripted path and times it; ?auto=flicker draws it in each
 *  stability mode and counts changing characters. &secs=N runs only the first N seconds of each phase. The result is
 *  shown as text (C copies it) and logged; the title becomes 'done'. A change of window size starts the run again. */
import { modeLabel } from './controls';
import { type Page, element, params, stabParam } from './page';
import { type ReportWindow, type RunInfo, formatFlicker, formatPerf, reportWindows } from './report';
import { FlickerRun, PerfRun } from './runs';
import { SCALE } from './scale';

/** A flicker run draws frames for this long before giving the browser a turn (when no worker has to answer). */
const SLICE_MS = 25;
const PROGRESS_MS = 1000;

export function runReport(page: Page, kind: 'perf' | 'flicker'): void {
  const { renderer, planet, info, sync, combat, scene } = page, field = page.field ?? undefined;
  renderer.rockDir = scene.focus;
  const world = scene.world.scene ?? undefined, own = world ? scene : undefined;
  const secs = params.get('secs');
  const windows: ReportWindow[] = kind === 'perf'
    ? reportWindows(secs, stabParam())
    : reportWindows(secs, 0).flatMap(w => ([0, 1, 2] as const).map(mode => ({ ...w, mode })));

  let perf: PerfRun | null = null, flicker: FlickerRun | null = null;
  let resized = 0, hidden = 0, wasHidden = false, prevNow = 0, nextProgress = 0, text = '';
  const start = (): void => {
    if (kind === 'perf') {
      const run = new PerfRun(renderer, planet, windows, () => performance.now(), field, own);
      perf = run;
      renderer.onGpu = (f, ms) => run.gpu(f, ms);
    } else flicker = new FlickerRun(renderer, planet, windows, field, own);
    nextProgress = 0;
  };
  if (kind === 'perf') {
    document.addEventListener('visibilitychange', () => { if (document.hidden && !text) wasHidden = true; });
  }

  function progress(): void {
    const run = perf ?? flicker!, at = run.at;
    if (!at) return;
    const w = windows[at.window];
    info.textContent =
      `${kind} run: ${perf?.counting ? 'counting what shows, ' : ''}` +
      `${w.phase}${kind === 'flicker' ? `, mode ${modeLabel(w.mode)}` : ''}  (part ${at.window + 1} of ${windows.length})  ` +
      (at.frame < 0 ? 'waiting for the ground to load' : `frame ${at.frame + 1} of ${w.frames}`) + '\n' +
      `canvas ${renderer.W}x${renderer.H}  grid ${renderer.cols}x${renderer.rows}\n` +
      'Keep this tab in front. A change of window size (F11, zoom) starts the run again.';
  }

  function finish(): void {
    const notes: string[] = [];
    const run = perf ?? flicker!;
    if (renderer.W !== 1920 || renderer.H !== 1080) notes.push('canvas is not 1920x1080 (for the gate: full screen, 100% zoom)');
    if (resized) notes.push(`started again ${resized} time(s) after a window size change`);
    if (hidden) notes.push(`started again ${hidden} time(s) after the tab was hidden`);
    if (run.unsettled) notes.push(`${run.unsettled} part(s) began before all tiles had loaded`);
    if (renderer.profile) notes.push('profile=1 is on: graphics frame times are not sampled');
    if (params.has('timers')) notes.push(`timers=${params.get('timers')}: that many timer queries may be in flight (6 without it)`);
    const about: RunInfo = {
      browser: navigator.userAgent, gpu: page.gpuName, W: renderer.W, H: renderer.H, cssW: innerWidth, cssH: innerHeight,
      dpr: window.devicePixelRatio, cols: renderer.cols, rows: renderer.rows,
      scale: Object.entries(SCALE).map(([k, v]) => `${k} ${v}`).join('  '),
      sync, notes, world,
      swarm: combat && run.counts ? { ...combat, ...run.counts } : undefined,
    };
    text = perf ? formatPerf(about, perf.data()) : formatFlicker(about, flicker!.rows);
    element('reportText').textContent = text;
    element('report').hidden = false;
    info.hidden = true;
    console.log(text);
    document.title = 'done';
  }

  /** C: to the clipboard; where that is not to be had, the text stays on screen, selected, for copying by hand. */
  function copy(): void {
    const hint = element('reportHint');
    const byHand = (): void => {
      getSelection()?.selectAllChildren(element('reportText'));
      hint.textContent = 'The clipboard is not available. The report is selected: copy it from the right-click menu.';
    };
    if (!navigator.clipboard?.writeText) { byHand(); return; }
    navigator.clipboard.writeText(text).then(() => { hint.textContent = 'Copied.'; }, byHand);
  }
  addEventListener('keydown', e => {
    if (e.code === 'KeyC' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && text) { e.preventDefault(); copy(); }
  });

  function tick(now: number): void {
    if (page.lost()) return;
    const t0 = performance.now();
    if (page.fit()) { resized++; start(); }
    if (wasHidden && !document.hidden) { wasHidden = false; hidden++; start(); }
    let more: boolean;
    if (perf) more = perf.tick();
    else {
      do more = flicker!.tick();
      while (more && sync && performance.now() - t0 < SLICE_MS);
    }
    if (!more) { finish(); return; }
    if (now >= nextProgress) { nextProgress = now + PROGRESS_MS; progress(); }
    requestAnimationFrame(tick);
    perf?.end(now - prevNow, performance.now() - t0); // the whole callback
    prevNow = now;
  }
  page.fit();
  start();
  info.textContent = `${kind} run: starting`;
  requestAnimationFrame(tick);
}
