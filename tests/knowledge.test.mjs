import test from 'node:test';
import assert from 'node:assert/strict';
import {updateKnowledge,KNOWLEDGE_GHOST_SEC,KNOWLEDGE_VISUAL_RANGE_M} from '../sim/knowledge.js';

function fakeWorld() {
  const radar = {config: {sweepSec: 2}, contacts: []};
  const own = {id: 'blue-1', alive: true, position: [0, 0, 5000], radar};
  const target = {id: 'tgt-1', callsign: 'TGT 01', team: 'practice', position: [0, 15000, 4500], velocity: [0, -250, 0], alive: true};
  return {time: 10, units: [own], radarTargets: [target], knowledge: []};
}
const contactFor = (time) => ({id: 'tgt-1', callsign: 'TGT 01', observedAt: time, position: [0, 15050, 4500], velocity: [0, -250, 0]});

test('雷达接触 → 只给符号状态，不暴露真实位置之外的东西', () => {
  const w = fakeWorld();
  w.units[0].radar.contacts = [contactFor(9.5)];
  const known = updateKnowledge(w);
  assert.equal(known.length, 1);
  assert.equal(known[0].state, 'radar');
  assert.equal(known[0].source, 'radar');
  assert.equal(known[0].callsign, 'TGT 01');
});

test('雷达丢失后保留残影，超时后遗忘', () => {
  const w = fakeWorld();
  w.units[0].radar.contacts = [contactFor(9.5)];
  w.knowledge = updateKnowledge(w);
  w.units[0].radar.contacts = [];
  w.time = 11;
  let known = updateKnowledge(w);
  assert.equal(known[0].state, 'ghost');
  w.time = 11 + KNOWLEDGE_GHOST_SEC + 1;
  known = updateKnowledge(w);
  assert.equal(known.length, 0);
});

test('近距离自动目视确认，显示真实模型', () => {
  const w = fakeWorld();
  w.radarTargets[0].position = [0, KNOWLEDGE_VISUAL_RANGE_M - 500, 5000];
  const known = updateKnowledge(w);
  assert.equal(known[0].state, 'visual');
  assert.equal(known[0].source, 'visual');
});

test('友军有雷达也共享同样情报，敌军不进入知识', () => {
  const w = fakeWorld();
  const wing = {id: 'blue-2', alive: true, position: [4000, 0, 5000], radar: {config: {sweepSec: 2}, contacts: [contactFor(9.5)]}};
  w.units.push(wing);
  const enemy = {id: 'red-1', team: 'red', alive: true, position: [0, 20000, 5000], velocity: [0, 0, 0]};
  w.units.push(enemy);
  const known = updateKnowledge(w);
  assert.equal(known.find((k) => k.id === 'tgt-1').state, 'radar');
  assert.equal(known.find((k) => k.id === 'red-1'), undefined);
});
