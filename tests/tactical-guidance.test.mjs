import {stepDatalinks,configureDatalink} from '../sim/datalink.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {TacticalCommands} from '../game/tactical-session.js';
import {guidanceContext} from '../sim/tactical-guidance.js';
import {attackTaskEvent} from '../sim/attack-task.js';
import {radialIndex,wheelPages,WHEEL_TABLES} from '../game/tactical-wheel.js';
import {captureWorld,restoreWorld,encodeState,decodeState} from '../sim/save-state.js';
import {createTacticalManeuver,validateManeuverProposal} from '../server/tactical-maneuver.mjs';
import {commandContext} from '../sim/orders.js';
import {captureUnitOrderScope,isUnitOrderScopeCurrent} from '../sim/command-scope.js';
const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const scenario={units:[{id:'blue-1',callsign:'ALPHA',profile:'f16',position:[0,0,6500],heading:0,speed:250}]};
const create=()=>new World(scenario,profiles),flush=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
const proposal=(waypoints=[[-4000,5000,6500]])=>({status:'execute',waypoints,speedMps:250,purposeZh:'拟按当前方针左转机动。',purposeEn:'MANOEUVRING LEFT UNDER ASSIGNED POLICY.',reasonZh:'调整任务内飞行位置。',reasonEn:'REPOSITIONING WITHIN ASSIGNED TASK.',recoveryZh:'机动后接回原任务目标。',recoveryEn:'WILL REJOIN THE ASSIGNED TASK.'});

test('轮盘中心取消，四向与八向扇区映射稳定',()=>{
  assert.equal(radialIndex(0,0,4),-1);assert.equal(radialIndex(0,-100,4),0);assert.equal(radialIndex(100,0,4),1);assert.equal(radialIndex(0,100,8),4);assert.equal(radialIndex(-100,0,8),6);
});

test('进攻六方案和防御五方针逐项保留，补充条令项目后每盘十项且不丢项',()=>{
  assert.deepEqual(Object.values(WHEEL_TABLES.offense).slice(0,6).map(x=>x.zh),['自主接战','支援后脱离','持续接敌','双机分工交战','双机侧向协同','轮换接战']);
  assert.deepEqual(Object.values(WHEEL_TABLES.defense).slice(0,5).map(x=>x.zh),['自保优先','保持支援','脱离重整','双机相互掩护','保护对象优先']);
  for(const category of Object.keys(WHEEL_TABLES)){const pages=wheelPages(category);assert.ok(pages.every(p=>p.length===10));assert.deepEqual(pages.flat().map(([key])=>key),Object.keys(WHEEL_TABLES[category]));}
  assert.equal(wheelPages('maneuver').length,2);
});

test('TERMINATE停止当前交战与后续发射，复位不重建旧攻击授权',async()=>{
  const world=create(),u=world.units[0],commands=new TacticalCommands({getWorld:()=>world,planManeuver:async input=>proposal(input.resumePoint?[input.resumePoint]:undefined)});
  u.radar.contacts=[{id:'red-1',callsign:'CONTACT',classification:'unknown',source:'radar',observedAt:0,position:[0,8000,6500],velocity:[0,-200,0]}];
  await commands.issue({action:'attack',unitIds:[u.id],targetId:'red-1'});const id=u.attackTask.id;
  await commands.issue({action:'maneuver',unitIds:[u.id],maneuver:'terminate'});
  assert.equal(u.attackTask.active,false);assert.equal(u.weapons.roe,'hold');assert.equal(u.attackTask.id,id);assert.equal(u.tacticalGuidance.direct.phase,'recovering');
});

test('双机方案分配共同编号与互补角色，单机条件不满足时拒绝整项',async()=>{
  const single=create(),singleCommands=new TacticalCommands({getWorld:()=>single});
  assert.equal((await singleCommands.issue({action:'offense_policy',unitIds:['blue-1'],value:'split'})).status,'unable');
  assert.equal(single.units[0].tacticalGuidance,undefined);
  const pair=new World({units:[scenario.units[0],{...scenario.units[0],id:'blue-2',callsign:'BRAVO',position:[1200,0,6500]}]},profiles),commands=new TacticalCommands({getWorld:()=>pair});
  await commands.issue({action:'offense_policy',unitIds:['blue-1'],value:'bracket'});
  const [a,b]=pair.units.map(u=>u.tacticalGuidance);assert.equal(a.group.id,b.group.id);assert.equal(a.group.role,'left');assert.equal(b.group.role,'right');assert.equal(b.offense,'bracket');assert.equal(pair.units[1].attackTask,undefined);
  const context=commandContext(pair,'blue-1');assert.match(context.units[0].tacticalGuidance.offenseIntent,/协同压力/);
});

test('轮换接战只在搭档已有授权时交接角色，不增加发射额度且废弃旧角色判断',async()=>{
  const world=new World({units:[scenario.units[0],{...scenario.units[0],id:'blue-2',callsign:'BRAVO',position:[1200,0,6500]}]},profiles),commands=new TacticalCommands({getWorld:()=>world});
  for(const u of world.units){u.radar.contacts=[{id:'red-1',callsign:'CONTACT',classification:'unknown',source:'radar',observedAt:0,position:[0,8000,6500],velocity:[0,-200,0]}];await commands.issue({action:'attack',unitIds:[u.id],targetId:'red-1'});}
  await commands.issue({action:'offense_policy',unitIds:['blue-1','blue-2'],value:'rotate'});
  const old=captureUnitOrderScope(world,world.units[1]);world.units[0].rwrDefense.active={manual:true,maneuver:'notch'};commands.tick();assert.equal(world.units[0].tacticalGuidance.group.role,'engaged');
  configureDatalink(world,'blue-2',{networkId:'isolated'});for(let i=0;i<16;i++){world.time+=.125;stepDatalinks(world);}commands.tick();assert.equal(world.units[0].tacticalGuidance.group.role,'engaged');
  configureDatalink(world,'blue-2',{networkId:'blue'});for(let i=0;i<16;i++){world.time+=.125;stepDatalinks(world);}commands.tick();
  assert.equal(world.units[0].tacticalGuidance.group.role,'supporting');assert.equal(world.units[1].tacticalGuidance.group.role,'engaged');assert.equal(isUnitOrderScopeCurrent(world,world.units[1],old),false);
  assert.deepEqual(world.units.map(u=>u.attackTask.shotLimit),[1,1]);assert.equal(world.missiles.length,0);
});
test('持续方针不新增攻击授权，且进入模型上下文与存档',async()=>{
  const world=create(),commands=new TacticalCommands({getWorld:()=>world});
  await commands.issue({action:'offense_policy',unitIds:['blue-1'],value:'support_exit'});
  await commands.issue({action:'defense_policy',unitIds:['blue-1'],value:'support'});
  assert.equal(world.units[0].attackTask,undefined);
  assert.equal(commandContext(world,'blue-1').units[0].tacticalGuidance.offense,'support_exit');
  const saved=decodeState(JSON.parse(JSON.stringify(encodeState(captureWorld(world))))),restored=restoreWorld(saved,scenario,profiles);
  assert.equal(guidanceContext(restored.units[0].tacticalGuidance).defense,'support');
});
test('直接机动有目的与复位闭环，原航点及方针保持',async()=>{
  const world=create(),requests=[],commands=new TacticalCommands({getWorld:()=>world,planManeuver:async input=>{requests.push(input);return proposal(input.stage==='recover'?[input.resumePoint]:undefined);}}),u=world.units[0];
  await commands.issue({action:'move',unitIds:[u.id],point:[0,14000,6500]});
  await commands.issue({action:'offense_policy',unitIds:[u.id],value:'press'});
  const result=await commands.issue({action:'maneuver',unitIds:[u.id],maneuver:'turn_left'});
  assert.equal(result.status,'executing');assert.equal(u.tacticalGuidance.direct.phase,'executing');
  assert.deepEqual(u.tacticalGuidance.resume.points,[[0,14000,6500]]);assert.equal(requests[0].context.units[0].tacticalGuidance.offense,'press');
  u.waypoints=[];commands.tick();await flush();assert.equal(u.tacticalGuidance.direct.phase,'recovering');
  assert.deepEqual(u.waypoints.at(-1).slice(0,3),[0,14000,6500]);
  u.waypoints=[];commands.tick();assert.equal(u.tacticalGuidance.direct.phase,'completed');assert.equal(u.tacticalGuidance.resume,null);
});
test('新指令接管后迟到的直接机动不装订',async()=>{
  const world=create();let release;const gate=new Promise(r=>{release=r;});
  const commands=new TacticalCommands({getWorld:()=>world,planManeuver:async()=>{await gate;return proposal();}}),u=world.units[0];
  const pending=commands.issue({action:'maneuver',unitIds:[u.id],maneuver:'turn_left'});
  await commands.issue({action:'move',unitIds:[u.id],point:[3000,15000,6500]});release();await pending;
  assert.deepEqual(u.waypoints.at(-1).slice(0,3),[3000,15000,6500]);assert.equal(u.tacticalGuidance.direct.phase,'cancelled');
});
test('模型拒绝或方向错误时不伪执行，也保留可请求的复位任务',async()=>{
  const world=create(),commands=new TacticalCommands({getWorld:()=>world,planManeuver:async()=>proposal([[4000,5000,6500]])}),u=world.units[0];
  await commands.issue({action:'move',unitIds:[u.id],point:[0,14000,6500]});
  assert.equal((await commands.issue({action:'maneuver',unitIds:[u.id],maneuver:'turn_left'})).status,'unable');
  assert.deepEqual(u.waypoints.at(-1).slice(0,3),[0,14000,6500]);assert.ok(u.tacticalGuidance.resume);
});
test('直接机动保留攻击任务但禁止自主攻击覆盖，H不撤销机动',async()=>{
  const world=create(),commands=new TacticalCommands({getWorld:()=>world,planManeuver:async()=>proposal()}),u=world.units[0];
  u.radar.contacts=[{id:'red-1',callsign:'CONTACT',classification:'unknown',source:'radar',observedAt:0,position:[0,8000,6500],velocity:[0,-200,0]}];
  await commands.issue({action:'attack',unitIds:[u.id],targetId:'red-1'});const attack=u.attackTask;
  await commands.issue({action:'maneuver',unitIds:[u.id],maneuver:'turn_left'});
  assert.strictEqual(u.attackTask,attack);assert.equal(attack.active,true);assert.equal(attackTaskEvent(u,0),null);
  await commands.issue({action:'hold',unitIds:[u.id]});commands.tick();assert.equal(u.tacticalGuidance.direct.phase,'executing');assert.equal(attack.active,false);
});
test('直接机动接口将方针交给模型，验证恢复目标及坐标范围',async()=>{
  const world=create();world.units[0].tacticalGuidance={offense:'press',defense:'support',revision:1,direct:null};let messages;
  const handler=createTacticalManeuver({completePilot:async m=>{messages=m;return {value:proposal()};}});
  const result=await handler({requestId:'r1',unitId:'blue-1',maneuver:'turn_left',stage:'execute',context:commandContext(world,'blue-1')});
  assert.equal(result.status,'execute');assert.equal(JSON.parse(messages[1].content).ownship.tacticalGuidance.offense,'press');
  assert.throws(()=>validateManeuverProposal(proposal([[250000,0,6500]])),/格式/);
  assert.throws(()=>validateManeuverProposal(proposal(),{stage:'recover',resumePoint:[0,14000,6500]}),/接回/);
});

test('改变方针使旧机动提案失效，并以新方针重新规划',async()=>{
  const world=create();let release;const gate=new Promise(r=>{release=r;}),seen=[];
  const commands=new TacticalCommands({getWorld:()=>world,planManeuver:async input=>{seen.push(input.context.units[0].tacticalGuidance.offense);if(seen.length===1)await gate;return proposal();}}),u=world.units[0];
  const old=commands.issue({action:'maneuver',unitIds:[u.id],maneuver:'turn_left'});
  await commands.issue({action:'offense_policy',unitIds:[u.id],value:'press'});commands.tick();await flush();release();await old;
  assert.deepEqual(seen,['auto','press']);assert.equal(u.tacticalGuidance.direct.phase,'executing');assert.equal(u.tacticalGuidance.offense,'press');
});

test('复位恢复长航路的全部剩余目标，不受单次任务条数限制',async()=>{
  const world=create(),u=world.units[0];u.waypoints=Array.from({length:20},(_,i)=>[0,10000+i*1000,6500]);
  const commands=new TacticalCommands({getWorld:()=>world,planManeuver:async input=>proposal(input.stage==='recover'?[input.resumePoint]:undefined)});
  await commands.issue({action:'maneuver',unitIds:[u.id],maneuver:'turn_left'});u.waypoints=[];commands.tick();await flush();
  u.position=[0,10000,6500];u.waypoints=[];commands.tick();
  assert.equal(u.tacticalGuidance.direct.phase,'completed');assert.equal(u.waypoints.length,19);assert.deepEqual(u.waypoints.at(-1).slice(0,3),[0,29000,6500]);
});

test('缺少观测的直接机动以无法执行回执拒绝，不留下待恢复段',async()=>{
  const world=create(),receipts=[],commands=new TacticalCommands({getWorld:()=>world,onReceipt:r=>receipts.push(r)});
  assert.equal((await commands.issue({action:'maneuver',unitIds:['blue-1'],maneuver:'notch_left'})).status,'unable');
  assert.equal(world.units[0].tacticalGuidance,undefined);assert.equal(receipts.at(-1).action,'guidance');
});
