import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {stepRadars,radarView} from '../sim/radar.js';
import {updateKnowledge} from '../sim/knowledge.js';

const profiles = JSON.parse(fs.readFileSync(new URL('../data/aircraft.json', import.meta.url)));
function create(radarOverride = {nctr: true, nctrSec: 4, nctrRangeM: 35000, nctrConfidence: .8}) {
  const scenario = {units: [{id: 'blue-1', callsign: 'ALPHA 01', profile: 'f16', position: [0, 0, 5000], heading: 0, speed: 250, radar: radarOverride}]};
  const world = new World(scenario, profiles);
  world.radarTargets.push({id: 'tgt-1', callsign: 'TGT 01', team: 'practice', radarPractice: true,
    aircraftCategory: '战斗机', aircraftType: 'F-16 同型靶', position: [0, 15000, 4500], velocity: [0, -250, 0], alive: true});
  return world;
}
const own = (w) => w.units[0];
const sense = (w, seconds) => { for (let i = 0; i < Math.round(seconds * 20); i++) { w.time += .05; stepRadars(w, .05); } };
const prepare = (w) => { w.radarCommand('blue-1', {operation:'mode', mode:'pd', targetId:null}); sense(w, 2.2); };

test('NCTR：持续锁定 4 秒后给出类别/型号/置信度', () => {
  const w = create();
  prepare(w);
  w.radarCommand('blue-1', {operation: 'lock', mode: null, targetId: 'tgt-1'});
  sense(w, 2.5);
  assert.equal(own(w).radar.contacts[0].identification, undefined);
  sense(w, 2.5);
  const contact = own(w).radar.contacts[0];
  assert.equal(contact.identification.category, '战斗机');
  assert.equal(contact.identification.type, 'F-16 同型靶');
  assert.equal(contact.identification.confidence, .8);
  assert.equal(radarView(own(w), w.time).contacts[0].identification.type, 'F-16 同型靶');
});

test('NCTR：没有该能力的雷达永远只给"未知"', () => {
  const w = create({nctr: false});
  prepare(w);
  w.radarCommand('blue-1', {operation: 'lock', mode: null, targetId: 'tgt-1'});
  sense(w, 6);
  assert.equal(own(w).radar.contacts[0].identification, undefined);
});

test('识别后情报状态升级为 identified，未识别仍是 radar', () => {
  const identified = create();
  prepare(identified);
  identified.radarCommand('blue-1', {operation: 'lock', mode: null, targetId: 'tgt-1'});
  sense(identified, 5);
  const known = updateKnowledge(identified);
  assert.equal(known[0].state, 'identified');
  assert.equal(known[0].identification.type, 'F-16 同型靶');

  const unknown = create({nctr: false});
  prepare(unknown);
  sense(unknown, 1.5);
  const plain = updateKnowledge(unknown);
  assert.equal(plain[0].state, 'radar');
});
