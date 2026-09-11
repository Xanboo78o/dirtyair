// What fraction of the ideal line can the AI actually drive cleanly?
import fs from 'fs';
import { Track } from '../js/track.js';
import { buildLine } from '../js/line.js';
import { Race } from '../js/race.js';
import { makeDriver } from '../js/ai.js';
import { COMPOUNDS } from '../js/physics.js';
const key = process.argv[2] || 'monza';
const track = new Track(JSON.parse(fs.readFileSync(`data/tracks/${key}.json`, 'utf8')));
const line = buildLine(track, COMPOUNDS.medium.mu);
const fmt = s => s == null ? '  --.---' : `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, '0')}`;
console.log(`${track.name}  ideal ${fmt(line.lapTime)}`);
for (const pace of [0.80, 0.85, 0.88, 0.91, 0.94, 0.97]) {
  const race = new Race({ track, line, laps: 4, gridSize: 1, playerGrid: 1, compound: 'medium' });
  const e = race.entries[0];
  e.isPlayer = false; e.driver = makeDriver(7); e.driver.pace = pace;
  e.driver.consistency = 1; e.driver.noise = 0;
  let rejoins = 0; const ol = race.log.bind(race);
  race.log = (k, t, x) => { if (/REJOIN/.test(t)) rejoins++; ol(k, t, x); };
  const DT = 1 / 120;
  let maxLat = 0;
  for (let k = 0; k < 120 * 500 && race.state !== 'over'; k++) {
    race.tick(DT, null);
    maxLat = Math.max(maxLat, Math.abs(e.proj.lat) - e.proj.w);
  }
  console.log(`  pace ${pace.toFixed(2)}  laps ${e.lap}  best ${fmt(e.bestLap)}  rejoins ${String(rejoins).padStart(3)}  worst excursion ${maxLat.toFixed(1)}m  warn ${e.warnings}`);
}
