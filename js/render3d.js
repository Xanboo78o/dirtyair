// render3d.js — low-poly 3D. Flat colours, no textures to speak of, but the
// geometry is the real circuit: same centreline, widths, kerbs, run-off,
// barriers and banking the physics is using.
import * as THREE from 'three';

// 2D sim space is x-right / y-up. 3D world is x-right / y-UP / z-back, so the
// sim's y becomes -z and the sim's heading becomes a yaw about Y.
const V = (x, y, h = 0) => new THREE.Vector3(x, h, -y);

const COL = {
  tarmac: 0x45484e, line: 0xe9e9e9, kerbA: 0xd23b30, kerbB: 0xecebe8,
  gravel: 0xa89272, grass: 0x4a6b3a, concrete: 0x8d9199,
  wall: 0xc7ccd4, sky: 0x9fb6cc, dark: 0x1b1e24,
};

export class Renderer3D {
  constructor(canvas, track, line) {
    this.cv = canvas; this.track = track; this.line = line;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COL.sky);
    this.scene.fog = new THREE.Fog(COL.sky, 260, 900);
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.4, 3000);
    this.camPos = new THREE.Vector3();
    this.camAim = new THREE.Vector3();
    this.mode = 0;                   // 0 chase, 1 close, 2 nose, 3 overhead
    this.showLine = false;
    this.cars = [];
    this.buildLights();
    this.buildTrack();
  }

  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xdfeaf5, 0x4a5240, 1.15));
    const sun = new THREE.DirectionalLight(0xfff3e0, 1.05);
    sun.position.set(-420, 700, 330);
    this.scene.add(sun);
  }

  // ---- one static mesh per surface type, built straight off the track data --
  buildTrack() {
    const t = this.track, n = t.n;
    const g = new THREE.Group();

    // geometry helpers: a ribbon between two lateral offsets
    const ribbon = (offA, offB, hA, hB, color, yBias = 0, everyKerb = null) => {
      const pos = [], col = [], idx = [];
      const c = new THREE.Color();
      for (let i = 0; i <= n; i++) {
        const j = i % n, h = t.hdg[j];
        const nx = -Math.sin(h), ny = Math.cos(h);
        const a = offA(j), b = offB(j);
        pos.push(t.x[j] + nx * a, hA(j) + yBias, -(t.y[j] + ny * a));
        pos.push(t.x[j] + nx * b, hB(j) + yBias, -(t.y[j] + ny * b));
        if (everyKerb) {
          // alternating kerb blocks, ~1.6 m each
          const s = j * t.ds;
          c.set(Math.floor(s / 1.6) % 2 ? COL.kerbA : COL.kerbB);
        } else c.set(color);
        col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }
      for (let i = 0; i < n; i++) {
        const a = i * 2, b = a + 1, cc = a + 2, d = a + 3;
        idx.push(a, b, cc, b, d, cc);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    };

    // banking: the OUTSIDE edge of the corner lifts
    const rise = j => {
      const b = t.bank[j];
      if (!b) return 0;
      return 2 * t.w[j] * Math.sin(b * Math.PI / 180);
    };
    const outsideLeft = j => Math.sign(t.curv[j]) > 0 ? -1 : 1;   // left turn -> outside is right
    this.hL = j => outsideLeft(j) < 0 ? 0 : rise(j);
    this.hR = j => outsideLeft(j) < 0 ? rise(j) : 0;
    const hL = this.hL, hR = this.hR;

    const W = j => t.w[j], R = j => t.run[j];

    // tarmac
    g.add(ribbon(j => W(j), j => -W(j), hL, hR, COL.tarmac, 0));
    // white lines
    g.add(ribbon(j => W(j), j => W(j) - 0.18, hL, hL, COL.line, 0.02));
    g.add(ribbon(j => -W(j) + 0.18, j => -W(j), hR, hR, COL.line, 0.02));
    // kerbs, only where the track actually turns
    this.kerbMeshes = [];
    for (const c of t.corners) {
      for (const side of [1, -1]) {
        const i0 = t.idx(c.s0 - 16), i1 = t.idx(c.s1 + 16);
        const count = ((i1 - i0 + n) % n) + 1;
        if (count < 4 || count > n * 0.5) continue;
        const pos = [], col = [], idx = [];
        const cc = new THREE.Color();
        for (let k = 0; k <= count; k++) {
          const j = (i0 + k) % n, h = t.hdg[j];
          const nx = -Math.sin(h), ny = Math.cos(h);
          const a = side * W(j), b = side * (W(j) + 0.95);
          const hh = (side > 0 ? hL(j) : hR(j)) + 0.03;
          pos.push(t.x[j] + nx * a, hh, -(t.y[j] + ny * a));
          pos.push(t.x[j] + nx * b, hh + 0.05, -(t.y[j] + ny * b));
          cc.set(Math.floor((j * t.ds) / 1.6) % 2 ? COL.kerbA : COL.kerbB);
          col.push(cc.r, cc.g, cc.b, cc.r, cc.g, cc.b);
        }
        for (let k = 0; k < count; k++) {
          const a = k * 2;
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        geo.setIndex(idx);
        geo.computeVertexNormals();
        g.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true })));
      }
    }
    // run-off both sides
    const runCol = t.wall === 'gravel' ? COL.gravel : t.wall === 'wall' ? COL.concrete : 0x6f7a5e;
    g.add(ribbon(j => W(j) + R(j), j => W(j), hL, hL, runCol, -0.04));
    g.add(ribbon(j => -W(j), j => -W(j) - R(j), hR, hR, runCol, -0.04));

    // barriers: a vertical strip at the edge of the run-off, with sponsors on it
    const wallTex = this.sponsorTexture(t.sponsors);
    const wallH = t.wall === 'wall' ? 2.6 : 1.5;
    for (const side of [1, -1]) {
      const pos = [], uv = [], idx = [];
      for (let i = 0; i <= n; i++) {
        const j = i % n, h = t.hdg[j];
        const nx = -Math.sin(h), ny = Math.cos(h);
        const o = side * (W(j) + R(j));
        const base = (side > 0 ? hL(j) : hR(j));
        pos.push(t.x[j] + nx * o, base, -(t.y[j] + ny * o));
        pos.push(t.x[j] + nx * o, base + wallH, -(t.y[j] + ny * o));
        // the right-hand barrier is wound inward, which mirrors its texture,
        // so run its U backwards to keep the sponsor names readable
        const span = 46 * (this.boardsPerTile || 8);
        const u = (side > 0 ? 1 : -1) * (j * t.ds) / span;
        uv.push(u, 0, u, 1);
      }
      for (let i = 0; i < n; i++) {
        const a = i * 2;
        if (side > 0) idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        else idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      g.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: wallTex, side: THREE.DoubleSide })));
    }

    // ground
    const b = t.bbox, pad = 700;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry((b.x1 - b.x0) + pad * 2, (b.y1 - b.y0) + pad * 2),
      new THREE.MeshLambertMaterial({ color: t.wall === 'wall' ? 0x5d6068 : COL.grass }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set((b.x0 + b.x1) / 2, -0.25, -(b.y0 + b.y1) / 2);
    g.add(ground);

    // start/finish line
    const sf = t.point(0, 0), w0 = t.widthAt(0);
    const sfm = new THREE.Mesh(new THREE.PlaneGeometry(w0 * 2, 1.6),
      new THREE.MeshBasicMaterial({ map: this.checkerTexture() }));
    sfm.rotation.x = -Math.PI / 2;
    sfm.rotation.z = -sf.hdg;
    sfm.position.set(sf.x, 0.03, -sf.y);
    g.add(sfm);

    // pit lane
    if (t.pit) {
      const p = t.pit.pts, pos = [], idx = [];
      for (let i = 0; i < p.length; i++) {
        const a = p[Math.max(0, i - 1)], c = p[Math.min(p.length - 1, i + 1)];
        const h = Math.atan2(c[1] - a[1], c[0] - a[0]);
        const nx = -Math.sin(h), ny = Math.cos(h), hw = 2.6;
        pos.push(p[i][0] + nx * hw, 0.01, -(p[i][1] + ny * hw));
        pos.push(p[i][0] - nx * hw, 0.01, -(p[i][1] - ny * hw));
      }
      for (let i = 0; i < p.length - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx); geo.computeVertexNormals();
      g.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x3e4147, side: THREE.DoubleSide })));
    }

    // the racing line, toggled with L
    const lp = [];
    for (let i = 0; i <= n; i++) {
      const j = i % n;
      lp.push(new THREE.Vector3(this.line.pts[j * 2], 0.05, -this.line.pts[j * 2 + 1]));
    }
    this.lineMesh = new THREE.Line(new THREE.BufferGeometry().setFromPoints(lp),
      new THREE.LineBasicMaterial({ color: 0xff5a5a }));
    this.lineMesh.visible = false;
    g.add(this.lineMesh);

    this.scene.add(g);
  }

  // One strip holding several boards, so the sponsors change as you go round
  // instead of the same name repeating the whole lap.
  sponsorTexture(names) {
    const per = 512, N = Math.min(8, names.length);
    this.boardsPerTile = N;
    const c = document.createElement('canvas');
    c.width = per * N; c.height = 128;
    const x = c.getContext('2d');
    const bg = ['#1b1e24', '#232833', '#1d2a2a', '#2a2119', '#1a2430', '#262029', '#1f2b24', '#2b2530'];
    x.textAlign = 'center'; x.textBaseline = 'middle';
    for (let i = 0; i < N; i++) {
      const name = names[(i * 3 + 1) % names.length];
      x.fillStyle = bg[i % bg.length];
      x.fillRect(i * per, 0, per, 128);
      x.fillStyle = 'rgba(255,255,255,0.10)';
      x.fillRect(i * per, 0, per, 12);
      x.fillStyle = 'rgba(0,0,0,0.35)';
      x.fillRect(i * per + 6, 118, per - 12, 10);
      let size = 62;
      x.font = `800 ${size}px ui-sans-serif,system-ui,sans-serif`;
      while (x.measureText(name).width > per - 40 && size > 18) {
        size -= 3;
        x.font = `800 ${size}px ui-sans-serif,system-ui,sans-serif`;
      }
      x.fillStyle = '#e8eaee';
      x.fillText(name, i * per + per / 2, 70);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 4;
    return tex;
  }

  checkerTexture() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 32;
    const x = c.getContext('2d');
    for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) {
      x.fillStyle = (i + j) % 2 ? '#f2f2f2' : '#22242a';
      x.fillRect(i * 16, j * 16, 16, 16);
    }
    return new THREE.CanvasTexture(c);
  }

  // ---- cars ---------------------------------------------------------------
  buildCar(col, isPlayer) {
    const g = new THREE.Group();
    const paint = new THREE.MeshLambertMaterial({ color: col });
    const dark = new THREE.MeshLambertMaterial({ color: 0x16181d });
    const body = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.42, 0.95), paint);
    body.position.set(0.1, 0.36, 0);
    g.add(body);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.26, 0.5), paint);
    nose.position.set(2.1, 0.30, 0); g.add(nose);
    const air = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.45, 0.5), paint);
    air.position.set(-0.9, 0.72, 0); g.add(air);
    const halo = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.05, 6, 12), dark);
    halo.position.set(0.35, 0.70, 0); halo.rotation.y = Math.PI / 2; g.add(halo);
    const fw = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.07, 1.85), paint);
    fw.position.set(2.75, 0.16, 0); g.add(fw);
    const rw = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 1.55), paint);
    rw.position.set(-1.9, 0.78, 0); g.add(rw);
    const drs = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.10, 1.5),
      new THREE.MeshLambertMaterial({ color: 0x38d6ff }));
    drs.position.set(-1.9, 0.98, 0); drs.visible = false; g.add(drs);
    const wheel = new THREE.CylinderGeometry(0.36, 0.36, 0.38, 12);
    const wheels = [];
    for (const [dx, dz] of [[1.5, 0.78], [1.5, -0.78], [-1.35, 0.82], [-1.35, -0.82]]) {
      const w = new THREE.Mesh(wheel, dark);
      w.rotation.x = Math.PI / 2;
      w.position.set(dx, 0.36, dz);
      g.add(w); wheels.push(w);
    }
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 2.1),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.26, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.012;
    g.add(shadow);
    g.rotation.order = 'YXZ';
    return { group: g, drs, wheels, isPlayer };
  }

  syncCars(race) {
    while (this.cars.length < race.entries.length) {
      const e = race.entries[this.cars.length];
      const c = this.buildCar(new THREE.Color(e.col), e.isPlayer);
      this.scene.add(c.group);
      this.cars.push(c);
    }
    for (let i = 0; i < this.cars.length; i++) {
      const e = race.entries[i], c = this.cars[i];
      if (!e) { c.group.visible = false; continue; }
      const car = e.car;
      const h = this.surfaceHeight(car.x, car.y, e.proj);
      c.group.visible = !e.retired || true;
      c.group.position.set(car.x, h, -car.y);
      c.group.rotation.y = car.hdg;
      c.group.rotation.x = this.rollAt(e.proj);
      c.drs.visible = !!car.drsOpen;
      const spin = (car.speed || 0) * 0.06;
      for (const w of c.wheels) w.rotation.y -= spin;
      c.group.traverse(o => { if (o.material && o.material.opacity !== undefined && o.material.transparent) return; });
      if (e.retired) c.group.position.y = h - 0.02;
    }
  }

  surfaceHeight(x, y, proj) {
    if (!proj || !this.track.bank[proj.i]) return 0;
    const j = proj.i, w = this.track.w[j];
    const t = Math.max(0, Math.min(1, (proj.lat + w) / (2 * w)));
    return this.hR(j) + t * (this.hL(j) - this.hR(j));
  }
  rollAt(proj) {
    if (!proj || !this.track.bank[proj.i]) return 0;
    const j = proj.i, w = this.track.w[j];
    return Math.atan2(this.hL(j) - this.hR(j), 2 * w);
  }

  // ---- camera -------------------------------------------------------------
  cycleCamera() { this.mode = (this.mode + 1) % 4; return ['CHASE', 'CLOSE', 'NOSE', 'OVERHEAD'][this.mode]; }

  follow(e, dt) {
    const car = e.car || e;
    const v = car.speed || 0;
    const fwd = new THREE.Vector3(Math.cos(car.hdg), 0, -Math.sin(car.hdg));
    const base = new THREE.Vector3(car.x, this.surfaceHeight(car.x, car.y, e.proj), -car.y);
    let want, aim;
    if (this.mode === 3) {
      want = base.clone().add(new THREE.Vector3(0, 115 + v * 0.7, 0)).add(fwd.clone().multiplyScalar(v * 0.25));
      aim = base.clone();
    } else if (this.mode === 2) {
      want = base.clone().add(fwd.clone().multiplyScalar(0.35)).add(new THREE.Vector3(0, 1.25, 0));
      aim = base.clone().add(fwd.clone().multiplyScalar(30)).add(new THREE.Vector3(0, 1.1, 0));
    } else {
      const back = this.mode === 1 ? 5.2 : 7.4 + v * 0.035;
      const up = this.mode === 1 ? 1.9 : 2.5 + v * 0.008;
      want = base.clone().sub(fwd.clone().multiplyScalar(back)).add(new THREE.Vector3(0, up, 0));
      aim = base.clone().add(fwd.clone().multiplyScalar(11 + v * 0.12)).add(new THREE.Vector3(0, 0.9, 0));
    }
    // spring toward the target so the camera lags a little under acceleration
    const k = 1 - Math.exp(-dt * (this.mode === 2 ? 30 : 7.5));
    this.camPos.lerp(want, k);
    this.camAim.lerp(aim, 1 - Math.exp(-dt * 10));
    if (this.camPos.y < 0.5) this.camPos.y = 0.5;
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camAim);
  }

  // cinematic framing of two cars for the highlight reel
  frameTwo(a, b, dt) {
    const mid = new THREE.Vector3((a.x + b.x) / 2, 0, -(a.y + b.y) / 2);
    const sep = Math.hypot(a.x - b.x, a.y - b.y);
    const hdg = a.hdg;
    const side = new THREE.Vector3(Math.sin(hdg), 0, Math.cos(hdg));
    const fwd = new THREE.Vector3(Math.cos(hdg), 0, -Math.sin(hdg));
    const want = mid.clone()
      .add(side.multiplyScalar(11 + sep * 0.5))
      .add(new THREE.Vector3(0, 6.5 + sep * 0.25, 0))
      .sub(fwd.clone().multiplyScalar(4));
    const k = 1 - Math.exp(-dt * 3.2);
    this.camPos.lerp(want, k);
    this.camAim.lerp(mid, 1 - Math.exp(-dt * 6));
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camAim);
  }

  resize() {
    const w = this.cv.clientWidth, h = this.cv.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  draw(race) {
    this.lineMesh.visible = this.showLine;
    this.syncCars(race);
    this.renderer.render(this.scene, this.camera);
  }

  minimap(ctx2, w, h, race) {
    const t = this.track, b = t.bbox, pad = 8;
    const sc = Math.min((w - pad * 2) / (b.x1 - b.x0), (h - pad * 2) / (b.y1 - b.y0));
    const ox = pad - b.x0 * sc, oy = h - pad + b.y0 * sc;
    ctx2.clearRect(0, 0, w, h);
    ctx2.lineWidth = 2.4; ctx2.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx2.beginPath();
    for (let i = 0; i <= t.n; i += 2) {
      const j = i % t.n, x = t.x[j] * sc + ox, y = oy - t.y[j] * sc;
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
