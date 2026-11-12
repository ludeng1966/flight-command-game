import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {World} from '../sim/world.js';import {commandContext,applyPlan,preparePilotPlan,commitPilotPlan} from '../sim/orders.js';
import {EMPTY_PARAMETERS,compileMilitaryInterpretation,normalizeMilitaryInterpretation} from '../server/military-planner.mjs';
import {runCommandSession} from '../game/command-session.js';import {verifyReadback,createCommandExchange} from '../sim/radio-procedure.js';
import {verifyCommanderAirportInstruction} from '../sim/commander-message.js';import {captureCommandResult,inspectCommandResult} from '../sim/pilot-result.js';
import {englishResultReadback} from '../sim/result-language.js';
const scenario=JSON.parse(fs.readFileSync(new URL('../data/scenarios/demo.json',import.meta.url))),profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const make=()=>{const w=new World(scenario,profiles,null,{spawnMode:'stands'});w.airportOps.traffic.state.playerDirected=true;w.airportOps.traffic.state.guidanceMode='player';return w;};
const run=(w,seconds,until=()=>false)=>{for(let i=0;i<seconds*60&&!until();i++)w.step(1/60);};
function reply(w,intent,parameters={},unitIds=['blue-1']){const interpretation={version:'1.0',status:'understood',summary:'按玩家指示安排机场管制',orders:[{id:'order-1',intent,unitIds,speechAct:'directive',timing:'now',condition:null,parameters:{...EMPTY_PARAMETERS,...parameters}}]};return {requestId:'atc-test',interpretation,...compileMilitaryInterpretation(interpretation,commandContext(w,unitIds[0]))};}
function apply(w,intent,p,ids){const r=reply(w,intent,p,ids);assert.equal(r.execution.status,'ready',r.plan.summary);applyPlan(w,r.plan,w.revision);return r;}
function departures(w){for(const u of w.units)w.airportCommand(u.id,{intent:'takeoff',runway:'09L'});}

test('排序支持第一、第二及前后关系，不把前后关系变成条件任务，不要求内部优先级',()=>{
 const w=make();departures(w);apply(w,'atc_sequence',{quantity:1},['blue-2']);assert.equal(w.airportOps.traffic.state.requests.find(q=>q.unitId==='blue-2').sequence,1);
 const r=reply(w,'atc_sequence',{mode:'after',targetRef:'Bravo'},['blue-1']);r.interpretation.orders[0].timing='after_previous';const normalized=normalizeMilitaryInterpretation(r.interpretation,{instruction:'先Bravo，再Alpha'});assert.equal(normalized.orders[0].timing,'now');applyPlan(w,compileMilitaryInterpretation(normalized,commandContext(w,'blue-1')).plan,w.revision);assert.equal(w.airportOps.traffic.state.requests.find(q=>q.unitId==='blue-1').sequence,2);
 w.declareAirportEmergency('blue-1','medical');run(w,.5);assert.throws(()=>apply(w,'atc_sequence',{quantity:1},['blue-2']),/紧急/);
});
test('改跑道复用实际执行器，保留减推力方案、质量和原任务；准备阶段无副作用',async()=>{
 const {departureOptions}=await import('../sim/departure-plan.js');const w=make(),u=w.units[0],order={intent:'takeoff',runway:'09L',mode:'reduced_thrust',altitudeM:null};w.airportOps.apply(u,order,w,departureOptions(w,u,order)[0]);const power=structuredClone(u.departurePowerPlan),position=[...u.position],r=reply(w,'change_runway',{runway:'09R'}),before=JSON.stringify(w),draft=preparePilotPlan(w,r.plan,w.revision);assert.equal(JSON.stringify(w),before);commitPilotPlan(draft);assert.equal(u.surface.runway,'09R');assert(u.surface.depart);assert.equal(u.departurePowerPlan.throttle,power.throttle);assert.equal(u.departurePowerPlan.afterburner,power.afterburner);assert.equal(u.departurePowerPlan.mode,'reduced_thrust');assert.deepEqual(u.position,position);
});
test('阶段许可沿用任务，经实际播报复诵后滑行、对正、起飞；原位等待及继续不重建任务',()=>{
 const w=make(),u=w.units[0];w.airportCommand(u.id,{intent:'takeoff',runway:'09L'});const request=u.surface.atcRequestId;apply(w,'atc_clearance',{mode:'taxi'});run(w,8);assert(u.speed>0);apply(w,'atc_hold',{durationSec:null});run(w,8);assert.equal(u.speed,0);assert(u.surface.depart);assert.equal(u.surface.atcRequestId,request);apply(w,'atc_resume',{});run(w,550,()=>u.surface.phase==='holding');assert.equal(u.surface.phase,'holding');apply(w,'atc_clearance',{mode:'line_up'});run(w,100,()=>u.surface.phase==='lined_up');assert.equal(u.surface.phase,'lined_up');apply(w,'atc_clearance',{mode:'takeoff'});assert(u.surface.grounded);run(w,100,()=>!u.surface.grounded);assert(!u.surface.grounded);assert.equal(u.surface.atcRequestId,request);
});
test('宽松取消许可后不自动重发，重新签发才允许起飞；已滑跑须用中断起飞',()=>{
 const w=make(),u=w.units[0];w.executionMode='relaxed';w.airportOps.traffic.state.guidanceMode='assisted';w.airportCommand(u.id,{intent:'takeoff',runway:'09L'});run(w,550,()=>u.surface.phase==='lined_up');apply(w,'atc_cancel_clearance',{mode:'takeoff'});run(w,20);assert.equal(u.surface.phase,'lined_up');assert(!w.airportOps.traffic.current(u,'takeoff'));apply(w,'atc_clearance',{mode:'takeoff'});run(w,6);assert.equal(u.surface.phase,'takeoff_roll');assert.throws(()=>apply(w,'atc_cancel_clearance',{mode:'takeoff'}),/滑跑/);
});
test('跑道、阶段或通信不允许时拒绝整批，不修改排序、许可和完整历史',()=>{
 const w=make();departures(w);const r=reply(w,'atc_sequence',{quantity:1},['blue-2']),second=reply(w,'atc_clearance',{mode:'taxi'}).plan.tasks[0];r.plan.tasks.push(second);const draft=preparePilotPlan(w,r.plan,w.revision);for(let i=0;i<100;i++)w.airportOps.log(w.units[0],'已有通联记录'+i,w.time);w.airportOps.airport.closed.push('RW0');const before=JSON.stringify({units:w.units,atc:w.airportOps.traffic.state,events:w.airportOps.airport.events});assert.throws(()=>commitPilotPlan(draft),/关闭/);assert.equal(JSON.stringify({units:w.units,atc:w.airportOps.traffic.state,events:w.airportOps.airport.events}),before);
 assert.throws(()=>apply(w,'atc_clearance',{mode:'takeoff',runway:'09R'}),/不一致/);
});
test('语音会话以机场席位播报，飞行员接令后提交；中英文含排序和许可的完整信息',async()=>{
 const w=make();departures(w);const r=reply(w,'atc_sequence',{mode:'before',targetId:'blue-1'},['blue-2']),heard=[];let pilotHeard;
 const session=await runCommandSession({world:w,reply:r,expectedRevision:w.revision,enforceAuthority:true,style:'nato',pause:async()=>{},radio:{phase(){},async transmit(m){heard.push(m);return {id:'atc-spoken',speechText:m.text,speechLanguage:m.language};}},planPilotCommand:async({commanderMessage})=>{pilotHeard=commanderMessage;return r;}});
 assert(session.committed);assert.equal(heard[0].speaker,'controller');assert.match(pilotHeard.text,/SEQUENCE BEFORE ALPHA 01/);assert.match(heard[0].texts.zh,/排序在.*之前/);assert(!/[\u3400-\u9fff]/.test(heard[0].texts.en));assert.equal(w.airportOps.traffic.state.requests.find(q=>q.unitId==='blue-2').sequence,1);
 const fact=inspectCommandResult(commandContext(w,'blue-2'),r.plan,r.interpretation,captureCommandResult(w))[0];assert.equal(fact.expectedVerdict,'reported');assert.match(englishResultReadback(fact,r.plan,commandContext(w,'blue-2')),/SEQUENCE BEFORE/);
});
test('飞行员不能把阶段许可改成整段离场，也不能偷换许可阶段或复诵跑道',()=>{
 const w=make(),r=reply(w,'atc_clearance',{mode:'takeoff',runway:'09L'});assert.throws(()=>verifyCommanderAirportInstruction(reply(w,'takeoff',{runway:'09L'}).interpretation,{text:'ISSUE TAKEOFF CLEARANCE, RUNWAY 09L'}),/不得重建/);assert.throws(()=>verifyCommanderAirportInstruction(reply(w,'atc_clearance',{mode:'land'}).interpretation,{text:'签发起飞许可，跑道09L'}),/阶段/);
 const exchange=createCommandExchange(r.plan,w.units),copy=structuredClone(exchange.pilots[0].tasks);copy[0].atcOrder.runway='09R';assert.throws(()=>verifyReadback(r.plan.tasks,copy),/复诵/);
});
test('语音指定先后顺序实际影响双机滑行和起飞顺序，迟到的危险调序被拒绝',()=>{
 const w=make();w.executionMode='relaxed';w.airportOps.traffic.state.guidanceMode='assisted';departures(w);apply(w,'atc_sequence',{quantity:1},['blue-2']);run(w,1200,()=>w.units.some(u=>!u.alive)||w.units.every(u=>!u.surface.grounded));assert(w.units.every(u=>u.alive&&!u.surface.grounded));const cleared=w.airportOps.traffic.state.clearances.filter(c=>c.type==='takeoff'&&c.acknowledgedAt!==null);assert.deepEqual(cleared.map(c=>c.unitId),['blue-2','blue-1']);
});
test('滑行中改跑道先沿原路至路口，不从滑行道中段斜穿；原位等待阻止已许可起飞',()=>{
 const w=make(),u=w.units[0];w.airportCommand(u.id,{intent:'takeoff',runway:'09L'});apply(w,'atc_clearance',{mode:'taxi'});run(w,20);assert(u.speed>0);const p=[...u.position];apply(w,'change_runway',{runway:'09R'});assert.equal(u.surface.runway,'09L');assert.equal(u.surface.pendingRunwayChange.runway,'09R');assert.deepEqual(u.position,p);run(w,200,()=>u.surface.runway==='09R');assert.equal(u.surface.runway,'09R');assert(Math.hypot(u.position[0]-w.airportOps.airport.nodes[u.surface.node][0],u.position[1]-w.airportOps.airport.nodes[u.surface.node][1])<4);
 const v=make(),jet=v.units[0];v.airportCommand(jet.id,{intent:'takeoff',runway:'09L'});apply(v,'atc_clearance',{mode:'taxi'});run(v,550,()=>jet.surface.phase==='holding');apply(v,'atc_clearance',{mode:'line_up'});run(v,100,()=>jet.surface.phase==='lined_up');apply(v,'atc_clearance',{mode:'takeoff'});apply(v,'atc_hold',{});run(v,5);assert.equal(jet.surface.phase,'lined_up');assert.equal(jet.speed,0);
});
test('取消进近实际中止下滑并保持复飞等待，可由语音重新批准进近',()=>{
 const w=new World(scenario,profiles),u=w.units[0];w.airportOps.traffic.state.playerDirected=true;w.airportOps.traffic.state.guidanceMode='player';w.airportCommand(u.id,{intent:'approach',runway:'09L',mode:'ils'});apply(w,'atc_cancel_clearance',{mode:'approach'});assert.equal(u.surface.phase,'missed');assert(u.surface.clearanceInhibits.approach);apply(w,'atc_clearance',{mode:'approach'});assert.equal(u.surface.phase,'approach');assert(u.surface.playerAuthorizations.approach);assert.equal(u.surface.landingRequested,false);
});
