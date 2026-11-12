import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {TacticalCommands} from '../game/tactical-session.js';
import {allowedAttackModels} from '../sim/attack-task.js';
import {MISSILE_MODELS} from '../sim/missiles.js';
import {preparePilotPlan} from '../sim/orders.js';
import {captureWorld,restoreWorld,encodeState,decodeState} from '../sim/save-state.js';

const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const scenario={units:[
  {id:'blue-1',callsign:'ALPHA 01',profile:'f16',position:[0,0,6500],heading:0,speed:250},
  {id:'blue-2',callsign:'BRAVO 02',profile:'f16',position:[1200,0,6500],heading:0,speed:250}
]};
const create=()=>new World(scenario,profiles);
const service=world=>new TacticalCommands({getWorld:()=>world});
const contact=(world,id='red-1')=>({id,callsign:'UNKNOWN',classification:'unknown',source:'radar',observedAt:world.time,position:[0,8000,6500],velocity:[0,-200,0]});
const point=[0,12000,6500];

test('玩家进攻方式限制实际模型可用武器，不允许越过选定弹种',async()=>{
  for(const attackMethod of ['radar','infrared']){
    const world=create(),unit=world.units[0],commands=service(world);unit.radar.contacts=[contact(world)];
    const receipt=await commands.issue({action:'attack',unitIds:[unit.id],targetId:'red-1',attackMethod});
    assert.equal(receipt.status,'executing');
    const models=allowedAttackModels(unit,unit.attackTask);assert.ok(models.length);
    assert.ok(models.every(id=>(MISSILE_MODELS.get(id).kind==='infrared')===(attackMethod==='infrared')));
    assert.equal(commands.snapshot().units[0].current.attackMethod,attackMethod);
  }
});

test('玩家横切左右转与背向脱离进入真实自卫控制',async()=>{
  for(const [defenseMethod,defenseSide,heading]of [['notch','left',270],['notch','right',90],['extend','left',180]]){
    const world=create(),unit=world.units[0],commands=service(world);
    unit.rwr.contacts=[{id:'RWR-1',level:'track',epoch:1,bearingDeg:0,signalType:'radar',firstSeen:0,observedAt:0}];
    const receipt=await commands.issue({action:'defend',unitIds:[unit.id],defenseMethod,defenseSide});
    assert.equal(receipt.status,'executing');assert.equal(unit.rwrDefense.active.maneuver,defenseMethod);assert.equal(unit.rwrDefense.active.headingDeg,heading);
  }
});

test('无效方式不改变任务，排队攻击保留选定方式',async()=>{
  const world=create(),commands=service(world),unit=world.units[0];
  assert.equal((await commands.issue({action:'move',unitIds:[unit.id],point,attackMethod:'unknown'})).status,'unable');
  assert.equal(unit.waypoints.length,0);
  await commands.issue({action:'move',unitIds:[unit.id],point});unit.radar.contacts=[contact(world)];
  assert.equal((await commands.issue({action:'attack',unitIds:[unit.id],targetId:'red-1',attackMethod:'infrared',append:true})).status,'queued');
  assert.equal(commands.snapshot().units[0].queue[0].attackMethod,'infrared');
});

test('双机转进保留相对间隔，后续队列经过存档恢复',async()=>{
  const world=create(),commands=service(world);
  const first=await commands.issue({action:'move',unitIds:['blue-1','blue-2'],point});
  assert.equal(first.status,'executing');
  assert.equal(world.units[1].waypoints.at(-1)[0]-world.units[0].waypoints.at(-1)[0],1200);
  const next=await commands.issue({action:'move',unitIds:['blue-1','blue-2'],point:[0,18000,6500],append:true});
  assert.equal(next.status,'queued');
  assert.equal(commands.snapshot().units[0].queue.length,1);
  const saved=decodeState(JSON.parse(JSON.stringify(encodeState(captureWorld(world)))));
  const restored=restoreWorld(saved,scenario,profiles),rebuilt=service(restored);
  assert.equal(rebuilt.snapshot().units[0].queue.length,1);
  assert.equal(rebuilt.snapshot().units[1].current.action,'move');
});

test('快捷攻击只授权主射手一枚，拒绝未观测及友机航迹',async()=>{
  const world=create(),commands=service(world),unit=world.units[0];
  assert.equal((await commands.issue({action:'attack',unitIds:['blue-1','blue-2'],targetId:'red-1'})).status,'unable');
  assert.equal(unit.attackTask?.active??false,false);
  unit.radar.contacts=[contact(world)];
  const receipt=await commands.issue({action:'attack',unitIds:['blue-1','blue-2'],targetId:'red-1'});
  assert.equal(receipt.status,'executing');
  assert.deepEqual(receipt.unitIds,['blue-1']);
  assert.equal(unit.attackTask.shotLimit,1);
  assert.equal(world.units[1].attackTask?.active??false,false);
  unit.radar.contacts=[{...contact(world,'blue-2'),classification:'friendly'}];
  assert.equal((await commands.issue({action:'attack',unitIds:['blue-1'],targetId:'blue-2'})).status,'unable');
});

test('H 停火阻止后续发射，保留已经在执行的自卫动作',async()=>{
  const world=create(),commands=service(world),unit=world.units[0];
  unit.rwrDefense.active={manual:true,maneuver:'notch',side:'left',startedAt:0};
  const receipt=await commands.issue({action:'hold',unitIds:[unit.id]});
  assert.equal(receipt.status,'completed');
  assert.equal(unit.weapons.roe,'hold');
  assert.equal(unit.rwrDefense.active?.manual,true);
});

test('脱离航路规划失败时不提交停火或半条航路',async()=>{
  const world=create(),unit=world.units[0],beforeRoe=unit.weapons.roe;
  const commands=new TacticalCommands({getWorld:()=>world,preparePlan:async()=>{throw Error('route unsafe');}});
  const result=await commands.issue({action:'disengage',unitIds:[unit.id],point});
  assert.equal(result.status,'unable');
  assert.equal(unit.weapons.roe,beforeRoe);
  assert.equal(unit.waypoints.length,0);
});

test('有效脱离同时停止后续发射并装订脱离航路',async()=>{
  const world=create(),unit=world.units[0],commands=service(world);
  const receipt=await commands.issue({action:'disengage',unitIds:[unit.id],point});
  assert.equal(receipt.status,'executing');
  assert.equal(unit.weapons.roe,'hold');
  assert.deepEqual(unit.waypoints.at(-1).slice(0,3),point);
});

test('重复命令编号只执行一次，排队不会重发当前任务',async()=>{
  const world=create(),commands=service(world);
  const request={action:'move',unitIds:['blue-1'],point,commandId:'order-1'};
  const first=await commands.issue(request),revision=world.revision;
  const repeat=await commands.issue(request);
  assert.strictEqual(repeat,first);assert.equal(world.revision,revision);
  const queued=await commands.issue({...request,commandId:'order-2',point:[0,18000,6500],append:true});
  assert.equal(queued.status,'queued');assert.equal(world.units[0].waypoints.length,1);
});

test('严格模式返场只到等待空域，不自行装订进近许可',async()=>{
  const airportScenario={...scenario,airport:{id:'BAY',center:[-18000,0],elevation:100}};
  const world=new World(airportScenario,profiles),commands=service(world),unit=world.units[0];
  const receipt=await commands.issue({action:'return_base',unitIds:[unit.id]});
  assert.equal(receipt.status,'executing');
  assert.equal(unit.surface?.phase,undefined);
  const current=commands.snapshot().units[0].current;
  unit.waypoints=[];unit.completedWaypoints=current.initialCompleted+current.routePointCount;
  commands.tick();
  const staged=commands.snapshot().units[0].current;
  assert.equal(staged.status,'waiting');assert.equal(staged.stage,'handoff');
  assert.equal(unit.controlAuthority.phase,'ready');assert.equal(unit.surface?.phase,undefined);
});

test('较慢的旧规划不能覆盖已提交的新指令',async()=>{
  const world=create();let release;
  const gate=new Promise(resolve=>{release=resolve;});let calls=0;
  const commands=new TacticalCommands({getWorld:()=>world,preparePlan:async(...args)=>{if(++calls===1)await gate;return preparePilotPlan(...args);}});
  const old=commands.issue({action:'move',unitIds:['blue-1'],point:[0,12000,6500]});
  const latest=await commands.issue({action:'move',unitIds:['blue-1'],point:[5000,15000,6500]});
  release();
  assert.equal(latest.status,'executing');
  assert.equal((await old).status,'superseded');
  assert.equal(world.units[0].waypoints.at(-1)[0],5000);
});
