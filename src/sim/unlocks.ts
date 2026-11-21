import type { Stats } from '../core/save';

/** Ships unlock through play: a lifetime achievement opens the slip, then scrap buys the hull. Hive needs a late-game record. */
export interface Unlock { id: string; cost: number; need: string; ok: (s: Stats) => boolean }
export const UNLOCKS: Unlock[] = [
  { id: 'wren', cost: 0, need: '', ok: () => true },
  { id: 'needle', cost: 150, need: 'REACH OBJECTIVE TIER 3 IN ONE RUN', ok: s => s.maxTier >= 3 },
  { id: 'magpie', cost: 200, need: 'COLLECT 1500 SCRAP (LIFETIME)', ok: s => s.scrap >= 1500 },
  { id: 'sextant', cost: 180, need: 'SCAN 12 BODIES OR ANOMALIES', ok: s => s.scans >= 12 },
  { id: 'anvil', cost: 250, need: 'DESTROY 2 DREADNOUGHTS', ok: s => s.bosses >= 2 },
  { id: 'shade', cost: 260, need: 'SELL 400 SURVEY DATA', ok: s => s.survey >= 400 },
  { id: 'mule', cost: 220, need: 'DELIVER 30 UNITS OF CARGO', ok: s => s.delivered >= 30 },
  { id: 'hive', cost: 600, need: 'DESTROY 5 DREADNOUGHTS AND SURVEY 3 SYSTEMS', ok: s => s.bosses >= 5 && s.systems >= 3 },
];
export function unlockOf(id: string): Unlock { return UNLOCKS.find(u => u.id === id) ?? UNLOCKS[0]; }
