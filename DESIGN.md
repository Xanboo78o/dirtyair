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
- **Behind the car, in 3D.** I shipped top-down first and Adam rejected it
  immediately ("not top down???"). Low-poly 3D chase cam is the view. `C` cycles
  CHASE / CLOSE / NOSE / OVERHEAD. The simulation is view-independent, so the swap
  cost nothing but the renderer.
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
- **Never bleed `vy` when clamping `vx` at zero.** A spun car still has ground
  speed; bleeding lateral velocity destroyed all of it in ~0.05 s and read as an
  instant stop from 120 km/h.
- Past the front tyre's peak slip (~0.17 rad) MORE lock gives LESS grip. The
  controller must stop winding on or it scrubs the car straight off.
- **Run-off is per side (`runL`/`runR`).** The clamp that stops the INSIDE of a
  tight corner inverting must not touch the outside, or a chicane becomes a
  2.5 m walled box that beaches anyone running slightly wide.
- **Pit lanes must be densified before projecting onto them.** OSM pit lanes can
  have 35 m between nodes; nearest-NODE distance then reads 17 m off for a car
  driving straight down the middle, which trips every "left the lane" test.
- **Commit to the pits at the entry line.** The lane can be 10-15 m away there,
  so a proximity test never fires and the car sails past its own pit stop.
- A pit stop needs an explicit STOPPING phase. "Inside a 4.5 m window AND already
  slow" never triggers, because the car creeps through the window.
- `gap(a, b)` is "a is ahead of b" -- getting that backwards silently disables
  whatever crossing you are detecting.
- **Damage on NEW contact only** — per-tick accumulation kills a car leaning on a wall.
- The grid sits behind the line, so the first crossing is the START, not a lap.

## Cache busting (do not remove)
`tools/stamp.mjs` rewrites the import map with `?v=<epoch>` for every local module,
and a `.git/hooks/pre-commit` re-stamps on every commit. Import maps remap URL-like
specifiers against the document base, so this versions the whole module graph
without touching a single `import` statement. Without it the browser happily mixes
new HTML with a cached old `race.js` — which cost real debugging time here.

## Not done yet
- **AI pace is ~30-45% off the ideal line.** `tools/pace.mjs` measures what it can
  sustain cleanly and `makeDriver` is capped to that, so it races, defends, pits
  and makes mistakes without wrecking itself — but it is not quick. The loss is
  almost entirely in the corners (92% of profile on the straights, 45-70% through
  Lesmo/Ascari/Parabolica); the fix is better path tracking at the limit, not more
  pace. Raising `pace` just makes it crash.
- No safety car / VSC, no qualifying, no flags beyond yellow display.
- No sound.
- The AI still runs wide too often on the tight circuits. Monza and Suzuka are
  clean (a handful of offs per race); Zandvoort, Monaco and Baku are not, and on
  a street circuit running wide means a wall. It is tracking error at the limit,
  not bravery -- it fails at pace 0.62 as readily as 0.86.

## Harnesses (use these instead of guessing)
- `node tools/map.mjs <track>` — ASCII circuit map + corner radii
- `node tools/laptime.mjs` — ideal lap vs real pole for all five
- `node tools/pace.mjs <track>` — what pace the AI can actually sustain, cleanly
- `node tools/sim.mjs <track> <laps> <cars>` — headless race, full classification
- `node tools/reel.mjs <track>` — proves the highlight detector still fires
