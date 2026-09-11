// track.js — runtime model of a baked circuit.
export class Track {
  constructor(d) {
    Object.assign(this, d);
    this.n = this.x.length;
    this.hdg = new Float32Array(this.n);
    this.curv = new Float32Array(this.n);
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      this.hdg[i] = Math.atan2(this.y[b] - this.y[a], this.x[b] - this.x[a]);
    }
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      let d2 = this.hdg[b] - this.hdg[a];
      while (d2 > Math.PI) d2 -= 2 * Math.PI;
      while (d2 < -Math.PI) d2 += 2 * Math.PI;
      this.curv[i] = d2 / (2 * this.ds);
    }
    this.pitLen = 0;
    if (this.pit) {
      for (let i = 1; i < this.pit.pts.length; i++)
        this.pitLen += Math.hypot(this.pit.pts[i][0] - this.pit.pts[i - 1][0], this.pit.pts[i][1] - this.pit.pts[i - 1][1]);
    }
  }
  static async load(key) {
    const r = await fetch(`./data/tracks/${key}.json`);
    return new Track(await r.json());
  }
  idx(s) { return ((Math.round(s / this.ds) % this.n) + this.n) % this.n; }
  wrap(s) { return ((s % this.length) + this.length) % this.length; }
  // signed shortest distance from b to a (positive = a is ahead of b)
  gap(a, b) {
    let d = a - b;
    while (d > this.length / 2) d -= this.length;
    while (d < -this.length / 2) d += this.length;
    return d;
  }
  // nearest centreline sample, searched around a hint so Suzuka's crossover
  // can't snap a car onto the bridge underneath it
  project(x, y, hint = null) {
    let lo = 0, hi = this.n, step = 1;
    if (hint != null) { lo = hint - 45; hi = hint + 45; }
    let best = 0, bd = Infinity;
    for (let k = lo; k < hi; k += step) {
      const i = ((k % this.n) + this.n) % this.n;
      const d = (this.x[i] - x) ** 2 + (this.y[i] - y) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    const h = this.hdg[best], dx = x - this.x[best], dy = y - this.y[best];
    return {
      i: best,
      s: this.wrap(best * this.ds + (Math.cos(h) * dx + Math.sin(h) * dy)),
      lat: -Math.sin(h) * dx + Math.cos(h) * dy,
      w: this.w[best], runL: this.runL[best], runR: this.runR[best],
      run: (-Math.sin(h) * dx + Math.cos(h) * dy) > 0 ? this.runL[best] : this.runR[best],
      bank: this.bank[best],
      curv: this.curv[best], hdg: h,
    };
  }
  point(s, lat = 0) {
    const i = this.idx(s), h = this.hdg[i];
    return { x: this.x[i] - Math.sin(h) * lat, y: this.y[i] + Math.cos(h) * lat, hdg: h, i };
  }
  widthAt(s) { return this.w[this.idx(s)]; }
  cornerAt(s) {
    for (const c of this.corners) {
      const a = this.gap(s, c.s0), b = this.gap(c.s1, s);
      if (a > -40 && b > -40) return c;
    }
    return null;
  }
  drsZoneAt(s) {
    for (const z of this.drs) {
      const inside = z.from <= z.to ? (s >= z.from && s <= z.to) : (s >= z.from || s <= z.to);
      if (inside) return z;
    }
    return null;
  }
}
