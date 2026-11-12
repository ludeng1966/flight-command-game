import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {stepRadars,radarView} from '../sim/radar.js';

const profiles = JSON.parse(fs.readFileSync(new URL('../data/aircraft.json', import.meta.url)));
const scenario = (scanType) => ({units: [{id: 'blue-1', callsign: 'ALPHA 01', profile: 'f16', position: [0, 0, 5000], heading: 0, speed: 250, radar: {scanType}}]});

test('雷达扫描方式：机械/相控阵可用，非法方式报错', () => {
  for (const scanType of ['mechanical', 'aesa']) {
    const w = new World(scenario(scanType), profiles);
    assert.equal(radarView(w.units[0], 0).scanType, scanType);
  }
  assert.throws(() => new World(scenario('phased'), profiles), /扫描方式无效/);
});

test('相控阵扫描周期是机械式的一半（相同目标更早发现）', () => {
  const make = (scanType) => {
    const w = new World(scenario(scanType), profiles);
    w.radarTargets.push({id: 'tgt-1', callsign: 'TGT 01', team: 'practice', radarPractice: true,
      position: [0, 15000, 4500], velocity: [0, -250, 0], alive: true});
    w.radarCommand('blue-1', {operation: 'mode', mode: 'pd', targetId: null});
    return w;
  };
  const mechanical = make('mechanical'), aesa = make('aesa');
  const firstContactTime = (w) => {
    for (let i = 0; i < 400; i++) {
      w.time += .05; stepRadars(w, .05);
      if (w.units[0].radar.contacts.length) return w.time;
    }
    return Infinity;
  };
  const t1 = firstContactTime(mechanical), t2 = firstContactTime(aesa);
  assert.ok(t2 < t1, `aesa ${t2} 应早于 mechanical ${t1}`);
});
