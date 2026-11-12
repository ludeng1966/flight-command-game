import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';

const profiles = JSON.parse(fs.readFileSync(new URL('../data/aircraft.json', import.meta.url)));
const scenario = {units: [{id: 'blue-1', callsign: 'ALPHA 01', profile: 'f16', position: [0, 0, 5000], heading: 0, speed: 250}]};
const create = () => new World(scenario, profiles);
const u = (w) => w.units[0];

test('点哪飞哪默认保持攻击任务（keepTask）', () => {
  const w = create();
  u(w).attackTask = {active: true, status: 'active', pending: false, events: [], eventSequence: 0, retryCount: 0, decisionCount: 0};
  w.command('blue-1', [3000, 4000, 5000], false, undefined, {keepTask: true});
  assert.equal(u(w).attackTask.active, true);
  assert.equal(u(w).waypoints.length, 1);
});

test('普通航路指令仍会取消攻击任务', () => {
  const w = create();
  u(w).attackTask = {active: true, status: 'active', pending: false, events: [], eventSequence: 0, retryCount: 0, decisionCount: 0};
  w.command('blue-1', [3000, 4000, 5000], false);
  assert.notEqual(u(w).attackTask.active, true);
});

test('巡逻：四点环形航路 + 循环标志', () => {
  const w = create();
  w.command('blue-1', [8000, 2000, 5000], false, undefined, {keepTask: true});
  w.command('blue-1', [8000, -2000, 5000], true, undefined, {keepTask: true});
  w.command('blue-1', [8000, 0, 5000], true, undefined, {keepTask: true});
  w.setRouteLoop('blue-1', true);
  assert.equal(u(w).waypoints.length, 3);
  assert.ok(u(w).routeLoop);
});
