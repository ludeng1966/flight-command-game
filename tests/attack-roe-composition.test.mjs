import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {applyPlan,commandContext} from '../sim/orders.js';
import {applyWeaponOrder,stepWeapons,engagementPermission,weaponTaskFor} from '../sim/weapons.js';
import {installAttackTask,applyAttackDecision,attackTaskEvent} from '../sim/attack-task.js';
import {stepRadars} from '../sim/radar.js';
import {commandReceipt} from '../sim/command-receipt.js';
import {captureCommandResult,inspectCommandResult} from '../sim/pilot-result.js';
import {compileMilitaryInterpretation,EMPTY_PARAMETERS} from '../server/military-planner.mjs';
const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const make=()=>new World({units:[{id:'blue-1',callsign:'ALPHA',profile:'f16',position:[0,0,6500],heading:0,speed:250}]},profiles);
const attackOrder=(extra={})=>({targetId:null,targetRef:'敌机',weaponRef:null,shotLimit:2,altitudeM:null,speedMps:null,headingDeg:null,...extra});
const attack=extra=>({unitId:'blue-1',action:'attack_task',attackOrder:attackOrder(extra)});
const sensor=(extra={})=>({unitId:'blue-1',action:'sensor_task',sensorTask:{goal:'search',targetId:null,targetRef:null,...extra}});
const weapon=operation=>({unitId:'blue-1',action:'weapon',weaponOrder:{operation,modelId:null,targetId:null,quantity:null}});
const plan=tasks=>({status:'accepted',summary:'搜索攻击并设置交战规则',tasks});
const receipt=(w,p)=>commandReceipt({requestId:'test',context:commandContext(w,'blue-1'),plan:p,result:captureCommandResult(w,{clockRunning:true})});
const military=orders=>({version:'1.0',status:'understood',summary:'搜索并攻击敌机，自主选择目标并开火',orders:orders.map(([intent,parameters={}],i)=>({id:'order-'+i,intent,unitIds:['blue-1'],speechAct:'directive',timing:'now',condition:null,parameters:{...EMPTY_PARAMETERS,...parameters}}))});

test('真实云模型Alpha与Bravo冗余mode=free输出可编译并持续执行攻击',()=>{
  const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/cloud-attack-roe.json',import.meta.url)));
  const scenario=JSON.parse(fs.readFileSync(new URL('../data/scenarios/duel.json',import.meta.url)));
  for(const sample of fixture.cases){
    const w=new World(scenario,profiles),before=structuredClone(sample.interpretation),compiled=compileMilitaryInterpretation(sample.interpretation,commandContext(w,sample.unitId));
    assert.equal(compiled.plan.status,'accepted',compiled.plan.summary);applyPlan(w,compiled.plan,w.revision);
    const unit=w.units.find(u=>u.id===sample.unitId);assert.equal(unit.attackTask.active,true);assert.equal(unit.weapons.roe,'free');assert.equal(unit.attackTask.targetRef,before.orders.find(o=>o.intent==='attack').parameters.targetRef);
    assert.equal(receipt(w,compiled.plan).checks[0].verdict,'executing');assert.deepEqual(sample.interpretation,before);assert.equal(w.missiles.length,0);
  }
});

test('只接受ROE意图对应的同义mode，不能吞掉冲突mode和额外要求',()=>{
  const context=commandContext(make(),'blue-1');
  for(const [intent,mode] of [['weapons_free','free'],['weapons_tight','tight'],['weapons_hold','hold'],['cease_fire','hold']]){
    const order=military([[intent,{mode}]]).orders[0],before=structuredClone(order);
    assert.equal(weaponTaskFor(order,context)[0].weaponOrder.operation,mode);assert.deepEqual(order,before);
    assert.throws(()=>weaponTaskFor({...order,parameters:{...order.parameters,mode:mode==='free'?'hold':'free'}},context),/mode冲突/);
    for(const extra of [{constraints:'仅对尾追目标发射'},{headingDeg:90},{targetRef:'RED 01'},{quantity:2}])assert.throws(()=>weaponTaskFor({...order,parameters:{...order.parameters,...extra}},context),/分条下达/);
  }
});

for(const roe of ['free','tight'])test(`${roe}仅改变交战限制，不取消攻击授权或重置已发射支持`,()=>{
  const w=make(),u=w.units[0];installAttackTask(w,u,attackOrder());const original=u.attackTask;original.firedMissileIds=['missile-1'];original.status='supporting';
  applyWeaponOrder(w,u,weapon(roe).weaponOrder);
  assert.equal(u.attackTask,original);assert.equal(original.active,true);assert.equal(original.status,'supporting');assert.deepEqual(original.firedMissileIds,['missile-1']);assert.equal(u.weapons.roe,roe);
  const allowed=engagementPermission(u,{id:'unknown-1',classification:'unknown'},{authorization:'attack'}).allowed;assert.equal(allowed,roe==='free');
});

test('真实组合sensor→attack→free保持攻击，回执是执行中而非装订错误或已完成',()=>{
  const w=make(),p=plan([sensor(),attack(),weapon('free')]);applyPlan(w,p,w.revision);
  assert.equal(w.units[0].attackTask.active,true);assert.equal(w.units[0].radarTask.active,false);assert.equal(w.units[0].weapons.roe,'free');
  const facts=inspectCommandResult(commandContext(w,'blue-1'),p,null,captureCommandResult(w));assert.ok(facts[0].modelFacts.installation.every(item=>item.matched));
  const review=receipt(w,p);assert.equal(review.checks[0].verdict,'executing');assert.match(review.checks[0].readbackText,/已装订，正在执行/);assert.doesNotMatch(review.checks[0].readbackText,/采样时已达到|装订设置不一致/);
  assert.equal(w.missiles.length,0);assert.ok(attackTaskEvent(w.units[0],w.time));
});

test('攻击与free/tight混合不会因为规则已经设置就宣称攻击目标已达到',()=>{
  for(const roe of ['free','tight']){const w=make(),p=plan([attack(),weapon(roe)]);applyPlan(w,p,w.revision);assert.equal(receipt(w,p).checks[0].verdict,'executing');}
});

test('编译器合并同机兼容搜索攻击，排列顺序不能让搜索取消攻击',()=>{
  for(const intents of [[['search'],['attack',{targetRef:'敌机'}],['weapons_free']],[['search'],['attack',{targetRef:'发现的敌机'}],['weapons_free']],
    [['search',{targetRef:'前方空域敌机'}],['attack',{targetRef:'discovered enemy aircraft'}],['weapons_free',{mode:'free'}]],
    [['attack',{targetRef:'前方目标'}],['search',{targetRef:'前方空域'}],['weapons_free']]]){
    const w=make(),compiled=compileMilitaryInterpretation(military(intents),commandContext(w,'blue-1'));
    assert.equal(compiled.plan.status,'accepted');assert.deepEqual(compiled.plan.tasks.map(t=>t.action),['attack_task','weapon']);
    applyPlan(w,compiled.plan,w.revision);assert.equal(w.units[0].attackTask.active,true);assert.equal(receipt(w,compiled.plan).checks[0].verdict,'executing');
  }
});

test('明确相同目标可合并，不同目标不丢弃、不伪报搜索已经执行',()=>{
  const w=make(),same=compileMilitaryInterpretation(military([['track_target',{targetRef:'RED 01'}],['attack',{targetRef:'RED 01'}]]),commandContext(w,'blue-1'));
  assert.equal(same.plan.status,'accepted');assert.deepEqual(same.plan.tasks.map(t=>t.action),['attack_task']);
  const different=compileMilitaryInterpretation(military([['track_target',{targetRef:'RED 02'}],['attack',{targetRef:'RED 01'}]]),commandContext(w,'blue-1'));
  assert.equal(different.plan.status,'needs_clarification');assert.equal(different.plan.tasks.length,0);
  const raw=plan([sensor({goal:'track_target',targetRef:'RED 02'}),attack({targetRef:'RED 01'})]);applyPlan(w,raw,w.revision);
  assert.equal(receipt(w,raw).checks[0].verdict,'mismatch');
});

test('hold仍中止任务，free本身不能恢复已取消的攻击或自动发射',()=>{
  const w=make(),u=w.units[0];installAttackTask(w,u,attackOrder());applyWeaponOrder(w,u,weapon('hold').weaponOrder);
  assert.equal(u.attackTask.active,false);assert.equal(u.attackTask.status,'cancelled');applyWeaponOrder(w,u,weapon('free').weaponOrder);
  assert.equal(u.attackTask.active,false);assert.equal(attackTaskEvent(u,w.time),null);assert.equal(w.missiles.length,0);
  const p=plan([attack(),weapon('hold')]);applyPlan(w,p,w.revision);assert.equal(receipt(w,p).checks[0].verdict,'mismatch');
});

function prepared(){
  const w=make(),u=w.units[0];w.addRadarPracticeTarget(u.id);installAttackTask(w,u,attackOrder());
  const act=(operation,extra={})=>applyAttackDecision(w,u,{operation,mode:null,modelId:null,targetId:null,quantity:null,headingDeg:null,altitudeM:null,speedMps:null,message:'拟执行当前操作',...extra},u.attackTask.id,u.attackTask.decisionCount);
  const sense=seconds=>{for(let i=0;i<Math.round(seconds*20);i++){w.time+=.05;stepRadars(w,.05);stepWeapons(w,.05);}};
  act('radar_mode',{mode:'pd'});sense(1.1);act('radar_lock',{targetId:'tgt-1'});sense(1);act('select',{modelId:'us_aim_120b',targetId:'tgt-1'});sense(.4);return w;
}
for(const operation of ['select','designate','launch'])test(`显式手动${operation}仍接管并取消自主攻击`,()=>{
  const w=prepared(),u=w.units[0];applyWeaponOrder(w,u,{operation,modelId:operation==='designate'?null:'us_aim_120b',targetId:operation==='select'?null:'tgt-1',quantity:operation==='launch'?1:null});
  assert.equal(u.attackTask.active,false);assert.equal(u.attackTask.status,'cancelled');assert.equal(w.missiles.length,operation==='launch'?1:0);
});
