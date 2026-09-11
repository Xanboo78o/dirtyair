// ai.js — the AI drives the same physics you do: same tyres, same aero, same
// dirty air. It doesn't get a speed cheat, it gets a line and a brain.
import { steerLock } from './input.js';
import { CAR, tyreGrip } from './physics.js';

export const GRID_NAMES = [
  'VERSTAPPEN', 'NORRIS', 'LECLERC', 'PIASTRI', 'SAINZ', 'RUSSELL',
  'HAMILTON', 'ALONSO', 'GASLY', 'HULKENBERG', 'TSUNODA', 'ALBON',
  'STROLL', 'OCON', 'BEARMAN', 'COLAPINTO', 'LAWSON', 'BORTOLETO',
  'ANTONELLI', 'HADJAR',
];

export function makeDriver(i, skill = 1) {
  // a grid where everyone is identical is a boring grid
  const rng = mulberry(i * 7919 + 13);
  return {
    // never above 1.0: driving faster than the ideal line just means crashing
    pace: Math.min(0.995, 0.905 + 0.058 * skill + rng() * 0.028),
    aggression: 0.35 + rng() * 0.6,
    defence: 0.3 + rng() * 0.65,
    consistency: 0.4 + rng() * 0.55,
    tyreCare: 0.3 + rng() * 0.7,
    noise: 0, noiseT: 0,
    lastMove: 0, movedAt: -999,
  };
}
function mulberry(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Returns {wheel, throttle, brake} for one AI car.
export function driveAI(e, world, dt) {
  const { track, line } = world;
  const d = e.driver, car = e.car;
  const v = car.speed;
  const i = e.proj.i;
  // Off the road and slow? Aim short and sharp to get back on, or you just
  // plough round in the gravel forever.
  const lost = !e.inPit && Math.abs(e.proj.lat) > e.proj.w && v < 22;

  // ---- where do I want to be, laterally? --------------------------------
  const aheadI = (k) => ((i + k) % track.n + track.n) % track.n;
  // The offset where the car IS -- not somewhere up the road. Sampling this
  // ahead makes the car chase the apex offset while still 25 m short of it,
  // which cuts every corner and puts it on the inside kerb or wall.
  let wantOff = line.off[i];

  // racecraft: attack the car in front, defend from the car behind
  let attacking = false, defending = false;
  if (e.ahead && e.aheadGapT < 1.4 && !e.inPit) {
    attacking = true;
    // get out of the dirty air, and take the inside for the next braking zone
    const side = e.ahead.proj.lat > 0 ? -1 : 1;
    const braking = world.brakingZone(e.proj.s, 130);
    const pull = braking ? 0.75 + 0.5 * d.aggression : 0.35;
    wantOff += side * pull * Math.max(0.8, track.w[i] - 2.2) * Math.min(1, (1.4 - e.aheadGapT) / 1.0);
  }
  if (e.behind && e.behindGapT < 0.75 && !e.inPit) {
    defending = true;
    const braking = world.brakingZone(e.proj.s, 150);
    if (braking) {
      // ONE move: pick a side, commit, don't weave (that's the actual rule)
      if (world.time - d.movedAt > 3.5) { d.lastMove = -Math.sign(line.off[i]) || 1; d.movedAt = world.time; }
      wantOff += d.lastMove * d.defence * Math.max(0.6, track.w[i] - 2.4) * 0.85;
    }
  }

  // don't drive into someone who is alongside
  if (!lost && Math.abs(e.proj.lat) < e.proj.w + 1) {
    for (const o of world.entries) {
      if (o === e || o.retired || o.inPit) continue;
      if (Math.abs(o.proj.lat) > o.proj.w + 1) continue;      // they're off; leave them
      const ds = track.gap(o.proj.s, e.proj.s);
      if (Math.abs(ds) > 7) continue;
      const dl = o.proj.lat - e.proj.lat;
      if (Math.abs(dl) < 3.8) wantOff -= Math.sign(dl || 1) * (3.8 - Math.abs(dl)) * 0.7;
    }
  }

  const lim = Math.max(0.3, track.w[i] - 1.0);
  wantOff = Math.max(-lim, Math.min(lim, wantOff));

  // ---- path tracking (Stanley) ------------------------------------------
  // Pure pursuit with a long lookahead cuts the apex and gets thrown wide on
  // exit. Stanley steers on heading error + cross-track error, so it actually
  // stays ON the line.
  let delta;
  if (e.inPit && world.pit && e.pitProj) {
    const tgt = world.pit.point(e.pitProj.s + Math.min(18, 6 + v * 0.5), 0);
    let ang = Math.atan2(tgt.y - car.y, tgt.x - car.x) - car.hdg;
    while (ang > Math.PI) ang -= 2 * Math.PI;
    while (ang < -Math.PI) ang += 2 * Math.PI;
    delta = Math.atan2(2 * CAR.L * Math.sin(ang), Math.max(8, v * 0.7));
  } else {
    // Look barely past the front axle. A long preview means the heading-error
    // term sees a whole corner's worth of rotation and applies near-full lock
    // on entry, which turns in early and cuts to the inside wall.
    const prev = Math.round(Math.min(8, CAR.a + 1 + v * 0.055) / track.ds);
    const j = aheadI(prev);
    let hErr = line.hdg[j] - car.hdg;
    while (hErr > Math.PI) hErr -= 2 * Math.PI;
    while (hErr < -Math.PI) hErr += 2 * Math.PI;
    const cross = e.proj.lat - wantOff;              // + = left of where I want to be
    const K = lost ? 1.6 : 3.2;
    delta = hErr + Math.atan2(-K * cross, Math.max(v, 7));
    // damp the yaw so it settles instead of weaving
    delta -= 0.030 * car.r;
  }

  // Catch oversteer: countersteer against the EXCESS rear slip only, so it
  // doesn't interfere with normal cornering. The rear slip angle is negative
  // in a left turn, so adding it winds OFF left lock -- the right correction.
  const over = Math.abs(car.slipR) - Math.abs(car.slipF);
  if (over > 0.03) delta += Math.sign(car.slipR) * Math.min(0.30, (over - 0.03) * 1.8);

  // human wobble so the grid isn't robotic
  d.noiseT -= dt;
  if (d.noiseT <= 0) { d.noiseT = 0.25 + Math.random() * 0.5; d.noise = (Math.random() * 2 - 1) * (1 - d.consistency) * 0.05; }
  delta += d.noise;

  const lock = steerLock(v);
  const wheel = Math.max(-1, Math.min(1, delta / lock));

  // ---- speed ------------------------------------------------------------
  // Target the profile HERE, and decide braking from the deceleration actually
  // required to meet every constraint ahead. (Taking the minimum profile speed
  // over a long window instead just brakes absurdly early, every corner, all
  // lap -- it cost about 40 seconds at Monza.)
  let mod = d.pace;
  const wear = Math.max(car.tyre.wf, car.tyre.wr);
  mod *= 1 - 0.05 * wear * d.tyreCare;
  mod *= 1 - 0.17 * car.dirty;                    // no front wing in the wake
  if (Math.abs(car.slipF) > 0.22) mod *= 0.94;    // washing out at the front
  const roadLeft = e.proj.w - Math.abs(e.proj.lat);
  if (roadLeft < 0.35 && Math.abs(e.proj.curv) > 1 / 200) mod *= 0.95;
  if (car.drsOpen) mod *= 1.02;

  let vTarget = line.v[i] * mod;
  if (e.inPit) vTarget = world.pitSpeed;
  if (lost) vTarget = Math.min(vTarget, 13);      // you cannot rejoin at 250 km/h

  // Walk the speed profile BACKWARDS from 260 m ahead to the car, propagating
  // the braking limit with the braking capability that actually applies at
  // each step (it falls off as you slow, because downforce does). This is the
  // profile's own backward pass done locally -- exact, so it brakes neither
  // early nor late. Using one averaged braking figure over-permits at corner
  // entry and puts the car in the wall.
  let vlim = Infinity;
  const STEP = 5;
  // use the grip the tyres actually have, not the peak they might reach
  const muNow = Math.min(tyreGrip(car.tyre.c, car.tyre.Tf, car.tyre.wf), tyreGrip(car.tyre.c, car.tyre.Tr, car.tyre.wr));
  if (!e.inPit && !lost) {
    for (let m = 260; m >= 0; m -= STEP) {
      const vt = line.v[aheadI(Math.round(m / track.ds))] * mod;
      if (vt < vlim) vlim = vt;
      if (m > 0) {
        const qq = 0.5 * 1.225 * vlim * vlim;
        const Fzz = CAR.m * 9.81 + qq * CAR.ClA;
        const ab = 0.90 * (Math.min(muNow * Fzz, CAR.Fbrake) + qq * CAR.CdA) / CAR.m;
        vlim = Math.sqrt(vlim * vlim + 2 * ab * STEP);
      }
    }
  }
  let vAllow = Math.min(vTarget, vlim);
  if (e.inPit) vAllow = world.pitSpeed;
  if (lost) vAllow = Math.min(vTarget, 13);

  let throttle = 0, brake = 0;
  if (v > vAllow + 0.25) {
    brake = Math.max(0, Math.min(1, (v - vAllow) / 4.0));
    if (attacking && world.brakingZone(e.proj.s, 90)) brake *= 1 - 0.05 * d.aggression;
  } else {
    throttle = Math.max(0, Math.min(1, (vAllow - v) / 3.5));
  }
  if (over > 0.07) throttle *= Math.max(0, 1 - (over - 0.07) * 5);   // rear going away
  if (e.inPit && v < world.pitSpeed) { throttle = Math.min(throttle, 0.45); brake = 0; }

  // Car-following: settle at a sensible headway and MATCH the car ahead once
  // there. (Always targeting a fraction of their speed cascades down the field
  // until the whole train stops.)
  if (e.ahead && !e.inPit) {
    const ds = track.gap(e.ahead.proj.s, e.proj.s);
    const dl = Math.abs(e.ahead.proj.lat - e.proj.lat);
    const vAhead = e.ahead.car.speed || 0;
    const closing = v - vAhead;
    const zone = world.brakingZone(e.proj.s, 140) ? 1.7 : 1.0;
    const headway = (6.5 + v * 0.28 + Math.max(0, closing) * 1.4) * zone;
    if (ds > 0 && ds < headway * 1.3 && dl < 3.4) {
      const f = Math.max(0.2, Math.min(1, ds / headway));
      const cap = vAhead * (0.55 + 0.47 * f) + 0.6;
      if (v > cap) { brake = Math.max(brake, Math.min(1, (v - cap) / 7)); throttle = 0; }
      else throttle = Math.min(throttle, Math.max(0, (cap - v) / 3));
    }
  }

  return { wheel, throttle, brake, attacking, defending };
}

// Once a lap, decide whether to box. Tyres going off, the two-compound rule,
// and not pitting into traffic -- the same three things a real pit wall weighs.
export function aiStrategy(e, race) {
  if (e.isPlayer || e.retired || e.inPit || e.pitRequest || e.finished) return;
  const left = race.laps - e.lap;
  if (left <= 1) return;
  const wear = Math.max(e.car.tyre.wf, e.car.tyre.wr);
  const d = e.driver;
  const mustChange = e.usedCompounds.size < 2 && left <= 3;
  const worn = wear > (0.52 + 0.22 * d.tyreCare);
  if (!mustChange && !worn) return;
  // don't box straight into the pack behind you
  const key = left > race.laps * 0.45 ? 'hard' : (left <= 3 ? 'soft' : 'medium');
  race.requestPit(e, key);
}
