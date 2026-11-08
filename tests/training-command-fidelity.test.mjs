import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {commandContext,applyPlan} from '../sim/orders.js';
import {TrainingWalkthrough} from '../sim/training-walkthrough.js';
import {createQwenClient} from '../server/qwen.mjs';
import {EMPTY_PARAMETERS,compileMilitaryInterpretation} from '../server/military-planner.mjs';
const read=p=>JSON.parse(fs.readFileSync(new URL('../'+p,import.meta.url)));
const make=()=>new World(read('data/scenarios/demo.json'),read('data/aircraft.json'));
const output=(altitudeM,speedMps,intent='cruise')=>({version:'1.0',status:'understood',summary:'建立指定巡航',orders:[{id:'order-1',intent,unitIds:['blue-1'],speechAct:'directive',timing:'now',condition:null,parameters:{...EMPTY_PARAMETERS,altitudeM,speedMps,...(intent==='fly_heading'?{headingDeg:0}:{})}}]});
test('玩家明确两万英尺350节时，指挥AI必须修正抄自当前实况的数值后才能播报',async()=>{
 const w=make(),before=JSON.stringify(w),requests=[];
 const client=createQwenClient({apiKey:'test',baseUrl:'https://test.invalid',commandModel:'mock',timeoutMs:1000},async(_url,options)=>{
   const request=JSON.parse(options.body);requests.push(request);
   const value=requests.length===1?output(6500,180,'fly_heading'):output(6096,350*1852/3600);
   return Response.json({choices:[{message:{content:JSON.stringify(value)}}]});
 });
 const reply=await client.interpret({requestId:'cruise-numbers',instruction:'Alpha，巡航，高度20000英尺，速度350节。',context:commandContext(w,'blue-1')});
 assert.equal(requests.length,2);assert.match(requests[1].messages.at(-1).content,/altitudeM|speedMps/);assert.equal(reply.plan.status,'accepted');assert.equal(reply.interpretation.orders[0].parameters.altitudeM,6096);assert.equal(JSON.stringify(w),before);
});
test('本步目标是实际稳定巡航，飞行员用保持当前航向的任务实现也可达成',()=>{
 const w=make(),t=new TrainingWalkthrough(w,'blue-1',{levelId:'navigation'});t.answer('navigate');t.next();assert.equal(t.step.intent,'cruise');
 const interpretation=output(6096,350*1852/3600,'fly_heading'),compiled=compileMilitaryInterpretation(interpretation,commandContext(w,t.unit.id));applyPlan(w,compiled.plan,w.revision);t.observeExecuted(interpretation);
 assert.equal(t.status,'active');assert.equal(t.phase,'working');
 for(let i=0;i<180*60&&t.phase!=='success';i++){w.step(1/60);t.tick();}
 assert.equal(t.phase,'success');assert(Math.abs(t.unit.position[2]-6096)<150);
});

test('导航关从稳定转弯待命开始，仅调整高度速度也不会永久卡在巡航计时',()=>{
 const w=make(),t=new TrainingWalkthrough(w,'blue-1',{levelId:'navigation'});t.answer('navigate');t.next();
 const interpretation=output(6096,350*1852/3600,'set_flight'),compiled=compileMilitaryInterpretation(interpretation,commandContext(w,t.unit.id));applyPlan(w,compiled.plan,w.revision);t.observeExecuted(interpretation);
 for(let i=0;i<180*60&&t.phase!=='success';i++){w.step(1/60);t.tick();}
 assert.equal(t.phase,'success');assert(t.flight.completed.cruise);assert(Math.abs(t.unit.bank)>Math.PI/12);assert(Math.abs(t.unit.bank)<Math.PI/4);
});

test('靶眼已在指挥通话中换成坐标时，按实际目的地与实际通过判定',()=>{
 const w=make(),t=new TrainingWalkthrough(w,'blue-1',{levelId:'navigation'});t.index=t.missions.findIndex(s=>s.id==='bullseye-fly');
 const interpretation={...output(6096,350*1852/3600,'fly_to'),orders:[{...output(6096,350*1852/3600,'fly_to').orders[0],parameters:{...EMPTY_PARAMETERS,altitudeM:6096,speedMps:350*1852/3600,eastM:518.56,northM:0}}]};
 const compiled=compileMilitaryInterpretation(interpretation,commandContext(w,t.unit.id));applyPlan(w,compiled.plan,w.revision);t.observeExecuted(interpretation);assert.equal(t.phase,'working');assert(t.issued.reference);
 for(let i=0;i<600*60&&t.phase!=='success'&&t.status==='active';i++){w.step(1/60);t.tick();}
 assert.equal(t.phase,'success');assert(t.unit.completedWaypoints>0);
});
