import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {stepRadars,radarView,applyRadarOrder} from '../sim/radar.js';

const profiles = JSON.parse(fs.readFileSync(new URL('../data/aircraft.json', import.meta.url)));
const scenario = {
  units: [{
    id: 'blue-1', callsign: 'ALPHA 01', profile: 'f16', color: '#fff',
    position: [0, 0, 5000], heading: 0, speed: 250,
    radar: {warmupSec: 2}
  }]
};
const create = () => new World(scenario, profiles);
const own = (w) => w.units[0];
const sense = (w, seconds) => { for (let i = 0; i < Math.round(seconds * 20); i++) { w.time += .05; stepRadars(w, .05); } };

test('开机有预热：预热中不搜索，到时进入搜索', () => {
  const w = create(), u = own(w);
  w.radarCommand('blue-1', {operation: 'mode', mode: 'pd', targetId: null});
  assert.equal(u.radar.mode, 'pd');
  assert.equal(u.radar.phase, 'warming');
  assert.ok(radarView(u, w.time).warmupRemainingSec > 1.9);
  sense(w, 1);
  assert.equal(u.radar.phase, 'warming');
  sense(w, 1.1);
  assert.equal(u.radar.phase, 'search');
  assert.equal(u.radar.warmingSec, 0);
});

test('电磁静默：雷达关、阶段显示静默，解除后回到关闭', () => {
  const w = create(), u = own(w);
  w.radarCommand('blue-1', {operation: 'mode', mode: 'pd', targetId: null});
  sense(w, 2.1);
  assert.equal(u.radar.phase, 'search');
  w.radarSilence('blue-1', true);
  assert.equal(u.radar.mode, 'off');
  assert.equal(u.radar.silent, true);
  assert.equal(u.radar.phase, 'silent');
  assert.equal(radarView(u, w.time).silent, true);
  w.radarSilence('blue-1', false);
  assert.equal(u.radar.silent, false);
  assert.equal(u.radar.phase, 'off');
});

test('静默后再开机同样要预热，并自动解除静默', () => {
  const w = create(), u = own(w);
  w.radarSilence('blue-1', true);
  w.radarCommand('blue-1', {operation: 'mode', mode: 'pulse', targetId: null});
  assert.equal(u.radar.silent, false);
  assert.equal(u.radar.mode, 'pulse');
  assert.equal(u.radar.phase, 'warming');
  sense(w, 2.1);
  assert.equal(u.radar.phase, 'search');
});

test('手动扫描扇区：中心/半宽生效，离开扇区的目标不会被扫到', () => {
  const profiles = JSON.parse(fs.readFileSync(new URL('../data/aircraft.json', import.meta.url)));
  const w = new World({units:[
    {id:'blue-1',callsign:'ALPHA 01',team:'blue',profile:'f16',position:[0,0,6000],heading:0,speed:250},
    {id:'red-1',callsign:'RED 01',team:'red',profile:'f16',position:[0,15000,6000],heading:180,speed:250}
  ]}, profiles);
  const u = w.units[0];
  applyRadarOrder(w, u, {operation:'mode', mode:'pd', targetId:null});
  const sense = (sec) => { for (let i=0;i<Math.round(sec*20);i++){ w.time+=.05; stepRadars(w,.05); } };
  sense(3);
  assert.ok(u.radar.contacts.length >= 1);
  const result = w.radarScanCommand('blue-1', {centerDeg:50, halfWidthDeg:10});
  assert.equal(result.centerDeg, 50);assert.equal(result.halfWidthDeg, 10);
  assert.equal(u.radar.scanCenterDeg, 50);
  assert.equal(u.radar.scanHalfDeg, 10);
  u.radar.contacts = [];
  sense(8);
  assert.equal(u.radar.contacts.length, 0);
  assert.throws(() => w.radarScanCommand('blue-1', {centerDeg:0, halfWidthDeg:1}), /扫描扇区宽度无效/);
});

test('TWS 多目标：只接受新鲜航迹，可清空且不改变火控锁定', () => {
  const profiles = JSON.parse(fs.readFileSync(new URL('../data/aircraft.json', import.meta.url)));
  const w = new World({units:[
    {id:'blue-1',callsign:'ALPHA 01',team:'blue',profile:'f16',position:[0,0,6000],heading:0,speed:250},
    {id:'red-1',callsign:'RED 01',team:'red',profile:'f16',position:[0,15000,6000],heading:180,speed:250}
  ]}, profiles);
  const u = w.units[0];
  applyRadarOrder(w, u, {operation:'mode', mode:'pd', targetId:null});
  for (let i=0;i<60;i++){ w.time+=.05; stepRadars(w,.05); }
  assert.ok(u.radar.contacts.length >= 1);
  assert.deepEqual(w.setRadarTws('blue-1',['red-1']),['red-1']);
  assert.deepEqual(radarView(u,w.time).twsTrackedIds,['red-1']);
  assert.equal(u.radar.targetId,null);
  assert.throws(() => w.setRadarTws('blue-1',['not-a-contact']), /新鲜雷达航迹/);
  assert.deepEqual(w.setRadarTws('blue-1',[]),[]);
  assert.deepEqual(radarView(u,w.time).twsTrackedIds,[]);
});
