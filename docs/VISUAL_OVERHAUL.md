# Asterion: visual & graphics overhaul plan (v4)

Status: **mostly implemented (v4.0-alpha.6)**; see the status table below. Original baseline was v3.3. The sections after the table are the
original plan text and are kept for reference; where the table says an item was reversed or changed, the table wins.

### Implementation status

| Phase | Done | Changed / reversed | Not done |
|---|---|---|---|
| **A** figure/ground | A3 quiet zone (softened, never below 35% so space is not black), A5 hull contrast floor, A7 nav lights + strobe + idle engine glow, A8 shadow floor (45%) | A1 separate glyph vocabularies reversed (the original ramp is back so the sun bloom stays); A6 allegiance rim removed (it read as a green circle) | A2 true distance field (circles are used), A4 fully cleared backdrop tile, stronger rim light in shadow |
| **B** ship art | B1/B2 new silhouettes + negative space for every hull except Wren (kept); B4 player drawn larger; B6 bigger slower hangar preview; silhouette-only mode (`?sil=1`) and `silhouette` test | | B3 systematic palette-vs-theme check, B5 panel lines as glyph structure |
| **C** colour | player mint accent; Anvil steel-blue with hazard stripes; each enemy has its own bright hue | C1 hostile = red was replaced by one hue per enemy type; C3 enemy muting reversed (brighter instead); C4 dotted rim removed with the rim | Magpie mint rim |
| **D** combat FX | D1 bolt tails + enemy `o` bolts, D2 spark glyphs, D3 shield arcs, D4 glyph explosions | | D4 light flash on nearby hulls, D5 enemy muzzle flashes |
| **E** backdrop | E1 three-depth nebula, E2 lit dust-lane edges, E4 stellar-class colours + clustered stars, E5 more/brighter galaxies, per-sector palette/scale/density | E6 is per sector, not tied to the system's star class | E3 god-rays blocked by planets, E4 far-layer-only twinkle |
| **F** planets | F1 city lights, F2 terminator band, F3 latitude gas bands, F4 `( )` atmosphere rim | F5 rings already had occlusion | |
| **G** hyperspace | G2 palette-tinted tunnel | G1 entry flash + stretch removed again (owner: nothing extra on boost) | G5 halved line count in reduced-FX |
| **H** tooling | H1 contrast test (8 hulls x 6 themes x home / sun glare / planet shadow), H2 `?theme=` `?idle=1` `?sil=1`, H3 golden scenes per phase (`idle_neb_0..5`, `idle_sun`, `idle_shadow`, `roster_silhouette`, `roster_enemies`, `hangar_*`), H4 before/after sheets (`node scripts/golden.mjs sheets` -> `docs/screens/v4/`) | | |
| **I** HUD | larger cells at 1440p+, low-hull warning is a pulsing ring around the ship | | |

Related changes made along the way: the black-screen "typed arrival" no longer replays on every sector crossing; all screen-space distortion
(explosion shock-ring warp, engine heat shimmer) is gone; the camera follow is the original; ships, enemies and rocks are physically solid
(body radius per kind, swept collision, mass-based impacts; see `test/collision.test.ts`).
Constraint that does not change: everything on screen is a text glyph. Performance is not the limiter
(CPU 0.4–0.7 ms/frame, sim 0.1–0.2 ms; the GPU passes are per-cell), so this plan spends GPU work freely,
but every phase still re-checks `?perf=1` at 1080p.

---

## 1. The problem, stated precisely

Owner play-test finding (v3.3): **an idle ship over certain backgrounds blends into them and is hard to find.**
It is worst in bright nebula sectors and near the sun; it is fine over empty space.

### Root causes found in the code

| # | Cause | Where |
|---|---|---|
| 1 | **Hull and backdrop share the same glyph vocabulary.** The background ramp is `' .:-=+*#%@'` (classic), and the hull interior fill ramp is `. : - = + * #`. In a bright nebula the backdrop is drawn in `= + * #` too, so a hull is "more of the same texture". | `src/gfx/atlas.ts` `RAMPS`, `FILL_CHARS` |
| 2 | **Both layers paint a coloured cell background.** Nebula cells get `bg = rgb * bgK (0.5)`; hull cells get `bg = avg * 0.5`. Same treatment, similar luminance, so the hull's "solid tile" is indistinguishable from a nebula tile. | `FS_ASCII`, `FS_MATCH` in `shaders.ts` / `spriteShaders.ts` |
| 3 | **Outline is too thin.** The dark ring only checks the 4 orthogonal neighbours, one cell deep, at 0.85 dim. Diagonal gaps leak backdrop straight up to the hull edge; at 10–14 cells per ship, one ring is not enough against busy texture. | `FS_ASCII` halo block |
| 4 | **Idle ships lose their only motion and light cues.** Engine glow and flame vanish when not thrusting (`thrS` falls to 0.12); the nose `•` is one cell; nothing on the hull blinks steadily. A static texture on top of an animated (dithered, twinkling) backdrop reads as background. | `draw.ts` player block, `marks()` |
| 5 | **Hull colours collide with backdrop hues.** Nebula themes are white, red, green, violet, amber and blue (`THEMES` in `main.ts`). Wren is white/grey, Needle ice-cyan, Shade violet, Hive/Anvil amber: each has at least one theme it disappears into. | `main.ts` `THEMES`, `paint()` |
| 6 | **Ships are darkened by planet shadow and by the light direction.** `shade()` multiplies the hull down in a planet's shadow, and the unlit side still sits at 0.42 ambient: a dark hull over a dark-but-textured backdrop. | `draw.ts` `shade()`, sprite lighting |
| 7 | **Friend/foe colour language is muddled.** Enemy hulls and bolts are red/orange; Anvil (orange), Magpie (rust) and Wren's red stripes use the same family. | `paint()` |
| 8 | **Three hull silhouettes are basically rectangles** at game size (Mule, Hive, Anvil), so they cannot be recognised by shape, only by colour. | `spriteShaders.ts` `fMule`, `fHive`, `fAnvil` |

---

## 2. Design principles for v4

1. **Two languages, never mixed.** The backdrop speaks in *light* glyphs (`. , ' \` : - ~` and the star set). Ships, bolts and pickups speak in *structural* glyphs (`# = + / \ | ( ) [ ] < > ^ _`). No glyph is used by both layers. This is about glyph *shape* only; nebula brightness, colour and density stay as dense as now (the M3 mistake was cutting brightness and density; this does not).
2. **Every ship carries its own quiet zone.** The backdrop is suppressed in a soft radius around every ship, scaled to ship size, so a ship always sits in darkness, whatever is behind it.
3. **Contrast is measured, not eyeballed.** A test renders every hull, idle, over every nebula theme and near the sun, and fails if hull-vs-surround luminance contrast drops below a threshold.
4. **Something on every ship is always moving and always bright**: nav lights, an idle engine pilot light, a strobe. A ship never becomes a static texture.
5. **Colour has meaning**: player hulls have a cool rim and a mint accent; hostiles are red/magenta; neutrals are amber; pickups are white/green. Hull body colours stay per-ship, but allegiance is carried by rim/outline colour, which is reserved.

---

## 3. The plan, phase by phase

Each phase lists the work, the acceptance check, and the golden scenes it adds.

### Phase A: Figure/ground separation (fixes the idle-blending bug; do first)

| Item | Change | Detail |
|---|---|---|
| A1 | **Separate glyph vocabularies** | New background ramp built only from light glyphs (e.g. `' .,:;-~'` plus star glyphs), still 8+ brightness levels via colour/brightness rather than heavier glyphs. Hull fill stays structural (`- = + * #`), edge matcher already shape-only. Bright nebula cores show as brighter/whiter light glyphs, not `#`. |
| A2 | **Distance-to-ship field** | After the glyph matcher, build a low-res coverage mask of all sprite cells (MA alpha), run 2 separable blur passes (or a small jump-flood) to get "distance to nearest hull cell" per cell. Cheap at cell resolution (≈ 240×68 texels). |
| A3 | **Quiet zone** | In `FS_ASCII`, attenuate backdrop by distance: 0 cells → black, 1 cell → 10 %, 2 cells → 35 %, 3 cells → 70 %, 4+ → 100 %. Radius scales with ship size (pass sprite size into the mask). Replaces the 4-neighbour 0.85 dim; includes diagonals. |
| A4 | **No solid tile for the backdrop near ships** | Inside the quiet zone the backdrop cell background (`bg`) is 0, so only hulls own a filled cell background. Hulls keep their solid tint tile, which then reads as a "lit object on black". |
| A5 | **Adaptive hull contrast** | `FS_ASCII` already has the scene colour under each hull cell. Compute local backdrop luminance from the blurred scene; if the hull fg is within 3:1 of it, brighten the hull fg and darken its bg until it is. Effectively an automatic exposure for the ship only. |
| A6 | **Allegiance rim** | The first ring cell around a hull is not pure black but a very dark allegiance tint (player: deep mint, hostile: deep red, neutral: deep amber). A ship outline you can read even with the hull half in shadow. |
| A7 | **Always-on lights** | Every hull gets red/green wingtip nav lights (glyph `•`, steady), a white strobe every ~1.2 s, and an idle "pilot light" in the engine (thrust level floor 0.25 instead of 0.12). The player strobe is mint. Shade's lights switch off only when running dark (that is its design). |
| A8 | **Planet-shadow floor** | `shade()` never takes a hull below 45 % brightness; in shadow the rim light gets stronger instead, so ships in a planet's shadow read as silhouettes with a bright edge. |

Acceptance:
- New automated **contrast test** (see Phase H) passes for all 8 hulls × 6 nebula themes × {open space, nebula core, sun glare, planet shadow}, idle and thrusting.
- Owner re-test: idle ship findable within ~1 s in every sector.

New golden scenes: `idle_neb_<theme>` (×6), `idle_sun`, `idle_shadow`.

### Phase B: Ship art redesign at glyph scale

Design hulls for the size they are actually shown at (12–18 cells across), not for the SDF.

| Item | Change |
|---|---|
| B1 | **Silhouette spec per hull.** Each hull gets one unmistakable outline feature readable at 12 cells: Wren (keep: X-wing, four wing tips), Needle (one long line, 3:1 length), Anvil (wide hammerhead front + twin barrels), Sextant (ring with a hole in the middle), Mule (spine + two detached container rows with a gap), Shade (flat chevron/arrowhead, notched rear), Magpie (asymmetric: one long claw arm), Hive (hexagon ring with a bay opening). The test: the silhouette alone (single colour) must be identifiable in a 12×12 thumbnail. |
| B2 | **Negative space inside hulls.** Gaps between wing and body, ring holes, container gaps. Gaps are what make a glyph silhouette readable; today the hulls are filled blobs. |
| B3 | **3-tone palette + emissive per hull**: primary body, secondary (wings/pods), accent (stripes, canopy), emissive (engine, lights). Palette chosen so it does not match any nebula theme hue at the same lightness (check against `THEMES`). |
| B4 | **Bigger player.** Player hull drawn at 1.5× (enemies stay 1.35×). The player is the thing you look at most. |
| B5 | **Panel lines as glyph structure.** Interior detail uses `=`/`|` panel rows aligned to the hull axis rather than luminance noise, so it reads as plating, not static. |
| B6 | **Hangar preview at 3×**, slow turntable, with a silhouette-only toggle for checking. |

Acceptance: roster scene, silhouette-only mode, each hull named correctly by someone who has seen the list once.

New golden scenes: `roster_silhouette`, `hangar_<ship>` for 2–3 representative hulls.

### Phase C: Colour language

| Item | Change |
|---|---|
| C1 | Reserved hues: mint = player (rim, nose, strobe, UI accent), red/magenta = hostile (rim, bolts, nose), amber = neutral (haulers, stations), white/green = pickups. |
| C2 | Hull body colours that collide with reserved hues get shifted: Anvil body from orange to steel-blue with yellow hazard stripes; Magpie rust stays but gets a mint rim (it's yours). |
| C3 | Enemy hull bodies desaturated slightly (charcoal/dark crimson) so player hulls are always the most saturated object on screen. |
| C4 | Colour-blind palette: allegiance also carried by rim *pattern* (player rim solid, hostile rim dotted `:` cells), not only hue. |

### Phase D: Combat FX legibility

| Item | Change |
|---|---|
| D1 | Bolts: bright core glyph plus a 2–3 cell tail along the velocity, plus glow (today glow plus sprite). Enemy bolts get a distinct glyph shape (`o`/`*`) as well as a distinct hue. |
| D2 | Hit feedback: a 2-frame white flash on the hull, plus a spark burst of 4–6 `'` `,` glyphs flying off along the impact normal. |
| D3 | Shield hits: an arc of `( )` glyphs on the ring at the impact angle, fading over 0.3 s. |
| D4 | Explosions as glyph sequences: `* → # → @ → % → : → .`, expanding ring, debris glyphs with velocity, and a short light flash on nearby hulls. |
| D5 | Muzzle flash per hardpoint (Anvil already has per-barrel flashes; generalise). |
| D6 | Combat focus: while hostiles are within range, backdrop exposure −25 % (the existing `combat` factor, made stronger and smoother). |

### Phase E: Backdrop richness (in the direction the owner liked)

All of this lives outside the ship quiet zones (Phase A), so it can be lush without hurting readability.

| Item | Change |
|---|---|
| E1 | **Three-depth nebula**: far wash (very low contrast, colour only), mid clouds (current), near wisps (faster parallax, light glyphs). Gives depth instead of one flat texture. |
| E2 | **Dust lanes and dark clouds**: absorption that cuts the nebula, giving shape and "caves" of darkness. Natural quiet areas. |
| E3 | **Sun**: keep the soft bloom; add slow god-ray glyph columns (`'` `.`) that fan from the sun and are blocked by planets (ray-march across planet discs in the scene pass), and a subtle heat shimmer near the corona. |
| E4 | **Star field**: 3 parallax layers plus rare bright stars with 4-arm `-|` glints (exists); add colour by stellar class, and slow twinkle only on the far layer (the near layer is steady so it does not flicker against ships). |
| E5 | **Distant set pieces** (galaxies, megastructure, eclipse) keep their current form; give galaxies a visible spiral in light glyphs. |
| E6 | **Per-system palette**: system star class sets sun tint and nebula palette together (cohesive look per system instead of independent random tints). |

### Phase F: Planets

| Item | Change |
|---|---|
| F1 | Night side: plain dark ramp (done in v3.3), plus sparse city lights (`.` warm) on habitable worlds. |
| F2 | Clear terminator: a 1-cell soft band of `:` at the day/night edge. |
| F3 | Gas giants: fewer, wider bands; band glyphs follow latitude curvature (`~` near the equator, `-` toward the poles) and drift slowly, instead of full-disc rows of dashes. |
| F4 | Atmosphere rim: a coloured 1–2 cell `( )` rim on the lit limb. |
| F5 | Rings: elliptical, with front/back occlusion (back half hidden behind the disc), drawn in `=` `-`, and a ring shadow across the disc (exists). |

### Phase G: Hyperspace boost polish

| Item | Change |
|---|---|
| G1 | Entry: 0.15 s flash at the vanishing point plus the ship stretched 1.2× along its heading (sprite scale only). |
| G2 | Tunnel tint from the current system palette (Phase E6). |
| G3 | Exit: lines decelerate and shrink back into stars over 0.4 s (no ripple, no reshuffle). |
| G4 | Quiet zone still applies: tunnel lines never cross the player hull. |
| G5 | Reduced FX: line count halved, no flash. |

### Phase H: Tooling that keeps this from regressing

| Item | Change |
|---|---|
| H1 | **Contrast test**: `scripts/golden.mjs contrast` renders each hull × theme × context (Phase A list), reads the PNG, finds hull cells via a debug layer mask (`?layers=1` already colours ship cells), and computes luminance contrast between hull cells and the ring 2–4 cells out. Fails below 3:1. Runs in CI next to goldens. |
| H2 | Debug params: `?theme=0..5` forces a nebula theme; `?idle=1` holds no input after spawn and skips invulnerability blink (screenshots currently catch the blink and lose the ship). |
| H3 | Golden scenes added per phase (listed above). |
| H4 | Before/after sheets: `node scripts/golden.mjs shots` into `docs/screens/v4/` so every visual change ships with side-by-side images. |

### Phase I: HUD (lower priority)

Bigger readouts at 1440p+, HUD panels with a solid dark background so the nebula never shows through text, and a low-hull pulse that uses the allegiance rim rather than full-screen tint.

---

## 4. Suggested order

1. **A** (fixes the reported bug; the biggest legibility gain).
2. **H1–H2** right after A1–A3, so later phases are measured against the contrast test.
3. **C**, because it is cheap and B depends on the palette.
4. **B** (the largest art job: 7 hulls).
5. **D**, then **E**, **F**, **G**, **I**.

Commit per phase, goldens regenerated per phase, CHANGELOG entry per phase.

---

## 5. Material improvements: v3.0 → v3.3 (done) and v3.3 → v4 (planned)

### Already shipped since v3.0 (M3)

| Area | v3.0 (M3) | v3.3 (now) |
|---|---|---|
| Backdrop | Sparse dim stars, nebula in ~1 of 5 sectors, brightness capped | Dense parallax stars, nebula everywhere, no cap |
| Sun | Glyph core `@ * +`, long spike rows, flare-ghost rings | Soft bloom with corona, rays and streak |
| Wren | Original swept-delta redesign | X-wing hull restored |
| Speed effect | Star "aberration" ripple above ~110 speed; auto-zoom resized the grid | Both removed |
| Boost | Stars turn into dashes | Hyperspace tunnel: radial star-lines from a vanishing point ahead |
| Lasers | Two text cells, black 3×3 halo around each | Glowing sprite bolts with a trailing glow; enemy bolts green |
| Ships | Small, dim, `@ & $ %` edge noise, Shade near invisible | 1.35× size, vivid per-hull colours, flatter lighting, solid hull tiles, dark ring, shape-only edge glyphs, Shade visible |
| Star/planet glyph cells | Black boxes in nebulae | Borrow surrounding backdrop |
| Gas giant night side | Rows of bright blue dashes | Plain dark ramp |
| Unlocks | Gated by play goals | All hulls open from the start |

### Planned in v4

| Area | v3.3 (now) | v4 (planned) |
|---|---|---|
| Idle ship over nebula/sun | Can blend into the backdrop | Quiet zone (2–4 cells of darkness around every ship), separate glyph vocabularies, adaptive hull contrast. Test-enforced 3:1 minimum |
| Outline | 1 cell, 4 neighbours, 0.85 dim | 2–4 cell graded falloff, includes diagonals, allegiance-tinted first ring |
| Glyph language | Backdrop and hulls share `= + * #` | Backdrop light glyphs only; hulls structural glyphs only |
| Idle cues | Ship goes static, glow off | Nav lights, strobe, pilot-light engine, always moving and always bright somewhere |
| Shadowed ships | Can drop to near-black | 45 % floor plus a stronger rim in shadow |
| Silhouettes | Mule/Hive/Anvil read as rectangles | Each hull has one signature shape feature and internal negative space; silhouette-only test |
| Player size | 1.35× | 1.5× |
| Colour meaning | Hull and enemy hues overlap | Reserved allegiance hues (mint/red/amber), shown in rim and lights; colour-blind pattern backup |
| Hits/explosions | Glow + particles | Spark bursts, shield arcs, glyph explosion sequences, light flash on nearby hulls |
| Backdrop depth | One nebula layer pair | Far wash, mid clouds, near wisps, dust lanes, god rays, per-system palette |
| Planets | Material glyph fields | Terminator band, city lights, curved gas bands, lit atmosphere rim, occluded rings |
| Hyperspace | Tunnel only | Entry flash and stretch, system-tinted tunnel, smooth exit |
| Regression guard | Goldens per machine only | Automated contrast test across hulls × themes × contexts, plus new golden scenes and before/after sheets |

---

## 6. Non-goals and risks

- **Non-goals**: no non-ASCII rendering, no new dependencies, no gameplay or balance changes, no change to hitboxes (art may grow; collision stays).
- **Risk: the quiet zone looks like a "hole" around ships.** Mitigation: graded falloff, radius scaled to ship size, tuned with the owner's play-test; a setting slider (0–100 %) if needed.
- **Risk: light-only backdrop glyphs lose richness.** Mitigation: richness moves into colour, depth layers and dust lanes (Phase E) rather than glyph weight; compare `docs/screens/v4/` against v3.3 before committing.
- **Risk: Shade's stealth fights the contrast test.** Shade is exempted only while running dark (it's a mechanic); the test runs it in the normal state.
- **Software-GL screenshots differ from real GPUs.** Goldens stay per-machine; the contrast test uses thresholds, not pixel equality, so it holds across machines.
