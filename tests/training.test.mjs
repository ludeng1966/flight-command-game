import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {FlightTrainingSession,navigationGeometry} from '../sim/training.js';
import {LESSONS,SOURCES,ALPHABET,DIGITS} from '../game/training-course.js';
import {World} from '../sim/world.js';
import {TerrainHeight} from '../sim/terrain.js';
import {commandContext,applyPlan} from '../sim/orders.js';
import {navigationTask} from '../sim/command-planning.js';

const near=(a,b)=>assert(Math.abs(a-b)<1e-8,`${a} != ${b}`);
test('靶眼地图北顺时针，TACAN径向与向台相反，DME包含高度差',()=>{
  const east=navigationGeometry(90,10,6000);near(east.eastM,18520);near(east.northM,0);assert.equal(east.inboundDeg,270);assert(east.dmeNm>10);
  const north=navigationGeometry(0,10,0);near(north.eastM,0);near(north.northM,18520);near(north.dmeNm,10);
  const overhead=navigationGeometry(90,0,6000);assert.equal(overhead.radialDeg,null);assert.equal(overhead.inboundDeg,null);near(overhead.dmeNm,1828.8/1852);
  assert.equal(navigationGeometry(-90,10,0).radialDeg,270);assert.throws(()=>navigationGeometry(90,-1,10));assert.throws(()=>navigationGeometry(NaN,1,10));
});
function fixture(){const unit={id:'a',alive:true,position:[0,0,101.6],speed:0,targetSpeed:180,holdAltitude:2000,bank:0,completedWaypoints:0,waypoints:[],surface:{phase:'parked',grounded:true}};const world={time:0,units:[unit],airportOps:{airport:{elevation:100,events:[]}}};const session=new FlightTrainingSession(world,'a',{mode:'exam'});return {unit,world,session};}
function advance(f,phase,seconds=.5){f.unit.surface.phase=phase;f.world.time+=seconds;f.session.tick();}
function departure(f){advance(f,'taxi');advance(f,'takeoff_roll');f.unit.surface.grounded=false;f.unit.position[2]=500;advance(f,'climb');}
function stable(f,seconds=11){f.unit.position[2]=2000;f.unit.speed=180;for(let i=0;i<seconds*2;i++)advance(f,'climb');}
test('考核按实际阶段与持续时间判定；暂停、瞬时设值不通过',()=>{
  const f=fixture();departure(f);assert(f.session.completed.departure);stable(f,1);assert(!f.session.completed.cruise);
  for(let i=0;i<50;i++)f.session.tick();assert.equal(f.session.cruiseSeconds,1);
  f.unit.bank=1;advance(f,'climb');assert.equal(f.session.cruiseSeconds,0);f.unit.bank=0;stable(f);assert(f.session.completed.cruise);
  assert.equal(f.session.stage,'waypoint');
});
test('持续航向与进近自动点不冒充目的点；完整滑跑、脱离、停稳才通过',()=>{
  const f=fixture();departure(f);stable(f);
  let p=[1,2,2000];f.unit.headingRoute={};f.unit.waypoints=[p];advance(f,'climb');f.unit.waypoints=[];f.unit.completedWaypoints++;advance(f,'climb');assert(!f.session.completed.waypoint);
  f.unit.headingRoute=null;p=[2,3,2000];f.unit.waypoints=[p];advance(f,'approach');f.unit.waypoints=[];f.unit.completedWaypoints++;advance(f,'approach');assert(!f.session.completed.waypoint);
  p=[3,4,2000];f.unit.waypoints=[p];advance(f,'climb');f.unit.waypoints=[];f.unit.completedWaypoints++;advance(f,'climb');assert(f.session.completed.waypoint);
  f.unit.surface.grounded=true;f.unit.speed=0;advance(f,'parked');assert.equal(f.session.status,'active');
  advance(f,'rollout');advance(f,'exit');f.unit.surface.node='G1';advance(f,'parked');assert.equal(f.session.status,'passed');assert.equal(f.session.result().evidence.recovery.stand,'G1');
});
test('地面出生、坠毁、重开与时间跳变使本轮结束',()=>{
  let f=fixture();f.unit.sceneResetCount=1;f.session.tick();assert.equal(f.session.status,'invalid');
  f=fixture();f.unit.alive=false;f.session.tick();assert.equal(f.session.status,'failed');
  f=fixture();f.session.tick({...f.world});assert.equal(f.session.status,'invalid');
  f=fixture();f.world.time+=3;f.session.tick();assert.equal(f.session.status,'invalid');
});
test('课程覆盖零基础至独立考核，公开来源与默认靶眼一致',()=>{
  assert.equal(LESSONS.length,11);assert.equal(new Set(LESSONS.map(l=>l.id)).size,11);assert.equal(ALPHABET.length,26);assert.equal(DIGITS.length,10);
  for(const l of LESSONS){assert(l.goal&&l.practice.length&&l.observe&&l.pitfall);assert(l.quiz.options[l.quiz.answer]);for(const id of l.sources)assert(SOURCES.some(s=>s.id===id));}
  const scenario=JSON.parse(fs.readFileSync(new URL('../data/scenarios/demo.json',import.meta.url)));assert.deepEqual(scenario.bullseye,{name:'BAY-REF',position:[-18000,0,100]});
});

test('按教程命令和真实地图内核完成：机位→离场→巡航→靶眼航点→着陆回机位',()=>{
  const read=p=>JSON.parse(fs.readFileSync(new URL('../'+p,import.meta.url)));
  const bytes=fs.readFileSync(new URL('../terrain/air_skyscraper_city_height.f32',import.meta.url));
  const terrain=new TerrainHeight(read('terrain/air_skyscraper_city_height.json'),new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4));
  const world=new World(read('data/scenarios/demo.json'),read('data/aircraft.json'),terrain,{spawnMode:'stands'}),unit=world.units[0];
  const session=new FlightTrainingSession(world,unit.id,{mode:'exam'}),report={};
  function run(until,seconds){for(let i=0;i<seconds*60&&unit.alive&&!until();i++){world.step(1/60);session.tick();}assert(unit.alive,JSON.stringify({phase:unit.surface.phase,position:unit.position}));}
  world.airportCommand(unit.id,{intent:'taxi',runway:'09L',taxiways:['A','A1']});run(()=>unit.surface.phase==='holding',600);assert.equal(unit.surface.phase,'holding');
  world.airportCommand(unit.id,{intent:'line_up',runway:'09L'});run(()=>unit.surface.phase==='lined_up',120);assert.equal(unit.surface.phase,'lined_up');assert.equal(unit.speed,0);
  world.airportCommand(unit.id,{intent:'takeoff',runway:'09L'});run(()=>session.completed.departure,200);assert(session.completed.departure);
  const context=()=>commandContext(world,unit.id),current=()=>context().units.find(u=>u.id===unit.id);
  let order={intent:'cruise',parameters:{headingDeg:null,distanceM:null,altitudeM:6096,speedMps:350*1852/3600}};
  applyPlan(world,{status:'accepted',summary:'教程巡航',tasks:[navigationTask(order,current(),context())]},world.revision);
  run(()=>session.completed.cruise,600);report.cruise={position:[...unit.position],speed:unit.speed};assert(session.completed.cruise,JSON.stringify({position:unit.position,target:unit.holdAltitude,bank:unit.bank,blocked:unit.navigationBlocked,stable:session.cruiseSeconds}));
  order={intent:'fly_to',parameters:{mode:'bullseye',bearingDeg:90,rangeM:18520,altitudeM:6096,speedMps:350*1852/3600,eastM:null,northM:null,append:false}};
  applyPlan(world,{status:'accepted',summary:'飞往靶眼090/10',tasks:[navigationTask(order,current(),context())]},world.revision);
  near(unit.waypoints.at(-1)[0],520);near(unit.waypoints.at(-1)[1],0);
  run(()=>session.completed.waypoint,600);assert(session.completed.waypoint);report.waypoint={position:[...unit.position],completed:unit.completedWaypoints};
  world.airportCommand(unit.id,{intent:'land',runway:'09L'});run(()=>session.status==='passed',1800);
  report.result=session.result();report.events=world.airportOps.airport.events;report.final={phase:unit.surface.phase,position:unit.position,speed:unit.speed,alive:unit.alive};
  fs.mkdirSync(new URL('../.game-server/',import.meta.url),{recursive:true});fs.writeFileSync(new URL('../.game-server/training-sortie.json',import.meta.url),JSON.stringify(report,null,2));
  assert.equal(session.status,'passed',JSON.stringify({phase:unit.surface.phase,stage:session.stage,flags:session.flags,position:unit.position}));assert.equal(unit.surface.phase,'parked');assert.equal(unit.speed,0);
});
