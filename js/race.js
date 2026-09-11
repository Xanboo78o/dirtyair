// race.js — the rulebook and the race director.
import { makeCar, step, COMPOUNDS, SURFACE, CAR } from './physics.js';
import { steerLock } from './input.js';
import { driveAI, makeDriver, GRID_NAMES, aiStrategy } from './ai.js';

const PIT_LIMIT = 80 / 3.6;          // 80 km/h, the real pit-lane limit
const STOP_TIME = 2.4;               // stationary time for a good stop
const TEAM_COLS = ['#1fd2be', '#ff8000', '#e8002d', '#ffd400', '#3671c6', '#27f4d2',
                   '#00a0de', '#229971', '#b6babd', '#6692ff'];

export class PitLane {
  constructor(raw, track) {
    this.track = track;
    const p = raw.pts.map(([x, y]) => ({ x, y }));
    this.pts = []; this.s = [0];
    let acc = 0;
    for (let i = 0; i < p.length; i++) {
      this.pts.push(p[i]);
      if (i) { acc += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y); this.s.push(acc); }
    }
    this.len = acc;
    this.hdg = this.pts.map((q, i) => {
      const a = this.pts[Math.max(0, i - 1)], b = this.pts[Math.min(this.pts.length - 1, i + 1)];
      return Math.atan2(b.y - a.y, b.x - a.x);
    });
    this.entryS = raw.entryS; this.exitS = raw.exitS; this.synth = raw.synth;
    this.boxS = this.len * 0.50;
    this.width = 5.2;
  }
  project(x, y) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.pts.length; i++) {
      const d = (this.pts[i].x - x) ** 2 + (this.pts[i].y - y) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    const h = this.hdg[best], dx = x - this.pts[best].x, dy = y - this.pts[best].y;
    return { i: best, s: this.s[best] + (Math.cos(h) * dx + Math.sin(h) * dy),
             lat: -Math.sin(h) * dx + Math.cos(h) * dy, d: Math.sqrt(bd) };
  }
  point(s, lat = 0) {
    s = Math.max(0, Math.min(this.len, s));
    let i = 0;
    while (i < this.s.length - 2 && this.s[i + 1] < s) i++;
    const h = this.hdg[i];
    const t = s - this.s[i];
    return { x: this.pts[i].x + Math.cos(h) * t - Math.sin(h) * lat,
             y: this.pts[i].y + Math.sin(h) * t + Math.cos(h) * lat, hdg: h };
  }
}

export class Race {
  constructor({ track, line, laps = 8, gridSize = 10, playerGrid = 5, compound = 'medium', skill = 1 }) {
    this.track = track; this.line = line; this.laps = laps;
    this.pit = track.pit ? new PitLane(track.pit, track) : null;
    this.pitSpeed = PIT_LIMIT;
    this.time = 0; this.state = 'grid'; this.lights = 3.2;
    this.events = [];
    this.entries = [];
    this.yellow = null;
    this.lastTouch = new Map();

    for (let k = 0; k < gridSize; k++) {
      const isPlayer = k === playerGrid - 1;
      // grid slots: staggered, 8 m apart, alternating sides like a real grid
      const gs = track.wrap(-22 - k * 11.5);
      const gl = (k % 2 ? 1 : -1) * Math.min(3.0, track.widthAt(gs) * 0.45);
      const p = track.point(gs, gl);
      const car = makeCar({ compound: isPlayer ? compound : ['soft', 'medium', 'medium', 'hard'][k % 4] });
      car.x = p.x; car.y = p.y; car.hdg = p.hdg; car.vx = 0.01;
      this.entries.push({
        car, isPlayer, idx: k,
        name: isPlayer ? 'YOU' : GRID_NAMES[k % GRID_NAMES.length],
        num: isPlayer ? 78 : (k + 1),
        col: isPlayer ? '#ffffff' : TEAM_COLS[k % TEAM_COLS.length],
        driver: isPlayer ? null : makeDriver(k, skill),
        lap: 0, gridPos: k + 1, pos: k + 1,
        proj: track.project(p.x, p.y), lastS: gs, crossed: false,
        lapStart: 0, lastLap: null, bestLap: null, laps: [],
        drsArmed: null, drsZone: null, drsWant: false,
        pitRequest: false, inPit: false, pitPhase: null, pitTimer: 0, pitStops: 0,
        nextCompound: null, usedCompounds: new Set([car.tyre.c.key]),
        penalty: 0, warnings: 0, offNow: false, retired: false,
        ahead: null, behind: null, aheadGapT: 99, behindGapT: 99,
        finished: false, finishTime: null, totalTime: 0, pastHalf: false, stuck: 0, crossed0: false,
      });
    }
    this.order();
  }

  log(kind, text, e = null) {
    this.events.push({ t: this.time, kind, text, car: e ? e.idx : null });
    if (this.events.length > 220) this.events.shift();
  }

  // ---- helpers the AI asks about -----------------------------------------
  get entriesAlive() { return this.entries.filter(e => !e.retired); }
  brakingZone(s, look) {
    const t = this.track, v = this.line.v;
    const i0 = t.idx(s), i1 = t.idx(s + look);
    let vmin = Infinity, v0 = v[i0];
    for (let k = 0; k < look / t.ds; k++) vmin = Math.min(vmin, v[((i0 + k) % t.n)]);
    return vmin < v0 * 0.86;
  }

  progress(e) {
    return (e.lap + (e.crossed0 ? 1 : 0)) * this.track.length + e.proj.s;
  }

  order() {
    const t = this.track;
    const prog = e => this.progress(e);
    const alive = this.entries.slice().sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      return prog(b) - prog(a);
    });
    alive.forEach((e, i) => { e.pos = i + 1; });
    this.standings = alive;
  }

  // ---- one simulation tick ------------------------------------------------
  tick(dt, playerInput) {
    this.time += dt;
    const t = this.track;
    if (this.state === 'grid') {
      this.lights -= dt;
      if (this.lights <= 0) { this.state = 'green'; this.log('flag', 'LIGHTS OUT'); this.entries.forEach(e => e.lapStart = this.time); }
    }
    const racing = this.state === 'green' || this.state === 'finish';

    // --- neighbours, dirty air and tow -----------------------------------
    for (const e of this.entries) {
      e.ahead = null; e.behind = null; e.aheadGapT = 99; e.behindGapT = 99;
      let dirty = 0, tow = 0;
      for (const o of this.entries) {
        if (o === e || o.retired) continue;
        const ds = t.gap(o.proj.s, e.proj.s);
        const dl = Math.abs(o.proj.lat - e.proj.lat);
        if (ds > 0 && ds < 70 && !e.inPit && !o.inPit) {
          const align = Math.max(0, 1 - dl / 7.5);
          dirty = Math.max(dirty, align * Math.pow(Math.max(0, 1 - ds / 42), 1.5));
          if (dl < 4.5) tow = Math.max(tow, (1 - dl / 4.5) * Math.max(0, 1 - ds / 45));
        }
        if (ds > 0 && ds < (e.ahead ? t.gap(e.ahead.proj.s, e.proj.s) : 1e9)) {
          e.ahead = o; e.aheadGapT = ds / Math.max(e.car.speed, 12);
        }
        if (ds < 0 && -ds < (e.behind ? -t.gap(e.behind.proj.s, e.proj.s) : 1e9)) {
          e.behind = o; e.behindGapT = -ds / Math.max(o.car.speed, 12);
        }
      }
      e.car.dirty = dirty; e.car.tow = tow;
    }

    // --- drive + integrate -----------------------------------------------
    for (const e of this.entries) {
      if (e.retired) continue;
      const car = e.car;
      let inp;
      if (e.isPlayer) inp = playerInput || { wheel: 0, throttle: 0, brake: 0 };
      else inp = driveAI(e, this, dt);
      if (!racing) { inp = { wheel: inp.wheel * 0, throttle: 0, brake: 1 }; }
      if (e.finished) inp = { wheel: inp.wheel, throttle: inp.throttle * 0.5, brake: 0 };

      // pit limiter: real cars have a button, so don't punish the keyboard
      if (e.inPit && car.speed > this.pitSpeed) { inp = { ...inp, throttle: 0, brake: Math.max(inp.brake, 0.25) }; }
      if (e.inPit && car.speed > this.pitSpeed * 1.02) inp.brake = 1;

      // pit stop: hold still in the box
      if (e.pitPhase === 'stopped') inp = { wheel: 0, throttle: 0, brake: 1 };

      car.delta = inp.wheel * steerLock(car.speed);
      car.throttle = inp.throttle; car.brake = inp.brake;

      // surface + banking under this car
      const pr = e.proj;
      const off = Math.abs(pr.lat) - pr.w;
      let surface = SURFACE.track;
      if (!e.inPit) {
        if (off > 0 && off < 0.9) surface = SURFACE.kerb;
        else if (off >= 0.9) surface = off < pr.run ? SURFACE.runoff : SURFACE.grass;
      }
      const env = {
        surface, dirty: car.dirty, tow: car.tow,
        bank: pr.bank, bankDir: pr.bank ? Math.sign(pr.curv || 1) : 0,
      };
      step(car, dt, env);
      car.surface = surface;

      // wall / barrier
      if (!e.inPit) {
        const limit = pr.w + pr.run;
        if (Math.abs(pr.lat) > limit) this.hitWall(e, pr, limit);
        else if (Math.abs(pr.lat) < limit - 0.6) e.wallTouch = false;
      }
    }

    // --- projection, laps, rules -----------------------------------------
    for (const e of this.entries) {
      if (e.retired) continue;
      const car = e.car;
      const pr = t.project(car.x, car.y, e.proj.i);
      const prev = e.proj.s;
      e.proj = pr;

      if (this.pit) {
        const pp = this.pit.project(car.x, car.y);
        e.pitProj = pp;
        const near = pp.d < this.pit.width * 1.25 && pp.s > -6 && pp.s < this.pit.len + 6;
        if (!e.inPit && near && e.pitRequest) { e.inPit = true; e.pitPhase = 'in'; this.log('pit', `${e.name} PITS`, e); }
        else if (e.inPit && !near) {
          if (e.pitPhase === 'out' || pp.s > this.pit.len - 4) { e.inPit = false; e.pitPhase = null; e.pitRequest = false; }
          else if (pp.d > this.pit.width * 2.2) { e.inPit = false; e.pitPhase = null; }
        }
        if (e.inPit) this.servicePit(e, dt);
      }

      // lap line
      if (pr.s > t.length * 0.42 && pr.s < t.length * 0.62) e.pastHalf = true;
      const crossed = prev > t.length * 0.8 && pr.s < t.length * 0.2;
      if (crossed && racing && !e.finished && !e.pastHalf) {
        // the grid sits behind the line, so this first crossing is the START,
        // not a lap: lap 1 is timed from here, as it is in the real thing
        e.lapStart = this.time;
        e.crossed0 = true;
      } else if (crossed && racing && !e.finished) {
        e.lap++;
        e.pastHalf = false;
        const lt = this.time - e.lapStart;
        e.lapStart = this.time;
        if (e.lap > 1 || this.state === 'green') {
          e.lastLap = lt; e.laps.push(lt);
          if (!e.bestLap || lt < e.bestLap) e.bestLap = lt;
        }
        aiStrategy(e, this);
        if (e.lap >= this.laps && !e.finished) {
          e.finished = true; e.finishTime = this.time; this.applyEndPenalties(e);
          this.log('flag', `${e.name} FINISHES P${e.pos}`, e);
          if (this.state !== 'finish') { this.state = 'finish'; this.log('flag', 'CHEQUERED FLAG'); }
        }
      }

      // track limits: all four wheels the other side of the white line
      if (!e.inPit && racing) {
        const outBy = Math.abs(pr.lat) - pr.w - 0.9;
        if (outBy > 0 && !e.offNow) {
          e.offNow = true;
          const c = t.cornerAt(pr.s);
          const fresh = this.time - (e.lastLimit || -99) > 4;
          if (c && fresh && e.car.speed > 14) {
            e.lastLimit = this.time;
            e.warnings++;
            this.log('limits', `${e.name} TRACK LIMITS (${e.warnings}/3)${c.name ? ' at ' + c.name : ''}`, e);
            if (e.warnings % 3 === 0) { e.penalty += 5; this.log('penalty', `${e.name} +5s TRACK LIMITS`, e); }
          }
        } else if (outBy < -0.4) e.offNow = false;
      }

      // beached in the gravel: give it back to the driver rather than let the
      // race wedge (same as a marshal push in the real thing)
      if (!e.inPit && !e.finished && racing) {
        if (e.car.speed < 3.2 && Math.abs(pr.lat) > pr.w) e.stuck = (e.stuck || 0) + dt;
        else e.stuck = 0;
        if (e.stuck > 4) {
          let back = 0;
          for (const o of this.entries) {
            if (o === e || o.retired) continue;
            if (Math.abs(t.gap(o.proj.s, pr.s)) < 14) back -= 16;
          }
          const lp = t.point(pr.s + back, this.line.off[t.idx(pr.s + back)] || 0);
          e.car.x = lp.x; e.car.y = lp.y; e.car.hdg = lp.hdg;
          e.car.vx = 9; e.car.vy = 0; e.car.r = 0; e.stuck = 0;
          this.log('flag', `${e.name} REJOINS`, e);
        }
      }

      // DRS
      this.drs(e, prev, pr);
    }

    this.collisions();
    this.order();
    for (const e of this.entries) if (!e.finished && !e.retired) e.totalTime = this.time;
    if (this.state === 'finish' && this.entries.every(e => e.finished || e.retired)) this.state = 'over';
    if (this.state === 'finish' && this.time - (this.finishAt || (this.finishAt = this.time)) > 25) this.state = 'over';
  }

  drs(e, prevS, pr) {
    const t = this.track;
    if (e.lap < 2 || e.inPit) { e.car.drsOpen = false; e.drsArmed = null; return; }
    for (const z of t.drs) {
      const crossedDetect = t.gap(z.detect, prevS) >= 0 && t.gap(z.detect, pr.s) < 0;
      if (crossedDetect) {
        e.drsArmed = (e.ahead && e.aheadGapT < 1.0) ? z : null;
        if (e.drsArmed && e.isPlayer) this.log('drs', 'DRS ENABLED', e);
      }
    }
    const zone = t.drsZoneAt(pr.s);
    e.drsZone = zone;
    const can = zone && e.drsArmed === zone;
    if (!can || e.car.brake > 0.12) e.car.drsOpen = false;
    else if (e.isPlayer) e.car.drsOpen = e.drsWant;
    else e.car.drsOpen = true;
    if (!zone) e.drsArmed = e.drsArmed && t.drsZoneAt(pr.s) ? e.drsArmed : e.drsArmed;
  }

  servicePit(e, dt) {
    const pp = e.pitProj, box = this.pit.boxS;
    if (e.pitPhase === 'in' && Math.abs(pp.s - box) < 4.5 && e.car.speed < 2.2) {
      e.pitPhase = 'stopped'; e.pitTimer = STOP_TIME + Math.random() * 0.6;
    } else if (e.pitPhase === 'stopped') {
      e.pitTimer -= dt;
      if (e.pitTimer <= 0) {
        const key = e.nextCompound || (e.car.tyre.c.key === 'soft' ? 'hard' : 'soft');
        e.car.tyre = { c: COMPOUNDS[key], Tf: 48, Tr: 48, wf: 0, wr: 0, age: 0 };  // out on cold rubber
        e.usedCompounds.add(key);
        e.pitStops++; e.pitPhase = 'out'; e.nextCompound = null;
        this.log('pit', `${e.name} -> ${COMPOUNDS[key].name}`, e);
      }
    }
  }

  hitWall(e, pr, limit) {
    const car = e.car;
    const sgn = Math.sign(pr.lat);
    const p = this.track.point(pr.s, limit * sgn);
    car.x = p.x; car.y = p.y;
    const h = pr.hdg;
    // kill the velocity component into the wall, scrub the rest
    const vWorldX = car.vx * Math.cos(car.hdg) - car.vy * Math.sin(car.hdg);
    const vWorldY = car.vx * Math.sin(car.hdg) + car.vy * Math.cos(car.hdg);
    const nX = -Math.sin(h) * sgn, nY = Math.cos(h) * sgn;
    const vn = vWorldX * nX + vWorldY * nY;
    const tX = vWorldX - vn * nX, tY = vWorldY - vn * nY;
    const fresh = !e.wallTouch;
    e.wallTouch = true;
    const scrub = this.track.wall === 'wall' ? 0.62 : 0.80;
    const nvx = tX * scrub, nvy = tY * scrub;
    car.vx = nvx * Math.cos(car.hdg) + nvy * Math.sin(car.hdg);
    car.vy = -nvx * Math.sin(car.hdg) + nvy * Math.cos(car.hdg);
    car.r *= 0.3;
    const hit = Math.abs(vn);
    if (fresh && hit > 3.5) {
      car.damage = Math.min(1, car.damage + Math.min(0.55, (hit - 3.5) / 42));
      this.log('crash', `${e.name} INTO THE ${this.track.wall === 'wall' ? 'WALL' : 'BARRIER'}`, e);
      if (car.damage >= 1) { e.retired = true; this.log('crash', `${e.name} RETIRES`, e); }
    }
  }

  collisions() {
    const t = this.track, R = 1.75;
    for (let i = 0; i < this.entries.length; i++) {
      const a = this.entries[i];
      if (a.retired) continue;
      for (let j = i + 1; j < this.entries.length; j++) {
        const b = this.entries[j];
        if (b.retired) continue;
        const dx = b.car.x - a.car.x, dy = b.car.y - a.car.y;
        const d = Math.hypot(dx, dy);
        if (d > R * 2 || d < 1e-5) continue;
        const nx = dx / d, ny = dy / d, push = (R * 2 - d) / 2;
        a.car.x -= nx * push; a.car.y -= ny * push;
        b.car.x += nx * push; b.car.y += ny * push;
        const wv = c => [c.vx * Math.cos(c.hdg) - c.vy * Math.sin(c.hdg), c.vx * Math.sin(c.hdg) + c.vy * Math.cos(c.hdg)];
        const [ax, ay] = wv(a.car), [bx, by] = wv(b.car);
        const rel = (bx - ax) * nx + (by - ay) * ny;
        if (rel < 0) {
          const imp = -rel * 0.55;
          const set = (e, vx, vy) => {
            e.car.vx = vx * Math.cos(e.car.hdg) + vy * Math.sin(e.car.hdg);
            e.car.vy = -vx * Math.sin(e.car.hdg) + vy * Math.cos(e.car.hdg);
          };
          set(a, ax - nx * imp, ay - ny * imp);
          set(b, bx + nx * imp, by + ny * imp);
          const sev = Math.abs(rel);
          const key = i * 1000 + j;
          const fresh = (this.time - (this.lastTouch.get(key) || -9)) > 0.5;
          this.lastTouch.set(key, this.time);
          const harm = fresh ? Math.max(0, sev - 7) / 240 : 0;
          a.car.damage = Math.min(1, a.car.damage + harm);
          b.car.damage = Math.min(1, b.car.damage + harm);
          for (const e of [a, b]) if (e.car.damage >= 1 && !e.retired) { e.retired = true; this.log('crash', `${e.name} RETIRES`, e); }
          if (fresh && sev > 14) {
            // whoever was behind going in carries the blame, as in the real thing
            const behind = t.gap(a.proj.s, b.proj.s) < 0 ? a : b;
            behind.penalty += 5;
            this.log('penalty', `${behind.name} +5s CAUSING A COLLISION`, behind);
          }
        }
      }
    }
  }

  applyEndPenalties(e) {
    // dry-race two-compound rule
    if (this.laps >= 4 && e.usedCompounds.size < 2) {
      e.penalty += 30;
      this.log('penalty', `${e.name} +30s TYRE RULE NOT MET`, e);
    }
  }

  requestPit(e, compound = null) {
    if (e.inPit) return;
    e.pitRequest = !e.pitRequest;
    if (compound) e.nextCompound = compound;
    if (e.isPlayer) this.log('pit', e.pitRequest ? 'BOX THIS LAP' : 'STAY OUT', e);
  }

  gapToAhead(e) {
    if (!e.ahead) return null;
    return this.track.gap(e.ahead.proj.s, e.proj.s) / Math.max(e.car.speed, 12);
  }
}
