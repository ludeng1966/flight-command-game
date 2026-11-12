import test from 'node:test';
import assert from 'node:assert/strict';
import {contactVisuals} from '../sim/contact-visuals.js';

const sample=(extra={})=>({id:'red-1',callsign:'RED 01',source:'radar',classification:'unknown',observedAt:0,position:[0,10000,6500],velocity:[100,-200,10],...extra});
const setup=()=>{
  const own={id:'blue-1',alive:true,radar:{available:true,mode:'pd',targetId:null,config:{sweepSec:2,memorySec:4},contacts:[sample()]},weapons:{contacts:[]}};
  const world={time:0,playerTeam:'blue'};
  return {world,own,read:()=>contactVisuals(world,[own]).get('red-1')};
};
const close=(actual,expected,tolerance=1e-8)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} != ${expected}`);

test('map track moves between radar sweeps using only the last observed velocity',()=>{
  const {world,read}=setup();assert.deepEqual(read().position,[0,10000,6500]);
  world.time=1;assert.deepEqual(read().position,[100,9800,6510]);
  world.time=1.016;const next=read();close(next.position[0],101.6);
  assert.equal(next.visualOpacity,1);assert.equal(next.visualState,'tracked');
  assert.equal(next.visualPredicted,true);assert.equal(next.visualizationOnly,true);
  assert.deepEqual(next.samplePosition,[0,10000,6500]);assert.equal(next.observedAt,0);
});

test('sweep cadence stays bright; removed signal continues moving and gradually disappears',()=>{
  const {world,own,read}=setup();read();
  world.time=2;assert.equal(read().visualOpacity,1);
  own.radar.contacts=[];world.time=3;const early=read();world.time=5;const late=read();
  assert.ok(early.visualOpacity>late.visualOpacity&&late.visualOpacity>0);
  assert.equal(late.visualState,'memory');assert.deepEqual(late.position,[500,9000,6550]);
  world.time=6;assert.equal(read(),undefined);
});

test('lost contact never follows hidden enemy movement or destruction',()=>{
  const {world,own,read}=setup();read();own.radar.contacts=[];
  Object.defineProperty(world,'units',{get(){throw Error('hidden world truth must not be read');}});
  world.time=4;assert.deepEqual(read().position,[400,9200,6540]);
  assert.equal(read().alive,undefined);assert.equal(read().attackTask,undefined);
});

test('reacquisition corrects a new observation smoothly without jumping at reception',()=>{
  const {world,own,read}=setup();read();own.radar.contacts=[];
  world.time=3;const before=read();
  own.radar.contacts=[sample({observedAt:3,position:[400,9300,6600]})];
  const reacquired=read();assert.deepEqual(reacquired.position,before.position);
  assert.deepEqual(reacquired.samplePosition,[400,9300,6600]);assert.equal(reacquired.visualOpacity,1);
  world.time=3.35;const after=read(),raw=[435,9230,6603.5];
  assert.ok(Math.hypot(...after.position.map((value,i)=>value-raw[i]))<Math.hypot(...before.position.map((value,i)=>value-[400,9300,6600][i])));
  world.time=4.75;close(read().position[0],575-100*Math.exp(-5));
});

test('paused simulation freezes both movement and fade; accelerated sim time controls both',()=>{
  const {world,read}=setup();read();world.time=3;
  const a=read(),b=read();assert.deepEqual(a,b);
  world.time=5;assert.ok(read().visualOpacity<a.visualOpacity);assert.equal(read().position[0],500);
});

test('rewind, new world, and changed team scope cannot inherit old tracks',()=>{
  const {world,own,read}=setup();read();own.radar.contacts=[];world.time=3;assert.ok(read());
  assert.equal(contactVisuals({time:3,playerTeam:'blue'},[own]).size,0);
  world.time=1;assert.equal(read(),undefined);
  own.radar.contacts=[sample({observedAt:1})];read();own.radar.contacts=[];
  world.playerTeam='red';assert.equal(read(),undefined);
});

test('memory is detached from mutable sensor records and consumer snapshots',()=>{
  const {world,own,read}=setup(),original=structuredClone(own.radar.contacts[0]);
  const visual=read();visual.position[0]=99999;visual.velocity[0]=99999;visual.samplePosition[0]=99999;
  assert.deepEqual(own.radar.contacts[0],original);
  own.radar.contacts[0].position[0]=88888;own.radar.contacts[0].velocity[0]=88888;
  world.time=1;assert.deepEqual(read().position,[100,9800,6510]);
});

test('newest friendly sensor wins; duplicate own tracks and extra internal state are excluded',()=>{
  const {world,own,read}=setup();world.time=1;
  own.radar.contacts=[sample({observedAt:.5,attackTask:{secret:true},alive:false}),sample({id:own.id})];
  own.weapons.contacts=[sample({source:'visual',observedAt:1,position:[500,8000,7000]})];
  const visual=read();assert.deepEqual(visual.position,[500,8000,7000]);assert.equal(visual.source,'visual');
  assert.equal(visual.attackTask,undefined);assert.equal(contactVisuals(world,[own]).has(own.id),false);
});

test('expired or invalid samples do not resurrect; dead receivers add no new observations',()=>{
  const {world,own,read}=setup();read();world.time=7;assert.equal(read(),undefined);
  own.radar.contacts=[sample({observedAt:8}),sample({id:'bad',position:[NaN,0,0]})];
  assert.equal(contactVisuals(world,[own]).size,0);
  own.radar.contacts=[sample({observedAt:7})];own.alive=false;assert.equal(read(),undefined);
});

test('locked radar and visual tracks fade promptly after continuous updates stop',()=>{
  const {world,own,read}=setup();own.radar.targetId='red-1';read();world.time=.5;
  assert.equal(read().visualState,'memory');assert.ok(read().visualOpacity<1);
  const other=setup();other.own.radar.mode='off';other.own.radar.contacts=[];other.own.weapons.contacts=[sample({source:'visual'})];other.read();
  other.own.weapons.contacts=[];other.world.time=1;assert.equal(other.read().visualState,'memory');
  other.world.time=2.25;assert.equal(other.read(),undefined);
});
