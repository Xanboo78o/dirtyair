// Shared geometry: GeoJSON lat/lon -> metres -> centripetal Catmull-Rom -> uniform samples.
import fs from 'fs';

export const CIRCUITS = {
  suzuka:    { id: 'jp-1962', name: 'Suzuka',    full: 'Suzuka International Racing Course' },
  zandvoort: { id: 'nl-1948', name: 'Zandvoort', full: 'Circuit Zandvoort' },
  monaco:    { id: 'mc-1929', name: 'Monaco',    full: 'Circuit de Monaco' },
  monza:     { id: 'it-1922', name: 'Monza',     full: 'Autodromo Nazionale Monza' },
  baku:      { id: 'az-2016', name: 'Baku',      full: 'Baku City Circuit' },
};

export function loadRaw(geojsonPath, id) {
  const gj = JSON.parse(fs.readFileSync(geojsonPath, 'utf8'));
  const f = gj.features.find(f => f.properties.id === id);
  if (!f) throw new Error('no circuit ' + id);
  let c = f.geometry.coordinates.slice();
  // closed ring -> drop the duplicated endpoint
  if (c[0][0] === c[c.length - 1][0] && c[0][1] === c[c.length - 1][1]) c.pop();
  // equirectangular about the circuit centroid: at these scales (<7 km) the
  // distortion is centimetres, so real metres in, real metres out.
  const lat0 = c.reduce((a, p) => a + p[1], 0) / c.length;
  const lon0 = c.reduce((a, p) => a + p[0], 0) / c.length;
  const mx = 111320 * Math.cos(lat0 * Math.PI / 180), my = 110540;
  return {
    props: f.properties,
    pts: c.map(([lo, la]) => ({ x: (lo - lon0) * mx, y: (la - lat0) * my })),
  };
}

// centripetal Catmull-Rom (alpha=0.5): handles the wildly non-uniform OSM
// node spacing without the loops/cusps a uniform spline gives you.
function crSeg(p0, p1, p2, p3, t, alpha = 0.5) {
  const tj = (pa, pb, ti) => ti + Math.pow(Math.hypot(pb.x - pa.x, pb.y - pa.y), alpha);
  const t0 = 0, t1 = tj(p0, p1, t0), t2 = tj(p1, p2, t1), t3 = tj(p2, p3, t2);
  if (t1 === t0 || t2 === t1 || t3 === t2) return { x: p1.x, y: p1.y };
  const tt = t1 + (t2 - t1) * t;
  const L = (a, b, ta, tb) => ({
    x: ((tb - tt) * a.x + (tt - ta) * b.x) / (tb - ta),
    y: ((tb - tt) * a.y + (tt - ta) * b.y) / (tb - ta),
  });
  const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
  const B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3);
  return L(B1, B2, t1, t2);
}

export function spline(pts, sub = 24) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    for (let k = 0; k < sub; k++) out.push(crSeg(p0, p1, p2, p3, k / sub));
  }
  return out;
}

export function resample(dense, ds = 2.0) {
  const n = dense.length;
  const seg = [], cum = [0];
  for (let i = 0; i < n; i++) {
    const a = dense[i], b = dense[(i + 1) % n];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    seg.push(d); cum.push(cum[i] + d);
  }
  const total = cum[n];
  const count = Math.round(total / ds);
  const step = total / count;
  const out = [];
  let j = 0;
  for (let k = 0; k < count; k++) {
    const target = k * step;
    while (j < n - 1 && cum[j + 1] < target) j++;
    const f = seg[j] > 1e-9 ? (target - cum[j]) / seg[j] : 0;
    const a = dense[j], b = dense[(j + 1) % n];
    out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, s: target });
  }
  return { pts: out, length: total, ds: step };
}

// heading + curvature, then a light box smooth on curvature to kill OSM
// node jitter (a 1 m node wobble on a 400 m straight reads as a corner).
export function reflow(pts, smoothM = 9) {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    pts[i].hdg = Math.atan2(b.y - a.y, b.x - a.x);
  }
  const raw = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    let dh = b.hdg - a.hdg;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    const ds = Math.hypot(b.x - a.x, b.y - a.y);
    raw[i] = ds > 1e-6 ? dh / ds : 0;
  }
  const ds = pts.length > 1 ? Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) : 1;
  const half = Math.max(1, Math.round(smoothM / ds / 2));
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -half; k <= half; k++) acc += raw[((i + k) % n + n) % n];
    pts[i].curv = acc / (2 * half + 1);
  }
  return pts;
}

export function build(geojsonPath, id, ds = 2.0) {
  const raw = loadRaw(geojsonPath, id);
  const { pts, length } = resample(spline(raw.pts), ds);
  reflow(pts);
  return { pts, length, props: raw.props };
}

export function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

// corners = contiguous runs where |curvature| is meaningful
export function findCorners(pts, minR = 400, minLen = 18, minTurnDeg = 22) {
  const n = pts.length, ds = pts[1].s - pts[0].s;
  const hot = pts.map(p => Math.abs(p.curv) > 1 / minR);
  const runs = [];
  let i = 0;
  while (i < n) {
    if (!hot[i]) { i++; continue; }
    let j = i;
    while (hot[(j + 1) % n] && j - i < n) j++;
    const len = (j - i + 1) * ds;
    let turn = 0, peak = i;
    for (let k = i; k <= j; k++) {
      const p = pts[k % n];
      turn += p.curv * ds;
      if (Math.abs(p.curv) > Math.abs(pts[peak % n].curv)) peak = k;
    }
    // a corner is a run that actually changes where you are pointing; a gentle
    // kink on a straight is not a corner no matter how long it is.
    if (len >= minLen && Math.abs(turn) * 180 / Math.PI >= minTurnDeg) {
      const pk = pts[peak % n];
      runs.push({ s0: pts[i % n].s, s1: pts[j % n].s, sPeak: pk.s, R: 1 / Math.abs(pk.curv),
                  dir: Math.sign(pk.curv), len, turn: Math.abs(turn) * 180 / Math.PI });
    }
    i = j + 1;
  }
  return runs;
}

// Signed area: >0 means the polyline runs counter-clockwise in maths coords.
export function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function reverseRing(pts) {
  const out = pts.slice().reverse();
  return out;
}
