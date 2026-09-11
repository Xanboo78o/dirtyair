import { Track } from './track.js';
import { buildLine } from './line.js';
import { Race } from './race.js';
import { Renderer3D } from './render3d.js';
import { Recorder } from './replay.js';
import { Hands } from './input.js';
import { COMPOUNDS } from './physics.js';

const CATALOG = [
  { key: 'monza',     name: 'MONZA',     country: 'ITALY',       note: 'the temple of speed · 5.79 km' },
  { key: 'suzuka',    name: 'SUZUKA',    country: 'JAPAN',       note: 'figure of eight · 5.81 km' },
  { key: 'zandvoort', name: 'ZANDVOORT', country: 'NETHERLANDS', note: 'banked, no room · 4.26 km' },
  { key: 'monaco',    name: 'MONACO',    country: 'MONACO',      note: 'walls everywhere · 3.34 km' },
  { key: 'baku',      name: 'BAKU',      country: 'AZERBAIJAN',  note: '2.2 km straight · 6.00 km' },
];

const $ = id => document.getElementById(id);
const cv = $('cv');
const hands = new Hands();
let chosen = 'monza';
let R = null;            // {track, line, race, rend, rec}
let mode = 'menu', last = 0, acc = 0, bigMsgT = 0;

// ---------- menu ----------
function buildMenu() {
  $('trackList').innerHTML = CATALOG.map(t =>
    `<div class="tcard${t.key === chosen ? ' on' : ''}" data-k="${t.key}">
       <b>${t.name}</b><span>${t.country}</span><em>${t.note}</em></div>`).join('');
  $('trackList').querySelectorAll('.tcard').forEach(el =>
    el.onclick = () => { chosen = el.dataset.k; buildMenu(); });
}
buildMenu();
$('go').onclick = () => start();
$('again').onclick = () => toMenu();
$('resume').onclick = () => { mode = 'race'; $('pause').classList.add('hidden'); };
$('quit').onclick = () => toMenu();

function toMenu() {
  mode = 'menu';
  $('menu').classList.remove('hidden');
  $('hud').classList.add('hidden');
  $('results').classList.add('hidden');
  $('pause').classList.add('hidden');
  hands.detach();
}

async function start() {
  $('go').textContent = 'LOADING…';
  const data = await (await fetch(`./data/tracks/${chosen}.json`)).json();
  const track = new Track(data);
  const compound = $('optTyre').value;
  const line = buildLine(track, COMPOUNDS[compound].mu);
  const laps = Math.max(2, +$('optLaps').value || 8);
  const gridSize = Math.max(2, +$('optGrid').value || 10);
  const playerGrid = Math.min(gridSize, Math.max(1, +$('optStart').value || 6));
  const race = new Race({ track, line, laps, gridSize, playerGrid, compound, skill: +$('optSkill').value });
  const rend = new Renderer3D(cv, track, line);
  rend.resize();
  const rec = new Recorder(race);
  R = { track, line, race, rend, rec, radio: [] };

  hands.attach();
  hands.onDrs = () => { const p = player(); if (p) p.drsWant = !p.drsWant; };
  hands.onPit = () => { const p = player(); if (p) race.requestPit(p); };

  $('lapOf').textContent = laps;
  $('posOf').textContent = '/' + gridSize;
  $('menu').classList.add('hidden');
  $('results').classList.add('hidden');
  $('hud').classList.remove('hidden');
  $('go').textContent = 'START RACE';
  mode = 'race'; last = performance.now(); acc = 0;
}
const player = () => R && R.race.entries.find(e => e.isPlayer);

addEventListener('keydown', e => {
  if (e.code === 'Escape' && (mode === 'race' || mode === 'pause')) {
    mode = mode === 'race' ? 'pause' : 'race';
    $('pause').classList.toggle('hidden', mode === 'race');
  }
  if (e.code === 'KeyL' && R) R.rend.showLine = !R.rend.showLine;
  if (e.code === 'KeyC' && R) {
    const name = R.rend.cycleCamera();
    R.radio.push({ text: 'CAMERA: ' + name, cls: '', t: 2.0 });
  }
});
addEventListener('resize', () => { if (R) R.rend.resize(); });

// ---------- loop ----------
const DT = 1 / 120;
function loop(ts) {
  requestAnimationFrame(loop);
  const dtReal = Math.min(0.25, (ts - last) / 1000 || 0);
  last = ts;
  if (mode === 'race' && R) {
    const { race, rend, rec } = R;
    acc += dtReal;
    let n = 0;
    while (acc >= DT && n++ < 10) {
      const p = player();
      const inp = hands.update(DT, p ? p.car.speed || 0 : 0);
      race.tick(DT, inp);
      rec.tick(DT);
      acc -= DT;
    }
    const p = player();
    if (p) rend.follow(p, dtReal);
    rend.draw(race);
    drawMini();
    updateHud(dtReal);
    if (race.state === 'over') showResults();
  } else if (mode === 'reel' && R) {
    playReel(dtReal);
  }
}
requestAnimationFrame(loop);

// ---------- hud ----------
const fmtT = s => s == null ? '--.---' :
  (s >= 60 ? `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, '0')}` : s.toFixed(3));

let shownEvents = 0;
function updateHud(dt) {
  const { race } = R, p = player();
  if (!p) return;
  const t = race.track;

  // tower
  $('tower').innerHTML = race.standings.slice(0, 12).map(e => {
    const lead = race.standings[0];
    let g = '';
    if (e !== lead) {
      const d = race.progress(lead) - race.progress(e);
      g = d > t.length ? `+${Math.floor(d / t.length)}L` : `+${(d / Math.max(e.car.speed || 40, 25)).toFixed(1)}`;
    }
    const cls = `row${e.isPlayer ? ' me' : ''}${e.inPit || e.pitRequest ? ' pit' : ''}${e.retired ? ' out' : ''}`;
    return `<div class="${cls}" style="border-left-color:${e.col}">
      <span class="p">${e.pos}</span>
      <span class="tg" style="background:${e.car.tyre.c.col}"></span>
      <span class="nm">${e.name}</span><span class="g">${g}</span></div>`;
  }).join('');

  $('posNow').textContent = p.pos;
  $('lapNow').textContent = Math.min(race.laps, p.lap + 1);
  $('tLast').textContent = fmtT(p.lastLap);
  $('tBest').textContent = fmtT(p.bestLap);
  $('spd').textContent = Math.round((p.car.speed || 0) * 3.6);
  $('pedT').style.width = (p.car.throttle * 100) + '%';
  $('pedB').style.width = (p.car.brake * 100) + '%';

  // tyres: temperature bar is centred on the working window
  const ty = p.car.tyre;
  $('tyreName').textContent = ty.c.name;
  $('tyreName').style.color = ty.c.col;
  const tempPct = T => Math.max(0, Math.min(100, ((T - 40) / (ty.c.Topt + 45 - 40)) * 100));
  const tempCol = T => Math.abs(T - ty.c.Topt) < ty.c.Twin ? 'var(--good)' : (T < ty.c.Topt ? 'var(--cool)' : 'var(--hot)');
  $('tfT').style.width = tempPct(ty.Tf) + '%'; $('tfT').style.background = tempCol(ty.Tf);
  $('trT').style.width = tempPct(ty.Tr) + '%'; $('trT').style.background = tempCol(ty.Tr);
  const wearPct = w => Math.max(0, 100 - w * 100);
  $('tfW').style.width = wearPct(ty.wf) + '%';
  $('trW').style.width = wearPct(ty.wr) + '%';
  $('tfW').style.background = ty.wf > 0.7 ? 'var(--hot)' : ty.wf > 0.45 ? 'var(--warn)' : 'var(--good)';
  $('trW').style.background = ty.wr > 0.7 ? 'var(--hot)' : ty.wr > 0.45 ? 'var(--warn)' : 'var(--good)';

  // lights
  $('drsLight').classList.toggle('on', !!p.car.drsOpen);
  $('drsLight').textContent = p.drsArmed && !p.car.drsOpen ? 'DRS?' : 'DRS';
  $('pitLight').classList.toggle('on', !!p.pitRequest);
  $('limLight').classList.toggle('on', !!p.inPit);

  // gaps
  const ga = race.gapToAhead(p);
  $('gapAhead').innerHTML = p.ahead ? `${p.ahead.name} <b>${ga.toFixed(2)}</b>` : '';
  const gb = p.behind ? race.track.gap(p.proj.s, p.behind.proj.s) / Math.max(p.behind.car.speed || 40, 12) : null;
  $('gapBehind').innerHTML = p.behind ? `<b>${gb.toFixed(2)}</b> ${p.behind.name}` : '';

  // radio feed
  while (shownEvents < race.events.length) {
    const ev = race.events[shownEvents++];
    const cls = ev.kind === 'penalty' || ev.kind === 'crash' ? 'bad' : ev.kind === 'drs' ? 'drs' : ev.kind === 'pit' || ev.kind === 'limits' ? 'hot' : '';
    R.radio.push({ text: ev.text, cls, t: 4.2 });
  }
  for (const m of R.radio) m.t -= dt;
  R.radio = R.radio.filter(m => m.t > 0).slice(-4);
  $('radio').innerHTML = R.radio.map(m => `<div class="${m.cls}">${m.text}</div>`).join('');

  // big message
  let big = '';
  if (race.state === 'grid') big = Math.ceil(race.lights) > 0 ? '' + Math.ceil(race.lights) : 'GO';
  else if (race.state === 'finish' && p.finished) big = 'P' + p.pos;
  $('bigmsg').textContent = big;
  $('bigmsg').style.color = race.state === 'grid' && race.lights <= 0 ? 'var(--good)' : '#fff';
}

function drawMini() {
  const c = $('mini').getContext('2d');
  R.rend.minimap(c, 190, 150, R.race);
}

// ---------- results + highlight reel ----------
let reel = [], reelI = 0, reelF = 0;

function showResults() {
  mode = 'results';
  hands.release();
  const { race, rec } = R;
  const p = player();
  $('resTitle').textContent = p && p.finished ? `P${p.pos} — ${race.track.full.toUpperCase()}` : race.track.full.toUpperCase();

  const rows = race.standings.map((e, i) => {
    const lead = race.standings[0];
    let time = '—';
    if (e.finished) {
      const tt = e.finishTime + e.penalty;
      time = i === 0 ? fmtT(tt) : `+${(tt - (lead.finishTime + lead.penalty)).toFixed(3)}`;
    } else if (e.retired) time = 'DNF';
    return `<tr class="${e.isPlayer ? 'me' : ''}">
      <td class="n">${e.retired ? '—' : i + 1}</td>
      <td style="color:${e.col}">${e.name}</td>
      <td class="n">${time}</td>
      <td class="n">${fmtT(e.bestLap)}</td>
      <td class="n">${e.pitStops}</td>
      <td class="n pen">${e.penalty ? '+' + e.penalty + 's' : ''}</td>
      <td>${[...e.usedCompounds].map(k => COMPOUNDS[k].name[0]).join('')}</td></tr>`;
  }).join('');
  $('classification').innerHTML =
    `<tr><th>POS</th><th>DRIVER</th><th>TIME</th><th>BEST LAP</th><th>STOPS</th><th>PEN</th><th>TYRES</th></tr>${rows}`;

  reel = rec.reel();
  reelI = 0;
  $('results').classList.remove('hidden');
  $('hud').classList.add('hidden');
  if (reel.length) { startClip(0); mode = 'reel'; }
  else {
    $('reelLabel').textContent = 'NO HIGHLIGHTS';
    $('reelSub').textContent = 'no passes, no defences \u2014 go racing';
    $('reelCount').textContent = '0 / 0';
    mode = 'results';
  }
}

function startClip(i) {
  if (!reel.length) return;
  reelI = (i + reel.length) % reel.length;
  const ev = reel[reelI];
  R.clip = R.rec.clip(ev);
  reelF = R.clip.from;
  $('reelLabel').textContent = ev.type === 'ATTACK' ? 'ATTACK — ' + ev.text : 'DEFENCE — ' + ev.text;
  $('reelLabel').style.color = ev.type === 'ATTACK' ? 'var(--good)' : 'var(--drs)';
  $('reelSub').textContent = `LAP ${ev.lap}${ev.corner ? ' · ' + ev.corner.toUpperCase() : ''}`;
  $('reelCount').textContent = `${reelI + 1} / ${reel.length}`;
}
$('reelNext').onclick = () => { startClip(reelI + 1); mode = 'reel'; };
$('reelPrev').onclick = () => { startClip(reelI - 1); mode = 'reel'; };

function playReel(dt) {
  const { rec, race, rend } = R, clip = R.clip;
  if (!clip) return;
  reelF += dt * clip.hz;
  if (reelF > clip.to) reelF = clip.from;
  const view = rec.frameView(Math.floor(reelF), race);
  if (!view) return;
  const me = view.entries.find(e => e.isPlayer);
  const other = view.entries.find(e => e.idx === clip.ev.other) || me;
  rend.syncCars(view);
  rend.frameTwo(me.car, other.car, dt);
  rend.renderer.render(rend.scene, rend.camera);
}
