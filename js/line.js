// line.js — racing line + speed profile, derived from the track and the car.
import { CAR, corneringSpeed, topSpeed } from './physics.js';

// Minimum-CURVATURE line, not minimum length. Pulling the line taut apexes
// too tight and is slower; what you want is the gentlest possible arc the
// corridor allows. Gradient descent on the sum of squared second differences,
// clamped to the track edges.
export function racingLine(track, margin = 0.35, iters = 6000, step = 0.12) {
  const n = track.n;
  const off = new Float32Array(n);
  const nx = new Float32Array(n), ny = new Float32Array(n);
  const lim = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    nx[i] = -Math.sin(track.hdg[i]); ny[i] = Math.cos(track.hdg[i]);
    lim[i] = Math.max(0.2, track.w[i] - margin);
  }
  const px = new Float32Array(n), py = new Float32Array(n);
  const dx = new Float32Array(n), dy = new Float32Array(n);
  for (let k = 0; k < iters; k++) {
    for (let i = 0; i < n; i++) { px[i] = track.x[i] + nx[i] * off[i]; py[i] = track.y[i] + ny[i] * off[i]; }
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      dx[i] = px[a] - 2 * px[i] + px[b];
      dy[i] = py[a] - 2 * py[i] + py[b];
    }
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      const g = nx[i] * (dx[a] - 2 * dx[i] + dx[b]) + ny[i] * (dy[a] - 2 * dy[i] + dy[b]);
      const v = off[i] - step * g;
      off[i] = v > lim[i] ? lim[i] : v < -lim[i] ? -lim[i] : v;
    }
  }
  return off;
}

function ptOf(t, off, i) {
  const h = t.hdg[i];
  return { x: t.x[i] - Math.sin(h) * off[i], y: t.y[i] + Math.cos(h) * off[i] };
}

// curvature of the offset line
export function lineCurvature(track, off) {
  const n = track.n, cur = new Float32Array(n);
  const P = i => ptOf(track, off, ((i % n) + n) % n);
  for (let i = 0; i < n; i++) {
    const a = P(i - 2), b = P(i), c = P(i + 2);
    const ax = b.x - a.x, ay = b.y - a.y, bx = c.x - b.x, by = c.y - b.y;
    const cross = ax * by - ay * bx;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by), lc = Math.hypot(c.x - a.x, c.y - a.y);
    cur[i] = (la * lb * lc) > 1e-6 ? (2 * cross) / (la * lb * lc) : 0;
  }
  // light smooth
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -3; k <= 3; k++) acc += cur[((i + k) % n + n) % n];
    out[i] = acc / 7;
  }
  return out;
}

// Forward/backward passes give the fastest speed you can actually carry:
// corner-limited, then brake-limited into it, then power-limited out of it.
export function speedProfile(track, off, cur, mu) {
  const n = track.n, ds = track.ds, vmax = topSpeed();
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const R = Math.abs(cur[i]) > 1e-5 ? 1 / Math.abs(cur[i]) : 1e6;
    v[i] = Math.min(vmax, corneringSpeed(R, mu, track.bank[i]) * 0.97);
  }
  const q = s => 0.5 * CAR.rho * s * s;
  for (let pass = 0; pass < 3; pass++) {
    for (let k = n * 2; k >= 0; k--) {           // backward: braking
      const i = k % n, j = (i + 1) % n;
      const Fz = CAR.m * 9.81 + q(v[j]) * CAR.ClA;
      const aBrake = (Math.min(mu * Fz, CAR.Fbrake) + q(v[j]) * CAR.CdA) / CAR.m;
      const cap = Math.sqrt(v[j] * v[j] + 2 * aBrake * ds);
      if (v[i] > cap) v[i] = cap;
    }
    for (let k = 0; k <= n * 2; k++) {           // forward: traction/power
      const i = k % n, j = (i - 1 + n) % n;
      const Fz = CAR.m * 9.81 + q(v[j]) * CAR.ClA;
      const Fdrive = Math.min(CAR.Pmax / Math.max(v[j], 9), CAR.Fdrive, mu * Fz * 0.62);
      const aAcc = (Fdrive - q(v[j]) * CAR.CdA - CAR.rollRes) / CAR.m;
      const cap = Math.sqrt(Math.max(1, v[j] * v[j] + 2 * Math.max(0, aAcc) * ds));
      if (v[i] > cap) v[i] = cap;
    }
  }
  return v;
}

export function buildLine(track, mu, margin = 0.35) {
  // The profile is what a car can do at its PEAK grip. In a race the tyre sits
  // a little off its optimum, so budget for that here instead of asking the
  // driver for 16% more grip than the car has.
  mu *= 0.93;
  const off = track.line ? Float32Array.from(track.line) : racingLine(track, margin);
  const cur = lineCurvature(track, off);
  const v = speedProfile(track, off, cur, mu);
  const pts = new Float32Array(track.n * 2);
  for (let i = 0; i < track.n; i++) {
    const p = ptOf(track, off, i);
    pts[i * 2] = p.x; pts[i * 2 + 1] = p.y;
  }
  // heading of the racing line itself (not the centreline) -- the path
  // tracker needs this or it fights a constant offset through every corner
  const hdg = new Float32Array(track.n);
  for (let i = 0; i < track.n; i++) {
    const a = ((i - 1) + track.n) % track.n, b = (i + 1) % track.n;
    hdg[i] = Math.atan2(pts[b * 2 + 1] - pts[a * 2 + 1], pts[b * 2] - pts[a * 2]);
  }
  let lap = 0;
  for (let i = 0; i < track.n; i++) lap += track.ds / Math.max(v[i], 5);
  return { off, cur, v, pts, hdg, lapTime: lap };
}
