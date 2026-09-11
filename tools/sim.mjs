// Headless race: can the AI actually drive the physics? Run it and find out.
import fs from 'fs';
import { Track } from '../js/track.js';
import { buildLine } from '../js/line.js';
import { Race } from '../js/race.js';
import { makeDriver } from '../js/ai.js';
import { COMPOUNDS } from '../js/physics.js';

const key = process.argv[2] || 'monza';
const laps = +(process.argv[3] || 5);
const grid = +(process.argv[4] || 8);
const track = new Track(JSON.parse(fs.readFileSync(`data/tracks/${key}.json`, 'utf8')));
const line = buildLine(track, COMPOUNDS.medium.mu);
const race = new Race({ track, line, laps, gridSize: grid, playerGrid: 1, compound: 'medium' });
// no human here: give the player slot a driver too
const p = race.entries.find(e => e.isPlayer);
p.isPlayer = false; p.driver = makeDriver(99); p.name = 'AI-TEST';

const DT = 1 / 120;
let t = 0, guard = 0;
const maxT = laps * 200 + 60;
while (race.state !== 'over' && t < maxT) {
  race.tick(DT, null);
  t += DT;
  if (++guard > 1e7) break;
}
const fmt = s => s == null ? '   --.---' : `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, '0')}`;
console.log(`${track.full} — ${laps} laps, ${grid} cars, state=${race.state}, sim time ${t.toFixed(1)}s`);
console.log('POS DRIVER        BEST LAP   LAPS STOPS PEN  WARN DMG   TYRES');
for (const e of race.standings) {
  console.log(
    String(e.pos).padStart(3), e.name.padEnd(13),
    fmt(e.bestLap), String(e.lap).padStart(4), String(e.pitStops).padStart(5),
    String(e.penalty).padStart(4), String(e.warnings).padStart(4),
    e.car.damage.toFixed(2).padStart(5), ' ', [...e.usedCompounds].join('/'),
    e.retired ? ' RETIRED' : '');
}
const ideal = line.lapTime;
const best = Math.min(...race.entries.map(e => e.bestLap || 1e9));
console.log(`\nideal line ${fmt(ideal)} | best AI lap ${fmt(best)} | AI is ${((best / ideal - 1) * 100).toFixed(1)}% off ideal`);
const kinds = {};
for (const ev of race.events) kinds[ev.kind] = (kinds[ev.kind] || 0) + 1;
console.log('events:', JSON.stringify(kinds));
console.log('sample:', race.events.slice(0, 8).map(e => e.text).join(' | '));
