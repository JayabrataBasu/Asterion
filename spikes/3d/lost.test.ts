import { describe, expect, it } from 'vitest';
import { LOST_TEXT, watchContext } from './lost';

describe('a lost graphics context', () => {
  const lose = (target: EventTarget): Event => {
    const e = new Event('webglcontextlost', { cancelable: true });
    target.dispatchEvent(e);
    return e;
  };
  it('asks for a reload', () => {
    expect(LOST_TEXT).toMatch(/reload the page/i);
  });
  it('shows the message and says so to the loop', () => {
    const canvas = new EventTarget(), shown: string[] = [];
    const lost = watchContext(canvas, text => shown.push(text));
    expect(lost()).toBe(false);
    expect(shown).toEqual([]);
    lose(canvas);
    expect(lost()).toBe(true);
    expect(shown).toEqual([LOST_TEXT]);
  });
  it('leaves the context lost: nothing restores it', () => {
    const canvas = new EventTarget();
    watchContext(canvas, () => {});
    expect(lose(canvas).defaultPrevented).toBe(false);
  });
});
