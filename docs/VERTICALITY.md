# Verticality experiment (M4) — report

Toggle: `?vert=1`, or **VERTICAL (EXP.)** in the options menu (default off). Off means the pure 2D game: every altitude value stays 0
and every height check passes, so the Wren regression trace is unchanged with the flag off.

## What was built

| Piece | Implementation |
|---|---|
| Bands | Low / Mid / High at z = -1, 0, 1. Climb `R`, dive `G` (rebindable), gamepad RB / LB while vertical is on (missile moves to d-pad down, boost to LT). Edge-triggered, animated at `climbRate` bands/s: Wren 0.4 s, Needle 0.25 s, Mule 0.83 s, Hive locked to Mid (`altitudeBands` 1). |
| Hits | 2D spatial hash plus `|dz| <= 0.5`. Bolts keep the shooter's z. Ramming, mines and rammers need the same band; blasts reach one band either side. Enemies do not fire across bands. Missiles ignore altitude (they are smart weapons). |
| Depth cues | Oblique lift (6 world units = 3 rows per band), a `.` shadow on the Low ground plane with a `:` stalk up to the craft, things on other bands at 38% brightness, sprites sorted by z so High draws over Low, `ALT . # .` notches + band name in the HUD. |
| Content | Planets occupy Low and Mid (High flies over them, no pull, bolts pass over); Low band inside a planet's atmosphere drags, heats at 16/s and cuts signature 60% (cover); rings sit at Mid and chip the hull while you cross them; asteroid fields leave one band open (canyons), planet belts sit in Low and Mid; ion storms do not reach Low; enemies match your band to attack and leave it to flee (drones and rammers fast, bosses slow). |

## Side by side

Same scene, same seed and spawn, vertical off then on: run `node scripts/golden.mjs shots` to regenerate the `vert_off` / `vert_on` scenes locally (screenshots are not stored in the repo).

## Honest assessment

I could not play this; the assessment below comes from the screenshots and the headless sim tests, not from hands-on feel.

- **Readability at a glance: weak.** A 3-row lift is small next to 20-unit hulls, so in a still frame the bands mostly read as
  "some ships are dimmer". The dimming is the strongest cue and it works (off-band enemies clearly look harmless). Shadows and
  stalks only read when a craft is isolated; in a fight they add noise. The HUD notch is unambiguous but needs a glance away.
- **Control complexity: moderate.** Two extra keys on keyboard is fine. On gamepad the bumpers had to be repurposed, which moved
  missile and boost; that is a real cost for a twin-stick shooter.
- **Combat: probably easier, not deeper.** Changing band is an instant dodge: enemies need 0.45 to 1.7 s to follow, and they stop
  firing while off-band. Without a cooldown this is likely to become the dominant defence.
- **Stealth: genuinely interesting.** Low-band cover near planets (60% lower signature, but heat and drag) gives Shade and Sextant a
  reason to hug atmospheres, and it costs something.

## What I would change if it stays

1. Larger lift (10 to 12 units) plus a faint per-band tint, so bands read in a still frame.
2. A short band-change cooldown or a boost-energy cost, and enemies that telegraph their own band changes (a `^`/`v` above the nose).
3. Try two bands (Low/High) instead of three: half the states, same stealth and fly-over ideas.
4. Make rings and belt canyons visible at a distance (band-coloured edge glyphs) so routing through them is a choice, not a surprise.
5. Keep missiles altitude-agnostic; they become the answer to band-hopping enemies.

The game has **not** been tuned around verticality; it stays off by default until you decide.
