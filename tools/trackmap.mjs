// Prints the circuit as ASCII so I can see the layout without a browser.
import { CENTER, LAP_LENGTH, CLOSURE, CORNERS, bounds, DRS_ZONES } from '../js/track.js';

const W = 118, H = 46;
const b = bounds();
const sx = (W - 2) / (b.x1 - b.x0), sy = (H - 2) / (b.y1 - b.y0);
const sc = Math.min(sx, sy);
const grid = Array.from({ length: H }, () => Array(W).fill(' '));
const put = (x, y, ch) => {
  const cx = Math.round((x - b.x0) * sc) + 1;
  const cy = H - 2 - Math.round((y - b.y0) * sc);
  if (cx >= 0 && cx < W && cy >= 0 && cy < H) grid[cy][cx] = ch;
};

for (const p of CENTER) {
  const l = { x: p.x - Math.sin(p.hdg) * p.w, y: p.y + Math.cos(p.hdg) * p.w };
  const r = { x: p.x + Math.sin(p.hdg) * p.w, y: p.y - Math.cos(p.hdg) * p.w };
  put(l.x, l.y, '.'); put(r.x, r.y, '.');
}
for (const z of DRS_ZONES) {
  for (let s = z.from; s < z.to; s += 4) {
    const i = Math.floor((s / LAP_LENGTH) * CENTER.length) % CENTER.length;
    put(CENTER[i].x, CENTER[i].y, '=');
  }
}
for (const c of CORNERS) {
  const i = Math.floor((c.s / LAP_LENGTH) * CENTER.length) % CENTER.length;
  put(CENTER[i].x, CENTER[i].y, c.name[1]);
}
put(CENTER[0].x, CENTER[0].y, 'S');

console.log(grid.map(r => r.join('').replace(/\s+$/, '')).join('\n'));

// corner speed estimate with downforce, to sanity-check the layout
const M = 800, G = 9.81, RHO = 1.225, CLA = 5.0, MU = 1.65;
function vmax(R) {
  let v = 20;
  for (let k = 0; k < 40; k++) {
    const Fz = M * G + 0.5 * RHO * CLA * v * v;
    v = Math.sqrt(MU * Fz * Math.abs(R) / M);
  }
  return v;
}
console.log(`\nlap ${LAP_LENGTH.toFixed(0)} m | closure error ${CLOSURE.toFixed(1)} m | ${CENTER.length} samples`);
const bySeg = new Map();
for (const p of CENTER) if (p.name) bySeg.set(p.name, 1 / Math.abs(p.curv || 1e-9));
console.log([...bySeg].map(([n, R]) => `${n} R${R.toFixed(0)}m ${(vmax(R) * 3.6).toFixed(0)}km/h`).join('  '));
console.log('DRS zones:', DRS_ZONES.map(z => `${z.name} det@${z.detect.toFixed(0)} ${z.from.toFixed(0)}-${z.to.toFixed(0)}`).join(' | '));
