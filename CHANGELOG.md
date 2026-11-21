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

## M2 — roster and hangar
- Seven new hulls (Needle, Anvil, Sextant, Mule, Shade, Magpie, Hive) drawn by the same SDF + glyph-matcher pipeline, each with live state: Anvil per-barrel muzzle flash, Sextant sensor petals, Mule visible containers = hold fill, Shade fades out running dark, Magpie grabber arm reaches for pickups, Hive bays iris open. Wren redrawn as an original design (the old art was a recognisable copy of an existing starfighter); its flight model is unchanged.
- New mechanics on every ship: shields (regen + delay, knocked out by ion storms), flat armour, kinetic/thermal/EM resists and typed damage, weapon energy, heat with overheat lockout, live signature that scales enemy notice range, mass-scaled ramming and knockback, turret hardpoints, multi-barrel fire. Quirks are numeric ShipDef fields (ramMult, cargoSoak, darkSig, wingmen, nebulaScan).
- Hive wingmen (`Kind.Wing`): friendly drones that orbit, dive and shoot; never targeted by the player, missiles or aim assist.
- Hangar (title menu): pick/unlock hulls, rating bars, derived readouts, rotating preview, best score per ship. Unlocks come from lifetime play stats plus scrap (`src/sim/unlocks.ts`); Hive is late.
- Save format v2 with a v1 migration (upgrades and best score move to the Wren slot). Per-ship modules and best scores, lifetime stats, options for verticality and the news ticker.
- Menus are item lists; new key defaults: climb R, dive G, scan Q, cruise Y. Debug: auto-quality Q -> F9. `?state=hangar`, `?unlockall=1`, `?roster=1`.
- Wren regression trace deliberately re-baselined (Wren gained shields, energy, heat, signature).

## M3 — visual awe pass (strict ASCII)
- Negative space: far sparser, dimmer stars; nebulae only in ~1 sector in 5 (home is faint), galaxies rarer. Background ramp is capped to the light end of the ramp (glyph budget).
- Glyph materials: gas `~ - =` flowing, rock `# % :`, ice `. * '`, oceans ripple `~ -`, atmosphere rims in the light family `, : ;`, sun core `@ * +`.
- Resolve-on-approach: distant bodies render as sparse flat cells; bands, then storms, clouds, cities, lightning and auroras load in as you close.
- Light: diffraction spikes as rows of `-` and `|`, lens-flare ghost rings along the line through screen centre, the sun is hidden by planets, eclipse coronas, ring shadows across discs.
- Scan view (planet rewrites into data strings), typed arrivals (scene types itself in from the centre on launch / new sector), catalogue designations typed into the sky on first sight.
- Set pieces: ringed giant eclipsing the sun (event 5, 45 s), megastructure arc crossing the sky (event 6, 90 s). (Derelict capital hull arrives with the exploration layer in M5.)
- Speed cues: stars bunch toward the heading and blue/red-shift near top speed; boost streaks; camera zoom steps out at speed and at vistas (cell-size step hidden by a CSS scale tween; atlases cached per size; off with reduced FX).
- Readability: true dark halo (blank cells) around ships, bolts and pickups; bright nose `•` + flickering tail on every ship, player in a mint accent nothing else uses; player bolts two cells in one colour, enemy bolts `o` in another hue blinking slowly; background thins in fights; larger `#`/`.` HUD bars plus shield and heat; layer debug (`F10` / `?layers=1`).
- Debug: `?event=eclipse|mega&evt=<0..1>`, `?scanview=1`, `?layers=1`. Golden tool gained `url` and `console` modes.

## M4 — verticality experiment (off by default)
- Three altitude bands behind `?vert=1` / options toggle; climb R / dive G, gamepad bumpers. Altitude per entity and bolt; collisions are the 2D hash plus a height check.
- Depth cues in glyphs only: oblique lift, `.` shadow + `:` stalk, off-band dimming, z-sorted sprites, HUD altitude notches.
- Content: fly over planets at High, atmosphere cover/drag/heat at Low, rings at Mid, asteroid canyons, band-limited storms, band-aware enemy AI.
- Report with side-by-side screenshots: `docs/VERTICALITY.md`. Not tuned around; awaiting a keep/kill decision.
- Soak watchdog now asserts no hang (< 500 ms) and a sane average step (< 2 ms) instead of counting wall-clock hiccups.

## M5 + M6 — exploration layer and living galaxy (one galaxy model, one commit)
- `src/sim/galaxy.ts`: 40 seeded systems on a 100 ly chart (home HELIX at the centre), each with a star type, owning faction, hazards and 2-5 points of interest; four procedurally named factions with a relation matrix; per-system stability, wealth, piracy and supply of six commodities. Deterministic from the seed, bounded, serialised into the save (validated on load).
- World: sectors hash with a per-system salt and end at 6 sectors from the origin (deep space beyond). Defaults stay the original endless field, so legacy tests are unchanged.
- Travel: galaxy chart (`N`, fog of war, jump-range ring, system info + news), jump drive (`jumpRange`, `jumpCharge`, fuel by distance; hits stall the charge), time-compressed cruise (`Y`; x4 speed, no weapons, dropped by hostiles, wells, damage and POIs), wormholes as free shortcuts.
- Fuel: burns with thrust (x2 boosting, x1.5 cruising); dry tanks leave 30% thrust; refuel at stations or scoop by skimming a gas giant (Low band when vertical is on).
- Scanning: hold `Q` near a body or POI (`scanRate`, `sensorRange`, Sensors module); nebulae and ion storms halve the speed unless the hull ignores them (Sextant). First surveys give survey data, a catalogue name stamped with your pilot tag (typed into the sky) and the scan view. Survey % per system; full surveys count toward unlocks.
- Points of interest: distress beacons (salvage, sometimes bait), derelict capital hulls (set piece; salvage, logs, fragments), pulsars (radiation, EM resist helps), rogue planets, wormholes, ion storms (shields off, HUD glitches), ore-rich belts (extra scrap), comets, nomad fleets, megastructures (triggers the sky-crossing set piece), quiet signals (fragments). Untouched POIs show as dim signal bearings at the screen edge before anything is visible.
- Hazards gate ships: radiation (EM resist), hot stars (heat dissipation), ion storms (shields), gravity wells, debris.
- Living galaxy: a tick every 3 minutes of play applies data-driven events (pirate surges, booms, famine, blockades, lost freighters, faction fire, truces, rumours). Kills, destroyed haulers, trade and defended stations move the numbers; piracy scales enemy pressure in that system.
- News ticker (dim, top row, `K` skips, option to disable). Station services: sell survey data, refuel, trade goods (buy/sell per commodity, hold = `cargo`; Mule's cargo soaks damage). Ship logs: the optional mystery of the quiet lanes in 8 fragments, plus recovered derelict logs.
- Game-over summary adds ship, distance, survey % and notable events of the run.

## M7 — integration and progression
- Modules: the ten station upgrades are now data (`MODULES` in ships.ts) in five families (weapons, hull, engine, reactor, utility) applying additive / multiplicative modifiers to the hull's ShipDef. The sim reads only the effective def (`sim.ship` = `sim.base` + modules). New slots: reactor, sensors, fuel tanks. Cannon fire rate is now linear (+8% per level).
- Module art: missile pods, sensor dish and armour plating rows appear on any hull carrying them.
- Economy loop: scrap (kills, salvage, ore), survey data (scans, sold at stations), trade goods (price differences between systems); unlocks read lifetime stats from all of it.
- Daily seed seeds the run and the whole galaxy (daily galaxy state is not saved). Game-over summary and the copied result line list ship, distance, survey % and notable events.
- Wren trace re-baselined (upgrades now flow through ShipDef).

## M8 — polish, performance, tests
- Soak over every hull x 2 seeds x vertical off/on, 3 simulated minutes each, hopping galaxy systems: no NaN, bounded counts, no cyclic hash chains, bounded explosion chains, bounded galaxy state, sane step time.
- Tests now cover ShipDef validation and budgets, Wren regression, galaxy and procedural-generation determinism, save migration and galaxy load validation, vertical-collision rules, exploration sim (scan, fuel, cruise, jump, POIs, trade), modules.
- Golden scenes: 14 (home, fleet, shop, map, gas giant, hangar, roster of all hulls, vertical off/on, chart, derelict, eclipse, scan view, layer debug). Screenshot sessions disable the timing-dependent auto-zoom and freeze debug set-piece progress, so baselines are stable.
- `node scripts/golden.mjs perf '<query>'` reports the perf overlay at 720p / 1080p / 1440p. DESIGN.md has the numbers and the before/after comparison.
- Docs: DESIGN.md (v3 decisions), TUNING.md (generated: every field, range, roster value, rating, module), README controls.

## v3.1 — backdrop and Wren restored
- Reverted the M3 negative-space backdrop: pre-M3 star density and brightness, bright-star arms, nebulae in every sector, galaxy frequency, no background glyph budget.
- Sun blooms again (pre-M3 corona, rays and streak); removed the glyph sun core, diffraction-spike rows and flare-ghost rings.
- Cells around ships are dimmed (pre-M3) instead of blanked.
- Wren uses its original X-wing style hull and paint again. Flight unchanged.
- Goldens and `docs/screens` regenerated.

## v3.2 — legibility
- Removed the speed "aberration" (stars warped toward the heading above ~110 speed; per-cell star hashing made the whole field reshuffle like a ripple when thrusting) and the auto camera zoom on boost/vistas (the grid resized mid-flight).
- Lasers are glowing SDF sprites again, larger and brighter, with a short trailing glow; enemy bolts green (colour-blind palette unchanged). Removed the black 3x3 halos around bolts and pickups.
- Ships draw 1.35x larger than before (hitboxes unchanged), nose marks and engine glows scaled to match.
- Star cells keep the nebula behind them instead of a black box.
- Debug `?fire=1` holds fire (for bolt screenshots).

## v3.3 — visual overhaul: ships, hyperspace boost, all hulls open
- Boost (Shift) is a hyperspace tunnel: star-lines rush outward from a vanishing point ahead of the ship, ramping in over ~0.3 s and out over ~0.5 s. Built in polar coordinates with a continuous outward phase, so lines slide smoothly instead of reshuffling. Reduced FX keeps 40%.
- Hull legibility: every hull has a vivid signature colour (Wren white/red, Needle ice cyan, Anvil industrial orange, Sextant teal + gold, Mule khaki with saturated containers, Shade violet, Magpie rust/teal/yellow, Hive honey), flatter lighting so the whole silhouette reads, solid colour tiles behind hull glyphs, and a dark outline ring.
- Hull glyphs: edges use shape glyphs only (no `@ & $ % " ~` noise); interior fill ramp `. : - = + * #`.
- Shade is fully visible unless running dark.
- Glyph cells (stars, planet materials, streaks) borrow the surrounding backdrop instead of drawing black boxes; planet night sides fall back to the plain ramp instead of a field of material glyphs.
- All ships unlocked from the start; unlock goals remain as achievements in the hangar.
- Debug `?boost=1` holds boost.

## v4.0-alpha (visual overhaul, phases A, C, H1-H2)
- Backdrop ramp is light glyphs only; hull fill is structural glyphs only (no shared vocabulary).
- Quiet zone: backdrop fades to black around every ship; allegiance-tinted rim (hostile rim dotted); diagonal dark ring.
- Always-on wingtip lights, strobe, idle engine pilot light; planet-shadow floor raised to 45%.
- Anvil recoloured steel-blue with yellow hazard stripes; hostile hulls slightly desaturated.
- `node scripts/golden.mjs contrast`: hull-vs-surround test (8 hulls x 6 themes, fails below 3:1). Debug params `?theme=0..5`, `?idle=1`.

## v4.0-alpha.2
- Removed the speed ripple (engine heat shimmer and star dashes); only the hyperspace tunnel reacts to speed.
- Removed the allegiance rim ring around ships; quiet zone is softer (backdrop never below 35%); original glyph ramp restored so the sun bloom is back.
- Per-sector sky: palette hue, cloud scale, star density, filament strength; stellar-class star colours, clustered stars, far colour wash layer.
- New silhouettes for Needle, Anvil, Sextant, Mule, Shade, Magpie, Hive and every enemy (drone, gunship, minelayer, dreadnought, sniper, splitter, rammer, tender). Wren unchanged. Hostile hulls lean red.

## v4.0-alpha.3
- Combat FX: glyph tails on player bolts, enemy bolts are `o`, sparks cool through `* + ' ,`, glyph explosions (`@ # % * : .`), shield-hit `( )` arcs at the impact angle.
- Planets: terminator band, night-side city lights, latitude-shaped gas bands, `( )` atmosphere rim on the lit limb.
- Hyperspace: entry flash, slight hull stretch, tunnel tinted by the sector palette.
- HUD: larger cells at 1440p+, low-hull warning is a pulsing ring around the ship instead of a full-screen tint. Player hull drawn slightly larger; hangar preview larger and slower.

## v4.0-alpha.4
- Vivid skies: saturated per-sector nebula palettes, hot emission cores, rim-lit dust lanes, bright knots and filaments, more (and brighter) galaxies and stars, a stronger sun corona, richer glyph colour. Dark gaps kept for contrast.
- Removed the black-screen reveal that replayed on every sector crossing (it was the "ripple" at speed); removed the speed fade and whole-cell backdrop scrolling that were earlier guesses.
- Mule frames thickened and brightened for contrast.

## v4.0-alpha.5
- Camera: restored the original follow (my boost easing let the ship drift to the screen edge and snap back when flying up).
- Enemy palettes: each hostile has its own bright hue (crimson drone, amber gunship, purple minelayer, red/steel dreadnought, icy-blue sniper, toxic-yellow splitter, red-orange rammer); drone drawn larger. Magpie body and claw made bolder.
- `?roster=2` shows every enemy and object side by side.

## v4.0-alpha.6 (physicality)
- Solid bodies: ships, enemies, stations and rocks now collide at the size they are drawn (body radius per kind; the smaller `er` stays the bullet hitbox). The player's body radius follows its hull art.
- Swept collision: the ship's whole path each tick is tested, so boost and cruise speed can no longer tunnel through small rocks.
- Weight: impacts exchange momentum by mass (restitution 0.4). Heavy rocks and the dreadnought barely move; light rocks and drones are flung. Hits throw sparks and shake the screen; stations are immovable.
- Planet surface is resolved after the move, so the ship can never end a tick inside a planet (it used to overlap by up to ~2.6 units at boost speed).
- Enemy-vs-enemy and enemy-vs-rock separation uses the same body sizes.
- New tests: test/collision.test.ts (7). Flight-trace fixture regenerated (collisions legitimately change it); one planet-atmosphere test re-placed to match the new body size.
