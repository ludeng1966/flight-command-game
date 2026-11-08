import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {World} from '../sim/world.js';
import {applyPlan} from '../sim/orders.js';
import {captureWorld,restoreWorld,encodeState,decodeState,saveFingerprint} from '../sim/save-state.js';
import {captureTraining,restoreTraining} from '../sim/training-state.js';
import {TrainingWalkthrough} from '../sim/training-walkthrough.js';
import {AutoSave,SAVE_KEYS} from '../game/autosave.js';
const scenario=JSON.parse(await readFile(new URL('../data/scenarios/demo.json',import.meta.url))),profiles=JSON.parse(await readFile(new URL('../data/aircraft.json',import.meta.url)));
const make=spawnMode=>new World(scenario,profiles,null,{spawnMode:spawnMode??'airborne'});
const roundtrip=value=>decodeState(JSON.parse(JSON.stringify(encodeState(value))));
const storage=()=>{const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),values};};
const task={unitId:'blue-1',action:'fly_heading',headingDeg:270,altitudeM:8000,speedMps:600/3.6,eastM:null,northM:null,distanceM:null,append:false};
const physical=w=>w.units.map(u=>({position:u.position,velocity:u.velocity,control:u.control,bank:u.bank,alive:u.alive,waypoints:u.waypoints,completed:u.completedWaypoints,surface:u.surface,formation:u.formation,flightRole:u.flightRole}));
test('存档保留航点编号、共享引用和教学Set，排除地形及异步程序',()=>{
  const w=make(),u=w.units[0],point=[100,200,6500];point.number=17;u.waypoints=[point];u.gateEntered=point;u.navigationPending=true;
  w.deferNavigation=()=>{};w.prediction={points:Array(500).fill([1,2,3])};u.terrain={secret:'not-saved'};
  const state=roundtrip({world:captureWorld(w),set:new Set([point])}),restored=restoreWorld(state.world,scenario,profiles);
  assert.equal(restored.units[0].waypoints[0].number,17);assert.equal(restored.units[0].gateEntered,restored.units[0].waypoints[0]);
  assert.equal([...state.set][0],restored.units[0].waypoints[0]);assert.equal(restored.units[0].profile,profiles[scenario.units[0].profile]);
  assert.equal(restored.units[0].navigationPending,false);assert.equal(restored.units[0].navigationKey,null);assert.equal(state.world.prediction,undefined);assert.equal(state.world.units[0].terrain,undefined);
});
test('飞行中存档后可连续执行原航路，恢复后气动状态与未退出一致',()=>{
  const original=make();applyPlan(original,{status:'accepted',summary:'西向爬升',tasks:[task]},0);
  for(let i=0;i<40;i++)original.step(1/60);
  const restored=restoreWorld(roundtrip(captureWorld(original)),scenario,profiles);assert.deepEqual(physical(restored),physical(original));
  for(let i=0;i<180;i++){original.step(1/60);restored.step(1/60);}
  assert.deepEqual(physical(restored),physical(original));assert.equal(restored.time,original.time);assert.equal(restored.revision,original.revision);
});
test('双机掩护、长僚机分工与编队控制在恢复后继续',()=>{
  const original=make();applyPlan(original,{status:'accepted',summary:'Bravo掩护Alpha',tasks:[{...task,unitId:'blue-2',action:'cover',altitudeM:null,speedMps:null,headingDeg:null,targetId:'blue-1',formation:'fighting_wing',side:'right',rangeM:1500}]},0);
  for(let i=0;i<60;i++)original.step(1/60);
  const restored=restoreWorld(roundtrip(captureWorld(original)),scenario,profiles);assert.deepEqual(physical(restored),physical(original));
  for(let i=0;i<180;i++){original.step(1/60);restored.step(1/60);}
  assert.deepEqual(physical(restored),physical(original));assert.equal(restored.units[1].formation.leaderId,'blue-1');assert.equal(restored.units[0].flightRole.role,'lead');
});
test('机场滑行、跑道占用与冷却时间保留，恢复后仍由机场控制器运行',()=>{
  const original=make('stands');original.airportCommand('blue-1',{intent:'taxi',runway:'09L'});
  for(let i=0;i<120;i++)original.step(1/60);
  original.airportOps.leases.RW1='blue-2';original.airportOps.cooldown.RW0=100;
  const restored=restoreWorld(roundtrip(captureWorld(original)),scenario,profiles);
  assert.equal(restored.airportOps.leases.RW1,'blue-2');assert.equal(restored.airportOps.cooldown.RW0,100);assert.equal(typeof restored.airportOps.step,'function');
  for(let i=0;i<120;i++){original.step(1/60);restored.step(1/60);}
  assert.deepEqual(physical(restored),physical(original));assert.deepEqual(restored.airportOps.airport.events,original.airportOps.airport.events);
});
test('教学中途恢复不从机位重新开始，计分与关卡及航点证据保留',()=>{
  const original=make('stands'),walk=new TrainingWalkthrough(original,'blue-1');walk.index=7;walk.completed=['select','report'];walk.phase='working';walk.attempts=2;
  original.airportCommand('blue-1',{intent:'taxi',runway:'09L'});for(let i=0;i<60;i++){original.step(1/60);walk.flight.tick();}
  const point=[100,200,300];point.number=4;original.units[0].waypoints=[point];walk.flight.lastWaypoints=new Set([point]);
  const state=roundtrip({world:captureWorld(original),training:captureTraining(walk.flight,walk)}),restored=restoreWorld(state.world,scenario,profiles),training=restoreTraining(restored,state.training);
  assert.equal(training.walkthrough.world,restored);assert.equal(training.session.unit,restored.units[0]);assert.equal(training.session.airport,restored.airportOps.airport);
  assert.equal(training.walkthrough.index,7);assert.equal(training.walkthrough.attempts,2);assert.equal(training.walkthrough.phase,'working');assert.equal(training.walkthrough.status,'active');
  assert.equal([...training.session.lastWaypoints][0],restored.units[0].waypoints[0]);training.walkthrough.tick(restored);assert.equal(training.session.status,'active');
});
test('定时与任务变更触发保存，写入失败时仍保留上一份可恢复存档',()=>{
  const store=storage();let time=0,revision=0;const statuses=[];
  const save=new AutoSave({storage:store,fingerprint:'test',now:()=>time,capture:()=>({world:{revision}}),restore(){},onStatus:s=>statuses.push(s)});
  save.load();save.save();time=1999;save.tick({revision});assert.equal(save.sequence,1);time=2000;save.tick({revision});assert.equal(save.sequence,2);
  revision=1;time=2300;save.tick({revision});assert.equal(save.sequence,3);const previous=[...store.values.entries()];
  let attempts=0;store.setItem=()=>{attempts++;throw Error('quota');};time=4300;save.tick({revision});assert.equal(statuses.at(-1).type,'error');assert.equal(save.sequence,3);assert.deepEqual([...store.values.entries()],previous);
  time=4400;save.tick({revision});assert.equal(attempts,1);time=6300;save.tick({revision});assert.equal(attempts,2);
});
test('最新存档损坏时恢复上一份，两份均损坏时不覆盖，重新开始才建立新档',()=>{
  const store=storage();let revision=1,restored;
  const makeSave=()=>new AutoSave({storage:store,fingerprint:'test',capture:()=>({world:{revision}}),restore:s=>{if(!Number.isInteger(s.world?.revision))throw Error('invalid');restored=s;}});
  const first=makeSave();first.load();first.save();revision=2;first.save();
  const bad=JSON.parse(store.getItem(SAVE_KEYS[1]));bad.state={root:{ref:999},nodes:[]};store.setItem(SAVE_KEYS[1],JSON.stringify(bad));
  assert.equal(makeSave().load().restored,true);assert.equal(restored.world.revision,1);
  store.setItem(SAVE_KEYS[0],'broken');const next=makeSave(),before=[...store.values.entries()];assert.equal(next.load().blocked,true);assert.equal(next.save(),false);assert.deepEqual([...store.values.entries()],before);
  assert.equal(next.newGame(),true);
});
test('退出、切后台和刷新均同步保存最后状态',()=>{
  const store=storage(),window=new EventTarget(),document=Object.assign(new EventTarget(),{hidden:false});let revision=0;
  const save=new AutoSave({storage:store,fingerprint:'test',capture:()=>({world:{revision}}),restore(){}});save.load();const unbind=save.bind(window,document);
  revision=1;window.dispatchEvent(new Event('pagehide'));assert.equal(save.sequence,1);
  revision=2;document.hidden=true;document.dispatchEvent(new Event('visibilitychange'));assert.equal(save.sequence,2);
  revision=3;window.dispatchEvent(new Event('beforeunload'));assert.equal(save.sequence,3);
  let state;new AutoSave({storage:store,fingerprint:'test',capture(){},restore:s=>state=s}).load();assert.equal(state.world.revision,3);unbind();
});
test('版本、场景或飞机数据变化不能误读旧档，非法物理数据被拒绝',()=>{
  assert.notEqual(saveFingerprint(scenario,profiles),saveFingerprint({...scenario,name:'changed'},profiles));
  const store=storage(),save=new AutoSave({storage:store,fingerprint:'old',capture:()=>({world:{revision:1}}),restore(){}});save.load();save.save();
  let called=false;const next=new AutoSave({storage:store,fingerprint:'new',capture(){},restore(){called=true;}});assert.equal(next.load().blocked,true);assert.equal(called,false);
  const state=roundtrip(captureWorld(make()));state.units[0].position[0]=NaN;assert.throws(()=>restoreWorld(state,scenario,profiles),/飞机存档无效/);
  assert.throws(()=>decodeState({root:{ref:0},nodes:[{type:'object',properties:[['__proto__',null]]}]}),/存档字段无效/);
});
