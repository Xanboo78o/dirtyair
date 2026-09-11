# DIRTY AIR

A flat-graphics, real-rules F1 game. Five real circuits (Monza, Suzuka, Zandvoort,
Monaco, Baku) built from OpenStreetMap survey data — real corner names, real widths,
real pit lanes, Zandvoort's real 18° banking. Slip-angle tyres with temperature and
wear, load transfer, dirty air and the tow. DRS, track limits, penalties, pit stops
and the two-compound rule.

The point of it is wheel-to-wheel: after the race it cuts a **highlight reel** of
every pass you made and every attack you survived.

## Run it

    python3 -m http.server 8171
    # then open http://localhost:8171/

## Controls
← → steer · ↑ throttle · ↓ brake · SPACE DRS · P box this lap · L show racing line · ESC pause

See `DESIGN.md` for the design bible and the list of bugs already paid for.
