import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {stepRadars} from '../sim/radar.js';

const profiles = JSON.parse(fs.readFileSync(new URL('../data/aircraft.json', import.meta.url)));
const scenario = {units: [
  {id: 'blue-1', callsign: 'ALPHA 01', profile: 'f16', position: [0, 0, 5000], heading: 0, speed: 250},
  {id: 'blue-2', callsign: 'BRAVO 02', profile: 'f16', position: [0, 15000, 5000], heading: 0, speed: 250}
]};
const create = () => new World(scenario, profiles);
const own = (w) => w.units[0];
const sense = (w, seconds) => { for (let i = 0; i < Math.round(seconds * 20); i++) { w.time += .05; stepRadars(w, .05); } };
const contact = (w) => own(w).radar.contacts.find((c) => c.id === 'blue-2');

test('IFF 自动：同阵营目标显示为友方', () => {
  const w = create();
  w.radarCommand('blue-1', {operation: 'mode', mode: 'pd', targetId: null});
  sense(w, 2.3);
  assert.equal(contact(w)?.classification, 'friendly');
});

test('IFF 关闭：同阵营目标也显示为未知', () => {
  const w = create();
  w.iffMode('blue-1', 'off');
  w.radarCommand('blue-1', {operation: 'mode', mode: 'pd', targetId: null});
  sense(w, 2.3);
  assert.equal(contact(w)?.classification, 'unknown');
});

test('IFF 手动：问询前未知，按 I 问询后友方', () => {
  const w = create();
  w.iffMode('blue-1', 'manual');
  w.radarCommand('blue-1', {operation: 'mode', mode: 'pd', targetId: null});
  sense(w, 2.3);
  assert.equal(contact(w)?.classification, 'unknown');
  w.iffInterrogate('blue-1');
  assert.equal(contact(w)?.classification, 'friendly');
});

test('非法 IFF 模式报错', () => {
  const w = create();
  assert.throws(() => w.iffMode('blue-1', 'maybe'), /敌我识别模式无效/);
});
