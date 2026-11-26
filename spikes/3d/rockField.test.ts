import { describe, expect, it } from 'vitest';
import { qIdentity, v3 } from './math';
import { newRingRock } from './ring';
import { BUCKETS, CAPACITY, LODS, RockField, viewDistance } from './rockField';
import { KINDS } from './ring';
import { makeWorld } from './world';

const ring = makeWorld('ring').ring!;
const TAN = Math.tan(Math.PI / 6), ASPECT = 240 / 134, CELL_K = 2 * TAN / 67;

/** Everything the field draws from `eye`, looking every way: a list of "x y z scale" per bucket, positions put back
 *  into the planet's space. */
function drawn(field: RockField, eye: { x: number; y: number; z: number }): string[] {
  field.update(eye, qIdentity(), TAN, ASPECT, CELL_K, false);
  const out: string[] = [];
  for (let b = 0; b < BUCKETS; b++) {
    for (let i = 0; i < field.count[b]; i++) {
      const o = (b * CAPACITY + i) * 8, d = field.data;
      out.push(`${b} ${(d[o] + eye.x).toFixed(1)} ${(d[o + 1] + eye.y).toFixed(1)} ${(d[o + 2] + eye.z).toFixed(1)} ${d[o + 3].toFixed(2)}`);
    }
  }
  return out.sort();
}

describe('the streamed rock field', () => {
  const middle = ring.toWorld(v3(), 0, 12600, 0); // the densest band
  const scales = [1, 1, 1, 1];

  it('draws the same rocks from the same place, however it got there', () => {
    const a = new RockField(ring, scales), b = new RockField(ring, scales);
    const first = drawn(a, middle);
    expect(first.length).toBeGreaterThan(300);
    for (const u of [700, -2400, 90, 5000]) drawn(b, ring.toWorld(v3(), u, 12000 + u / 3, 20));
    expect(drawn(b, middle)).toEqual(first);
    expect(drawn(a, middle)).toEqual(first);
  });

  it('keeps within its room, in the densest part and from just above it', () => {
    const field = new RockField(ring, scales);
    let most = 0;
    for (let rho = ring.inner; rho < ring.outer; rho += 460) {
      for (const h of [0, 200, 900]) {
        field.update(ring.toWorld(v3(), 0, rho, h), qIdentity(), TAN, ASPECT, CELL_K, false);
        most = Math.max(most, ...field.count);
        expect(field.dropped).toBe(0);
      }
    }
    expect(most).toBeGreaterThan(20);
    expect(most).toBeLessThanOrEqual(CAPACITY);
    expect(BUCKETS).toBe(KINDS * LODS);
  });

  it('draws nothing far from the ring', () => {
    const field = new RockField(ring, scales);
    for (const eye of [ring.toWorld(v3(), 0, 12000, 5000), v3(), ring.toWorld(v3(), 0, ring.outer + 3000, 0)]) {
      field.update(eye, qIdentity(), TAN, ASPECT, CELL_K, false);
      expect(field.total).toBe(0);
    }
  });

  it('brings a rock in by growing it from nothing, with no jump', () => {
    const field = new RockField(ring, scales), rock = newRingRock();
    let i = 0;
    while (!ring.rockAt(i, 200, 1, rock) || rock.r < 9) i++;
    const at = ring.toWorld(v3(), rock.u, rock.v, rock.h), far = viewDistance(rock.r);
    expect(far).toBeGreaterThanOrEqual(300);
    expect(far).toBeLessThanOrEqual(1300);
    const scaleAt = (d: number): number => {
      const eye = v3(at.x - d * ring.e1.x, at.y - d * ring.e1.y, at.z - d * ring.e1.z);
      field.update(eye, qIdentity(), TAN, ASPECT, CELL_K, false);
      for (let b = 0; b < BUCKETS; b++) {
        for (let n = 0; n < field.count[b]; n++) {
          const o = (b * CAPACITY + n) * 8, f = field.data;
          if (Math.abs(f[o] - (at.x - eye.x)) < 0.01 && Math.abs(f[o + 1] - (at.y - eye.y)) < 0.01 && Math.abs(f[o + 2] - (at.z - eye.z)) < 0.01) return f[o + 3];
        }
      }
      return 0;
    };
    expect(scaleAt(far + 1)).toBe(0);
    expect(scaleAt(far * 0.99)).toBeLessThan(0.02 * rock.r);
    expect(scaleAt(far * 0.6)).toBeCloseTo(rock.r, 4);
    expect(scaleAt(60)).toBeCloseTo(rock.r, 4);
    let before = scaleAt(far + 2), most = 0;
    for (let d = far + 1; d > far * 0.6; d -= 1) {
      const now = scaleAt(d);
      most = Math.max(most, now - before);
      expect(now).toBeGreaterThanOrEqual(before - 1e-5);
      before = now;
    }
    expect(most).toBeLessThan(0.05 * rock.r);
  });

  it('leaves out what the camera cannot see', () => {
    const field = new RockField(ring, scales);
    field.update(middle, qIdentity(), TAN, ASPECT, CELL_K, false);
    const all = field.total;
    field.update(middle, qIdentity(), TAN, ASPECT, CELL_K, true);
    expect(field.total).toBeGreaterThan(0);
    expect(field.total).toBeLessThan(all * 0.5);
  });
});
