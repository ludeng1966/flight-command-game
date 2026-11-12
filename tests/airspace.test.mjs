import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AIRSPACE_STANDARD_IDS,AIRSPACE_STANDARDS,airspaceZones,airspaceAt,isAirspaceStandard,airspaceContext
} from '../sim/airspace.js';

test('空域标准：北约/FAA 两套都有数据，标准可校验',()=>{
  assert.deepEqual([...AIRSPACE_STANDARD_IDS],['faa','nato']);
  assert.ok(AIRSPACE_STANDARDS.faa.length>=4);
  assert.ok(AIRSPACE_STANDARDS.nato.length>=4);
  assert.equal(isAirspaceStandard('faa'),true);
  assert.equal(isAirspaceStandard('icao'),false);
});
test('空域查询：机场中心/高度命中对应层，双层可同时返回',()=>{
  const zones=airspaceAt('faa',[-18000,0,500]);
  const ids=zones.map(z=>z.id);
  assert.ok(ids.includes('BAY-B'));
  assert.ok(ids.includes('BAY-C'));
  assert.ok(ids.includes('BAY-D'));
  assert.equal(airspaceAt('faa',[-18000,0,5000]).some(z=>['BAY-B','BAY-C','BAY-D'].includes(z.id)),false);
  assert.equal(airspaceAt('nato',[-18000,0,1200]).some(z=>z.id==='BAY-TMA'),true);
});
test('空域上下文：按世界标准返回所在空域且不带几何细节',()=>{
  const world={airspaceStandard:'nato'};
  const context=airspaceContext(world,{position:[-18000,0,1200]});
  assert.equal(context.standard,'nato');
  assert.ok(context.zones.some(z=>z.id==='BAY-TMA'));
  assert.equal(context.zones[0].polygon,undefined);
  assert.equal(airspaceContext({airspaceStandard:'faa'},{position:[-18000,0,8000]}).zones.length,0);
});
