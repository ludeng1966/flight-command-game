import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {selectedAircraftStatus} from '../sim/unit-status.js';
test('选中机状态使用实际朝向和SI遥测，与目标参数分开',()=>{
  const s=JSON.parse(fs.readFileSync(new URL('../data/scenarios/demo.json',import.meta.url))),p=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url))),w=new World(s,p),u=w.units[0];
  u.velocity=[180,0,0];u.speed=180;u.holdAltitude=6096;u.targetSpeed=190;const status=selectedAircraftStatus(u);
  assert.equal(status.callsign,'ALPHA 01');assert.equal(status.headingDeg,90);assert.equal(status.speed,180);assert.equal(status.targetSpeed,190);assert.equal(status.altitudeM,6500);assert.equal(status.targetAltitudeM,6096);assert.equal(status.color,u.color);
  u.alive=false;u.lastPose={forward:[0,1,0]};assert.equal(selectedAircraftStatus(u).phase,'飞机损毁');assert.equal(selectedAircraftStatus(u).headingDeg,0);
});
