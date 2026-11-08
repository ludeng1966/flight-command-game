import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {World} from '../sim/world.js';import {applyPlan,commandContext} from '../sim/orders.js';
import {installAttackTask,applyAttackDecision,attackTaskEvent,attackObservation,monitorAttackTasks,attackTaskContext} from '../sim/attack-task.js';
import {stepRadars} from '../sim/radar.js';import {stepWeapons,applyWeaponOrder} from '../sim/weapons.js';
import {createAttackPilot} from '../server/attack-pilot.mjs';import {AttackPilot} from '../game/attack-pilot.js';
import {compileMilitaryInterpretation,EMPTY_PARAMETERS} from '../server/military-planner.mjs';
import {captureCommandResult,inspectCommandResult} from '../sim/pilot-result.js';
import {captureWorld,restoreWorld,encodeState,decodeState} from '../sim/save-state.js';import {PilotAssistant} from '../server/pilot-assistant.mjs';
import {createQwenClient} from '../server/qwen.mjs';
const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url))),scenario={units:[{id:'blue-1',callsign:'ALPHA 01',profile:'f16',position:[0,0,6500],heading:0,speed:180,color:'#fff'}]};
const create=()=>new World(scenario,profiles),own=w=>w.units[0],modelId='us_aim_120b';
const order=(extra={})=>({targetId:null,targetRef:'前方目标',weaponRef:null,shotLimit:2,altitudeM:null,speedMps:null,headingDeg:null,...extra});
const decision=(operation,extra={})=>({operation,mode:null,modelId:null,targetId:null,quantity:null,headingDeg:null,altitudeM:null,speedMps:null,message:'按实际状态执行本次操作',...extra});
const act=(w,d,count=own(w).attackTask.decisionCount)=>applyAttackDecision(w,own(w),d,own(w).attackTask.id,count);
const sense=(w,s)=>{for(let i=0;i<Math.round(s*20);i++){w.time+=.05;stepRadars(w,.05);stepWeapons(w,.05);monitorAttackTasks(w);}};
function prepared(){const w=create(),u=own(w);w.addRadarPracticeTarget(u.id);installAttackTask(w,u,order());act(w,decision('radar_mode',{mode:'pd'}));sense(w,1.1);act(w,decision('radar_lock',{targetId:'tgt-1'}));sense(w,1);act(w,decision('select',{targetId:'tgt-1',modelId}));sense(w,.4);return w;}
const body=w=>({requestId:'attack-test',unitId:'blue-1',taskId:own(w).attackTask?.id??'none',context:commandContext(w,'blue-1'),observation:attackObservation(w,own(w))});

test('只接收攻击任务不立即开火；模型逐步搜索、锁定、选弹后才发射真实实体',()=>{
 const w=prepared(),u=own(w);assert.equal(u.attackTask.selectedModelId,modelId);assert.equal(w.missiles.length,0);assert.equal(u.weapons.ready,true);const before=u.weapons.inventory[modelId];
 act(w,decision('launch',{targetId:'tgt-1',modelId,quantity:1}));assert.equal(w.missiles.length,1);assert.equal(u.weapons.inventory[modelId],before-1);assert.equal(w.missiles[0].ageSec,0);assert.equal(w.missiles[0].alive,true);assert.equal(u.attackTask.status,'supporting');assert.equal(u.attackTask.firedMissileIds[0],w.missiles[0].id);
});
test('默认导弹不能代替模型明确选弹，未就绪或掉锁时不扣弹',()=>{
 const w=create(),u=own(w);w.addRadarPracticeTarget(u.id);installAttackTask(w,u,order());act(w,decision('radar_mode',{mode:'pd'}));sense(w,1.1);act(w,decision('radar_lock',{targetId:'tgt-1'}));sense(w,1.2);assert.equal(u.weapons.ready,true);
 assert.throws(()=>act(w,decision('launch',{targetId:'tgt-1',modelId,quantity:1})),/明确选择/);act(w,decision('select',{targetId:'tgt-1',modelId}));sense(w,.1);u.radar.canIlluminate=false;const before=u.weapons.inventory[modelId];
 assert.throws(()=>act(w,decision('launch',{targetId:'tgt-1',modelId,quantity:1})),/雷达稳定锁定/);assert.equal(u.weapons.inventory[modelId],before);assert.equal(w.missiles.length,0);
});
test('不允许未知真值、友机、换目标、超额发射或重复应用旧决定',()=>{
 const w=prepared(),u=own(w),before=u.weapons.inventory[modelId];assert.throws(()=>act(w,decision('select',{targetId:'hidden',modelId})),/本机刚刚/);
 u.radar.contacts[0].classification='friendly';assert.throws(()=>act(w,decision('launch',{targetId:'tgt-1',modelId,quantity:1})),/友机/);u.radar.contacts[0].classification='unknown';
 assert.throws(()=>act(w,decision('launch',{targetId:'tgt-1',modelId,quantity:3})),/额度/);const count=u.attackTask.decisionCount,d=decision('launch',{targetId:'tgt-1',modelId,quantity:1});act(w,d,count);assert.throws(()=>act(w,d,count),/阶段已变化/);assert.equal(u.weapons.inventory[modelId],before-1);
 sense(w,.1);assert.throws(()=>act(w,d),/已有本任务导弹/);assert.equal(w.missiles.length,1);
});
test('武器保持中止任务，后续模型结果无法再次发射；搜索任务本身没有攻击授权',()=>{
 const w=prepared(),u=own(w);applyWeaponOrder(w,u,{operation:'hold',modelId:null,targetId:null,quantity:null});assert.equal(u.attackTask.active,false);assert.equal(attackTaskEvent(u,w.time),null);assert.throws(()=>act(w,decision('launch',{targetId:'tgt-1',modelId,quantity:1})),/任务或阶段/);assert.equal(w.missiles.length,0);
});
test('发射不能报告命中；只有本任务真实碰撞结果才完成',()=>{
 const w=prepared(),u=own(w);assert.throws(()=>act(w,decision('wait',{message:'目标已摧毁'})),/碰撞结果/);act(w,decision('launch',{targetId:'tgt-1',modelId,quantity:1}));monitorAttackTasks(w);assert.equal(u.attackTask.active,true);
 const m=w.missiles[0];m.alive=false;m.phase='expired';monitorAttackTasks(w);assert.equal(u.attackTask.active,true);assert.ok(u.attackTask.events.some(e=>e.type==='miss'));
 m.phase='hit';m.hitTargetId='tgt-1';monitorAttackTasks(w);assert.equal(u.attackTask.status,'completed');assert.equal(u.attackTask.active,false);assert.ok(u.attackTask.events.some(e=>e.type==='hit'));
});
test('攻击任务口令接收和结果复述不要求玩家提供模式、锁定或导弹',()=>{
 const w=create(),raw={version:'1.0',status:'understood',summary:'攻击前方目标',orders:[{id:'order-1',intent:'attack',unitIds:['blue-1'],speechAct:'directive',timing:'now',condition:null,parameters:{...EMPTY_PARAMETERS,targetRef:'前方目标'}}]};
 const compiled=compileMilitaryInterpretation(raw,commandContext(w,'blue-1'));assert.equal(compiled.execution.status,'ready');assert.equal(compiled.plan.tasks[0].action,'attack_task');applyPlan(w,compiled.plan,w.revision);assert.equal(own(w).radar.mode,'off');
 const facts=inspectCommandResult(commandContext(w,'blue-1'),compiled.plan,raw,captureCommandResult(w));assert.equal(facts[0].expectedVerdict,'executing');assert.ok(facts[0].modelFacts.installation.every(x=>x.matched));
});
test('攻击模型只接收本机观测，不看到其他飞机位置；同一状态缓存',async()=>{
 const w=create();w.units.push({...own(w),id:'blue-2',callsign:'SECRET BRAVO',position:[123456,654321,7000]});installAttackTask(w,own(w),order());let calls=0;
 const api=createAttackPilot({async completePilot(messages){calls++;assert.doesNotMatch(messages[1].content,/SECRET|123456|654321/);return {value:decision('radar_mode',{mode:'pd'})};}});
 assert.equal((await api(body(w))).decision.mode,'pd');assert.equal((await api(body(w))).modelInvoked,false);assert.equal(calls,1);
});
test('暂停/换任务后迟到的攻击判断作废',async()=>{
 const w=create();installAttackTask(w,own(w),order());let finish;const pending=new Promise(r=>finish=r),pilot=new AttackPilot({getWorld:()=>w,now:()=>1000,fetchImpl:async(_url,o)=>{const input=JSON.parse(o.body);await pending;return {ok:true,json:async()=>({requestId:input.requestId,taskId:input.taskId,revision:input.context.revision,simTimeSec:input.context.simTimeSec,decisionCount:0,decision:decision('radar_mode',{mode:'pd'})})};}});
 pilot.tick();installAttackTask(w,own(w),order({targetRef:'另一目标'}));finish();await new Promise(r=>setTimeout(r,0));assert.equal(own(w).radar.mode,'off');pilot.stop();
});
test('攻击任务与弹量、在空导弹随进度恢复，模型等待重新判断',()=>{
 const w=prepared();act(w,decision('launch',{targetId:'tgt-1',modelId,quantity:1}));own(w).attackTask.pending=true;const next=restoreWorld(decodeState(encodeState(captureWorld(w))),scenario,profiles);assert.equal(own(next).attackTask.pending,false);assert.equal(own(next).attackTask.firedMissileIds.length,1);assert.equal(next.missiles.length,1);
});
test('接令模型不因缺目标编号拒绝前方攻击任务，允许自修正后先搜索',async()=>{
 const w=create();let calls=0;const api=new PilotAssistant('.',{runtimeFactory:()=>({start:async()=>{},stop:async()=>{},health:()=>({status:'ready',memory:{}}),complete:async()=>{calls++;return {value:calls===1?{version:'1.0',status:'needs_clarification',summary:'请提供目标编号',orders:[]}:{version:'1.0',status:'understood',summary:'攻击前方目标',orders:[{id:'order-1',intent:'attack',unitIds:['blue-1'],speechAct:'directive',timing:'now',condition:null,parameters:{...EMPTY_PARAMETERS,targetRef:'前方目标'}}]},timing:{}};}})});
 const reply=await api.planCommand({requestId:'accept-attack',commanderMessage:{id:'attack-command',speaker:'commander',text:'Alpha，攻击前方目标。',language:'zh-CN'},context:commandContext(w,'blue-1')});assert.equal(calls,2);assert.equal(reply.plan.status,'accepted');assert.equal(reply.plan.tasks[0].action,'attack_task');
});

test('指挥员解释阶段也修复索要目标编号，并保留飞行参数自主判断',async()=>{
 const w=create();let calls=0;
 const client=createQwenClient({apiKey:'test-only',baseUrl:'http://test',commandModel:'flash',timeoutMs:5000},async(_url,options)=>{
  calls++;if(calls===2)assert.match(JSON.parse(options.body).messages.at(-1).content,/允许先搜索/);
  const value=calls===1?{version:'1.0',status:'needs_clarification',summary:'请提供已经锁定的目标编号',orders:[]}:{version:'1.0',status:'understood',summary:'攻击前方目标',orders:[{id:'order-1',intent:'attack',unitIds:['blue-1'],speechAct:'directive',timing:'now',condition:null,parameters:{...EMPTY_PARAMETERS,targetRef:'前方目标'}}]};
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]});
 });
 const reply=await client.interpret({requestId:'attack-repair',instruction:'Alpha，攻击前方目标',context:commandContext(w,'blue-1')});assert.equal(calls,2);assert.equal(reply.plan.tasks[0].action,'attack_task');assert.equal(reply.plan.tasks[0].attackOrder.headingDeg,null);
});

test('未发现目标时模型可规划搜索航段，通过正常飞控执行而不改变即时位置',()=>{
 const w=create(),u=own(w),position=[...u.position];installAttackTask(w,u,order());act(w,decision('maneuver',{headingDeg:0,altitudeM:6500,speedMps:200}));
 assert.deepEqual(u.position,position);assert.ok(u.waypoints.length>0);assert.equal(u.headingRoute.headingDeg,0);assert.equal(u.attackTask.active,true);assert.equal(u.attackTask.engagedTargetId,null);assert.equal(u.attackTask.searchLegEstablished,true);
 w.time+=1;assert.equal(attackTaskEvent(u,w.time).reason,'search_sensors');assert.equal(attackTaskEvent(commandContext(w,u.id).units[0],w.time).reason,'search_sensors');assert.equal(attackTaskContext(u).lastOperation,'maneuver');
 installAttackTask(w,u,order({altitudeM:6500}));assert.throws(()=>act(w,decision('maneuver',{headingDeg:0,altitudeM:7000,speedMps:200})),/明确的飞行约束/);
});

test('截获驻留期间不重复请求模型，锁定完成后才判断下一步',()=>{
 const w=create(),u=own(w);w.addRadarPracticeTarget(u.id);installAttackTask(w,u,order());act(w,decision('radar_mode',{mode:'pd'}));sense(w,1.1);act(w,decision('radar_lock',{targetId:'tgt-1'}));sense(w,.6);assert.equal(u.radar.phase,'acquiring');assert.equal(attackTaskEvent(u,w.time),null);assert.equal(attackTaskEvent(commandContext(w,u.id).units[0],w.time),null);
 sense(w,.4);assert.equal(u.radar.phase,'locked');assert.ok(attackTaskEvent(u,w.time));const acquired=u.radar.acquiredSec;act(w,decision('radar_lock',{targetId:'tgt-1'}));assert.equal(u.radar.phase,'locked');assert.equal(u.radar.acquiredSec,acquired);
});

test('新的飞行任务取消自主攻击，旧发射判断不得执行',()=>{
 const w=prepared(),u=own(w),id=u.attackTask.id,count=u.attackTask.decisionCount;
 applyPlan(w,{status:'accepted',summary:'转向返航',tasks:[{unitId:u.id,action:'fly_heading',headingDeg:0,altitudeM:6500,speedMps:180,eastM:null,northM:null,distanceM:null,append:false}]},w.revision);
 assert.equal(u.attackTask.status,'cancelled');assert.throws(()=>applyAttackDecision(w,u,decision('launch',{targetId:'tgt-1',modelId,quantity:1}),id,count),/任务或阶段/);assert.equal(w.missiles.length,0);
});
