// Which way round does the stored polyline actually run? Decide from the data:
// OSM corner numbers where they exist, signed area otherwise.
import fs from 'fs';
import { CIRCUITS, loadRaw, spline, resample, reflow, signedArea } from './geo.mjs';
const DIR = new URL('../data/', import.meta.url).pathname;
const OSM = JSON.parse(fs.readFileSync(DIR + 'ways.json', 'utf8')).elements;
const gj = JSON.parse(fs.readFileSync(DIR + 'f1-circuits.geojson', 'utf8'));

for (const [key, meta] of Object.entries(CIRCUITS)) {
  const raw = loadRaw(DIR + 'f1-circuits.geojson', meta.id);
  const { pts: center, length } = resample(spline(raw.pts), 2);
  reflow(center);
  const f = gj.features.find(f => f.properties.id === meta.id);
  let c = f.geometry.coordinates.slice();
  if (c[0][0] === c[c.length - 1][0]) c.pop();
  const lat0 = c.reduce((a, p) => a + p[1], 0) / c.length;
  const lon0 = c.reduce((a, p) => a + p[0], 0) / c.length;
  const mx = 111320 * Math.cos(lat0 * Math.PI / 180);
  const proj = (x, y) => { let b = 0, bd = Infinity;
    for (let i = 0; i < center.length; i++) { const d = (center[i].x - x) ** 2 + (center[i].y - y) ** 2; if (d < bd) { bd = d; b = i; } }
    return { s: center[b].s, d: Math.sqrt(bd) }; };

  const hits = [];
  for (const w of OSM) {
    const t = w.tags || {};
    if (t.highway !== 'raceway' || !t['raceway:corner_number'] || !w.geometry) continue;
    const m = w.geometry.map(p => ({ x: (p.lon - lon0) * mx, y: (p.lat - lat0) * 110540 }));
    const ds = m.map(p => proj(p.x, p.y));
    const med = ds.map(d => d.d).sort((a, b) => a - b)[ds.length >> 1];
    if (med > 18) continue;
    hits.push({ num: +t['raceway:corner_number'], s: ds[ds.length >> 1].s });
  }
  hits.sort((a, b) => a.num - b.num);
  let vote = 0;
  for (let i = 0; i + 1 < hits.length; i++) {
    let d = hits[i + 1].s - hits[i].s;
    while (d > length / 2) d -= length;
    while (d < -length / 2) d += length;
    if (Math.abs(d) > 5) vote += Math.sign(d);
  }
  const area = signedArea(center);
  console.log(`${meta.name.padEnd(10)} cornerNumberVote=${vote >= 0 ? '+' : ''}${vote} (${hits.length} numbered)  signedArea=${area > 0 ? 'CCW' : 'CW '}  -> stored order is ${vote > 0 ? 'RACING DIRECTION' : vote < 0 ? 'REVERSED' : (area > 0 ? 'CCW' : 'CW')}`);
}
