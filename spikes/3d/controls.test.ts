import { describe, expect, it } from 'vitest';
import { Controls, RETICLE_PX, SPIKE_PX, isGameKey, modeLabel } from './controls';
import type { Input } from './flight';

const blank = (): Input => ({ mx: 9, my: 9, thrust: true, brake: true, roll: 9, strafeX: 9, strafeY: 9, boost: true, cruise: true });
const IDLE: Input = { mx: 0, my: 0, thrust: false, brake: false, roll: 0, strafeX: 0, strafeY: 0, boost: false, cruise: false };
const read = (c: Controls): Input => { const i = blank(); c.read(i); return i; };
const flying = (): Controls => { const c = new Controls(); c.resume(); return c; };
const holding = (...codes: string[]): Input => { const c = flying(); for (const k of codes) c.keyDown(k); return read(c); };

describe('key map', () => {
  it('starts paused and idle', () => {
    const c = new Controls();
    expect(c.paused).toBe(true);
    expect(read(c)).toEqual(IDLE);
  });
  it.each([
    ['KeyW', { thrust: true }], ['KeyS', { brake: true }],
    ['KeyA', { roll: -1 }], ['KeyD', { roll: 1 }],
    ['KeyZ', { strafeX: -1 }], ['KeyC', { strafeX: 1 }], ['KeyR', { strafeY: 1 }], ['KeyG', { strafeY: -1 }],
    ['ShiftLeft', { boost: true }], ['ShiftRight', { boost: true }],
  ])('%s', (code, want) => {
    expect(holding(code)).toEqual({ ...IDLE, ...want });
  });
  it('combines keys, opposites cancel, and releasing ends the action', () => {
    expect(holding('KeyW', 'ShiftLeft', 'KeyA', 'KeyD', 'KeyR')).toEqual({ ...IDLE, thrust: true, boost: true, strafeY: 1 });
    const c = flying();
    c.keyDown('KeyW'); c.keyUp('KeyW');
    expect(read(c)).toEqual(IDLE);
    c.keyDown('ShiftLeft'); c.keyDown('ShiftRight'); c.keyUp('ShiftLeft');
    expect(read(c).boost).toBe(true);
  });
  it('turns the prototype keys into actions', () => {
    const c = flying();
    expect(['KeyH', 'Digit1', 'Digit2', 'Digit3', 'KeyB', 'KeyP'].map(k => c.keyDown(k)))
      .toEqual(['level', 'mode0', 'mode1', 'mode2', 'restart', 'readout']);
    expect(c.keyDown('KeyW')).toBeNull();
    expect(c.keyDown('KeyQ')).toBeNull();
    expect(c.keyDown('KeyH', true)).toBeNull(); // auto-repeat
  });
  it('binds nothing to Ctrl, and leaves keys alone while Ctrl, Alt or Meta is down', () => {
    for (const code of ['ControlLeft', 'ControlRight']) {
      expect(isGameKey(code)).toBe(false);
      const c = flying();
      expect(c.keyDown(code)).toBeNull();
      expect(read(c)).toEqual(IDLE);
    }
    const c = flying();
    expect(c.keyDown('KeyR', false, true)).toBeNull();
    expect(c.keyDown('KeyB', false, true)).toBeNull();
    c.keyDown('KeyW', false, true); c.keyDown('KeyY', false, true);
    expect(read(c)).toEqual(IDLE);
  });
  it('knows its own keys', () => {
    for (const k of ['KeyW', 'KeyY', 'KeyH', 'Digit3', 'ShiftRight', 'KeyB', 'KeyP']) expect(isGameKey(k)).toBe(true);
    for (const k of ['F5', 'F11', 'Tab', 'Escape', 'toString']) expect(isGameKey(k)).toBe(false);
  });
});

describe('cruise presses', () => {
  it('reaches exactly one read, however long that read takes to come', () => {
    const c = flying();
    c.keyDown('KeyY'); c.keyUp('KeyY'); // released before any step ran
    expect(read(c).cruise).toBe(true);
    expect(read(c).cruise).toBe(false);
  });
  it('is one press while held, and two presses are two reads', () => {
    const c = flying();
    c.keyDown('KeyY'); c.keyDown('KeyY', true);
    expect([read(c).cruise, read(c).cruise]).toEqual([true, false]);
    c.keyUp('KeyY'); c.keyDown('KeyY'); c.keyUp('KeyY'); c.keyDown('KeyY');
    expect([read(c).cruise, read(c).cruise, read(c).cruise]).toEqual([true, true, false]);
  });
});

describe('reticle', () => {
  it('follows the mouse, screen up being nose up', () => {
    const c = flying();
    c.mouseMove(RETICLE_PX / 2, -RETICLE_PX / 4);
    expect(read(c).mx).toBeCloseTo(0.5, 12);
    expect(read(c).my).toBeCloseTo(0.25, 12);
  });
  it('stays inside the unit circle, keeping its direction', () => {
    const c = flying();
    for (let i = 0; i < 5; i++) c.mouseMove(RETICLE_PX * 0.6, -RETICLE_PX * 0.8); // 3 and 4 radii in all
    expect(Math.hypot(c.mx, c.my)).toBeCloseTo(1, 12);
    expect(c.mx).toBeCloseTo(0.6, 12); expect(c.my).toBeCloseTo(0.8, 12);
    c.mouseMove(-RETICLE_PX * 0.6, 0); // moves back from the rim at once, with no stored overshoot
    expect(c.mx).toBeCloseTo(0, 12);
  });
  it('ignores a single movement over 200 units on either axis, as pointer lock sometimes sends', () => {
    expect(SPIKE_PX).toBe(200);
    const c = flying();
    c.mouseMove(50, -25);
    const before = [c.mx, c.my];
    for (const [dx, dy] of [[201, 0], [-201, 0], [0, 201], [0, -201], [5000, 3], [3, -5000], [200.5, 200.5]]) {
      c.mouseMove(dx, dy);
      expect([c.mx, c.my]).toEqual(before); // the whole event, not only the large axis
    }
  });
  it('takes a movement of 200 units on both axes', () => {
    for (const [dx, dy] of [[200, 0], [-200, 0], [0, 200], [0, -200], [200, 200]]) {
      const c = flying();
      c.mouseMove(dx, dy);
      expect(Math.hypot(c.mx, c.my)).toBeCloseTo(Math.min(1, Math.hypot(dx, dy) / RETICLE_PX), 12);
    }
  });
  it('ignores values that are not numbers', () => {
    const c = flying();
    c.mouseMove(NaN, Infinity);
    expect([c.mx, c.my]).toEqual([0, 0]);
  });
});

describe('losing focus (Esc, blur, hidden tab)', () => {
  const busy = (): Controls => {
    const c = flying();
    for (const k of ['KeyW', 'KeyD', 'KeyZ', 'KeyR', 'ShiftLeft', 'KeyY']) c.keyDown(k);
    c.mouseMove(100, -100);
    return c;
  };
  it('pauses, clears held keys and pending presses, and centres the reticle', () => {
    const c = busy();
    c.pause();
    expect(c.paused).toBe(true);
    expect(read(c)).toEqual(IDLE);
    expect([c.mx, c.my]).toEqual([0, 0]);
  });
  it('stays idle on return, even if the key releases were never seen', () => {
    const c = busy();
    c.pause(); c.resume();
    expect(read(c)).toEqual(IDLE);
    c.keyDown('KeyW', true); // auto-repeat of a key held across the pause does not restart it
    expect(read(c)).toEqual(IDLE);
    c.keyDown('KeyW');
    expect(read(c).thrust).toBe(true);
  });
  it('records neither flight keys nor mouse movement while paused, but still gives the prototype actions', () => {
    const c = new Controls();
    c.keyDown('KeyW'); c.keyDown('KeyY'); c.mouseMove(100, 100);
    expect(c.keyDown('Digit1')).toBe('mode0');
    c.resume();
    expect(read(c)).toEqual(IDLE);
  });
});

describe('stability mode names', () => {
  it('give the name, the key that selects it and the stab value', () => {
    expect([0, 1, 2].map(modeLabel))
      .toEqual(['dithered (key 1, stab=0)', 'plain (key 2, stab=1)', 'held (key 3, stab=2)']);
  });
  it('match the keys', () => {
    const c = flying();
    expect(['Digit1', 'Digit2', 'Digit3'].map(k => c.keyDown(k))).toEqual(['mode0', 'mode1', 'mode2']);
  });
});
