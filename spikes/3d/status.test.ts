import { describe, expect, it } from 'vitest';
import { newShip } from './flight';
import { sceneStatus } from './status';
import { makeWorld } from './world';

describe('the scene line of the readout', () => {
  it('says nothing without a world scene', () => {
    expect(sceneStatus(makeWorld(null), newShip(), 0)).toEqual({ line: '', warning: '' });
  });

  it('gives the height above the cloud tops, the limits and the damage over a gas giant', () => {
    const world = makeWorld('gas'), s = newShip();
    s.pos.z = 13500 - 100;
    expect(sceneStatus(world, s, 0)).toEqual({
      line: 'gas giant: -100 from the cloud tops   crush depth -405   floor -810   hull damage 0', warning: '',
    });
  });

  it('warns below the crush depth', () => {
    const world = makeWorld('gas'), s = newShip();
    s.pos.z = 13500 - 500; s.crushDamage = 3;
    const status = sceneStatus(world, s, 0);
    expect(status.line).toContain('hull damage 3');
    expect(status.warning).toBe('CRUSH DEPTH  hull damage 3  climb!');
  });

  it('gives the height over the moon and whether the ship is carried with it', () => {
    const world = makeWorld('moon'), s = newShip(), moon = world.moon!;
    moon.place(0);
    s.pos.x = moon.body.center.x; s.pos.y = moon.body.center.y + 2000; s.pos.z = moon.body.center.z;
    expect(sceneStatus(world, s, 0).line).toMatch(/^moon: \d+ above its ground   carried with it   cruise ends below 600$/);
    s.pos.y += 5000;
    expect(sceneStatus(world, s, 0).line).toContain('not carried');
  });
});
