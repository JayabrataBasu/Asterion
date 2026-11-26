/** What every view of the prototype page shares: URL parameters, the planet, the canvas and its renderer. */
import { type Planet, makePlanet } from './planet';
import { Renderer3 } from './render';

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
  /** Rebuilds the drawing if the window size or the display scale (browser zoom) changed; true if it did. */
  fit(): boolean;
}

export function openPage(sync: boolean): Page {
  const canvas = element<HTMLCanvasElement>('c'), info = element<HTMLPreElement>('info');
  const renderer = new Renderer3(canvas, { sync });
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
  return { canvas, info, planet: makePlanet(1), renderer, sync, gpuName, fit };
}
