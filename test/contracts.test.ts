import { describe, expect, it } from 'vitest';
import { CKind, MAX_ACTIVE, applyRep, canAccept, deliverReady, huntDone, hunted, offers, repLabel, repPriceMod, sanitize, stationName, type OfferParams } from '../src/game/contracts';

const P: OfferParams = { seed: 7, sys: 3, faction: 1, from: { sx: 0, sy: 0 }, others: [{ sx: 2, sy: -1 }, { sx: -3, sy: 2 }], piracy: 0.3,
  unitValue: [12, 18, 15, 34, 26, 48], bucket: 5, sector: 460, rep: 0 };

describe('contract offers', () => {
  it('are deterministic: same inputs give the same board', () => {
    expect(offers(P)).toEqual(offers(P));
  });
  it('refresh when the bucket changes, and differ between stations', () => {
    expect(offers({ ...P, bucket: 6 })).not.toEqual(offers(P));
    expect(offers({ ...P, from: { sx: 4, sy: 4 } })).not.toEqual(offers(P));
  });
  it('always offer three jobs with sane values', () => {
    for (let b = 0; b < 40; b++) for (let sys = 0; sys < 10; sys++) {
      const o = offers({ ...P, bucket: b, sys });
      expect(o.length).toBe(3);
      for (const c of o) {
        expect(c.reward).toBeGreaterThan(0); expect(c.rep).toBeGreaterThan(0);
        if (c.kind === CKind.Deliver) { expect(c.units).toBeGreaterThanOrEqual(3); expect(c.units).toBeLessThanOrEqual(10); expect(c.toX === c.fromX && c.toY === c.fromY).toBe(false); }
        else { expect(c.kills).toBeGreaterThanOrEqual(4); expect(c.kills).toBeLessThanOrEqual(9); }
      }
    }
  });
  it('offer only hunts when there is no other station to deliver to', () => {
    for (let b = 0; b < 30; b++) for (const c of offers({ ...P, others: [], bucket: b })) expect(c.kind).toBe(CKind.Hunt);
  });
  it('lawless systems offer more hunts than calm ones', () => {
    const count = (piracy: number): number => { let n = 0; for (let b = 0; b < 200; b++) for (const c of offers({ ...P, piracy, bucket: b })) if (c.kind === CKind.Hunt) n++; return n; };
    expect(count(0.9)).toBeGreaterThan(count(0.0) * 1.5);
  });
});

describe('completion', () => {
  const deliver = offers({ ...P, piracy: 0 }).find(c => c.kind === CKind.Deliver)!;
  const hunt = offers({ ...P, piracy: 1 }).find(c => c.kind === CKind.Hunt)!;
  it('a delivery needs the right station, system and enough goods', () => {
    const cargo = new Array(6).fill(0); cargo[deliver.com] = deliver.units;
    expect(deliverReady(deliver, deliver.toX, deliver.toY, deliver.sys, cargo)).toBe(true);
    expect(deliverReady(deliver, deliver.toX + 1, deliver.toY, deliver.sys, cargo)).toBe(false);   // wrong station
    expect(deliverReady(deliver, deliver.toX, deliver.toY, deliver.sys + 1, cargo)).toBe(false);   // wrong system
    cargo[deliver.com] = deliver.units - 1;
    expect(deliverReady(deliver, deliver.toX, deliver.toY, deliver.sys, cargo)).toBe(false);        // not enough
  });
  it('a hunt counts kills since it was accepted', () => {
    const c = { ...hunt, base: 100 };
    expect(hunted(c, 100)).toBe(0); expect(huntDone(c, 100 + c.kills - 1)).toBe(false); expect(huntDone(c, 100 + c.kills)).toBe(true);
    expect(hunted(c, 50)).toBe(0);                                  // never negative
  });
  it('tier-1 jobs need standing', () => {
    const t1 = { ...deliver, tier: 1 };
    expect(canAccept(t1, 0)).toBe(false); expect(canAccept(t1, 0.2)).toBe(true); expect(canAccept({ ...deliver, tier: 0 }, -1)).toBe(true);
  });
});

describe('reputation', () => {
  const rel = new Array(16).fill(0); rel[1 * 4 + 2] = -0.8; rel[2 * 4 + 1] = -0.8; rel[1 * 4 + 3] = 0.5; rel[3 * 4 + 1] = 0.5;
  it('helping a faction raises it, lifts its friends a little and costs you with its enemies', () => {
    const rep = [0, 0, 0, 0]; applyRep(rep, 1, 0.2, rel);
    expect(rep[1]).toBeCloseTo(0.2); expect(rep[3]).toBeGreaterThan(0); expect(rep[2]).toBeLessThan(0); expect(rep[0]).toBe(0);
  });
  it('clamps to -1..1', () => {
    const rep = [0.95, 0, 0, 0]; applyRep(rep, 0, 0.5, rel); expect(rep[0]).toBe(1);
    applyRep(rep, 0, -5, rel); expect(rep[0]).toBe(-1);
  });
  it('friends get cheaper prices, enemies pay more, and the labels follow', () => {
    expect(repPriceMod(1)).toBeCloseTo(0.88); expect(repPriceMod(-1)).toBeCloseTo(1.12); expect(repPriceMod(0)).toBe(1);
    expect(repLabel(0.7)).toBe('ALLIED'); expect(repLabel(0)).toBe('NEUTRAL'); expect(repLabel(-0.9)).toBe('HOSTILE');
  });
});

describe('save validation and names', () => {
  it('sanitize drops garbage and caps the list', () => {
    const good = offers(P)[0];
    expect(sanitize('nope', 6, 40)).toEqual([]);
    expect(sanitize([null, 5, { kind: 9 }], 6, 40)).toEqual([]);
    expect(sanitize([good, good, good, good, good], 6, 40).length).toBe(MAX_ACTIVE);
    const bad = sanitize([{ ...good, com: 99, units: 1e9, reward: -5 }], 6, 40)[0];
    expect(bad.com).toBe(5); expect(bad.units).toBe(60); expect(bad.reward).toBe(0);
  });
  it('station names are stable', () => {
    expect(stationName(0, 0, 2, 3, 'DEPOT')).toBe(stationName(0, 0, 2, 3, 'DEPOT'));
    expect(stationName(0, 0, 2, 3, 'DEPOT')).toMatch(/ DEPOT$/);
  });
});
