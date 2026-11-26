/** The flight input without a browser: key map, mouse reticle, pause. The page feeds it events; the simulation reads
 *  one Input per step. */
import type { Input } from './flight';

/** Mouse travel (movementX/Y units) from the centre of the reticle circle to its rim. */
export const RETICLE_PX = 250;

/** Prototype keys, which act when pressed; they also work while paused. */
export type Action = 'level' | 'mode0' | 'mode1' | 'mode2' | 'restart' | 'readout';

const ACTIONS = new Map<string, Action>([
  ['KeyH', 'level'], ['Digit1', 'mode0'], ['Digit2', 'mode1'], ['Digit3', 'mode2'], ['KeyB', 'restart'], ['KeyP', 'readout'],
]);
/** Keys the ship reads (by position on the keyboard, KeyboardEvent.code). Nothing is bound to Ctrl. */
const FLIGHT_KEYS = new Set(['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyZ', 'KeyC', 'KeyR', 'KeyG', 'ShiftLeft', 'ShiftRight', 'KeyY']);

export function isGameKey(code: string): boolean { return FLIGHT_KEYS.has(code) || ACTIONS.has(code); }

export class Controls {
  paused = true;
  /** The reticle, inside the unit circle: right and nose up are positive. */
  mx = 0; my = 0;
  private readonly held = new Set<string>();
  /** Cruise presses no step has taken yet. */
  private presses = 0;

  resume(): void { this.paused = false; }

  /** For lost mouse capture, window blur and a hidden tab: nothing stays held, and nothing is left to happen. */
  pause(): void {
    this.paused = true;
    this.held.clear();
    this.neutral();
  }

  /** Centres the reticle and forgets presses not yet taken. */
  neutral(): void { this.mx = 0; this.my = 0; this.presses = 0; }

  /** `modified`: Ctrl, Alt or Meta is down, so the key belongs to the browser. Auto-repeat is ignored: a key counts
   *  from a press made while flying, so one held across a pause does nothing until pressed again. */
  keyDown(code: string, repeat = false, modified = false): Action | null {
    if (repeat || modified) return null;
    const action = ACTIONS.get(code);
    if (action) return action;
    if (this.paused || !FLIGHT_KEYS.has(code)) return null;
    if (code === 'KeyY') this.presses++;
    else this.held.add(code);
    return null;
  }

  keyUp(code: string): void { this.held.delete(code); }

  /** Mouse movement, screen axes (down is positive y). */
  mouseMove(dx: number, dy: number): void {
    if (this.paused || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const x = this.mx + dx / RETICLE_PX, y = this.my - dy / RETICLE_PX;
    const over = Math.max(1, Math.hypot(x, y));
    this.mx = x / over; this.my = y / over;
  }

  /** Writes the input of one simulation step into `out`, using up one cruise press if there is one. */
  read(out: Input): void {
    const k = this.held;
    out.mx = this.mx; out.my = this.my;
    out.thrust = k.has('KeyW'); out.brake = k.has('KeyS');
    out.roll = this.axis('KeyD', 'KeyA');
    out.strafeX = this.axis('KeyC', 'KeyZ'); out.strafeY = this.axis('KeyR', 'KeyG');
    out.boost = k.has('ShiftLeft') || k.has('ShiftRight');
    out.cruise = this.presses > 0;
    if (out.cruise) this.presses--;
  }

  private axis(plus: string, minus: string): number { return (this.held.has(plus) ? 1 : 0) - (this.held.has(minus) ? 1 : 0); }
}
