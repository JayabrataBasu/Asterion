/** What every view of the prototype page shares: URL parameters, the planet, the canvas and its renderer, and the
 *  combat load test or world scene if the URL asks for one. */
import { type Capacity, type CombatConfig, CombatField, parseCombat } from './combat';
import { watchContext } from './lost';
import type { Planet } from './planet';
import { Renderer3 } from './render';
import { type Scene, makeScene } from './scene';
import { makeWorld, parseWorldScene } from './world';

export const params = new URLSearchParams(location.search);
export const intParam = (name: string, lo: number, hi: number, dflt: number): number => {
  const n = Number(params.get(name));
  return params.has(name) && Number.isInteger(n) && n >= lo && n <= hi ? n : dflt;
};
/** ?stab=0|1|2, the stability mode. */
export const stabParam = (): 0 | 1 | 2 => intParam('stab', 0, 2, 2) as 0 | 1 | 2;

export const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export interface Page {
  canvas: HTMLCanvasElement; info: HTMLPreElement; planet: Planet; renderer: Renderer3; sync: boolean; gpuName: string;
  /** The combat load test: what was asked for, and its motion. Both null without one. */
  combat: CombatConfig | null; field: CombatField | null;
  /** What the views fly and look at: the default planet's, or the world scene's (its name in scene.world.scene). */
  readonly scene: Scene;
  /** Rebuilds the drawing if the window size or the display scale (browser zoom) changed; true if it did. */
  fit(): boolean;
  /** True once the graphics context is gone: the loop must stop. The page then asks for a reload. */
  lost(): boolean;
}

/** `room`: room in the renderer for a swarm other than the URL's (the occlusion check places its own). */
export function openPage(sync: boolean, room?: Capacity): Page {
  const canvas = element<HTMLCanvasElement>('c'), info = element<HTMLPreElement>('info');
  const combat = parseCombat(params);
  // the occlusion check places its own objects round the default planet
  const world = makeWorld(room ? null : parseWorldScene(params));
  const renderer = new Renderer3(canvas, { sync, swarm: room ?? combat, world: world.scene ? world : null });
  renderer.debug = intParam('dbg', 0, 1, 0);
  renderer.profile = params.get('profile') === '1'; // graphics time per pass
  const gl = renderer.gl, dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const gpuName = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  let dpr = 0, cssW = 0, cssH = 0;
  const fit = (): boolean => {
    if (window.devicePixelRatio === dpr && innerWidth === cssW && innerHeight === cssH) return false;
    dpr = window.devicePixelRatio; cssW = innerWidth; cssH = innerHeight;
    renderer.resize(cssW, cssH, dpr);
    return true;
  };
  const told = watchContext(canvas, text => {
    const panel = element('lost');
    panel.textContent = text; panel.hidden = false;
    if (document.pointerLockElement) document.exitPointerLock();
  });
  // the context says it is lost before the event arrives: a frame in between must not run either
  const lost = (): boolean => told() || gl.isContextLost();
  const field = combat ? new CombatField(combat) : null;
  let scene: Scene | undefined; // made when first asked for: the default planet's path takes a while to find
  return {
    canvas, info, planet: world.planet, renderer, sync, gpuName, combat, field, fit, lost,
    get scene() { return scene ??= makeScene(world); },
  };
}
