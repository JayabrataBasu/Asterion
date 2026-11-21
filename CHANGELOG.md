# Changelog

## M0 — tooling
- `npm run golden` / `golden:update` / `shots` now run `scripts/golden.mjs` (Node + installed Chrome/Edge/Chromium, no ImageMagick, no new dependency). Baselines regenerated on the current machine.
- `?perf=1` overlay shows per-system sim step timings (ship, world, ents, bolts, misc, fx).
- Soak watchdog tolerates rare scheduler/GC hiccups under parallel test workers (it still fails on a hang or on repeated slow steps).
- Note: Vitest 5 needs Node 22+ (CI uses 22). On Node 20 failing tests crash the reporter (`Map.groupBy`).
