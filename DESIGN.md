# DIRTY AIR — design bible

**The one sentence:** cheap flat graphics, real F1 rules and real handling, and the
whole game is about *attacking and defending* — with a post-race highlight reel
that cuts your passes and your defences together.

Working directory name only; the game is unnamed so far. "Dirty air" is the
mechanic the whole thing is built on: you cannot follow closely without losing
front downforce, which is exactly why passing is hard and why the tow matters.

## Locked decisions
- **Keyboard.** Not a compromise — `input.js` models the DRIVER'S HANDS: the wheel
  winds on at a finite rate, self-centres faster than it winds on (so you catch a
  slide by letting go), and usable lock falls away with speed.
- **Top-down, world-up camera.** Readability of who is alongside you beats immersion,
  because the game is wheel-to-wheel.
- **Five real circuits**, geometry from OpenStreetMap, not drawn by hand.
- **Highlights are the point.** Every pass and every successful defence is detected
  live, then replayed with the real corner name attached.

## Tracks are real survey data, not art
`tools/bake.mjs` turns OSM data into `data/tracks/*.json`:
- centreline from the `f1-circuits` GeoJSON (OSM-derived), centripetal Catmull-Rom
  splined and resampled every 2 m
- baked lengths land within 0.4% of official: Monza 5768/5793, Suzuka 5805/5807,
  Zandvoort 4254/4259, Monaco 3321/3337, Baku 5939/6003
- **corner names and official corner numbers come from OSM tags** (Degner, Spoon,
  130R, Tarzanbocht, Hugenholtzbocht, Lesmo, Variante Ascari, Curva Alboreto...)
- **Zandvoort's banking is real** — OSM literally tags Hugenholtzbocht and Arie
  Luyendykbocht "Helling 32% / 18 graden"
- **pit lanes are the real ones** from OSM for 4 of 5; Monaco's is synthesised
  alongside Boulevard Albert 1er because OSM only has the pit *building*
- direction verified from the data (Suzuka's corner numbers 1→18 increase with
  distance; signed area for the rest), not from memory
- Monaco's start/finish was derived: Boulevard Albert 1er ends at s=2623, the first
  tight right after it is Sainte Dévote, back off the real 170 m to the line

Check any of it with `node tools/map.mjs <track>` (ASCII map) or `tools/bake.mjs`.

## Physics (js/physics.js) — validated against real F1 numbers
Bicycle model, Pacejka-ish slip-angle tyres, longitudinal load transfer, friction
circle per axle, aero downforce/drag, tyre temperature and wear.

| quantity | model | real F1 |
|---|---|---|
| top speed | 321 km/h (355 w/ DRS) | ~330 / ~355 |
| downforce @300 km/h | 2000 kg | ~1800-2100 kg |
| Monaco hairpin (R9) | 45 km/h | ~48 km/h |
| Zandvoort banked R27 | 97 vs 84 km/h flat | +10-15 km/h |
| tyre working range | 60-86 °C in race | 90-110 °C |

Ideal-line lap times land within a few % of real pole: Monza 1:28 (real 1:20),
Zandvoort 1:17 (1:09), Baku 1:44 (1:41). `tools/laptime.mjs` is the gate.

## Rules implemented
DRS with a real detection line (gap < 1.0 s at detection, zone-limited, disabled
for the first 2 laps, closes under braking, and costs downforce when open) ·
track limits with 3 strikes → 5 s · causing a collision → 5 s · pit lane with an
80 km/h limiter and a stationary stop · **the two-compound rule** (+30 s if you
never change compound) · tyre compounds with different peak grip, wear rate and
temperature windows · cold tyres out of the pits.

## Gotchas already paid for (do not reintroduce)
- **Countersteer sign.** Steering off the raw rear slip angle is *positive feedback*
  and spins the car. Correct against the EXCESS rear slip only (`|αr| − |αf|`).
- **Stanley preview must be short** (~front axle). A long preview makes the heading
  term see a whole corner of rotation and turn in early, cutting to the inside wall.
- **Target the line offset where the car IS**, never sampled ahead — sampling ahead
  makes it chase the apex offset 25 m early and cut every corner.
- **Low-speed regularisation is mandatory.** With `vx → 0` raw slip angles blow up to
  90°, the friction circle eats all drive force, and the car scrubs to a halt at
  full throttle. Denominator floor of 6 m/s.
- **Tyre thermal scales.** An earlier cooling term had a ~1 s time constant, pinning
  every tyre at ambient: 30% less grip than the racing line demands, which makes
  the AI look broken when the tyres are the problem.
- **The AI must not brake on its own averaged braking estimate** — capability falls
  as you slow because downforce does. Track the baked profile instead.
- **Banking sign**: bankDir follows `sign(curvature)`, or the bank throws you out.
- **Damage on NEW contact only** — per-tick accumulation kills a car leaning on a wall.
- The grid sits behind the line, so the first crossing is the START, not a lap.

## Not done yet
- **AI pace is ~34% off the ideal line** and it still beaches occasionally. It races,
  it defends, it pits, it makes mistakes — but it is not yet quick.
- No safety car / VSC, no qualifying, no flags beyond yellow display.
- No sound.
- Monaco is the hardest for the AI (Swimming Pool).

## Harnesses (use these instead of guessing)
- `node tools/map.mjs <track>` — ASCII circuit map + corner radii
- `node tools/laptime.mjs` — ideal lap vs real pole for all five
- `node tools/pace.mjs <track>` — what pace the AI can actually sustain, cleanly
- `node tools/sim.mjs <track> <laps> <cars>` — headless race, full classification
- `node tools/reel.mjs <track>` — proves the highlight detector still fires
