import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {stepRadars} from '../sim/radar.js';
import {stepRwr,rwrContext,parseRwrContext,RWR_LEVELS} from '../sim/rwr.js';
import {stepRwrDefense,configureDefense,notePlayerDefenseOrder,defenseGuidance} from '../sim/rwr-defense.js';
import {spawnMissile,MISSILE_MODELS} from '../sim/missiles.js';
import {commandContext,applyPlan} from '../sim/orders.js';
import {validateContext} from '../server/qwen.mjs';
import {createRwrPilot,validateRwrDecision} from '../server/rwr-pilot.mjs';
import {RwrPilot} from '../game/rwr-pilot.js';
import {RwrRadio} from '../game/rwr-radio.js';
import {compileMilitaryInterpretation,EMPTY_PARAMETERS} from '../server/military-planner.mjs';
import {captureWorld,restoreWorld,encodeState,decodeState} from '../sim/save-state.js';

const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const scenario={units:[{id:'blue-1',callsign:'ALPHA 01',team:'blue',profile:'f16',position:[0,0,4500],heading:0,speed:250},
  {id:'red-1',callsign:'SECRET EMITTER',team:'red',profile:'f16',position:[0,20000,5000],heading:180,speed:250}]};
const create=()=>new World(scenario,profiles),own=w=>w.units[0],source=w=>w.units[1];
const sense=(w,seconds)=>{for(let i=0;i<Math.round(seconds*20);i++){w.time+=.05;stepRadars(w,.05);stepRwr(w,.05);stepRwrDefense(w);}};
const search=w=>w.radarCommand('red-1',{operation:'mode',mode:'pd',targetId:null});
const locked=()=>{const w=create();search(w);sense(w,3);w.radarCommand('red-1',{operation:'lock',mode:null,targetId:'blue-1'});sense(w,1);assert.equal(source(w).radar.phase,'locked');return w;};
const strongest=w=>own(w).rwr.contacts.slice().sort((a,b)=>RWR_LEVELS[b.level]-RWR_LEVELS[a.level])[0];
const planOrder=(intent,p={})=>({version:'1.0',status:'understood',summary:'告警处置',orders:[{id:'order-1',intent,unitIds:['blue-1'],speechAct:'directive',timing:'now',condition:null,parameters:{...EMPTY_PARAMETERS,...p}}]});
const microtask=()=>new Promise(r=>setImmediate(r));

test('RWR按辐射工作：关雷达无告警，搜索波束扫描才发现，持续搜索只报告不规避',()=>{
  const w=create();sense(w,1);assert.equal(own(w).rwr.contacts.length,0);search(w);sense(w,3);
  assert.equal(strongest(w).level,'search');assert.equal(own(w).rwrDefense.episode,null);sense(w,15);assert.equal(own(w).rwrDefense.active,null);
  assert.equal(own(w).rwr.events.filter(e=>e.type==='detected').length,1);
});

test('稳定跟踪升级立即自主规避，未知信号不冒充精确坐标或距离',()=>{
  const w=locked(),u=own(w),e=u.rwrDefense.episode;assert.equal(strongest(w).level,'track');assert.ok(e);assert.ok(u.rwrDefense.active);
  assert.equal(e.autoAt,e.firstSeen);assert.equal(u.rwrDefense.active.decidedBy,'local_rule');
  const c=rwrContext(u,w.time);assert.doesNotMatch(JSON.stringify(c),/SECRET|red-1|range|position|velocity|targetId/);assert.ok(c.contacts[0].bearingDeg%15===0);
});

test('接收受频率、距离、仰角和地形限制；F86没有凭空新增RWR',()=>{
  for(const change of [w=>source(w).position=[0,100000,5000],w=>source(w).radar.config.frequencyGHz=30,w=>{source(w).position=[0,100,20000];},w=>{w.terrain={heightAt:()=>6000};}]){
    const w=create();change(w);search(w);sense(w,3);assert.equal(own(w).rwr.contacts.length,0);
  }
  const w=new World({units:[{...scenario.units[0],profile:'f86'}]},profiles);assert.equal(own(w).rwr.available,false);
});

test('被动红外弹和未开机主动弹不产生RWR发射告警，主动开机才被接收',()=>{
  const w=create(),u=own(w),s=source(w),observation={position:u.position,velocity:u.velocity};
  spawnMissile(w,s,u,MISSILE_MODELS.get('us_aim9m_sidewinder'),observation);const m=spawnMissile(w,s,u,MISSILE_MODELS.get('us_aim_120b'),observation);
  sense(w,.2);assert.equal(u.rwr.contacts.length,0);m.active=true;sense(w,.2);assert.equal(strongest(w).level,'launch');assert.equal(strongest(w).signalType,'active_seeker');
});

test('半主动弹真实照射产生发射告警后立即规避，非所有跟踪都称为发射',()=>{
  const w=locked(),u=own(w);assert.equal(strongest(w).level,'track');
  spawnMissile(w,source(w),u,MISSILE_MODELS.get('us_aim7p_sparrow_fa_18'),{position:u.position,velocity:u.velocity});sense(w,.1);
  assert.equal(strongest(w).level,'launch');const e=u.rwrDefense.episode;assert.equal(e.level,'launch');assert.equal(e.autoAt,e.firstSeen);assert.ok(u.rwrDefense.active);
});

test('雷达因横切丢失回波，不等于RWR也收不到仍在照射的发射机',()=>{
  const w=locked();own(w).velocity=[250,0,0];sense(w,.3);assert.equal(source(w).radar.canIlluminate,false);assert.equal(strongest(w).level,'track');assert.ok(w.time-strongest(w).observedAt<.1);
});

test('新玩家指令取消本轮等待或现有规避，同一告警不会再次抢夺控制',()=>{
  for(const started of [false,true]){
    const w=locked(),u=own(w);if(started)sense(w,9);assert.ok(u.rwrDefense.active);
    notePlayerDefenseOrder(w,u);assert.equal(u.rwrDefense.active,null);assert.equal(u.rwrDefense.episode.playerOverride,true);sense(w,20);assert.equal(u.rwrDefense.active,null);
    spawnMissile(w,source(w),u,MISSILE_MODELS.get('us_aim7p_sparrow_fa_18'),{position:u.position,velocity:u.velocity});sense(w,.1);assert.equal(u.rwrDefense.episode.playerOverride,true);assert.equal(u.rwrDefense.episode.level,'launch');assert.equal(u.rwrDefense.active,null);
  }
});

test('未装订的新指令不延后既有防御时限，只报告与已装订策略仍优先',()=>{
  const w=locked(),u=own(w),deadline=u.rwrDefense.episode.autoAt;w.playerCommandPending=true;
  sense(w,7);assert.ok(u.rwrDefense.active);assert.equal(u.rwrDefense.episode.autoAt,deadline);
  sense(w,1.2);assert.ok(u.rwrDefense.active);w.playerCommandPending=false;
  configureDefense(w,u,{mode:'report_only'});sense(w,20);assert.equal(u.rwrDefense.active,null);
  configureDefense(w,u,{mode:'auto',lockDelaySec:2});sense(w,.05);assert.ok(u.rwrDefense.active);assert.equal(u.rwrDefense.lockDelaySec,0);
});

test('告警只报告/横切/背向命令能编译执行；玩家指定航向保留，不能虚构不支持的措施',()=>{
  const w=locked(),u=own(w),context=validateContext(commandContext(w,u.id));
  let compiled=compileMilitaryInterpretation(planOrder('defend',{mode:'report_only'}),context);assert.equal(compiled.plan.status,'accepted');applyPlan(w,compiled.plan,w.revision);assert.equal(u.rwrDefense.mode,'report_only');
  compiled=compileMilitaryInterpretation(planOrder('drag',{headingDeg:270,side:'left',mode:'execute'}),commandContext(w,u.id));applyPlan(w,compiled.plan,w.revision);assert.equal(u.rwrDefense.active.headingDeg,270);assert.equal(u.rwrDefense.active.manual,true);
  assert.equal(compileMilitaryInterpretation(planOrder('defend',{mode:'jammer'}),commandContext(w,u.id)).plan.status,'needs_clarification');
  assert.equal(compileMilitaryInterpretation(planOrder('countermeasures'),commandContext(w,u.id)).execution.status,'capability_unavailable');
});

test('规避通过真实飞控改变姿态，不瞬移或覆盖原航点；解除告警后停止并恢复原任务',()=>{
  const w=locked(),u=own(w);u.waypoints=[Object.assign([0,60000,4500],{number:1})];u.navigationKey=w.routeKey(u);u.navigationCheckAt=100000;
  sense(w,9);const route=JSON.stringify(u.waypoints),before=[...u.position],initial=Math.atan2(u.velocity[0],u.velocity[1])*180/Math.PI;
  assert.deepEqual(u.position,before);assert.ok(defenseGuidance(u));
  for(let i=0;i<300;i++)w.step(1/60);
  const actual=(Math.atan2(u.velocity[0],u.velocity[1])*180/Math.PI+360)%360;assert.ok(Math.abs(actual-initial)>2);assert.equal(JSON.stringify(u.waypoints),route);assert.ok(u.alive);assert.equal(u.flightState,'normal');
  source(w).radar.mode='off';for(let i=0;i<360;i++)w.step(1/60);assert.equal(u.rwrDefense.active,null);assert.ok(u.rwr.events.some(e=>e.type==='resume'));assert.equal(JSON.stringify(u.waypoints),route);
});

test('告警判断模型只收到本机遥测和方位观测，玩家接管/只报告不调用模型',async()=>{
  const w=locked(),u=own(w);let calls=0;
  const service=createRwrPilot({async completePilot(messages){calls++;assert.doesNotMatch(messages[1].content,/SECRET|red-1|20000|rangeM|missileWarning/);return {value:{maneuver:'notch',side:'auto',message:'建议按告警方位横切，等待玩家指令。'}};}});
  const input=()=>({requestId:'rwr-model-test',unitId:u.id,episodeKey:u.rwrDefense.episode.key,controlSequence:u.rwrDefense.controlSequence,context:commandContext(w,u.id)});
  const result=await service(input());assert.equal(result.modelInvoked,true);assert.equal(result.decision.maneuver,'notch');await service(input());assert.equal(calls,1);
  notePlayerDefenseOrder(w,u);assert.equal((await service(input())).modelInvoked,false);assert.equal(calls,1);
  const forged=rwrContext(u,w.time);forged.contacts[0].position=[1,2,3];assert.equal(parseRwrContext(forged,w.time).contacts[0].position,undefined);forged.contacts[0].bearingDeg=Infinity;assert.throws(()=>parseRwrContext(forged,w.time));
  assert.doesNotThrow(()=>validateRwrDecision({maneuver:'notch',side:'left',message:'立即横切'}));
});

test('迟到模型建议不能覆盖玩家新指令；健康无告警不请求推理',async()=>{
  let at=0,release,calls=0;const w=create(),u=own(w);const pilot=new RwrPilot({getWorld:()=>w,now:()=>at,fetchImpl:async(_url,options)=>{calls++;const data=JSON.parse(options.body);return new Promise(r=>{release=()=>r(Response.json({requestId:data.requestId,revision:data.context.revision,simTimeSec:data.context.simTimeSec,episodeKey:data.episodeKey,controlSequence:data.controlSequence,decision:{maneuver:'extend',side:'left',message:'拟背向脱离'}}));});}});
  pilot.tick();assert.equal(calls,0);const alarm=locked();Object.assign(w,alarm);at=2000;pilot.tick();assert.equal(calls,1);const target=own(w);notePlayerDefenseOrder(w,target);release();await microtask();await microtask();assert.equal(target.rwrDefense.modelReview,null);assert.equal(target.rwrDefense.active,null);
});

test('紧急RWR报告可以插入普通通联，不反复报告同一事件',async()=>{
  const w=locked(),sent=[];let busy=true;const radio=new RwrRadio({getWorld:()=>w,isBusy:()=>busy,radio:{async transmit(m){sent.push(m);}}});radio.pump();assert.equal(sent.length,1);assert.equal(sent[0].priority,100);busy=false;await microtask();assert.match(sent[0].text,/告警|跟踪|威胁/);radio.pump();await microtask();assert.equal(sent.length,1);
});

test('告警、等待时间和玩家接管状态随存档恢复，旧存档仍可加载',()=>{
  const w=locked(),u=own(w);configureDefense(w,u,{mode:'report_only',lockDelaySec:12,launchDelaySec:6});w.addRwrPracticeEmitter(u.id,'active');
  const restored=restoreWorld(decodeState(encodeState(captureWorld(w))),scenario,profiles);assert.equal(own(restored).rwrDefense.mode,'report_only');assert.equal(own(restored).rwrDefense.episode.playerOverride,true);assert.equal(restored.rwrPracticeEmitters.length,1);assert.deepEqual(own(restored).rwr.contacts,u.rwr.contacts);
  const old=captureWorld(create());for(const unit of old.units){delete unit.rwr;delete unit.rwrDefense;}delete old.rwrPracticeEmitters;delete old.rwrPracticeSequence;assert.equal(own(restoreWorld(old,scenario,profiles)).rwr.available,true);
});

test('同一辐射源再次发射重新报告，明确冲突飞行指令仍优先',()=>{
  const w=locked(),u=own(w),s=source(w),model=MISSILE_MODELS.get('us_aim7p_sparrow_fa_18');
  const first=spawnMissile(w,s,u,model,{position:u.position,velocity:u.velocity});sense(w,.1);const key=u.rwrDefense.episode.key;
  notePlayerDefenseOrder(w,u);first.alive=false;sense(w,.1);assert.equal(strongest(w).level,'track');
  spawnMissile(w,s,u,model,{position:u.position,velocity:u.velocity});sense(w,.1);assert.notEqual(u.rwrDefense.episode.key,key);assert.equal(u.rwrDefense.episode.playerOverride,true);
});

test('慢模型不阻塞默认自卫，返回后只能修订同一有效告警的建议',async()=>{
  const w=locked(),u=own(w);let release;
  const pilot=new RwrPilot({getWorld:()=>w,fetchImpl:async(_url,options)=>{const p=JSON.parse(options.body);return new Promise(r=>{release=()=>r(Response.json({requestId:p.requestId,revision:p.context.revision,simTimeSec:p.context.simTimeSec,episodeKey:p.episodeKey,controlSequence:p.controlSequence,decision:{maneuver:'extend',side:'auto',message:'等待告警结束后再规避'}}));});}});
  pilot.tick();sense(w,9);assert.ok(u.rwrDefense.active);assert.equal(u.rwrDefense.active.decidedBy,'local_rule');release();await microtask();await microtask();assert.equal(u.rwrDefense.active.decidedBy,'pilot_model');assert.doesNotMatch(u.rwr.events.at(-1).text,/等待告警结束/);assert.match(u.rwr.events.at(-1).text,/已装订.*正在执行/);pilot.stop();
});

test('规避中暂缓旧航路重规划，成功下达普通新飞行参数后立即交还控制',()=>{
  const w=locked(),u=own(w);sense(w,9);u.waypoints=[Object.assign([0,50000,4500],{number:1})];let replans=0;w.deferNavigation=()=>{replans++;};u.navigationKey=null;
  w.ensureNavigation(u);assert.equal(replans,0);
  applyPlan(w,{status:'accepted',summary:'保持新高度',tasks:[{unitId:u.id,action:'set_flight',altitudeM:5000,speedMps:null,headingDeg:null,eastM:null,northM:null,distanceM:null,append:false}]},w.revision);
  assert.equal(u.rwrDefense.active,null);assert.equal(u.rwrDefense.episode.playerOverride,true);assert.equal(u.targetAltitude,5000);sense(w,20);assert.equal(u.rwrDefense.active,null);
});

test('语音排队期间改成只报告，不播报旧的自主规避承诺',async()=>{
  const w=locked(),u=own(w),sent=[];configureDefense(w,u,{mode:'report_only'});
  const radio=new RwrRadio({getWorld:()=>w,isBusy:()=>false,radio:{async transmit(m){sent.push(m);}}});radio.pump();await microtask();assert.equal(sent.length,1);assert.match(sent[0].text,/只报告/);assert.doesNotMatch(sent[0].text,/8秒后/);
});

test('真实云建议不能虚构自动投放干扰弹',()=>{
 assert.throws(()=>validateRwrDecision({maneuver:'notch',side:'left',message:'建议保持左横切，同时等待防御系统自动投放干扰弹。'}),/未接入动作/);
});
test('尚未装订的新指令不撤回正在飞行的自卫，成功装订后才交还控制',()=>{
  const w=locked(),u=own(w);sense(w,9);const active=u.rwrDefense.active;
  w.playerCommandPending=true;sense(w,1);assert.equal(defenseGuidance(u),active);
  w.defenseCommand(u.id,{mode:'report_only',maneuver:null,side:'auto',headingDeg:null});assert.equal(defenseGuidance(u),null);assert.equal(u.rwrDefense.mode,'report_only');
});
