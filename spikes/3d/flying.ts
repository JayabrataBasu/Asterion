/** Free flight in the browser: mouse capture, keys, the loop, reticle, pause screen and readout. The rules are in
 *  controls.ts, session.ts and camera.ts. The title becomes 'ready' once the first tiles are all drawn. */
import { ChaseCamera } from './camera';
import { sceneLine } from './combat';
import { type Action, Controls, isGameKey, modeLabel } from './controls';
import { len } from './math';
import { type Page, element, stabParam } from './page';
import type { Frame3 } from './render';
import { FlightSession } from './session';
import { sceneStatus } from './status';

const READOUT_MS = 250;
/** The reticle circle's radius on screen, as a share of the window's shorter side. */
const RETICLE_SCREEN = 0.25;
const REFUSED = 'The browser did not capture the mouse. Click again.\n(Just after Esc it refuses for about a second.)';

export function fly(page: Page): void {
  const { canvas, renderer, planet, info, combat, field, scene } = page;
  const world = scene.world, warn = element('warn');
  const help = element('help'), note = element('note'), reticle = element('reticle'), centre = element('centre');
  const focus = scene.focus;
  renderer.rockDir = focus;
  const session = new FlightSession(planet, focus, { near: scene.near, start: scene.start?.bind(scene) });
  const controls = new Controls(), camera = new ChaseCamera(), moon = scene.near?.moon?.body;
  camera.snap(session.pos, session.q, planet, moon);
  // here the swarm keeps its bearing, so that turning moves it across the screen (the reports and the still view
  // let it follow the nose)
  const holdSwarm = (): void => field?.fixHeading(session.pos, session.q, planet);
  holdSwarm();
  const frame: Frame3 = {
    camPos: camera.pos, camQ: camera.q, ship: { pos: session.pos, q: session.q }, planet, time: session.time, stab: stabParam(),
    swarm: field?.swarm,
  };

  // ---- the mouse, the keys, and everything that pauses
  const leave = (): void => {
    controls.pause();
    if (document.pointerLockElement) document.exitPointerLock();
  };
  const refused = (): void => { note.textContent = REFUSED; };
  canvas.addEventListener('click', () => {
    if (document.pointerLockElement === canvas || page.lost()) return;
    note.textContent = '';
    // a promise in current browsers, nothing in some older ones
    (canvas.requestPointerLock() as Promise<void> | undefined)?.catch(refused);
  });
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement === canvas) { note.textContent = ''; controls.resume(); }
    else controls.pause();
  });
  document.addEventListener('pointerlockerror', refused);
  addEventListener('blur', leave);
  document.addEventListener('visibilitychange', () => { if (document.hidden) leave(); });
  document.addEventListener('mousemove', e => {
    if (document.pointerLockElement === canvas) controls.mouseMove(e.movementX, e.movementY);
  });
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  const act = (a: Action): void => {
    if (a === 'level') session.ship.level = !session.ship.level;
    else if (a === 'readout') info.hidden = !info.hidden;
    else if (a === 'restart') {
      session.restart(controls);
      camera.snap(session.pos, session.q, planet, moon);
      holdSwarm();
      renderer.resetHistory();
    } else frame.stab = a === 'mode0' ? 0 : a === 'mode1' ? 1 : 2;
    nextReadout = 0;
  };
  addEventListener('keydown', e => {
    if (e.code === 'Escape') { leave(); return; }
    const modified = e.ctrlKey || e.metaKey || e.altKey;
    if (!modified && isGameKey(e.code)) e.preventDefault();
    const action = controls.keyDown(e.code, e.repeat, modified);
    if (action) act(action);
  });
  addEventListener('keyup', e => controls.keyUp(e.code));

  // ---- the loop
  let prevNow = 0, drawnTime = session.time, ready = false;
  let paused: boolean | null = null, retX = NaN, retY = NaN;
  let nextReadout = 0, since = 0, frames = 0, busy = 0, worst = 0;
  let figures = 'fps --   processor --';

  function readout(now: number): void {
    if (frames > 0 && now - since >= READOUT_MS) {
      figures = `fps ${(frames * 1000 / (now - since)).toFixed(0)}   processor ${(busy / frames).toFixed(2)} ms (worst ${worst.toFixed(2)})`;
      since = now; frames = 0; busy = 0; worst = 0;
    }
    const st = renderer.stats, s = session.ship;
    const status = sceneStatus(world, s, session.time);
    if (warn.textContent !== status.warning) warn.textContent = status.warning;
    const gpu = !renderer.hasTimer ? 'n/a' : st.gpuMs > 0 ? `${st.gpuMs.toFixed(2)} ms` : '--';
    info.textContent =
      `${figures}   graphics ${gpu}\n` +
      `tiles ${st.tiles}   triangles ${st.tris}   pending builds ${st.pending}\n` +
      `altitude ${s.alt.toFixed(0)}   speed ${len(s.vel).toFixed(0)}   boost ${Math.max(0, s.boostE).toFixed(0)}\n` +
      `mode ${modeLabel(frame.stab)}   level ${s.level ? 'on' : 'off'}\n` +
      `cruise ${s.cruising ? 'ON' : 'off'}${controls.paused ? '   PAUSED' : ''}   P hides this` +
      (combat ? '\n' + sceneLine(combat) : '') +
      (status.line ? '\n' + status.line : '') +
      (renderer.profile ? '\npasses ms: ' + renderer.passNames.map((n, i) => `${n} ${renderer.passMs[i].toFixed(2)}`).join('  ') : '');
  }

  function tick(now: number): void {
    if (page.lost()) return;
    const t0 = performance.now();
    const seconds = prevNow ? (now - prevNow) / 1000 : 0;
    prevNow = now;
    if (!since) since = now;
    page.fit();
    session.advance(seconds, controls);
    camera.update(session.pos, session.q, planet, session.time - drawnTime, moon);
    drawnTime = frame.time = session.time;
    field?.update(session.time, session.pos, session.q, planet);
    renderer.render(frame);
    if (!ready && renderer.settled) { ready = true; document.title = 'ready'; }

    if (paused !== controls.paused) {
      paused = controls.paused;
      help.hidden = !paused; reticle.hidden = centre.hidden = paused;
      nextReadout = 0;
    }
    const r = RETICLE_SCREEN * Math.min(innerWidth, innerHeight), x = controls.mx * r, y = -controls.my * r;
    if (x !== retX || y !== retY) {
      retX = x; retY = y;
      reticle.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
    if (now >= nextReadout) { nextReadout = now + READOUT_MS; readout(now); }
    requestAnimationFrame(tick);
    const took = performance.now() - t0; // the whole callback
    frames++; busy += took; worst = Math.max(worst, took);
  }
  requestAnimationFrame(tick);
}
