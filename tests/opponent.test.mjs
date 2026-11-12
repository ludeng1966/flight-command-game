import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {World} from '../sim/world.js';
import {makeOpponentScenario,stepOpponents} from '../sim/opponent.js';
import {commandContext} from '../sim/orders.js';
import {stepRadars} from '../sim/radar.js';import {stepWeapons} from '../sim/weapons.js';
import {captureWorld,restoreWorld,encodeState,decodeState} from '../sim/save-state.js';
import {attackContacts} from '../sim/attack-task.js';
const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url))),base={units:[{id:'blue-1',callsign:'ALPHA',profile:'f16',position:[0,0,6500],heading:0,speed:250}]};
const create=()=>new World(makeOpponentScenario(base),profiles);
test('可选对抗场景不改变基础场景，红方不进入玩家上下文',()=>{const scenario=makeOpponentScenario(base);assert.equal(base.units.length,1);assert.equal(scenario.units.length,2);assert.equal(scenario.defaultSpawnMode,'airborne');const w=create();assert.deepEqual(commandContext(w,'blue-1').units.map(u=>u.id),['blue-1']);});
test('无传感器发现时对手不偷读目标位置，修改隐蔽蓝方真值不改变决策',()=>{
  const a=create(),b=create();b.units[0].position=[-80000,60000,3000];b.units[0].velocity=[100,-100,0];stepOpponents(a);stepOpponents(b);
  const own=a.units[1],other=b.units[1];assert.equal(own.opponentState.targetId,null);assert.deepEqual(own.opponentState,other.opponentState);assert.equal(own.headingTarget,other.headingTarget);assert.deepEqual(own.position,[0,28000,6500]);
});
test('对手通过实际扫描、锁定、准备、合法发射形成闭环，不瞬移、不调用模型',()=>{
  const w=create(),red=w.units[1],start=[...red.position];stepOpponents(w);
  for(let i=0;i<300&&!w.missiles.length;i++){w.time+=.05;stepRadars(w,.05);stepWeapons(w,.05);stepOpponents(w);}
  assert.equal(red.opponentState.targetId,'blue-1');assert.equal(w.missiles.length,1);assert.equal(w.missiles[0].ownerId,red.id);assert.equal(red.opponentState.phase,'support');assert.deepEqual(red.position,start);
});
test('告警自卫优先且缺弹脱离，不清空告警或伪造新目标',()=>{
  const w=create(),red=w.units[1];red.rwrDefense.active={maneuver:'notch'};stepOpponents(w);assert.equal(red.opponentState.phase,'defend');assert.equal(red.radar.mode,'off');
  red.rwrDefense.active=null;for(const key in red.weapons.inventory)red.weapons.inventory[key]=0;w.time=1;stepOpponents(w);assert.equal(red.opponentState.phase,'disengage');assert.equal(w.missiles.length,0);
});
test('世界画面从己方采样外推敌机，失联记忆渐隐但不读取敌机新真值',()=>{
  const w=create(),blue=w.units[0],red=w.units[1];
  assert.deepEqual(w.snapshot(blue.id,{forecast:false}).units.map(u=>u.id),[blue.id]);
  const sample=[10,15000,6100],velocity=[0,-200,0];blue.radar.contacts=[{id:red.id,callsign:'UNKNOWN',classification:'unknown',source:'radar',position:[...sample],velocity:[...velocity],observedAt:0}];
  red.position=[100,16000,7000];red.velocity=[100,-150,20];w.time=1;
  const visible=w.snapshot(blue.id,{forecast:false}),track=visible.units.find(u=>u.id===red.id);assert.ok(track);assert.deepEqual(track.samplePosition,sample);assert.deepEqual(track.position,[10,14800,6100]);assert.deepEqual(track.velocity,velocity);assert.equal(track.radar,null);assert.equal(track.weapons,null);assert.deepEqual(track.trail,[]);assert.ok(visible.units.some(u=>u.id===blue.id));
  blue.radar.contacts=[];red.position=[90000,90000,1000];w.time=3;
  const memory=w.snapshot(blue.id,{forecast:false}).units.find(u=>u.id===red.id);
  assert.deepEqual(memory.position,[10,14400,6100]);assert.equal(memory.visualState,'memory');assert.ok(memory.visualOpacity>0&&memory.visualOpacity<1);assert.deepEqual(attackContacts(blue,3),[]);
  w.time=7;assert.deepEqual(w.snapshot(blue.id,{forecast:false}).units.map(u=>u.id),[blue.id]);
});
test('对抗存档往返保留阵营、模式、对手状态及红方不可控属性',()=>{
  const scenario=makeOpponentScenario(base),w=new World(scenario,profiles);w.step(.05);
  const next=restoreWorld(decodeState(encodeState(captureWorld(w))),scenario,profiles);
  assert.equal(next.playerTeam,'blue');assert.equal(next.battleMode,'opponent_training');assert.equal(next.units[1].controllable,false);assert.deepEqual(next.units[1].opponentState,w.units[1].opponentState);assert.deepEqual(commandContext(next,'blue-1').units.map(u=>u.id),['blue-1']);
});
test('雷达与光学、双机融合都选择最新采样，不被后遍历的旧样本覆盖',()=>{
  const extra={...base.units[0],id:'blue-2',callsign:'BRAVO',position:[500,0,6500]},w=new World(makeOpponentScenario({...base,units:[...base.units,extra]}),profiles),[alpha,bravo,red]=w.units;
  const sample=(at,position,source)=>({id:red.id,callsign:'OBSERVED CONTACT',classification:'unknown',source,position,velocity:[0,-200,0],observedAt:at});w.time=2;
  alpha.radar.contacts=[sample(1.8,[10,12000,6100],'radar')];alpha.weapons.contacts=[sample(1,[100,14000,6500],'visual')];bravo.radar.contacts=[sample(1.5,[70,13000,6300],'radar')];
  assert.equal(attackContacts(alpha,2)[0].source,'radar');assert.equal(attackContacts(alpha,2)[0].observedAt,1.8);
  let rendered=w.snapshot(alpha.id,{forecast:false}).units.find(u=>u.id===red.id);assert.deepEqual(rendered.samplePosition,[10,12000,6100]);assert.deepEqual(rendered.position,[10,11960,6100]);
  alpha.weapons.contacts[0]=sample(1.9,[20,11900,6100],'visual');rendered=w.snapshot(alpha.id,{forecast:false}).units.find(u=>u.id===red.id);assert.deepEqual(rendered.samplePosition,[20,11900,6100]);assert.equal(rendered.source,'visual');assert.deepEqual(rendered.position,[10,11960,6100],'同帧重获不瞬移');
});
test('观测画面白名单不泄露敌机实时毁伤、姿态、发动机或内部任务状态',()=>{
  const w=create(),blue=w.units[0],red=w.units[1];w.time=1;blue.radar.contacts=[{id:red.id,callsign:'SAMPLED CONTACT',classification:'unknown',source:'radar',position:[10,15000,6100],velocity:[0,-200,0],observedAt:.5}];
  Object.assign(red,{alive:false,speed:0,bank:1.1,afterburner:1,gearDown:true,callsign:'HIDDEN LIVE IDENTITY',flightState:'destroyed',lastIncident:'HIDDEN DAMAGE',control:{throttle:1},secretMission:'HIDDEN PLAN'});
  const picture=w.snapshot(blue.id,{forecast:false}),track=picture.units.find(u=>u.id===red.id);
  assert.equal(track.alive,null);assert.equal(track.speed,200);assert.equal(track.bank,0);assert.equal(track.afterburner,0);assert.equal(track.gearDown,false);assert.equal(track.callsign,'SAMPLED CONTACT');assert.deepEqual(track.forward,[0,-1,0]);assert.deepEqual(track.up,[0,0,1]);
  for(const key of ['control','flightState','lastIncident','secretMission','surface','profile'])assert.equal(Object.hasOwn(track,key),false,key);
  assert.doesNotMatch(JSON.stringify(track),/HIDDEN/);assert.ok(picture.units.some(u=>u.id===blue.id&&u.alive===true));
});
