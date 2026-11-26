/** Prototype scale constants, each overridable by a URL parameter of the same name.
 *  Mutable on purpose: the tile worker copies the page's values in with Object.assign, so read them at call time. */
export const SCALE = {
  radiusK: 150, atmoFrac: 0.08, reliefFrac: 0.03, reliefMax: 250, cruiseGain: 0.35, cruiseMax: 20000,
};

const params = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
for (const key of Object.keys(SCALE) as (keyof typeof SCALE)[]) {
  const raw = params.get(key)?.trim(); // Number('') is 0, so blanks are skipped first
  if (raw && Number.isFinite(Number(raw))) SCALE[key] = Number(raw);
}
