// physics.js — a real bicycle model: slip-angle tyres, load transfer, aero,
// tyre temperature and wear. The graphics are cheap so this doesn't have to be.
export const CAR = {
  m: 798, Izz: 950,
  L: 3.60, a: 1.62, b: 1.98,   // a = CG->front axle, b = CG->rear axle
  h: 0.30,                      // CG height: this is what makes trail-braking work
  ClA: 4.62, CdA: 1.28, rho: 1.225,
  aeroBal: 0.435,               // fraction of downforce carried by the front
  Pmax: 580e3, Fdrive: 13800,
  Fbrake: 46000, brakeBal: 0.60,
  rollRes: 260,
  // Pacejka-ish lateral curve
  B: 9.4, C: 1.55, E: 0.94,
};

export const COMPOUNDS = {
  soft:   { key: 'soft',   name: 'SOFT',   mu: 2.00, wear: 1.60, Topt:  96, Twin: 30, col: '#e5342f' },
  medium: { key: 'medium', name: 'MEDIUM', mu: 1.91, wear: 1.00, Topt:  92, Twin: 33, col: '#e8c51f' },
  hard:   { key: 'hard',   name: 'HARD',   mu: 1.82, wear: 0.66, Topt:  88, Twin: 36, col: '#e2e2e2' },
};

export const SURFACE = { track: 1.0, kerb: 0.93, runoff: 0.58, grass: 0.42 };
const AMBIENT = 30;

export function makeCar(opts = {}) {
  return {
    x: 0, y: 0, hdg: 0,
    vx: 0.001, vy: 0, r: 0,          // body frame: vx forward, vy left, r yaw rate
    ax: 0, ay: 0,
    delta: 0, throttle: 0, brake: 0,
    tyre: {
      c: COMPOUNDS[opts.compound || 'medium'],
      Tf: 68, Tr: 68, wf: 0, wr: 0, age: 0,
    },
    drsOpen: false, dirty: 0, tow: 0,
    surface: 1, damage: 0, spin: 0,
    speed: 0, slipF: 0, slipR: 0, lock: false, wheelspin: false,
    ...opts,
  };
}

const pac = (alpha, D) => {
  const x = CAR.B * alpha;
  return -D * Math.sin(CAR.C * Math.atan(x - CAR.E * (x - Math.atan(x))));
};

function gripOf(t, T, wear) {
  const win = Math.exp(-(((T - t.Topt) / t.Twin) ** 2));  // 1.0 inside the window
  const temp = 0.82 + 0.18 * win;                        // cold or cooked = 82% grip
  const w = 1 - 0.24 * Math.pow(wear, 1.25);
  return t.mu * temp * w;
}
export const tyreGrip = gripOf;

function clampCircle(fx, fy, cap) {
  const m = Math.hypot(fx, fy);
  if (m <= cap || m < 1e-6) return [fx, fy, false];
  const k = cap / m;
  return [fx * k, fy * k, true];
}

// One physics substep. `env` carries what the world is doing to this car.
export function step(car, dt, env = {}) {
  const t = car.tyre;
  const v = Math.hypot(car.vx, car.vy);
  // Low-speed regularisation. With a raw slip-angle model, vx -> 0 makes every
  // slip angle blow up to 90 degrees, the friction circle then eats all the
  // drive force, and the car scrubs to a halt under full throttle. Real tyre
  // models damp this the same way.
  const vSafe = Math.max(Math.abs(car.vx), 6.0);
  const surf = env.surface ?? 1;

  // ---- aero -----------------------------------------------------------
  const q = 0.5 * CAR.rho * v * v;
  let clA = CAR.ClA, cdA = CAR.CdA;
  if (car.drsOpen) { clA *= 0.80; cdA *= 0.74; }        // DRS costs you downforce
  const dirty = env.dirty ?? car.dirty ?? 0;
  const tow = env.tow ?? car.tow ?? 0;
  // following a car guts your FRONT wing first -> understeer, the real problem
  const DFf = q * clA * CAR.aeroBal * (1 - 0.40 * dirty);
  const DFr = q * clA * (1 - CAR.aeroBal) * (1 - 0.12 * dirty);
  const drag = q * cdA * (1 - 0.40 * tow) + CAR.rollRes;

  // ---- vertical loads (load transfer is what makes the car feel alive) --
  const g = 9.81;
  const statF = CAR.m * g * CAR.b / CAR.L, statR = CAR.m * g * CAR.a / CAR.L;
  const tr = CAR.m * car.ax * CAR.h / CAR.L;
  const Fzf = Math.max(200, statF + DFf - tr);
  const Fzr = Math.max(200, statR + DFr + tr);

  const muF = gripOf(t.c, t.Tf, t.wf) * surf;
  const muR = gripOf(t.c, t.Tr, t.wr) * surf;

  // ---- slip angles ------------------------------------------------------
  const af = Math.atan((car.vy + CAR.a * car.r) / vSafe) - car.delta;
  const ar = Math.atan((car.vy - CAR.b * car.r) / vSafe);
  let Fyf = pac(af, muF * Fzf);
  let Fyr = pac(ar, muR * Fzr);

  // ---- longitudinal -----------------------------------------------------
  let FxR = 0, FxF = 0;
  if (car.throttle > 0) FxR += Math.min(CAR.Pmax / Math.max(v, 9), CAR.Fdrive) * car.throttle;
  if (car.brake > 0) {
    FxF -= CAR.Fbrake * CAR.brakeBal * car.brake;
    FxR -= CAR.Fbrake * (1 - CAR.brakeBal) * car.brake;
  }
  // friction circle: use up grip longitudinally and you have none left to turn
  let lockF = false, spinR = false;
  [FxF, Fyf, lockF] = clampCircle(FxF, Fyf, muF * Fzf);
  [FxR, Fyr, spinR] = clampCircle(FxR, Fyr, muR * Fzr);

  // ---- banking: Zandvoort's 18 degrees is worth real lap time ------------
  let bankF = 0;
  if (env.bank) {
    const th = env.bank * Math.PI / 180;
    bankF = (CAR.m * g + DFf + DFr) * Math.sin(th) * (env.bankDir || 0);
  }

  // ---- equations of motion ---------------------------------------------
  const cd = Math.cos(car.delta), sd = Math.sin(car.delta);
  const Fx = FxR + FxF * cd - Fyf * sd - drag * Math.sign(car.vx || 1);
  const Fy = Fyf * cd + Fyr + FxF * sd + bankF;
  const Mz = CAR.a * (Fyf * cd + FxF * sd) - CAR.b * Fyr;

  car.ax = Fx / CAR.m + car.vy * car.r;
  car.ay = Fy / CAR.m - car.vx * car.r;
  car.vx += car.ax * dt;
  car.vy += car.ay * dt;
  car.r += (Mz / CAR.Izz) * dt;
  // a spinning F1 car tops out near 3 rad/s; clamping keeps an explicit
  // integrator from inventing 20 rad/s nonsense at the limit
  const RMAX = 4.5;
  if (car.r > RMAX) car.r = RMAX; else if (car.r < -RMAX) car.r = -RMAX;
  if (v < 3) car.r *= 1 - Math.min(0.9, 4 * dt);

  // A spun car still has ground speed. Clamp forward velocity at zero, but do
  // NOT bleed the lateral component -- doing that destroyed all the car's
  // energy in about 0.05 s and read as an instant stop from 120 km/h.
  if (car.vx < 0) car.vx = 0;
  // at a crawl the tyres bite and the car straightens out instead of hovering
  // sideways forever
  if (v < 5) {
    const k = Math.min(0.85, (1 - v / 5) * 5 * dt);
    car.vy -= car.vy * k;
    car.r -= car.r * k;
  }
  car.hdg += car.r * dt;
  car.x += (car.vx * Math.cos(car.hdg) - car.vy * Math.sin(car.hdg)) * dt;
  car.y += (car.vx * Math.sin(car.hdg) + car.vy * Math.cos(car.hdg)) * dt;

  // ---- tyre temperature and wear ---------------------------------------
  // Slip POWER, in watts-ish: force x slip angle x speed.
  const vh = Math.max(v, 3);
  const powF = Math.abs(af) * Math.abs(Fyf) * vh + (lockF ? Math.abs(FxF) * 0.05 * vh : 0);
  const powR = Math.abs(ar) * Math.abs(Fyr) * vh + (spinR ? Math.abs(FxR) * 0.05 * vh : 0);
  // Tuned so sustained cornering settles around the working window and a long
  // straight sheds 15-20C. The old coefficients had a ~1 s cooling time
  // constant, which pinned every tyre at ambient and cost 30% of the grip.
  const HEAT = 6.2e-5, COOL = 0.010;
  const air = 1 + 0.016 * v;
  t.Tf += (HEAT * powF - COOL * air * (t.Tf - AMBIENT)) * dt;
  t.Tr += (HEAT * powR - COOL * air * (t.Tr - AMBIENT)) * dt;
  const wk = 2.0e-9 * t.c.wear;
  t.wf = Math.min(1.6, t.wf + wk * powF * dt);
  t.wr = Math.min(1.6, t.wr + wk * powR * dt * 1.12);
  t.age += dt;

  car.slipF = af; car.slipR = ar;
  car.lock = lockF; car.wheelspin = spinR;
  car.speed = Math.hypot(car.vx, car.vy);
  return car;
}

// Drag-limited top speed: power in, aero out.
export function topSpeed(drs = false) {
  const cdA = CAR.CdA * (drs ? 0.74 : 1);
  let v = 80;
  for (let i = 0; i < 60; i++) {
    const d = 0.5 * CAR.rho * cdA * v * v + CAR.rollRes;
    v = Math.cbrt(CAR.Pmax / (0.5 * CAR.rho * cdA)) * 0.5 + v * 0.5;
    if (d * v > CAR.Pmax) v *= 0.999;
  }
  // solve P = (0.5 rho cdA v^2 + rr) v directly
  let lo = 10, hi = 160;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const p = (0.5 * CAR.rho * cdA * mid * mid + CAR.rollRes) * mid;
    if (p > CAR.Pmax) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

// Steady-state cornering speed for a radius. Downforce rises with v^2, so past
// a certain radius grip is never the limit -- top speed is. Closed form, then
// clamp, instead of an iteration that runs away to infinity.
export function corneringSpeed(R, mu, bank = 0) {
  R = Math.abs(R);
  // The textbook banked-curve formula blows up at F1 grip levels; the real
  // gain at Zandvoort's 18 degrees is about 10-15 km/h, so scale it sanely.
  const m = bank ? mu * (1 + 0.90 * Math.sin(Math.abs(bank) * Math.PI / 180)) : mu;
  const k = CAR.m / R - m * 0.5 * CAR.rho * CAR.ClA;
  const vGrip = k <= 1e-3 ? Infinity : Math.sqrt(m * CAR.m * 9.81 / k);
  return Math.min(vGrip, topSpeed());
}
