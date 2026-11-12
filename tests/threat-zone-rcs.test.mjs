import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {RADAR_DEFAULTS,radarVisibility} from '../sim/radar.js';

const profiles = JSON.parse(fs.readFileSync(new URL('../data/aircraft.json', import.meta.url)));
const scenario = {units: [{id: 'blue-1', callsign: 'ALPHA 01', profile: 'f16', position: [0, 0, 5000], heading: 0, speed: 250}],
  threatZones: [{name: 'SAM-1', center: [0, 6000], radiusM: 2000}]};
const create = () => new World(scenario, profiles);

test('威胁区：航线穿过时给出提示，不判为不可执行', () => {
  const w = create();
  w.command('blue-1', [0, 6000, 5000]);
  assert.deepEqual(w.threatWarnings(w.units[0].waypoints), ['SAM-1']);
});

test('威胁区：航线不穿过时不提示', () => {
  const w = create();
  w.command('blue-1', [20000, 20000, 5000]);
  assert.deepEqual(w.threatWarnings(w.units[0].waypoints), []);
});

test('RCS→探测距离：RCS 16 的等效距离为基准的 2 倍', () => {
  const w = create(), own = w.units[0];
  own.position = [0, 0, 8000]; own.velocity = [0, 250, 0];
  own.radar.mode = 'pd';
  const target = {id: 'tgt-1', position: [0, 100000, 8000], velocity: [0, -260, 0], alive: true, rcs: 16};
  const near = radarVisibility(own, target, own.radar);
  assert.ok(near.effectiveRangeM >= 119000 && near.effectiveRangeM <= 121000);
  assert.equal(near.visible, true);
  target.rcs = 1;
  const far = radarVisibility(own, target, own.radar);
  assert.equal(far.visible, false);
  assert.equal(far.reason, 'range');
});
