import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {World} from '../sim/world.js';
import {commandContext,applyPlan} from '../sim/orders.js';
import {EMPTY_PARAMETERS,compileMilitaryInterpretation} from '../server/military-planner.mjs';
import {planningRequirement} from '../sim/command-planning.js';
import {validateContext,createQwenClient} from '../server/qwen.mjs';
import {pilotReading} from '../server/pilot-handbook.mjs';
const scenario=JSON.parse(readFileSync(new URL('../data/scenarios/demo.json',import.meta.url))),profiles=JSON.parse(readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const world=()=>new World(scenario,profiles);
const order=(intent,parameters={},unitIds=['blue-1'])=>({id:'order-1',intent,unitIds,speechAct:'directive',timing:'now',condition:null,parameters:{...EMPTY_PARAMETERS,...parameters}});
const value=o=>({version:'1.0',status:'understood',summary:'任务已理解',orders:[o]});
const compile=(w,o,mapPoint=null)=>compileMilitaryInterpretation(value(o),commandContext(w,'blue-1',mapPoint));

test('巡航不追问航点；无航路保持各机当前航向及已有目标参数，实际运动交给飞控',()=>{
 const w=world(),before=w.units.map(u=>({position:[...u.position],velocity:[...u.velocity]}));w.units[1].holdAltitude=7000;w.units[1].targetAltitude=7000;
 const result=compile(w,order('cruise',{},['blue-1','blue-2']));assert.equal(result.execution.status,'ready');
 assert.equal(result.execution.planning[0].playerWaypointsRequired,false);assert.equal(result.plan.tasks.length,2);
 result.plan.tasks.forEach((t,i)=>{assert.equal(t.action,'fly_heading');assert.equal(t.altitudeM,w.units[i].targetAltitude);assert.equal(t.speedMps,w.units[i].targetSpeed);});
 applyPlan(w,result.plan,w.revision);assert.deepEqual(w.units.map(u=>({position:[...u.position],velocity:[...u.velocity]})),before);assert.ok(w.units.every(u=>u.waypoints.length));
});
test('巡航沿用已有三维航路，不拉平各点高度；只有明确自定义路线缺失才要求玩家给路线',()=>{
 const w=world();w.command('blue-1',[10000,0,7000]);w.command('blue-1',[15000,5000,8000],true);const points=w.units[0].waypoints.map(w=>[...w]);
 const result=compile(w,order('cruise'));assert.equal(result.plan.tasks[0].action,'set_flight');assert.equal(result.plan.tasks[0].altitudeM,null);applyPlan(w,result.plan,w.revision);assert.deepEqual(w.units[0].waypoints.map(w=>[...w]),points);
 const empty=world(),custom=compile(empty,order('cruise',{mode:'custom_route'}));assert.equal(custom.execution.status,'needs_clarification');assert.match(custom.plan.summary,/自定义路线/);assert.equal(custom.execution.planning[0].playerWaypointsRequired,true);
 assert.equal(compile(empty,order('cruise')).execution.status,'ready');empty.spawnAtStand('blue-1','G1');assert.match(compile(empty,order('cruise')).plan.summary,/先下达起飞/);
});
test('飞往坐标或一个标记点由程序规划，不要求玩家画全程；缺目的地只问目的地',()=>{
 const w=world();for(const [parameters,point]of [[{eastM:20000,northM:10000,altitudeM:7000},null],[{},[20000,10000,7000]],[{eastM:20000,northM:10000},[20000,10000,7000]]]){
  const result=compile(w,order('fly_to',parameters),point);assert.equal(result.execution.status,'ready');assert.equal(result.plan.tasks[0].eastM,20000);assert.equal(result.plan.tasks[0].altitudeM,7000);assert.equal(result.execution.planning[0].playerWaypointsRequired,false);
 }
 const missing=compile(w,order('fly_to'));assert.equal(missing.execution.status,'needs_clarification');assert.match(missing.plan.summary,/目的地/);assert.doesNotMatch(missing.plan.summary,/绘制|规划航路/);
 assert.equal(compile(w,order('fly_to',{mode:'custom_route',eastM:20000,northM:10000})).execution.status,'ready','已经提供的自定义点不应要求重新画一次');
});
test('靶眼按共同基准及方位距离计算，坐标/通报/接敌互不混淆，不借用飞机或标记点作基准',()=>{
 const w=world();w.bullseye={name:'TEST BULLSEYE',position:[1000,2000,0]};const input=order('fly_to',{mode:'bullseye',bearingDeg:90,rangeM:20000,altitudeM:7000});
 const context=validateContext(commandContext(w,'blue-1'));assert.deepEqual(context.bullseye,w.bullseye);
 const result=compile(w,input,[999,999,999]);assert.equal(result.execution.status,'ready');assert.ok(Math.abs(result.plan.tasks[0].eastM-21000)<1e-8);assert.ok(Math.abs(result.plan.tasks[0].northM-2000)<1e-8);assert.equal(result.plan.tasks[0].altitudeM,7000);
 const other=world();other.bullseye=null;const missing=compile(other,input,[999,999,999]);assert.equal(missing.execution.status,'needs_clarification');assert.match(missing.plan.summary,/靶眼基准/);assert.doesNotMatch(missing.plan.summary,/航点|航路/);
 assert.throws(()=>validateContext({...context,bullseye:{name:'X',position:[NaN,0,0]}}),/靶眼/);
 const report=compile(w,{...order('report_event',{mode:'bullseye',bearingDeg:90,rangeM:20000}),speechAct:'report'});assert.equal(report.execution.status,'informational');assert.deepEqual(report.plan.tasks,[]);
 const contact=compile(w,order('intercept',{targetRef:'目标一号',bearingDeg:90,rangeM:20000}));assert.equal(contact.execution.status,'capability_unavailable');assert.equal(contact.execution.planning[0].kind,'tactical');assert.equal(contact.execution.planning[0].playerWaypointsRequired,false);assert.deepEqual(contact.plan.tasks,[]);
});
test('战术选择与航路责任分别声明，已指定战术保留；未接入的执行器不会变成要求人工画点',()=>{
 const w=world(),context=commandContext(w,'blue-1');
 assert.equal(planningRequirement(order('crank',{targetRef:'目标一号',side:'left'}),context).tacticalChoice,'player_selected');
 assert.equal(planningRequirement(order('intercept',{targetRef:'目标一号',mode:'auto_tactics'}),context).tacticalChoice,'flash_within_task');
 for(const intent of ['patrol','intercept','crank']){const result=compile(w,order(intent,{targetRef:'指定任务区域/目标'}));assert.equal(result.execution.status,'capability_unavailable');assert.equal(result.execution.planning[0].playerWaypointsRequired,false);}
 const defense=compile(w,order('defend',{mode:'report_only'}));assert.equal(defense.execution.status,'ready');assert.equal(defense.execution.planning[0].playerWaypointsRequired,false);assert.equal(defense.plan.tasks[0].action,'defense');
 const search=compile(w,order('search'));assert.equal(search.execution.status,'ready');assert.equal(search.plan.tasks[0].action,'sensor_task');assert.equal(search.execution.planning[0].kind,'sensor');
});
test('Flash请求真实附带分工文件与靶眼基准，2B简版教材不会膨胀',async()=>{
 const w=world();w.bullseye={name:'TEST',position:[1000,2000,0]};let calls=0;
 const client=createQwenClient({apiKey:'test-only',baseUrl:'http://test',commandModel:'flash',timeoutMs:5000},async(_url,options)=>{
  calls++;const body=JSON.parse(options.body),data=JSON.parse(body.messages[1].content);assert.deepEqual(data.context.bullseye,w.bullseye);assert.match(body.messages[0].content,/12_谁来规划航路/);assert.match(body.messages[0].content,/不追问航点/);
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value(order('cruise')))}}]});
 });
 const result=await client.interpret({requestId:'planning-test',instruction:'Alpha开始巡航',context:commandContext(w,'blue-1')});assert.equal(calls,1);assert.equal(result.plan.status,'accepted');assert.ok(result.knowledgeUsed.some(f=>f.id==='planning'));assert.equal(pilotReading('接敌',{compact:true}).files.some(f=>f.id==='planning'),false);
});
test('Flash遗漏原话已给的靶眼距离时修复模型输出，不转成追问玩家',async()=>{
 const w=world();w.bullseye={name:'TEST',position:[1000,2000,0]};let calls=0;
 const client=createQwenClient({apiKey:'test-only',baseUrl:'http://test',commandModel:'flash',timeoutMs:5000},async(_url,options)=>{
  calls++;const body=JSON.parse(options.body);if(calls===2)assert.match(body.messages.at(-1).content,/不引用教材示例/);
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value(order('fly_to',{mode:'bullseye',bearingDeg:180,rangeM:calls===1?null:30000})))}}]});
 });
 const result=await client.interpret({requestId:'repair-bullseye',instruction:'Alpha，飞往靶眼180度30公里处',context:commandContext(w,'blue-1')});assert.equal(calls,2);assert.equal(result.plan.status,'accepted');assert.ok(Math.abs(result.plan.tasks[0].northM+28000)<.01);
});
