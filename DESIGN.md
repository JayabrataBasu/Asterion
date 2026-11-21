# Asterion v2 — design notes

## Hook candidates
1. **Gravity & slingshots** (implemented as the baseline): planets pull the ship (1/d falloff out to 6.5 radii),
   bullets are absorbed, enemies route around them. Next step: let slingshots *give* energy (moving planets/orbits)
   and add a gravity-assist HUD arc.
2. **Sonar / light-limited vision**: scene pass already knows luminance; fog-of-war = multiply scene by a
   light-radius mask and reveal via radar pings (glyph shockwave rings already exist).
3. **Salvage / trade loop**: debris particles become pickups; stations in chunked sectors buy cargo.
4. **Procedural lore**: derive sector names + log fragments from the sector hash; scan planets for text.
5. **Mirror surfaces**: ice/ocean planets reflect ship + stars (render entities into a mirrored mini-pass).

## Architecture
- `src/sim` — headless, struct-of-arrays, fixed 60 Hz, pooled, spatial hash, seeded RNG. No DOM/GL.
- `src/gfx` — WebGL2: scene pass (1 texel/cell: nebula, galaxies, sun, stars, planets) -> glow sprites -> SDF sprite layer (4x8 samples/cell: ships, rocks, bolts, station) -> glyph matcher (cell-res, MRT) -> ASCII pass -> instanced glyphs (particles/HUD) -> dual-Kawase bloom -> composite.
- Sprite shading: each sprite is a lit SDF (bevel height-field normals, panel decals, emissive engines). Solid interiors use a density ramp; edge cells pick the glyph whose 4x8 ink signature best matches the sprite coverage.
- Auto-quality governor steps chroma/grain -> scanlines -> bloom levels -> cell size down when frames run long (Q toggles).
- `src/dev` — perf HUD (F3 / `): CPU, sim, GPU (EXT_disjoint_timer_query_webgl2), draw calls, counts.
- `test/` — Vitest headless smoke (NaN/leak/overflow/determinism/step-time).

## Keys
W/↑ thrust · A/D turn · S brake · Space fire · Shift boost · R relaunch
1-4 presets · Q auto-quality · B bloom · C CRT · G aberration · T ramp · [ ] cell size · - = backdrop · F3 perf · H HUD
Debug URL params: `?demo=1&ff=20&x=40&y=0&bloom=0&exposure=…&perf=1`

## v2.1 additions
- Audio: `src/audio/audio.ts` — SFX with positional pan + reverb, plus a generative score (pad/bass/arp/drums) driven by wave phase and boss fights. `M` mutes.
- Progression: scrap, 7 upgrades (incl. homing missiles, `X`), docking (`E`), objectives that rotate hostiles/scrap/asteroids, repair + ammo pickups, banked via `src/core/save.ts`.
- Enemies: drone, gunship (some shielded), minelayer, sniper, splitter, rammer, tender (heals), boss (scales per kill, fan widens). Boss + sniper have their own SDF sprites.
- Visuals: per-sector nebula tint, dark halo around sprites, combat backdrop dimming, tumbling debris, longer exhaust, slow-mo on boss kill.
- Controls: rebindable keys, mouse aim (`Tab`), gamepad, dash, flight assist (`V`), lead reticle. `C` on the game-over screen copies a result line.
- Debug: `?spawn=boss,sniper,tender,splitter,rammer,gunship`, `?state=shop|pause|controls`.
- v2.2: unique sprites for splitter/rammer/tender; title screen runs a live attract-mode flight; sector map (`N`, explored sectors only); station types (Depot / Armory -20% / Black Market +35%); derelict cargo caches (radar blips, seeded once per sector); asteroid belts around planets; 'survive' objective; daily seed, hard mode, high-contrast options.
- v2.3: orbiting moons, swirling gas-giant storms with lightning, planet shadows darken ships/rocks/stations, screen-space shock-ring distortion + engine heat shimmer, glowing tumbling hull chunks, 'defend station' objective, `?seed=` debug param, `npm run golden` / `golden:update` (headless screenshot regression guard; loose tolerance because enemy motion is not frame-locked).
- v2.4: escort mission (6th objective: a freighter crawls along a heading while you stay within 230 units; enemies target it, your bolts pass through it, losing it fails the mission with no bonus), pulsing hull-breach vent jet below 22% hull, camera look-ahead that grows with speed (a stand-in for zoom). Debug params `?obj=N` and `?hp=N`.
- v2.5: ship reflections: the player's engine glow glints off glossy surfaces (oceans, ice), scaled by thrust/boost and distance.
- v2.6 handling: keyboard turning ramps (`HANDLING` block in `src/sim/sim.ts`: TURN_MAX 2.6 rad/s, TURN_ACC 9, TURN_DECAY 12, GRIP_COAST 0.25 while coasting) and lateral grip (GRIP 0.8/s, GRIP_FWD 0.5) bends the flight path; flight assist now defaults on for new saves. Mouse aim keeps the old 3.7 rad/s rate. Feel is untested by a human: tune the block.
- v2.7 planet scale: medium planets x1.6, ~15% giants x3 (`MEDIUM_K`, `GIANT_K`, `GIANT_SHARE`, `PLANET_MAX_R` in `src/sim/world.ts`); planets always fit their sector; gravity pull is size-independent with reach `min(130, 6.5r)` (`GRAV_REACH` in sim.ts); stations, caches and belts are pushed clear of planets. Home planet r46 at (190,-60). Sizes are untested by a human: tune the constants.
- v2.8 aim assist: options row AIM ASSIST (OFF / WIDE / LEAD / HOMING, default LEAD, saved as `aimAssist`). Constants in the `AIM_ASSIST` block in `src/sim/sim.ts`: WIDE +1.2 hit radius; LEAD bends fired bolts toward the lead point of the enemy nearest the nose within 8 degrees (full within 3); HOMING turns player bolts up to 1.6 rad/s toward a lead point inside a 25 degree cone. The reticle marks the assisted target. Untested by a human.
- Not done: per-cell ASCII pass / real-GPU profiling (needs real hardware numbers), true camera zoom and HUD scale (both need world-to-cell scaling through the scene, glow, sprite and glyph passes plus a second glyph grid, a rework rather than a feature).

## v2.9 — Living space
- **Reactions:** parallax dust motes stretch into speed streaks; boost start/dash emit a shock ring; long boost wake; explosion rings add a soft light pulse (feeds bloom). Reduced FX scales dust down.
- **Sector events** (`Sim.updateEvents`, `triggerEvent`, debug `?event=1..4&evwarn=s`): comet (invulnerable, 25 dmg once per contact, wipes non-boss enemies), meteor shower (14 fast rocks), solar flare (`flare` envelope: sun, bloom, atmosphere up, radar jammed), ion storm (`storm`: nebula lightning, boost recharge -70%). First at 40 s, then every 70-110 s, never the same twice running; 5 s HUD warning.
- **Planets:** spin and cloud drift ~3.5x faster, polar auroras on terran/ice-type worlds, atmosphere rim surges with the flare.
- **Traffic:** `Kind.Hauler` neutral convoys (1-3) in calm/lull phases; 8 scrap each; not enemies, not targeted by missiles or aim assist. `isMissileTarget()` now guards all three missile target paths (also fixed the escort Freighter being re-targetable).
- Unverified: event pacing/difficulty, dust readability, real-GPU cost.

## v3 — the expansion (M0–M8): decisions and rationale
- **Ships are data.** `ShipDef` (src/sim/ships.ts) is the only source of per-ship numbers; the sim reads the *effective* def (`sim.ship` = `sim.base` + modules). Enemies share the schema (`ENEMY`), flattened to arrays for the hot loop. Quirks are numeric fields (ramMult, cargoSoak, darkSig, wingmen, nebulaScan) so they tune like everything else.
- **Wren regression.** M1 proved the refactor bit-identical against a trace recorded before it (commit 4098ecb). The fixture was then re-baselined on purpose three times (M2 new defence/power mechanics, M3 event RNG, M7 modules); each is noted in test/wren.test.ts.
- **Wren art.** Wren keeps the original X-wing style hull (owner's call, v3.1). The other hulls and all faction/system names are original.
- **Backdrop (v3.1).** The M3 negative-space pass was reverted on request: dense parallax stars, nebulae everywhere, a soft blooming sun (no glyph core/spikes/flare ghosts), cells around ships dimmed rather than blanked. Set pieces, materials, LOD, eclipse and the rest of M3 stay.
- **One balance rule.** Seven 0–100 ratings on a log scale (Wren = 50) sum to a stat budget; the validator warns beyond ±15% of Wren. The roster lands at −6%…+9%.
- **Tuning panel is HTML** (dev-only `?tune=1`, like `?perf=1`) — the one exception to "everything is a glyph", because it never appears in play.
- **Strict ASCII visuals.** Every new effect is glyph choice, brightness, colour, density or motion: materials per matter, light family for background (ramp capped), mid weight for bodies, heavy shape-matched glyphs for ships, a mint accent only for the player, true blank-cell halos. (v3.2: auto camera zoom, star aberration and blank-cell halos were removed for legibility; use `[` `]` to change cell size.)
- **Verticality** is an experiment behind a flag; when off every z is 0 and every height check passes. See docs/VERTICALITY.md. Not tuned around.
- **Galaxy** (src/sim/galaxy.ts) is cold-path, deterministic from its seed, bounded and serialised in the save. Systems salt the existing sector generator; world defaults remain the endless home field so legacy tests and the attract mode are unchanged. The living galaxy is abstract: no off-screen ships, only per-system numbers moved by a 3-minute tick and by player actions.
- **Story stays ambient**: names, logs, a ticker and one optional mystery in eight fragments. Nothing interrupts play.
- **Module layout.** New code lives in new files (ships.ts, unlocks.ts, galaxy.ts, game/explore.ts, dev/tune.ts); main.ts menus became item lists. Existing modules were extended in place rather than reorganised.

## Keys (v3)
W/A/D thrust/turn · S brake (reverse near standstill) · Z/C strafe · Space fire · Shift boost · F dodge · X missile · Q hold to scan · Y cruise · N galaxy chart (Tab: sector map) · E dock · R/G climb/dive (vertical mode) · K skip news · P/Esc pause.
Debug: F3 perf · F7 CRT · F8 aberration · F9 auto-quality · F10 layer debug · B bloom · T ramp · [ ] cell size · - = backdrop.
URL: `?tune=1 ?ship=<id> ?vert=1 ?layers=1 ?roster=1 ?unlockall=1 ?state=hangar|chart|shop|map|logs ?sys=N ?setpiece=derelict|pulsar|wormhole|beacon|signal ?event=eclipse|mega&evt=0..1 ?scanview=1 ?modules=1` plus the older ones.

## Performance (M8, measured in headless Chrome with SwiftShader software GL on this machine)
| Resolution | Cells | CPU / frame | Sim / frame | GPU (SwiftShader) now | GPU (SwiftShader) before v3 |
|---|---|---|---|---|---|
| 1280x720 | 157x35 | 0.41 ms | 0.12 ms | 71.9 ms | 58.6 ms |
| 1920x1080 | 237x58 | 0.61 ms | 0.12 ms | 81.3 ms | 79.8 ms |
| 2560x1440 | 317x80 | 0.74 ms | 0.20 ms | 121.2 ms | 150.5 ms |
Software GL is far slower than any real GPU, so only the before/after comparison is meaningful (no clear regression). Real integrated / discrete GPU numbers still need hardware: run `?perf=1` and read the overlay (it now includes per-system sim timings). Headless sim: average step well under 1 ms across all ships (smoke + soak tests).
