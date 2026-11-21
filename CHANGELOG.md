# Changelog

## M0 — tooling
- `npm run golden` / `golden:update` / `shots` now run `scripts/golden.mjs` (Node + installed Chrome/Edge/Chromium, no ImageMagick, no new dependency). Baselines regenerated on the current machine.
- `?perf=1` overlay shows per-system sim step timings (ship, world, ents, bolts, misc, fx).
- Soak watchdog tolerates rare scheduler/GC hiccups under parallel test workers (it still fails on a hang or on repeated slow steps).
- Note: Vitest 5 needs Node 22+ (CI uses 22). On Node 20 failing tests crash the reporter (`Map.groupBy`).

## M1 — stat-driven ships
- `src/sim/ships.ts`: `ShipDef` schema, field metadata (ranges, docs, which milestone wires it), derived readouts, 0–100 ratings, stat budget and validator. Enemies use the same schema (`ENEMY`), flattened into arrays for the hot loop.
- The sim reads every ship constant from `sim.ship` (mutable copy; `setShip()` swaps hulls at runtime). Upgrades are modifiers on top of the def.
- Wren = the original ship; `test/wren.test.ts` proves its flight is bit-identical to the pre-refactor sim (fixture recorded before the refactor).
- New: strafe (`Z`/`C`, d-pad left/right) using `thrustLat`; reverse thrust while braking near standstill (`thrustRev`, 0 on Wren); multi-charge dash.
- `?tune=1` live tuning panel; `?ship=<id>` flies a given hull.
- Debug key moves: CRT toggle C -> F7, aberration G -> F8 (C is strafe now).
