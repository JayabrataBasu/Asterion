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
