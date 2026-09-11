// Does the highlight recorder actually catch attacks and defences?
import fs from 'fs';
import { Track } from '../js/track.js';
import { buildLine } from '../js/line.js';
import { Race } from '../js/race.js';
import { Recorder } from '../js/replay.js';
import { makeDriver, driveAI } from '../js/ai.js';
import { COMPOUNDS } from '../js/physics.js';

const key = process.argv[2] || 'monza';
const track = new Track(JSON.parse(fs.readFileSync(`data/tracks/${key}.json`, 'utf8')));
const line = buildLine(track, COMPOUNDS.medium.mu);
// player starts last with a pace advantage, so there should be passes to find
const race = new Race({ track, line, laps: 4, gridSize: 8, playerGrid: 8, compound: 'soft' });
const me = race.entries.find(e => e.isPlayer);
const ghost = makeDriver(3); ghost.pace = 0.97; ghost.aggression = 0.9; ghost.consistency = 1;
const rec = new Recorder(race);
const DT = 1 / 120;
for (let i = 0; i < 120 * 900 && race.state !== 'over'; i++) {
  const inp = driveAI({ ...me, driver: ghost }, race, DT);
  race.tick(DT, { wheel: inp.wheel, throttle: inp.throttle, brake: inp.brake });
  rec.tick(DT);
}
console.log(`${track.name}: player started P8, finished P${me.pos}, lap ${me.lap}`);
console.log(`frames recorded ${rec.frames.length} (${(rec.frames.length / 20).toFixed(0)}s of replay)`);
const all = rec.events;
console.log(`events detected: ${all.length}`);
for (const ev of all.slice(0, 14))
  console.log(`  [${ev.type.padEnd(8)}] lap ${ev.lap}  ${ev.text}${ev.corner ? '  @ ' + ev.corner : ''}`);
const reel = rec.reel();
console.log(`\nhighlight reel: ${reel.length} clips (${reel.filter(e => e.type === 'ATTACK').length} attack, ${reel.filter(e => e.type === 'DEFENCE').length} defence)`);
if (reel.length) {
  const c = rec.clip(reel[0]);
  const v = rec.frameView(c.from, race);
  console.log(`first clip: frames ${c.from}-${c.to} (${((c.to - c.from) / c.hz).toFixed(1)}s), view has ${v.entries.length} cars, player at ${v.entries.find(e => e.isPlayer).car.x.toFixed(0)},${v.entries.find(e => e.isPlayer).car.y.toFixed(0)}`);
}
