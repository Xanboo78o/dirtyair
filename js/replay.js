// replay.js — records the race and picks out the moments that matter:
// passes you made, and passes you survived.
const HZ = 20;

export class Recorder {
  constructor(race) {
    this.race = race;
    this.frames = [];
    this.acc = 0;
    this.events = [];
    this.rel = new Map();     // per rival: what was happening between us
    this.player = race.entries.find(e => e.isPlayer);
  }

  tick(dt) {
    this.acc += dt;
    const race = this.race;
    if (this.acc >= 1 / HZ) {
      this.acc -= 1 / HZ;
      this.frames.push({
        t: race.time,
        c: race.entries.map(e => [
          +e.car.x.toFixed(2), +e.car.y.toFixed(2), +e.car.hdg.toFixed(3),
          Math.round(e.car.speed), e.car.drsOpen ? 1 : 0, e.retired ? 1 : 0, e.pos,
        ]),
      });
      if (this.frames.length > 24000) this.frames.shift();
    }
    this.detect(dt);
  }

  detect(dt) {
    const race = this.race, t = race.track, me = this.player;
    if (!me || me.retired || race.state !== 'green') return;
    const f = this.frames.length - 1;
    for (const o of race.entries) {
      if (o === me || o.retired) continue;
      let r = this.rel.get(o.idx);
      if (!r) { r = { ahead: null, press: 0, pressPeak: 0, cool: 0, defFrame: -1 }; this.rel.set(o.idx, r); }
      r.cool = Math.max(0, r.cool - dt);

      const ds = t.gap(o.proj.s, me.proj.s);      // >0 => rival is ahead of me
      const rivalAhead = ds > 0;
      const gapT = Math.abs(ds) / Math.max(me.car.speed, 12);
      const sameLap = Math.abs(o.lap - me.lap) < 1;

      if (r.ahead !== null && sameLap && !me.inPit && !o.inPit) {
        // ---- I got past them: ATTACK -----------------------------------
        if (r.ahead === true && rivalAhead === false && r.cool === 0 && Math.abs(ds) < 45) {
          this.push('ATTACK', f, o, `PASSED ${o.name}`);
          r.cool = 6; r.press = 0;
        }
        // ---- they got past me ------------------------------------------
        if (r.ahead === false && rivalAhead === true && r.cool === 0 && Math.abs(ds) < 45) {
          this.push('LOST', f, o, `${o.name} PASSED YOU`);
          r.cool = 6; r.press = 0;
        }
      }

      // ---- they sat on my gearbox and never got through: DEFENCE ------
      if (!rivalAhead && sameLap && gapT < 0.55 && !me.inPit && !o.inPit) {
        r.press += dt;
        if (r.press > r.pressPeak) { r.pressPeak = r.press; r.defFrame = f; }
      } else {
        if (r.pressPeak > 2.6 && !rivalAhead && r.cool === 0) {
          this.push('DEFENCE', r.defFrame, o, `HELD OFF ${o.name}`);
          r.cool = 6;
        }
        r.press = 0; r.pressPeak = 0;
      }
      r.ahead = rivalAhead;
    }
  }

  push(type, frame, other, text) {
    if (frame < 0) return;
    const race = this.race, t = race.track;
    const c = t.cornerAt(this.player.proj.s);
    this.events.push({
      type, frame, other: other.idx, otherName: other.name, text,
      lap: this.player.lap + 1, corner: c && c.name ? c.name : (c ? 'T' + c.n : null),
      t: race.time,
    });
  }

  // Reel = your passes and your successful defences, best first.
  reel() {
    const rank = { ATTACK: 0, DEFENCE: 1, LOST: 2 };
    return this.events
      .filter(e => e.type !== 'LOST')
      .sort((a, b) => (rank[a.type] - rank[b.type]) || a.frame - b.frame);
  }

  clip(ev, pre = 4.0, post = 2.6) {
    const a = Math.max(0, ev.frame - Math.round(pre * HZ));
    const b = Math.min(this.frames.length - 1, ev.frame + Math.round(post * HZ));
    return { from: a, to: b, hz: HZ, ev };
  }

  // build a race-shaped object the renderer can draw
  frameView(i, race) {
    const fr = this.frames[Math.max(0, Math.min(this.frames.length - 1, i))];
    if (!fr) return null;
    return {
      track: race.track, pit: race.pit,
      entries: race.entries.map((e, k) => {
        const c = fr.c[k];
        return { col: e.col, isPlayer: e.isPlayer, retired: !!c[5], name: e.name, idx: e.idx,
                 car: { x: c[0], y: c[1], hdg: c[2], speed: c[3], drsOpen: !!c[4] } };
      }),
      t: fr.t,
    };
  }
}
