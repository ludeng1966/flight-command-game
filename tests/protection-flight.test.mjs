import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {World} from '../sim/world.js';
import {commandContext,applyPlan,preparePilotPlan,validatePlan} from '../sim/orders.js';
import {EMPTY_PARAMETERS,compileMilitaryInterpretation,groundCooperation,cooperationRoleHints,cooperationProtectionHints} from '../server/military-planner.mjs';
import {captureCommandResult,inspectCommandResult,validateResultReadbacks} from '../sim/pilot-result.js';
import {validateContext} from '../server/qwen.mjs';
import {PROTECTION_MODES} from '../sim/formation.js';
import {pilotObservation} from '../sim/pilot-watch.js';
import {verifyReadback} from '../sim/radio-procedure.js';
import {createLocalAiClient} from '../server/local-ai-client.mjs';
const scenario=JSON.parse(await readFile(new URL('../data/scenarios/demo.json',import.meta.url))),profiles=JSON.parse(await readFile(new URL('../data/aircraft.json',import.meta.url)));
const world=(straight=true)=>{const w=new World(scenario,profiles);if(straight)w.units[0].headingTarget=0;return w;};
const order=(intent,unitIds,parameters={})=>({intent,unitIds,speechAct:'directive',timing:'now',condition:null,parameters:{...EMPTY_PARAMETERS,...parameters}});
function parse(w,...orders){const interpretation={version:'1.0',status:'understood',summary:'长僚机协同',orders:orders.map((o,i)=>({...o,id:`order-${i+1}`}))};return {...compileMilitaryInterpretation(interpretation,commandContext(w,'blue-1')),interpretation};}
function issue(w,...orders){const reply=parse(w,...orders);assert.equal(reply.execution.status,'ready',reply.plan.summary);applyPlan(w,reply.plan,w.revision);return reply;}
function fly(w,seconds){let min=Infinity;for(let i=0;i<seconds*60;i++){w.step(1/60);min=Math.min(min,Math.hypot(...w.units[0].position.map((v,k)=>v-w.units[1].position[k])));}return min;}
const protect=(intent,parameters={})=>order(intent,['blue-2'],{targetId:'blue-1',...parameters});
const roles=(reverse=false)=>[order('assign_role',['blue-1'],{role:reverse?'wingman':'lead'}),order('assign_role',['blue-2'],{role:reverse?'lead':'wingman'})];

test('掩护和护航真实占据不同支援位，被保护机继续原任务，下令不瞬移',()=>{
 for(const intent of ['cover','escort']){
  const w=world(),[lead,u]=w.units,poses=w.units.map(u=>[...u.position]),velocity=w.units.map(u=>[...u.velocity]),mode=PROTECTION_MODES[intent];
  issue(w,protect(intent));assert.deepEqual(w.units.map(u=>u.position),poses);assert.deepEqual(w.units.map(u=>u.velocity),velocity);assert.equal(lead.headingTarget,0);
  const minimum=fly(w,240);assert.ok(w.units.every(u=>u.alive));assert.ok(minimum>250);assert.equal(u.formation.intent,intent);assert.equal(u.formation.shape,mode.shape);
  assert.equal(u.formation.status,'holding');assert.ok(u.formation.slotErrorM<60,u.formation.slotErrorM);assert.ok(Math.abs(u.position[2]-lead.position[2]-mode.heightM)<30);
  assert.deepEqual(lead.flightRole,{role:'lead',partnerId:u.id});assert.deepEqual(u.flightRole,{role:'wingman',partnerId:lead.id});assert.equal(u.protectionWatch.protectedId,lead.id);
 }
});
test('保护位随长机盘旋、爬升、变速；改变队形保留保护职责与高差',()=>{
 for(const intent of ['cover','escort']){
  const w=world(false),[lead,u]=w.units;issue(w,protect(intent));assert.ok(fly(w,240)>250);
  assert.ok(u.formation.slotErrorM<200,u.formation.slotErrorM);lead.holdAltitude=7300;lead.targetSpeed=200;w.revision++;assert.ok(fly(w,240)>250);
  assert.ok(u.formation.slotErrorM<200,u.formation.slotErrorM);assert.ok(Math.abs(u.position[2]-lead.position[2]-PROTECTION_MODES[intent].heightM)<70);
  issue(w,order('formation_change',['blue-1','blue-2'],{formation:'line_abreast',side:'left',rangeM:1200}));assert.equal(u.formation.intent,intent);
  assert.ok(fly(w,360)>250);assert.equal(u.formation.side,'left');assert.equal(u.formation.intent,intent);assert.ok(u.formation.slotErrorM<220,u.formation.slotErrorM);
 }
});
test('长僚分工直接绑定搭档并让僚机集合；显式掩护优先于默认集合',()=>{
 const w=world(),before=JSON.stringify(w),reply=parse(w,...roles(),protect('cover'));
 assert.equal(reply.execution.status,'ready');assert.deepEqual(reply.plan.tasks.map(t=>t.action),['assign_role','assign_role','cover']);preparePilotPlan(w,reply.plan,w.revision);assert.equal(JSON.stringify(w),before);
 applyPlan(w,reply.plan,w.revision);fly(w,240);assert.equal(w.units[1].formation.intent,'cover');assert.equal(w.units[1].formation.status,'holding');
 const v=world();issue(v,...roles());assert.equal(v.units[1].formation.leaderId,'blue-1');assert.equal(v.units[1].formation.intent,'join_formation');
 issue(v,order('assign_role',['blue-1'],{role:'lead'}));assert.equal(v.units[1].flightRole.role,'wingman');
});
test('长僚机能交换分工，原僚机成为独立长机；相互冲突的角色与保护对象整批拒绝',()=>{
 const w=world();issue(w,...roles(),protect('escort'));fly(w,30);
 issue(w,...roles(true),order('cover',['blue-1'],{targetId:'blue-2'}));assert.equal(w.units[1].formation,null);assert.equal(w.units[1].flightRole.role,'lead');
 assert.equal(w.units[0].formation.leaderId,'blue-2');assert.equal(w.units[0].formation.intent,'cover');assert.ok(fly(w,300)>250);assert.ok(w.units.every(u=>u.alive));
 const v=world(),before=JSON.stringify(v);const conflict=parse(v,...roles(),order('escort',['blue-1'],{targetId:'blue-2'}));assert.equal(conflict.execution.status,'needs_clarification');applyPlan(v,conflict.plan,v.revision);assert.equal(JSON.stringify(v),before);
 assert.equal(parse(v,order('assign_role',['blue-1'],{role:'lead'}),order('assign_role',['blue-2'],{role:'lead'})).execution.status,'needs_clarification');
});
test('无效或自我保护、未知运输机、敌机和地面对象不会启动；附带未实现战术不部分执行',()=>{
 const w=world();for(const p of [{targetId:'blue-2'},{targetId:null,targetRef:'运输机'},{targetId:'blue-1',rangeM:100}])assert.equal(parse(w,protect('escort',p)).execution.status,'needs_clarification');
 w.units[0].team='red';assert.equal(parse(w,protect('cover')).execution.status,'needs_clarification');delete w.units[0].team;
 w.units[0].surface={grounded:true};assert.equal(parse(w,protect('cover')).execution.status,'needs_clarification');delete w.units[0].surface;
 const before=JSON.stringify(w),mixed=parse(w,protect('cover'),order('banzai',['blue-1'],{targetRef:'敌机'}));assert.equal(mixed.execution.status,'capability_unavailable');applyPlan(w,mixed.plan,w.revision);assert.equal(JSON.stringify(w),before);
});
test('人工接管与对象失效结束保护；地形阻断暂停且不改长机航路',()=>{
 const w=world();issue(w,protect('cover'));fly(w,5);const leaderHeading=w.units[0].headingTarget;
 w.terrain={heightAt:()=>0,collision:()=>null,checkPoint:()=>({valid:false,reason:'掩护位越界'})};fly(w,1);assert.equal(w.units[1].formation.status,'blocked');assert.equal(w.units[0].headingTarget,leaderHeading);
 w.terrain=null;fly(w,1);assert.equal(w.units[1].navigationBlocked,null);w.units[0].alive=false;fly(w,1);assert.equal(w.units[1].formation,null);assert.equal(w.units[1].protectionWatch,null);
 const v=world();issue(v,protect('escort'));applyPlan(v,{status:'accepted',summary:'独立待命',tasks:[{unitId:'blue-2',action:'orbit',altitudeM:null,speedMps:null,headingDeg:null,eastM:null,northM:null,distanceM:null,append:false}]},v.revision);assert.equal(v.units[1].formation,null);assert.equal(v.units[1].protectionWatch,null);
});
test('只共享有来源的新鲜敌方威胁通报，不伪造敌机或开火；日常伴飞不唤醒模型',()=>{
 const w=world();const reply=issue(w,protect('cover'));w.recordMilitaryOrder('protect',reply.interpretation,reply.execution);fly(w,1);assert.equal(pilotObservation(w,w.units[1]),null);
 w.units[0].pilotContacts=[{id:'bandit-1',source:'scenario_observer',classification:'hostile',threat:true,observedAt:w.time}];fly(w,1);assert.equal(w.units[1].protectionWatch.contactId,'bandit-1');assert.equal(w.units.length,2);
 fly(w,6);assert.equal(w.units[1].protectionWatch.contactId,null);w.units[0].pilotContacts=[{id:'fake',classification:'hostile',threat:true,observedAt:w.time}];fly(w,1);assert.equal(w.units[1].protectionWatch.contactId,null);
});
test('结果检查验证角色、掩护与护航真实任务；装订不等于到位，也不能把护航报告成掩护',()=>{
 const w=world(),reply=issue(w,...roles(),protect('cover'));
 let context=validateContext(commandContext(w,'blue-1')),facts=inspectCommandResult(context,reply.plan,reply.interpretation,captureCommandResult(w));
 assert.equal(context.units[1].formation.intent,'cover');assert.equal(facts.find(f=>f.unitId==='blue-2').expectedVerdict,'executing');assert.match(facts.find(f=>f.unitId==='blue-2').requiredReadback,/僚机.*掩护/);
 fly(w,240);facts=inspectCommandResult(commandContext(w,'blue-1'),reply.plan,reply.interpretation,captureCommandResult(w));assert.ok(facts.every(f=>f.expectedVerdict==='reached'));
 const leadFact=facts.find(f=>f.unitId==='blue-1'),leadCheck={unitId:'blue-1',verdict:'reached',readbackText:leadFact.requiredReadback+'，ALPHA 01已达到目标'};
 assert.doesNotThrow(()=>validateResultReadbacks({checks:[leadCheck]},[leadFact]));assert.throws(()=>validateResultReadbacks({checks:[{...leadCheck,readbackText:leadCheck.readbackText+'，9999米'}]},[leadFact]),/数值/);
 const wrong=captureCommandResult(w);wrong.units[1].formation.intent='escort';assert.equal(inspectCommandResult(commandContext(w,'blue-1'),reply.plan,reply.interpretation,wrong).find(f=>f.unitId==='blue-2').expectedVerdict,'mismatch');
 const task=reply.plan.tasks[1];assert.throws(()=>verifyReadback([task],[{...task,role:'lead'}]));assert.throws(()=>validatePlan({...reply.plan,tasks:reply.plan.tasks.slice(1)},w.units));
});
test('模型输出按原话核对角色和保护方向，不用示例中的飞机替代未知对象或添加间隔',()=>{
 const w=world(),context=commandContext(w,'blue-1'),wrong=parse(w,...roles(),protect('cover')).interpretation;
 const text='Bravo为长机，Alpha为僚机；Alpha掩护Bravo。';
 assert.deepEqual(cooperationRoleHints(text,context),[{unitId:'blue-2',role:'lead'},{unitId:'blue-1',role:'wingman'}]);
 assert.deepEqual(cooperationProtectionHints(text,context),[{unitId:'blue-1',intent:'cover',targetId:'blue-2'}]);
 assert.equal(groundCooperation(wrong,context,text).status,'needs_clarification');
 assert.equal(groundCooperation(parse(w,protect('escort')).interpretation,context,'Bravo护航运输机').status,'needs_clarification');
 assert.equal(groundCooperation(parse(w,protect('cover',{side:'left',rangeM:2000})).interpretation,context,'Bravo掩护Alpha').status,'needs_clarification');
 const valid=parse(w,...roles(true),order('cover',['blue-1'],{targetId:'blue-2'})).interpretation;assert.equal(groundCooperation(valid,context,text).status,'understood');
});
test('2B对象或分工不一致只修正一次；仍不一致就澄清，不能装订错误方向',async()=>{
 const w=world(),context=commandContext(w,'blue-1'),instruction='Bravo为长机，Alpha为僚机；Alpha掩护Bravo。';
 const compact=orders=>({status:'understood',summary:'长僚机协同',orders:orders.map(o=>({intent:o.intent,unitIds:o.unitIds,parameters:o.parameters}))});
 const wrong=compact([...roles(),protect('cover')]),right=compact([...roles(true),order('cover',['blue-1'],{targetId:'blue-2'})]);
 for(const repairWorks of [true,false]){let calls=0;const client=createLocalAiClient({async complete(){return {value:structuredClone(++calls===1||!repairWorks?wrong:right),timing:{inferenceMs:1}};}},{transcribe(){}});
  const before=JSON.stringify(w),reply=await client.interpret({requestId:'role-repair',instruction,context});assert.equal(calls,2);assert.equal(JSON.stringify(w),before);
  assert.equal(reply.execution.status,repairWorks?'ready':'needs_clarification');
  if(repairWorks){assert.equal(reply.plan.tasks.find(t=>t.action==='cover').targetId,'blue-2');assert.equal(reply.ai.timing.semanticRepair,true);}else assert.equal(reply.plan.tasks.length,0);
 }
});
