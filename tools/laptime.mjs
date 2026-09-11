// Lap-time harness: the ideal line should land near real F1 pole pace.
import fs from 'fs';
import { Track } from '../js/track.js';
import { buildLine, racingLine, lineCurvature, speedProfile } from '../js/line.js';
import { COMPOUNDS } from '../js/physics.js';
const REAL = { monza: 80, suzuka: 88.5, zandvoort: 69.5, monaco: 71, baku: 101 };  // pole, seconds
const keys = Object.keys(REAL);
const tracks = {};
for (const k of keys) tracks[k] = new Track(JSON.parse(fs.readFileSync(`data/tracks/${k}.json`, 'utf8')));

const margin = +(process.argv[2] ?? 0.35), iters = +(process.argv[3] ?? 4000), step = +(process.argv[4] ?? 0.055), mu = +(process.argv[5] ?? COMPOUNDS.soft.mu);
let err = 0;
const rows = [];
for (const k of keys) {
  const t = tracks[k];
  const off = racingLine(t, margin, iters, step);
  const cur = lineCurvature(t, off);
  const v = speedProfile(t, off, cur, mu);
  let lap = 0;
  for (let i = 0; i < t.n; i++) lap += t.ds / Math.max(v[i], 5);
  const d = lap - REAL[k];
  err += Math.abs(d);
  const fmt = x => `${Math.floor(x / 60)}:${(x % 60).toFixed(2).padStart(5, '0')}`;
  rows.push(`${t.name.padEnd(10)} ${fmt(lap)}  real ${fmt(REAL[k])}  ${d >= 0 ? '+' : ''}${d.toFixed(1)}s  (${(100 * d / REAL[k]).toFixed(1)}%)`);
}
console.log(`margin=${margin} iters=${iters} step=${step} mu=${mu}`);
console.log(rows.join('\n'));
console.log('total abs error', err.toFixed(1) + 's');
