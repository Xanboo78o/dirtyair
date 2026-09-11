// input.js — a keyboard is a digital device and a steering wheel is not, so
// don't pretend. This models the DRIVER'S HANDS: the wheel takes real time to
// wind on, self-centres like a real rack when you let go, and the usable lock
// falls away with speed exactly as it does in a real car. That's what keeps a
// slip-angle tyre model drivable without faking the tyres.
export const KEYMAP = {
  left: ['ArrowLeft', 'KeyA'], right: ['ArrowRight', 'KeyD'],
  throttle: ['ArrowUp', 'KeyW'], brake: ['ArrowDown', 'KeyS'],
  drs: ['Space'], pit: ['KeyP'], look: ['ShiftLeft', 'ShiftRight'],
};

export class Hands {
  constructor() {
    this.down = new Set();
    this.wheel = 0;          // -1..1, where the driver's hands actually are
    this.throttle = 0; this.brake = 0;
    this.drsHeld = false; this.pitHeld = false;
    this.onPit = null; this.onDrs = null;
    this._kd = e => {
      if (e.repeat) return;
      this.down.add(e.code);
      if (KEYMAP.pit.includes(e.code) && this.onPit) this.onPit();
      if (KEYMAP.drs.includes(e.code) && this.onDrs) this.onDrs();
      if (Object.values(KEYMAP).some(a => a.includes(e.code))) e.preventDefault();
    };
    this._ku = e => this.down.delete(e.code);
  }
  attach(el = window) { el.addEventListener('keydown', this._kd); el.addEventListener('keyup', this._ku); }
  detach(el = window) { el.removeEventListener('keydown', this._kd); el.removeEventListener('keyup', this._ku); }
  held(action) { return KEYMAP[action].some(c => this.down.has(c)); }
  release() { this.down.clear(); }

  // Rates are the whole game. Wind-on is deliberately slower than the snap
  // back to centre, which is what lets you catch a slide by just letting go.
  update(dt, speed) {
    const want = (this.held('right') ? -1 : 0) + (this.held('left') ? 1 : 0);
    const WIND = 2.7, CENTRE = 5.2;
    if (want !== 0) {
      const rate = WIND * (want * this.wheel < 0 ? 1.8 : 1);   // reversing lock is quicker
      this.wheel += Math.sign(want - this.wheel) * Math.min(rate * dt, Math.abs(want - this.wheel));
    } else {
      const d = Math.min(CENTRE * dt, Math.abs(this.wheel));
      this.wheel -= Math.sign(this.wheel) * d;
    }
    const tUp = 3.4, tDn = 7.5, bUp = 5.5, bDn = 9;
    this.throttle += this.held('throttle') ? Math.min(tUp * dt, 1 - this.throttle) : -Math.min(tDn * dt, this.throttle);
    this.brake += this.held('brake') ? Math.min(bUp * dt, 1 - this.brake) : -Math.min(bDn * dt, this.brake);
    return { wheel: this.wheel, throttle: this.throttle, brake: this.brake };
  }
}

// Usable steering lock falls off with speed. At 300 km/h a real driver moves
// the wheel a few degrees; letting a keyboard apply full lock there would just
// spin the car every time.
export function steerLock(speed) {
  const v = Math.max(Number.isFinite(speed) ? speed : 0, 12);
  return 0.40 * Math.min(1, Math.pow(14 / v, 0.80));
}
