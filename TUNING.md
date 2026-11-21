# Tuning reference

Generated from `FIELDS`, `ROSTER` and `MODULES` in `src/sim/ships.ts` (the validator and the `?tune=1` panel use the same ranges).
Values are absolute; the brief's relative table (Wren = 100) was turned into these by `make()`.

## Fields

| Field | Group | Safe range | Used from | What it does |
|---|---|---|---|---|
| `mass` | flight | 20 .. 400 | M1 | scales acceleration (thrust/mass), ram damage dealt, knockback taken |
| `thrustFwd` | flight | 1000 .. 40000 | M1 | forward thrust; acceleration = thrustFwd / mass |
| `thrustRev` | flight | 0 .. 20000 | M1 | reverse thrust while braking below 4 u/s (backing up) |
| `thrustLat` | flight | 0 .. 20000 | M1 | strafe thrust (strafe keys) |
| `maxSpeed` | flight | 40 .. 260 | M1 | cruise speed cap; boost cap is maxSpeed x 1.61 |
| `grip` | flight | 0 .. 1 | M1 | lateral grip per second under thrust (coasting uses 31%); low = drift |
| `assist` | flight | 0 .. 1 | M1 | flight-assist damping per second when not thrusting (assist on) |
| `brake` | flight | 0.2 .. 8 | M1 | brake damping per second |
| `turnRate` | flight | 0.5 .. 6 | M1 | max keyboard turn rate (rad/s); mouse aim uses x1.42 |
| `turnAccel` | flight | 1 .. 30 | M1 | angular acceleration (rad/s^2); release decays at x1.33 |
| `boostMult` | flight | 1 .. 3.5 | M1 | thrust multiplier while boosting |
| `boostCap` | flight | 20 .. 300 | M1 | boost energy capacity |
| `boostDrain` | flight | 5 .. 80 | M1 | boost energy used per second |
| `boostRegen` | flight | 1 .. 40 | M1 | boost energy regained per second |
| `dashImpulse` | flight | 0 .. 160 | M1 | dodge velocity impulse |
| `dashCooldown` | flight | 0.3 .. 5 | M1 | seconds per dash charge |
| `dashIFrames` | flight | 0 .. 1 | M1 | invulnerable seconds after a dash |
| `dashCharges` | flight | 1 .. 3 | M2 | dash charges |
| `gravSusceptibility` | flight | 0 .. 2 | M1 | multiplier on planet gravity pull |
| `energyMax` | power | 20 .. 300 | M2 | weapon energy capacity (1 per bolt) |
| `energyRegen` | power | 1 .. 60 | M2 | weapon energy per second |
| `heatMax` | power | 30 .. 300 | M2 | heat capacity; over it weapons lock and the hull burns |
| `heatDissipation` | power | 1 .. 40 | M2 | heat shed per second |
| `hullMax` | defence | 20 .. 500 | M1 | hull points |
| `hullRegen` | defence | 0 .. 10 | M1 | hull repair per second |
| `hullRegenDelay` | defence | 0 .. 15 | M1 | seconds after a hit before hull repair starts (0 = always) |
| `armor` | defence | 0 .. 6 | M2 | flat damage reduction per hit (never below 25% of the hit) |
| `shieldMax` | defence | 0 .. 300 | M2 | shield points, absorbed before hull |
| `shieldRegen` | defence | 0 .. 40 | M2 | shield regen per second |
| `shieldDelay` | defence | 0 .. 10 | M2 | seconds after a hit before shields regen |
| `resist.kinetic` | defence | 0 .. 0.8 | M2 | fraction of kinetic damage ignored (bolts, rams, rocks) |
| `resist.thermal` | defence | 0 .. 0.8 | M2 | fraction of thermal damage ignored (blasts, heat, plasma) |
| `resist.em` | defence | 0 .. 0.8 | M2 | fraction of EM damage ignored (rail shots, radiation) |
| `radius` | defence | 1 .. 6 | M1 | hitbox radius |
| `signature` | defence | 0.1 .. 3 | M2 | detectability: scales enemy notice range; boost/firing raise it |
| `fireRateMult` | offence | 0.2 .. 3 | M1 | fire rate multiplier (cooldown 0.105 s x 2 / hardpoints / mult) |
| `damageMult` | offence | 0.2 .. 3 | M1 | bolt damage multiplier |
| `boltSpeedMult` | offence | 0.5 .. 2 | M1 | bolt speed multiplier |
| `spread` | offence | 0 .. 0.3 | M1 | random aim jitter (rad) |
| `missileCap` | offence | 0 .. 12 | M1 | base missile capacity (the MISSILES module adds to it) |
| `fuelMax` | utility | 10 .. 400 | M5 | fuel capacity |
| `fuelBurn` | utility | 0 .. 2 | M5 | fuel per second of thrust (jumps cost fuel by distance) |
| `jumpRange` | utility | 2 .. 40 | M5 | jump range on the chart (light-years) |
| `jumpCharge` | utility | 0.5 .. 15 | M5 | seconds to charge the jump drive |
| `sensorRange` | utility | 100 .. 2000 | M5 | scan range and signal-detection range |
| `scanRate` | utility | 0.1 .. 5 | M5 | scan speed multiplier (base scan 2.5 s) |
| `cargo` | utility | 0 .. 200 | M6 | cargo hold (trade goods) |
| `tractor` | utility | 5 .. 120 | M1 | pickup / salvage pull radius |
| `climbRate` | vertical | 0 .. 8 | M4 | band changes per second (0 = locked to one band) |
| `altitudeBands` | vertical | 1 .. 3 | M4 | altitude bands this hull can use |
| `ramMult` | quirk | 0.5 .. 5 | M2 | ram damage multiplier (Anvil) |
| `cargoSoak` | quirk | 0 .. 0.8 | M2 | share of hull damage absorbed by carried cargo, 3 damage per unit lost (Mule) |
| `darkSig` | quirk | 0.02 .. 1 | M2 | signature while coasting and not firing; 1 = no effect (Shade) |
| `wingmen` | quirk | 0 .. 5 | M2 | drone wingmen launched near hostiles (Hive) |
| `nebulaScan` | quirk | 0 .. 1 | M5 | 1 = scans ignore nebula / ion interference (Sextant) |

## Roster values

| Field | WREN | NEEDLE | ANVIL | SEXTANT | MULE | SHADE | MAGPIE | HIVE |
|---|---|---|---|---|---|---|---|---|
| mass | 100 | 60 | 170 | 90 | 220 | 70 | 110 | 260 |
| thrustFwd | 7800 | 6084 | 9282 | 5967 | 9438 | 6006 | 8151 | 10140 |
| thrustRev | 0 | 2129 | 3249 | 2088 | 3303 | 2102 | 2853 | 3549 |
| thrustLat | 3500 | 2730 | 4165 | 2678 | 4235 | 2695 | 3658 | 4550 |
| maxSpeed | 118 | 148 | 94 | 112 | 83 | 124 | 106 | 77 |
| grip | 0.8 | 0.88 | 0.96 | 0.8 | 1 | 0.64 | 0.84 | 1 |
| assist | 0.9 | 0.55 | 0.6 | 0.7 | 0.6 | 0.5 | 0.75 | 0.6 |
| brake | 2.8 | 2.8 | 2.8 | 2.8 | 2.8 | 2.8 | 2.8 | 2.8 |
| turnRate | 2.6 | 3.64 | 1.69 | 2.34 | 1.3 | 3.12 | 2.6 | 1.17 |
| turnAccel | 9 | 12.6 | 5.85 | 8.1 | 4.5 | 10.8 | 9 | 4.05 |
| boostMult | 1.9 | 1.9 | 1.9 | 1.9 | 1.9 | 1.9 | 1.9 | 1.9 |
| boostCap | 100 | 130 | 70 | 80 | 50 | 120 | 90 | 45 |
| boostDrain | 30 | 30 | 30 | 30 | 30 | 30 | 30 | 30 |
| boostRegen | 9 | 11.7 | 6.3 | 7.2 | 4.5 | 10.8 | 8.1 | 4 |
| dashImpulse | 70 | 70 | 55 | 70 | 45 | 70 | 70 | 40 |
| dashCooldown | 1.3 | 1.6 | 1.3 | 1.3 | 1.3 | 1.3 | 1.3 | 1.3 |
| dashIFrames | 0.3 | 0.3 | 0.3 | 0.3 | 0.3 | 0.3 | 0.3 | 0.3 |
| dashCharges | 1 | 2 | 1 | 1 | 1 | 1 | 1 | 1 |
| gravSusceptibility | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| energyMax | 100 | 100 | 100 | 100 | 100 | 100 | 100 | 100 |
| energyRegen | 16 | 16 | 16 | 16 | 16 | 16 | 16 | 16 |
| heatMax | 100 | 100 | 140 | 100 | 100 | 100 | 100 | 100 |
| heatDissipation | 12 | 11 | 14 | 12 | 12 | 12 | 12 | 12 |
| hullMax | 100 | 55 | 190 | 80 | 150 | 60 | 100 | 220 |
| hullRegen | 3.5 | 3.5 | 3.5 | 3.5 | 3.5 | 3.5 | 1.5 | 3.5 |
| hullRegenDelay | 5 | 5 | 5 | 5 | 5 | 5 | 0 | 5 |
| armor | 0 | 0 | 1.5 | 0 | 1 | 0 | 0 | 1 |
| shieldMax | 20 | 14 | 26 | 18 | 20 | 10 | 18 | 32 |
| shieldRegen | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 8 |
| shieldDelay | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 3 |
| resist.kinetic | 0 | 0 | 0.25 | 0 | 0.1 | 0 | 0.1 | 0.15 |
| resist.thermal | 0 | 0 | 0.1 | 0.1 | 0.1 | 0 | 0 | 0.15 |
| resist.em | 0 | 0 | 0 | 0.3 | 0.1 | 0.2 | 0 | 0.15 |
| radius | 2.4 | 1.8 | 3.2 | 2.3 | 3.4 | 2 | 2.6 | 3.6 |
| signature | 1 | 1.1 | 1.3 | 0.7 | 1.4 | 0.4 | 1 | 1.5 |
| fireRateMult | 1 | 1.1 | 0.62 | 1.3 | 0.8 | 1.05 | 1.4 | 1.2 |
| damageMult | 1 | 0.8 | 1.15 | 0.95 | 0.9 | 1.1 | 1 | 1 |
| boltSpeedMult | 1 | 1.15 | 0.95 | 1 | 1 | 1 | 1 | 1 |
| spread | 0.03 | 0.03 | 0.05 | 0.03 | 0.03 | 0.03 | 0.03 | 0.03 |
| missileCap | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| fuelMax | 100 | 90 | 80 | 200 | 130 | 100 | 110 | 140 |
| fuelBurn | 0.25 | 0.25 | 0.25 | 0.2 | 0.25 | 0.25 | 0.25 | 0.25 |
| jumpRange | 14 | 12 | 10 | 22 | 12 | 15 | 14 | 16 |
| jumpCharge | 4 | 4 | 4 | 3 | 4 | 4 | 4 | 4 |
| sensorRange | 600 | 540 | 540 | 1320 | 480 | 720 | 660 | 780 |
| scanRate | 1 | 0.9 | 0.7 | 2.2 | 0.8 | 1.1 | 1.2 | 1 |
| cargo | 20 | 8 | 16 | 18 | 80 | 12 | 30 | 40 |
| tractor | 28 | 24 | 28 | 30 | 40 | 28 | 70 | 36 |
| climbRate | 2.5 | 4 | 1.8 | 2.5 | 1.2 | 3.5 | 2.2 | 0 |
| altitudeBands | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 1 |
| ramMult | 1 | 1 | 3 | 1 | 1 | 1 | 1 | 1 |
| cargoSoak | 0 | 0 | 0 | 0 | 0.35 | 0 | 0 | 0 |
| darkSig | 1 | 1 | 1 | 1 | 1 | 0.08 | 1 | 1 |
| wingmen | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3 |
| nebulaScan | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 |
| hardpoints | 2 fixed | 2 fixed | 4 fixed | 1 fixed | 2 turret | 2 fixed | 1 fixed | 1 turret |

## Derived ratings (50 = Wren) and stat budget (target: within 15% of Wren)

| Ship | SPEED | AGILITY | DEFENCE | FIREPOWER | SENSORS | STEALTH | HAUL | Budget | 0-95% s | Turn circle | EHP | DPS |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| WREN | 50 | 50 | 50 | 50 | 50 | 50 | 50 | 350 | 1.55 | 90 | 120 | 9.5 |
| NEEDLE | 62 | 59 | 35 | 47 | 44 | 46 | 38 | 333 | 1.48 | 81 | 69 | 8.4 |
| ANVIL | 34 | 41 | 82 | 61 | 37 | 40 | 47 | 346 | 1.78 | 111 | 349 | 13.6 |
| SEXTANT | 42 | 47 | 48 | 32 | 82 | 62 | 50 | 366 | 1.75 | 95 | 113 | 5.9 |
| MULE | 21 | 35 | 70 | 44 | 45 | 37 | 76 | 332 | 2.02 | 127 | 236 | 8.2 |
| SHADE | 56 | 52 | 37 | 55 | 54 | 83 | 44 | 382 | 1.48 | 79 | 75 | 11.0 |
| MAGPIE | 45 | 50 | 45 | 37 | 54 | 50 | 71 | 354 | 1.47 | 81 | 122 | 6.7 |
| HIVE | 17 | 32 | 84 | 38 | 58 | 35 | 63 | 330 | 2.07 | 131 | 370 | 6.9 |

## Modules (per level: value = base x (1 + mul x level) + add x level, + first at level 1)

| Module | Family | Effect | Modifiers |
|---|---|---|---|
| CANNONS | WEAPONS | +8% fire rate, +30% damage | fireRateMult x0.08, damageMult x0.3 |
| HULL PLATING | HULL | +25 max hull | hullMax +25 |
| BOOST CELLS | ENGINE | +25 boost capacity | boostCap +25 |
| ENGINES | ENGINE | +8% thrust | thrustFwd x0.08, thrustLat x0.08, thrustRev x0.08 |
| SCRAP MAGNET | UTILITY | +16 pickup range | tractor +16 |
| SPREAD SHOT | WEAPONS | side bolts | behaviour flag |
| MISSILES | WEAPONS | homing, ignores shields | missileCap +2 first +3 |
| REACTOR | REACTOR | +15% energy, +12% cooling | energyRegen x0.15, heatDissipation x0.12 |
| SENSORS | UTILITY | +15% range, +20% scan, +10% jump | sensorRange x0.15, scanRate x0.2, jumpRange x0.1 |
| FUEL TANKS | UTILITY | +20% fuel capacity | fuelMax x0.2 |

## Shared constants

`FLIGHT` in ships.ts: drag 0.09/s, coasting grip = grip x 0.3125, grip-to-nose transfer 0.5, turn release decay = turnAccel x 1.33, mouse-aim turn = turnRate x 1.42, boost top speed = maxSpeed x 1.61, base fire cooldown 0.105 s (x 2 / hardpoints / fireRateMult), bolt speed 215, heat per shot 0.5, boost heat 5/s.
Verticality: `V_TOL` 0.5 bands, lift 6 world units per band. Galaxy: tick every 180 s, systems bounded at 6 sectors.
