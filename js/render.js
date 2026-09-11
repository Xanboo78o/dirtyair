// render.js — deliberately plain graphics. Flat shapes, real geometry.
const KERB_LEN = 1.4;

export class Renderer {
  constructor(canvas, track, line) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.track = track; this.line = line;
    this.cam = { x: 0, y: 0, zoom: 3.4, tx: 0, ty: 0 };
    this.showLine = false;
    this.build();
  }

  build() {
    const t = this.track, n = t.n;
    const edge = (side, extra = 0) => {
      const p = new Path2D();
      for (let i = 0; i <= n; i++) {
        const j = i % n, h = t.hdg[j], o = (t.w[j] + extra) * side;
        const x = t.x[j] - Math.sin(h) * o, y = t.y[j] + Math.cos(h) * o;
        i ? p.lineTo(x, y) : p.moveTo(x, y);
      }
      p.closePath();
      return p;
    };
    // tarmac = between the two edges (even-odd fill of two rings)
    this.tarmac = new Path2D();
    this.tarmac.addPath(edge(1));
    this.tarmac.addPath(edge(-1));
    this.runoff = new Path2D();
    const runRing = side => {
      const p = new Path2D();
      for (let i = 0; i <= n; i++) {
        const j = i % n, h = t.hdg[j], o = (t.w[j] + t.run[j]) * side;
        const x = t.x[j] - Math.sin(h) * o, y = t.y[j] + Math.cos(h) * o;
        i ? p.lineTo(x, y) : p.moveTo(x, y);
      }
      p.closePath(); return p;
    };
    this.runoff.addPath(runRing(1));
    this.runoff.addPath(runRing(-1));
    this.edgeL = edge(1); this.edgeR = edge(-1);
    this.wallL = runRing(1); this.wallR = runRing(-1);

    // kerbs: only where the track actually turns
    this.kerbs = [];
    for (const c of t.corners) {
      const side = c.dir > 0 ? 1 : -1;         // inside of the corner
      for (const sd of [side, -side]) {
        const from = c.s0 - 18, to = c.s1 + 18;
        let k = 0;
        for (let s = from; s < to; s += KERB_LEN, k++) {
          const i = t.idx(s), h = t.hdg[i], o = t.w[i] * sd;
          const x = t.x[i] - Math.sin(h) * o, y = t.y[i] + Math.cos(h) * o;
          this.kerbs.push({ x, y, h, red: k % 2 === 0, w: sd > 0 ? 1 : -1 });
        }
      }
    }

    // sponsor boards along the barriers, plus painted names on the run-off
    this.boards = []; this.paint = [];
    const names = t.sponsors;
    let bi = 0;
    for (let s = 0; s < t.length; s += 42) {
      const i = t.idx(s), h = t.hdg[i];
      const sd = (bi % 2) ? 1 : -1;
      const o = (t.w[i] + Math.max(1.2, t.run[i])) * sd;
      this.boards.push({ x: t.x[i] - Math.sin(h) * o, y: t.y[i] + Math.cos(h) * o, h,
                         name: names[bi % names.length], sd });
      bi++;
    }
    for (const c of t.corners) {
      if (c.R < 40) continue;
      const i = t.idx(c.s);
      const h = t.hdg[i], sd = c.dir > 0 ? -1 : 1;
      const o = (t.w[i] + t.run[i] * 0.55) * sd;
      if (t.run[i] < 5) continue;
      this.paint.push({ x: t.x[i] - Math.sin(h) * o, y: t.y[i] + Math.cos(h) * o, h,
                        name: names[(c.n * 3) % names.length] });
    }

    if (t.pit) {
      this.pitPath = new Path2D();
      t.pit.pts.forEach(([x, y], i) => i ? this.pitPath.lineTo(x, y) : this.pitPath.moveTo(x, y));
    }
    if (this.line) {
      this.linePath = new Path2D();
      for (let i = 0; i <= n; i++) {
        const j = (i % n) * 2;
        i ? this.linePath.lineTo(this.line.pts[j], this.line.pts[j + 1]) : this.linePath.moveTo(this.line.pts[j], this.line.pts[j + 1]);
      }
      this.linePath.closePath();
    }
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cv.width = Math.floor(this.cv.clientWidth * dpr);
    this.cv.height = Math.floor(this.cv.clientHeight * dpr);
    this.dpr = dpr;
  }

  follow(car, dt, zoomBias = 1) {
    const c = this.cam;
    const lead = 0.55;
    const tx = car.x + car.vx * Math.cos(car.hdg) * lead;
    const ty = car.y + car.vx * Math.sin(car.hdg) * lead;
    const k = 1 - Math.exp(-dt * 6);
    c.x += (tx - c.x) * k; c.y += (ty - c.y) * k;
    const want = (4.6 - Math.min(2.4, car.speed / 42)) * zoomBias;
    c.zoom += (want - c.zoom) * (1 - Math.exp(-dt * 2.5));
  }
  lookAt(x, y, zoom) { this.cam.x = x; this.cam.y = y; this.cam.zoom = zoom; }

  world(ctx) {
    const z = this.cam.zoom * this.dpr;
    ctx.setTransform(z, 0, 0, -z, this.cv.width / 2 - this.cam.x * z, this.cv.height / 2 + this.cam.y * z);
  }
  w2s(x, y) {
    const z = this.cam.zoom * this.dpr;
    return [x * z + this.cv.width / 2 - this.cam.x * z, -y * z + this.cv.height / 2 + this.cam.y * z];
  }

  draw(race, opts = {}) {
    const ctx = this.ctx, t = this.track;
    const z = this.cam.zoom;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = t.wall === 'wall' ? '#2b2f36' : '#3d4a2e';
    ctx.fillRect(0, 0, this.cv.width, this.cv.height);

    this.world(ctx);
    // run-off / gravel
    ctx.fillStyle = t.wall === 'gravel' ? '#9a8b6a' : t.wall === 'wall' ? '#4a4f57' : '#6b6f58';
    ctx.fill(this.runoff, 'evenodd');
    // tarmac
    ctx.fillStyle = '#4b4e53';
    ctx.fill(this.tarmac, 'evenodd');

    // kerbs
    for (const k of this.kerbs) {
      ctx.save();
      ctx.translate(k.x, k.y); ctx.rotate(k.h);
      ctx.fillStyle = k.red ? '#d8352a' : '#e9e9e9';
      ctx.fillRect(-KERB_LEN / 2, k.w > 0 ? 0 : -0.95, KERB_LEN, 0.95);
      ctx.restore();
    }
    // white lines
    ctx.lineWidth = 0.16; ctx.strokeStyle = '#e6e6e6';
    ctx.stroke(this.edgeL); ctx.stroke(this.edgeR);
    // barriers
    ctx.lineWidth = t.wall === 'wall' ? 0.55 : 0.38;
    ctx.strokeStyle = t.wall === 'wall' ? '#b9bcc2' : '#9aa0a6';
    ctx.stroke(this.wallL); ctx.stroke(this.wallR);

    // DRS zones marked on the tarmac edge
    ctx.lineWidth = 0.3; ctx.strokeStyle = 'rgba(60,200,255,0.5)';
    for (const zn of t.drs) {
      ctx.beginPath();
      const span = ((zn.to - zn.from) % t.length + t.length) % t.length;
      for (let s = 0; s <= span; s += 6) {
        const i = t.idx(zn.from + s), h = t.hdg[i], o = t.w[i] - 0.5;
        const x = t.x[i] - Math.sin(h) * o, y = t.y[i] + Math.cos(h) * o;
        s ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
    }

    // pit lane
    if (this.pitPath) {
      ctx.lineWidth = t.pit ? 5.2 : 5; ctx.strokeStyle = '#43464b';
      ctx.stroke(this.pitPath);
      ctx.lineWidth = 0.14; ctx.strokeStyle = 'rgba(230,230,230,0.75)';
      ctx.stroke(this.pitPath);
      if (race.pit) {
        const b = race.pit.point(race.pit.boxS, 0);
        ctx.fillStyle = '#d8d84a';
        ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.hdg);
        ctx.fillRect(-2.4, -2.6, 4.8, 0.3);
        ctx.restore();
      }
    }

    // start/finish
    const sf = t.point(0, 0);
    ctx.save(); ctx.translate(sf.x, sf.y); ctx.rotate(sf.hdg);
    const hw = t.widthAt(0);
    for (let k = 0; k < Math.ceil(hw * 2 / 0.7); k++) {
      ctx.fillStyle = k % 2 ? '#f2f2f2' : '#2a2a2a';
      ctx.fillRect(-0.5, -hw + k * 0.7, 1.0, 0.7);
    }
    ctx.restore();

    if (this.showLine && this.linePath) {
      ctx.lineWidth = 0.22; ctx.strokeStyle = 'rgba(255,90,90,0.55)';
      ctx.stroke(this.linePath);
    }

    // sponsor boards (shapes here, text in screen space below)
    for (const b of this.boards) {
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.h);
      ctx.fillStyle = '#1d2026';
      ctx.fillRect(-5, b.sd > 0 ? 0 : -1.0, 10, 1.0);
      ctx.restore();
    }

    // cars
    for (const e of race.entries) this.drawCar(ctx, e, race);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (z > 2.2) this.drawTrackText();
    if (opts.hud !== false) this.hud(race, opts);
  }

  drawCar(ctx, e, race) {
    const c = e.car;
    ctx.save();
    ctx.translate(c.x, c.y); ctx.rotate(c.hdg);
    if (e.retired) ctx.globalAlpha = 0.4;
    // floor
    ctx.fillStyle = e.col;
    ctx.fillRect(-2.5, -0.45, 4.2, 0.9);
    // wings
    ctx.fillRect(1.75, -0.92, 0.42, 1.84);
    ctx.fillStyle = e.isPlayer ? '#ffffff' : '#17191d';
    ctx.fillRect(-2.62, -0.78, 0.4, 1.56);
    // tyres
    ctx.fillStyle = '#131417';
    for (const [dx, dy] of [[1.25, 0.78], [1.25, -0.78], [-1.35, 0.82], [-1.35, -0.82]])
      ctx.fillRect(dx - 0.34, dy - 0.28, 0.68, 0.56);
    // DRS flap up
    if (c.drsOpen) { ctx.fillStyle = '#38d6ff'; ctx.fillRect(-2.62, -0.78, 0.4, 1.56); }
    ctx.restore();
    ctx.globalAlpha = 1;
    // dirty air puff behind a car, so you can SEE why you can't follow
    if (c.speed > 25) {
      const g = ctx.createRadialGradient(c.x, c.y, 0.5, c.x, c.y, 9);
      g.addColorStop(0, 'rgba(200,215,230,0.10)');
      g.addColorStop(1, 'rgba(200,215,230,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      const bx = c.x - Math.cos(c.hdg) * 6, by = c.y - Math.sin(c.hdg) * 6;
      ctx.arc(bx, by, 8, 0, 7);
      ctx.fill();
    }
  }

  drawTrackText() {
    const ctx = this.ctx, z = this.cam.zoom * this.dpr;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const b of this.boards) {
      const [sx, sy] = this.w2s(b.x, b.y);
      if (sx < -120 || sy < -120 || sx > this.cv.width + 120 || sy > this.cv.height + 120) continue;
      ctx.save(); ctx.translate(sx, sy); ctx.rotate(-b.h);
      ctx.fillStyle = '#8d939c';
      ctx.font = `600 ${Math.max(6, 0.62 * z)}px ui-sans-serif,system-ui,sans-serif`;
      ctx.fillText(b.name, 0, b.sd > 0 ? 0.5 * z : -0.5 * z);
      ctx.restore();
    }
    for (const p of this.paint) {
      const [sx, sy] = this.w2s(p.x, p.y);
      if (sx < -300 || sy < -300 || sx > this.cv.width + 300 || sy > this.cv.height + 300) continue;
      ctx.save(); ctx.translate(sx, sy); ctx.rotate(-p.h);
      ctx.fillStyle = 'rgba(255,255,255,0.13)';
      ctx.font = `800 ${Math.max(8, 2.6 * z)}px ui-sans-serif,system-ui,sans-serif`;
      ctx.fillText(p.name, 0, 0);
      ctx.restore();
    }
    // corner names
    for (const c of this.track.corners) {
      if (!c.name) continue;
      const i = this.track.idx(c.s), t = this.track;
      const h = t.hdg[i], sd = c.dir > 0 ? -1 : 1;
      const o = (t.w[i] + Math.min(t.run[i], 8) + 3) * sd;
      const [sx, sy] = this.w2s(t.x[i] - Math.sin(h) * o, t.y[i] + Math.cos(h) * o);
      if (sx < 0 || sy < 0 || sx > this.cv.width || sy > this.cv.height) continue;
      ctx.save(); ctx.translate(sx, sy);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = `600 ${Math.max(9, 0.9 * this.cam.zoom * this.dpr)}px ui-sans-serif,system-ui,sans-serif`;
      ctx.fillText(c.name.toUpperCase(), 0, 0);
      ctx.restore();
    }
  }

  hud() { /* HUD lives in main.js as DOM so it stays crisp */ }

  minimap(ctx2, w, h, race) {
    const t = this.track, b = t.bbox;
    const pad = 8;
    const sc = Math.min((w - pad * 2) / (b.x1 - b.x0), (h - pad * 2) / (b.y1 - b.y0));
    const ox = pad - b.x0 * sc, oy = h - pad + b.y0 * sc;
    ctx2.clearRect(0, 0, w, h);
    ctx2.lineWidth = 2.4; ctx2.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx2.beginPath();
    for (let i = 0; i <= t.n; i += 2) {
      const j = i % t.n;
      const x = t.x[j] * sc + ox, y = oy - t.y[j] * sc;
      i ? ctx2.lineTo(x, y) : ctx2.moveTo(x, y);
    }
    ctx2.closePath(); ctx2.stroke();
    for (const e of race.entries) {
      if (e.retired) continue;
      ctx2.fillStyle = e.col;
      ctx2.beginPath();
      ctx2.arc(e.car.x * sc + ox, oy - e.car.y * sc, e.isPlayer ? 3.4 : 2.2, 0, 7);
      ctx2.fill();
    }
  }
}
