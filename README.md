# Asterion

An ASCII space shooter that runs in your browser. Fly, fight, collect scrap, upgrade at stations.

**Play:** https://jayabratabasu.github.io/Asterion/

## Controls

| Key | Action |
| --- | --- |
| W / A / D | Thrust / turn |
| S | Brake |
| Z / C | Strafe |
| Space | Fire |
| Shift | Boost |
| F | Dodge |
| X | Missile (needs the module) |
| Q (hold) | Scan a nearby body or signal |
| Y | Cruise (time-compressed travel, no hostiles near) |
| N | Galaxy chart and jump (Tab: sector map) |
| E | Dock at a station (upgrades, survey data, fuel, trade) |
| R / G | Climb / dive (vertical experiment, off by default) |
| K | Skip a news item |
| P / Esc | Pause |

Keys can be rebound in the menu. Pick and unlock ships in the **Hangar**. Needs a browser with WebGL2.

## Run locally

```
npm install
npm run dev
```

Build: `npm run build` (output in `dist/`). Tests: `npm test` (Node 22+). Screenshots: `npm run golden` / `npm run golden:update` / `npm run shots` (uses an installed Chrome, Edge or Chromium).

Docs: `DESIGN.md` (decisions), `TUNING.md` (every ship stat and its safe range), `CHANGELOG.md`, `docs/VERTICALITY.md` (experiment report).
