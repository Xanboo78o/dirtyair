// bake.mjs — real OSM survey data -> game-ready track JSON.
// Everything here is measured, not invented: centreline from the F1-circuits
// GeoJSON, corner names/numbers/widths/banking from OSM raceway tags, pit
// lanes from OSM pit-lane ways.
import fs from 'fs';
import { CIRCUITS, loadRaw, spline, resample, reflow, bbox, findCorners } from './geo.mjs';
import { Track } from '../js/track.js';
import { racingLine } from '../js/line.js';

const DIR = new URL('../data/', import.meta.url).pathname;
const GJ = DIR + 'f1-circuits.geojson';
const OSM = JSON.parse(fs.readFileSync(DIR + 'ways.json', 'utf8')).elements;
const MCPIT = JSON.parse(fs.readFileSync(DIR + 'mcpit.json', 'utf8')).elements;
const DS = 2.0;

// ---- per-circuit authored layer (widths, runoff, start offsets) ------------
// Widths/runoff in metres. `w` is HALF width. Overrides are [s0, s1, value]
// in lap-relative metres and are applied after the start offset.
const SPEC = {
  monza: {
    country: 'ITALY', w: 5.75, runoff: 14, wall: 'gravel', startOff: 0,
    // Monza's long straights are lined much closer than its corner run-offs.
    runoffOver: [[0, 560, 9], [5100, 5768, 9]],
    drs: 2, corner: [200, 14, 24, 40],
  },
  suzuka: {
    country: 'JAPAN', w: 6.0, runoff: 12, wall: 'gravel', startOff: 0,
    wOver: [[430, 700, 7.5]],           // T1/T2 is notably wide
    runoffOver: [[2000, 2300, 5]],      // Degner is famously tight on space
    drs: 1, crossover: true, corner: [200, 14, 24, 40],
  },
  zandvoort: {
    country: 'NETHERLANDS', w: 5.0, runoff: 6, wall: 'barrier', startOff: 0,
    drs: 2, corner: [200, 14, 24, 32],
  },
  monaco: {
    country: 'MONACO', w: 4.6, runoff: 3.2, wall: 'wall', startOff: null,
    wOver: [[1020, 1130, 3.8]],         // Fairmont hairpin, tightest in F1
    drs: 1, corner: [150, 8, 14, 11], smooth: 4, lineMargin: 1.15,
    // Monaco's one DRS zone is the start/finish straight, detection at Rascasse.
    drsManual: [{ detect: 2860, from: 3080, to: 100 }],
    namesAt: [[170, 'Sainte D\u00e9vote'], [452, 'Beau Rivage'], [734, 'Massenet'], [864, 'Casino'],
      [1082, 'Mirabeau Haute'], [1214, 'Fairmont Hairpin'], [1316, 'Mirabeau Bas'], [1398, 'Portier'],
      [1620, 'Tunnel'], [2070, 'Nouvelle Chicane'], [2100, 'Nouvelle Chicane'], [2333, 'Tabac'],
      [2487, 'Piscine'], [2529, 'Piscine'], [2819, 'Piscine'], [2881, 'La Rascasse'],
      [2975, 'Anthony Nogh\u00e8s']],
  },
  baku: {
    country: 'AZERBAIJAN', w: 6.5, runoff: 2.6, wall: 'wall', startOff: 0,
    wOver: [[2450, 2800, 3.8]],         // the castle section, narrowest in F1
    runoffOver: [[0, 300, 3], [4400, 5939, 3]],
    drs: 2, corner: [200, 10, 18, 18], smooth: 5, lineMargin: 0.95,
  },
};

// Monaco corner names, in lap order (OSM tags street names, not corners).
const MONACO_NAMES = [
  'Sainte Dévote', 'Beau Rivage', 'Massenet', 'Casino', 'Mirabeau Haute',
  'Fairmont Hairpin', 'Mirabeau Bas', 'Portier', 'Tunnel', 'Nouvelle Chicane',
  'Nouvelle Chicane', 'Tabac', 'Piscine', 'Piscine', 'Piscine', 'Piscine',
  'La Rascasse', 'Anthony Noghès',
];
const BAKU_NAMES = { 8: 'Castle Section', 15: 'Old City', 16: 'Seafront' };

// ---- helpers ---------------------------------------------------------------
const latlon2m = (pts, lat0, lon0) => pts.map(p => ({
  x: (p.lon - lon0) * 111320 * Math.cos(lat0 * Math.PI / 180),
  y: (p.lat - lat0) * 110540,
}));

function projector(center) {
  const n = center.length;
  return function project(x, y) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = (center[i].x - x) ** 2 + (center[i].y - y) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    const p = center[best];
    const lat = -Math.sin(p.hdg) * (x - p.x) + Math.cos(p.hdg) * (y - p.y);
    return { i: best, s: p.s, d: Math.sqrt(bestD), lat };
  };
}

function applyOver(arr, center, over, len) {
  if (!over) return;
  for (const [a, b, v] of over) {
    for (const p of center) {
      const s = p.lapS;
      const inRange = a <= b ? (s >= a && s <= b) : (s >= a || s <= b);
      if (inRange) arr[p.idx] = v;
    }
  }
}

// merge detector runs into real corners
function mergeCorners(runs, gap = 40) {
  const out = [];
  for (const r of runs) {
    const prev = out[out.length - 1];
    if (prev && prev.dir === r.dir && r.s0 - prev.s1 < gap) {
      prev.s1 = r.s1;
      if (r.R < prev.R) { prev.R = r.R; prev.sPeak = r.sPeak; }
    } else out.push({ ...r });
  }
  return out;
}

function longestStraights(center, len, maxCurv = 1 / 500, minLen = 240) {
  const n = center.length, ds = DS;
  const flat = center.map(p => Math.abs(p.curv) < maxCurv);
  const runs = [];
  let i = 0;
  while (i < n) {
    if (!flat[i]) { i++; continue; }
    let j = i;
    while (flat[(j + 1) % n] && j - i < n - 1) j++;
    const L = (j - i + 1) * ds;
    if (L >= minLen) runs.push({ s0: center[i % n].lapS, s1: center[j % n].lapS, len: L });
    i = j + 1;
  }
  return runs.sort((a, b) => b.len - a.len);
}

// ---- main ------------------------------------------------------------------
const SPONSORS = [
  'FOGLAST', 'CRITTERS', 'VROOM', 'XANCOIN', 'TERMINAL TYCOON', 'ORBIX',
  'MOLT', 'OMMOR', 'DEEPWALK', 'INKOGNITO', 'BACKROOMS', 'DOGGO BATTLES',
  'EVERYDEATH', 'CORN', 'RIG 13', 'POND', 'OVERHANG', 'ANT INC',
  'SLIPSTREAM', 'CANON EVENT', 'CARDBOARD WARFARE', 'XANBOO78O STUDIOS',
];

const report = [];
for (const [key, meta] of Object.entries(CIRCUITS)) {
  const spec = SPEC[key];
  const raw = loadRaw(GJ, meta.id);
  const { pts: center, length } = resample(spline(raw.pts), DS);
  reflow(center, spec.smooth || 9);
  center.forEach((p, i) => { p.idx = i; });

  // ---- origin in lat/lon so OSM ways land in the same metre frame ----------
  const gj = JSON.parse(fs.readFileSync(GJ, 'utf8'));
  const f = gj.features.find(f => f.properties.id === meta.id);
  let c = f.geometry.coordinates.slice();
  if (c[0][0] === c[c.length - 1][0] && c[0][1] === c[c.length - 1][1]) c.pop();
  const lat0 = c.reduce((a, p) => a + p[1], 0) / c.length;
  const lon0 = c.reduce((a, p) => a + p[0], 0) / c.length;
  const project = projector(center);

  // ---- start/finish offset -------------------------------------------------
  let startOff = spec.startOff;
  const pitWays = OSM.filter(e => /pit/i.test((e.tags || {}).name || '') && e.geometry)
    .map(e => ({ e, m: latlon2m(e.geometry, lat0, lon0) }))
    .filter(o => project(o.m[0].x, o.m[0].y).d < 260 && project(o.m[o.m.length - 1].x, o.m[o.m.length - 1].y).d < 260);
  let albertMax = null;
  if (key === 'monaco') {
    // Monaco's start/finish is on Boulevard Albert 1er, which ends at the
    // braking zone for Sainte Dévote. Find where the boulevard stops, take the
    // first tight right after it as Sainte Dévote, and back off the real
    // 170 m from the line to the corner.
    const alb = OSM.concat(MCPIT).filter(e => /Albert 1er|b\u00e2timent pit lane/i.test((e.tags || {}).name || '') && e.geometry);
    const ss = [];
    for (const w of alb) for (const p of latlon2m(w.geometry, lat0, lon0)) {
      const pr = project(p.x, p.y);
      if (pr.d < 45) ss.push(pr.s);
    }
    ss.sort((a, b) => a - b);
    albertMax = ss[ss.length - 1];
    const pre = findCorners(center.map(p => ({ ...p })), 200, 14, 24)
      .filter(c => c.dir < 0 && c.R < 45);
    let best = null, bestGap = Infinity;
    for (const c of pre) {
      let g = c.sPeak - albertMax;
      while (g < 0) g += length;
      if (g < bestGap) { bestGap = g; best = c; }
    }
    startOff = ((best.sPeak - 170) % length + length) % length;
    report.push(`  monaco: Albert 1er ends s=${albertMax.toFixed(0)}, Sainte Devote (R${best.R.toFixed(0)}m) at s=${best.sPeak.toFixed(0)} -> start/finish s=${startOff.toFixed(0)}`);
  }
  if (startOff == null) startOff = 0;

  center.forEach(p => { p.lapS = ((p.s - startOff) % length + length) % length; });
  const byLapS = center.slice().sort((a, b) => a.lapS - b.lapS);

  // ---- corners -------------------------------------------------------------
  const runs = mergeCorners(findCorners(byLapS.map(p => ({ ...p, s: p.lapS })), ...(spec.corner || [200, 14, 24]).slice(0, 3)), (spec.corner || [0,0,0,40])[3]);
  const corners = runs.map((r, i) => ({ n: i + 1, ...r }));

  // name them from OSM where the circuit is tagged as a raceway
  const namedWays = OSM.filter(e => e.geometry && (e.tags || {}).highway === 'raceway' &&
    ((e.tags['name:en'] || e.tags.name) || e.tags['raceway:corner_number']));
  const tagHits = [];
  for (const w of namedWays) {
    const m = latlon2m(w.geometry, lat0, lon0);
    const ds = m.map(p => project(p.x, p.y));
    const med = ds.map(d => d.d).sort((a, b) => a - b)[Math.floor(ds.length / 2)];
    if (med > 18) continue;             // not this circuit (theme-park rides etc.)
    const laps = ds.map(d => ((d.s - startOff) % length + length) % length);
    tagHits.push({
      name: w.tags['name:en'] || w.tags.name || null,
      num: w.tags['raceway:corner_number'] ? +w.tags['raceway:corner_number'] : null,
      width: w.tags.width ? +w.tags.width : null,
      bank: /(\d+)\s*graden/.exec(w.tags.description || '') ? +/(\d+)\s*graden/.exec(w.tags.description)[1] : 0,
      s0: Math.min(...laps), s1: Math.max(...laps), mid: laps[Math.floor(laps.length / 2)],
    });
  }
  for (const co of corners) {
    const hit = tagHits.filter(h => h.mid >= co.s0 - 30 && h.mid <= co.s1 + 30 && (h.name || h.num))
      .sort((a, b) => Math.abs(a.mid - co.sPeak) - Math.abs(b.mid - co.sPeak))[0];
    if (hit) { co.name = hit.name; co.num = hit.num; }
    if (key === 'baku') co.name = BAKU_NAMES[co.n] || null;
  }
  // one name per corner: give each table entry to its single closest corner
  if (spec.namesAt) {
    for (const co of corners) co.name = null;
    for (const [ns, nm] of spec.namesAt) {
      let best = null, bd = 110;
      for (const co of corners) {
        if (co.name) continue;
        let d = Math.abs(ns - co.sPeak); d = Math.min(d, length - d);
        if (d < bd) { bd = d; best = co; }
      }
      if (best) best.name = nm;
    }
  }

  // ---- per-sample width / banking / runoff ---------------------------------
  const osmW = tagHits.filter(h => h.width).length
    ? tagHits.filter(h => h.width).reduce((a, h) => a + h.width, 0) / tagHits.filter(h => h.width).length / 2
    : null;
  const baseW = osmW || spec.w;
  const W = new Array(center.length).fill(baseW);
  const BANK = new Array(center.length).fill(0);
  const RUN = new Array(center.length).fill(spec.runoff);
  for (const h of tagHits) if (h.bank) {
    for (const p of center) {
      const s = p.lapS;
      if (s >= h.s0 && s <= h.s1) BANK[p.idx] = h.bank;
    }
  }
  applyOver(W, center, spec.wOver, length);
  applyOver(RUN, center, spec.runoffOver, length);
  // never let inner run-off invert through the centre of a tight corner
  for (const p of center) {
    const R = 1 / Math.max(Math.abs(p.curv), 1e-6);
    RUN[p.idx] = Math.min(RUN[p.idx], Math.max(1.5, R * 0.8 - W[p.idx]));
  }

  // ---- DRS ------------------------------------------------------------------
  const sorted = center.slice().sort((a, b) => a.lapS - b.lapS);
  let straights = [];
  for (const minLen of [260, 220, 180, 150, 120, 95]) {
    straights = longestStraights(sorted, length, 1 / (spec.drsCurv || 500), minLen);
    if (straights.length >= spec.drs) break;
  }
  const drs = spec.drsManual ? spec.drsManual.map(z => ({ ...z, len: +(((z.to - z.from) % length + length) % length).toFixed(0) })) : straights.slice(0, spec.drs).map(st => ({
    from: +(st.s0 + 45).toFixed(0),
    to: +(st.s1 - 55).toFixed(0),
    detect: +(((st.s0 - 130) % length + length) % length).toFixed(0),
    len: +st.len.toFixed(0),
  }));

  // ---- pit lane --------------------------------------------------------------
  let pit = null;
  const bySort = center.slice().sort((a, b) => a.lapS - b.lapS);
  const atLapS = t => bySort[Math.max(0, Math.min(bySort.length - 1, Math.round((((t % length) + length) % length) / DS)))];
  if (pitWays.length) {
    const w = pitWays.sort((a, b) => b.m.length - a.m.length)[0];
    let m = w.m;
    const pa = project(m[0].x, m[0].y), pb = project(m[m.length - 1].x, m[m.length - 1].y);
    let aS = ((pa.s - startOff) % length + length) % length;
    let bS = ((pb.s - startOff) % length + length) % length;
    // orient the lane so it runs entry -> exit with the traffic
    let fwd = bS - aS; while (fwd < 0) fwd += length;
    if (fwd > length / 2) { m = m.slice().reverse(); const t = aS; aS = bS; bS = t; }
    pit = { entryS: +aS.toFixed(0), exitS: +bS.toFixed(0), side: Math.sign(pa.lat) || 1,
            synth: false, pts: m.map(p => [+p.x.toFixed(2), +p.y.toFixed(2)]) };
  } else {
    // Monaco: run it alongside the start/finish straight on the pit-building side
    let side = 1;
    const bld = MCPIT.find(e => /b\u00e2timent pit lane/i.test((e.tags || {}).name || ''));
    if (bld) {
      const m = latlon2m(bld.geometry, lat0, lon0);
      const lats = m.map(p => project(p.x, p.y).lat);
      side = Math.sign(lats.reduce((a, v) => a + v, 0)) || 1;
    }
    const entryS = ((-330) % length + length) % length, exitS = 250;
    const pts = [];
    for (let t = 0; t <= 580; t += 4) {
      const s0 = entryS + t;
      const p = atLapS(s0);
      const off = W[p.idx] + 5.5 * Math.min(1, t / 55) * Math.min(1, (580 - t) / 55);
      pts.push([+(p.x - Math.sin(p.hdg) * off * side).toFixed(2), +(p.y + Math.cos(p.hdg) * off * side).toFixed(2)]);
    }
    pit = { entryS: +entryS.toFixed(0), exitS, side, synth: true, pts };
  }
  const b = bbox(center);
  const out = {
    key, name: meta.name, full: meta.full, country: spec.country,
    length: +length.toFixed(1), ds: DS, wall: spec.wall, crossover: !!spec.crossover,
    bbox: { x0: +b.x0.toFixed(1), y0: +b.y0.toFixed(1), x1: +b.x1.toFixed(1), y1: +b.y1.toFixed(1) },
    x: byLapS.map(p => +p.x.toFixed(2)),
    y: byLapS.map(p => +p.y.toFixed(2)),
    w: byLapS.map(p => +W[p.idx].toFixed(2)),
    bank: byLapS.map(p => BANK[p.idx]),
    run: byLapS.map(p => +RUN[p.idx].toFixed(1)),
    line: null,
    corners: corners.map(c => ({ n: c.n, num: c.num || null, name: c.name || null,
      s0: +c.s0.toFixed(0), s1: +c.s1.toFixed(0), s: +c.sPeak.toFixed(0),
      R: +c.R.toFixed(0), dir: c.dir, turn: +c.turn.toFixed(0) })),
    drs, pit,
    sponsors: SPONSORS,
  };
  // bake the minimum-curvature racing line so the game starts instantly
  const tk = new Track(JSON.parse(JSON.stringify(out)));
  const off = racingLine(tk, spec.lineMargin ?? 0.35);
  out.line = Array.from(off, v => +v.toFixed(2));
  fs.mkdirSync(DIR + 'tracks', { recursive: true });
  fs.writeFileSync(`${DIR}tracks/${key}.json`, JSON.stringify(out));

  const kb = (fs.statSync(`${DIR}tracks/${key}.json`).size / 1024).toFixed(0);
  report.push(`${meta.name.padEnd(10)} ${out.length.toFixed(0)}m (official ${f.properties.length}m)  ${corners.length} corners  w±${baseW.toFixed(1)}m  DRS ${drs.map(d => d.len + 'm').join('+') || 'none'}  pit ${pit ? `${pit.entryS}->${pit.exitS}` : 'SYNTH'}  ${kb}KB`);
  report.push('   ' + corners.map(c => `${c.num || c.n}${c.dir > 0 ? 'L' : 'R'}${c.name ? ':' + c.name.slice(0, 16) : ''}`).join(' '));
}
console.log(report.join('\n'));
