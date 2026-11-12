import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {unitHeadingRad} from '../sim/flight.js';
import {bearingClock} from '../sim/rwr.js';

const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const profile=profiles.f16;
const base={profile,position:[0,0,1000],velocity:[0,0,0],bank:0,cl:profile.cl0??0};
test('飞机航向：地面用 surface.heading，不拿零速度当北',()=>{
  const grounded={...base,surface:{grounded:true,heading:Math.PI/2}};
  assert.ok(Math.abs(unitHeadingRad(grounded)-Math.PI/2)<1e-9);
  const parked={...base,surface:{grounded:true,heading:Math.PI}};
  assert.ok(Math.abs(unitHeadingRad(parked)-Math.PI)<1e-9);
});
test('飞机航向：空中用速度方向，RWR 点钟随真实航向',()=>{
  const airborne={...base,surface:{grounded:false,heading:0},velocity:[250,0,0]};
  assert.ok(Math.abs(unitHeadingRad(airborne)-Math.PI/2)<1e-9);
  assert.equal(bearingClock(airborne,90),12);
  assert.equal(bearingClock(airborne,180),3);
});
