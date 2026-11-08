import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {World} from '../sim/world.js';
import {commandContext,applyPlan,validatePlan,preparePilotPlan,commitPilotPlan} from '../sim/orders.js';
import {EMPTY_PARAMETERS,compileMilitaryInterpretation} from '../server/military-planner.mjs';
import {DUAL_FORMATIONS,formationOffset} from '../sim/formation.js';
import {captureCommandResult,inspectCommandResult} from '../sim/pilot-result.js';
import {pilotObservation} from '../sim/pilot-watch.js';
import {verifyReadback} from '../sim/radio-procedure.js';
const scenario=JSON.parse(await readFile(new URL('../data/scenarios/demo.json',import.meta.url))),profiles=JSON.parse(await readFile(new URL('../data/aircraft.json',import.meta.url)));
const world=(straight=true)=>{const w=new World(scenario,profiles);if(straight)w.units[0].headingTarget=0;return w;};
function parse(w,intent='join_formation',parameters={},unitIds=['blue-2'],selected='blue-1'){
 const interpretation={version:'1.0',status:'understood',summary:'双机编队指令',orders:[{id:'order-1',intent,unitIds,speechAct:'directive',timing:'now',condition:null,parameters:{...EMPTY_PARAMETERS,...parameters}}]};
 return {...compileMilitaryInterpretation(interpretation,commandContext(w,selected)),interpretation};
}
function issue(w,intent,params,ids,selected){const reply=parse(w,intent,params,ids,selected);assert.equal(reply.execution.status,'ready',reply.plan.summary);applyPlan(w,reply.plan,w.revision);return reply;}
function fly(w,seconds){let min=Infinity,peakG=0;for(let i=0;i<seconds*60;i++){w.step(1/60);min=Math.min(min,Math.hypot(...w.units[0].position.map((x,k)=>x-w.units[1].position[k])));peakG=Math.max(peakG,...w.units.map(u=>u.loadFactor));}return {min,peakG};}
function relative(w){const [l,u]=w.units,h=Math.atan2(l.velocity[0],l.velocity[1]),d=u.position.map((x,k)=>x-l.position[k]);return {along:d[0]*Math.sin(h)+d[1]*Math.cos(h),lateral:d[0]*Math.cos(h)-d[1]*Math.sin(h),alt:d[2]};}

test('六种双机队形沿真实气动轨迹集合并稳定保持；下令不瞬移且长机任务不变',()=>{
 for(const shape of DUAL_FORMATIONS){
  const w=world(),[lead,u]=w.units,positions=w.units.map(u=>[...u.position]),velocities=w.units.map(u=>[...u.velocity]);
  issue(w,'join_formation',{targetId:lead.id,formation:shape,rangeM:1200,side:'right'});
  assert.deepEqual(w.units.map(u=>u.position),positions);assert.deepEqual(w.units.map(u=>u.velocity),velocities);assert.equal(lead.headingTarget,0);
  const stats=fly(w,180),r=relative(w),expected=formationOffset(shape,'right',1200);
  assert.ok(w.units.every(u=>u.alive),shape);assert.equal(u.formation.status,'holding',shape);assert.ok(u.formation.slotErrorM<60,`${shape}:${u.formation.slotErrorM}`);
  assert.ok(Math.abs(r.along-expected[0])<60);assert.ok(Math.abs(r.lateral-expected[1])<60);assert.ok(Math.abs(r.alt)<30);assert.ok(stats.min>300,shape);
 }
});
test('持续跟随能随长机转弯、爬升和变速；真实编队关系不因指令版本改变丢失',()=>{
 const w=world(),[lead,u]=w.units;issue(w,'follow_unit',{targetId:lead.id,rangeM:1500});fly(w,180);
 assert.equal(u.formation.shape,'trail');assert.equal(u.formation.status,'holding');
 lead.headingTarget=Math.PI/2;lead.holdAltitude=7500;lead.targetSpeed=200;w.revision++;
 const stats=fly(w,360),r=relative(w);
 assert.ok(w.units.every(u=>u.alive));assert.ok(stats.min>250);assert.ok(u.formation.slotErrorM<160,u.formation.slotErrorM);assert.ok(Math.abs(r.alt)<80,r.alt);
 assert.ok(Math.abs(r.along+1500)<160,r.along);assert.ok(Math.abs(r.lateral)<120,r.lateral);assert.equal(u.formation.leaderId,lead.id);
});
test('长机保持默认盘旋时，僚机能集合并持续追随移动队位',()=>{
 const w=world(false),u=w.units[1];issue(w,'join_formation',{targetId:'blue-1',formation:'echelon',rangeM:1200});const stats=fly(w,360);
 assert.ok(w.units.every(u=>u.alive));assert.ok(stats.min>250);assert.ok(u.formation.slotErrorM<220,u.formation.slotErrorM);
});
test('横队由右换左先后撤再横移；单独改僚机队形保留原长机',()=>{
 const w=world(),[lead,u]=w.units;issue(w,'join_formation',{targetId:lead.id,formation:'line_abreast',rangeM:1200,side:'right'});fly(w,180);
 const before=[...u.position],reply=issue(w,'formation_change',{formation:'line_abreast',side:'left'},[u.id],u.id);
 assert.equal(reply.plan.tasks[0].targetId,lead.id);assert.deepEqual(u.position,before);assert.equal(u.formation.stage,'astern');
 const stats=fly(w,300),r=relative(w);assert.ok(stats.min>350,stats.min);assert.ok(r.lateral<-1100,r.lateral);assert.ok(Math.abs(r.along)<100,r.along);assert.equal(u.formation.status,'holding');
});
test('全体改队形以选中机为初始长机；已编队后切换选择不会交换长僚',()=>{
 const w=world();const first=issue(w,'formation_change',{formation:'wedge'},['blue-1','blue-2']);assert.equal(first.plan.tasks.length,1);assert.equal(first.plan.tasks[0].targetId,'blue-1');
 const second=issue(w,'formation_change',{formation:'trail'},['blue-1','blue-2'],'blue-2');assert.equal(second.plan.tasks[0].targetId,'blue-1');
});
test('禁止自我跟随、循环、超限间隔、地面/失效/敌方长机和超过两机的编队',()=>{
 const w=world();assert.equal(parse(w,'join_formation',{targetId:'blue-2'}).execution.status,'needs_clarification');
 assert.equal(parse(w,'join_formation',{targetId:'blue-1',rangeM:100}).execution.status,'needs_clarification');
 const valid=parse(w,'join_formation',{targetId:'blue-1'}).plan;w.units[0].alive=false;assert.throws(()=>validatePlan(valid,w.units));w.units[0].alive=true;
 w.units[0].surface={grounded:true};assert.throws(()=>validatePlan(valid,w.units));delete w.units[0].surface;
 w.units[0].team='red';assert.throws(()=>validatePlan(valid,w.units));delete w.units[0].team;
 applyPlan(w,valid,w.revision);const cycle=parse(w,'join_formation',{targetId:'blue-2'},['blue-1']);assert.equal(cycle.execution.status,'needs_clarification');
 w.units.push({...w.units[0],id:'blue-3'});assert.equal(parse(w,'formation_change',{formation:'wedge'},['blue-1','blue-2','blue-3']).execution.status,'needs_clarification');
});
test('人工给僚机独立命令解除编队；长机失效转待命；未实现战术不部分执行',()=>{
 const w=world(),u=w.units[1];issue(w,'join_formation',{targetId:'blue-1'});fly(w,2);
 const t={unitId:u.id,action:'set_flight',altitudeM:null,speedMps:190,headingDeg:null,eastM:null,northM:null,distanceM:null,append:false};
 applyPlan(w,{status:'accepted',summary:'独立飞行',tasks:[t]},w.revision);assert.equal(u.formation,null);assert.equal(u.targetSpeed,190);
 issue(w,'join_formation',{targetId:'blue-1'});w.units[0].alive=false;fly(w,1);assert.equal(u.formation,null);assert.match(u.navigationMessage,/长机失效/);assert.ok(u.alive);
 const v=world(),before=JSON.stringify(v),reply=parse(v,'cooperate',{mode:'thach_weave'},['blue-1','blue-2']);assert.equal(reply.execution.status,'capability_unavailable');applyPlan(v,reply.plan,v.revision);assert.equal(JSON.stringify(v),before);
});
test('编队队位或前方地形不安全时暂缓，不能绕过地形；解除障碍后恢复集合',()=>{
 const w=world();issue(w,'join_formation',{targetId:'blue-1',formation:'line_abreast'});
 w.terrain={heightAt:()=>0,collision:()=>null,checkPoint:()=>({valid:false,reason:'队位超出边界'})};fly(w,1);
 const u=w.units[1];assert.equal(u.formation.status,'blocked');assert.equal(u.formationGuidance,null);assert.match(u.navigationBlocked,/边界/);
 w.terrain=null;fly(w,1);assert.equal(u.navigationBlocked,null);assert.ok(u.formationGuidance);
});
test('编队装订与实际到位分别核验，回执对象与间隔必须一致；日常保持不唤醒模型',()=>{
 const w=world(),reply=issue(w,'join_formation',{targetId:'blue-1',formation:'trail',rangeM:1200}),task=reply.plan.tasks[0];
 let facts=inspectCommandResult(commandContext(w,'blue-2'),reply.plan,reply.interpretation,captureCommandResult(w));assert.equal(facts[0].expectedVerdict,'executing');
 assert.throws(()=>verifyReadback([task],[{...task,rangeM:500}]));assert.throws(()=>verifyReadback([task],[{...task,targetId:'blue-2'}]));
 w.recordMilitaryOrder('join-1',reply.interpretation,reply.execution);assert.equal(pilotObservation(w,w.units[1]),null);
 fly(w,180);facts=inspectCommandResult(commandContext(w,'blue-2'),reply.plan,reply.interpretation,captureCommandResult(w));assert.equal(facts[0].expectedVerdict,'reached');
});
test('编队准备可取消且旧版本不能装订；混合批次下层失败时撤回整个编队关系',()=>{
 const w=world(),reply=parse(w,'join_formation',{targetId:'blue-1'}),before=JSON.stringify(w),draft=preparePilotPlan(w,reply.plan,w.revision);
 assert.equal(JSON.stringify(w),before);w.revision++;assert.throws(()=>commitPilotPlan(draft),/新指令|作废/);assert.equal(w.units[1].formation,undefined);
 const v=world(),formation=parse(v,'join_formation',{targetId:'blue-1'}).plan.tasks[0];
 const nav={unitId:'blue-1',action:'fly_to',eastM:-8000,northM:8000,altitudeM:6500,speedMps:null,headingDeg:null,distanceM:null,append:false};
 const mixed={status:'accepted',summary:'长机导航与僚机集合',tasks:[formation,nav]},original=v.command,state=JSON.stringify(v);
 v.command=()=>{throw Error('下层航路拒绝');};assert.throws(()=>applyPlan(v,mixed,v.revision),/下层航路拒绝/);v.command=original;assert.equal(JSON.stringify(v),state);
});
test('直接放置人工航点及进入机场地面阶段会解除编队',()=>{
 const w=world(),u=w.units[1];issue(w,'join_formation',{targetId:'blue-1'});w.command(u.id,[-6200,10000,6500]);assert.equal(u.formation,null);assert.equal(u.waypoints.length,1);
 issue(w,'join_formation',{targetId:'blue-1'});u.surface={grounded:true,phase:'parked'};w.ai=.1;w.step(0);assert.equal(u.formation,null);
});
