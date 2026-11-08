import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setUnitSystem,getUnitSystem,speedValue,speedMps,altitudeValue,altitudeMeters,distanceValue,distanceMeters,formatSpeed,formatAltitude,formatMach,modelUnitInstruction} from '../sim/units.js';
import {World} from '../sim/world.js';
import {commandContext,applyPlan} from '../sim/orders.js';
import {captureCommandResult,inspectCommandResult,validateResultReadbacks} from '../sim/pilot-result.js';
import {radioReadback} from '../sim/radio.js';
import {createCommandExchange} from '../sim/radio-procedure.js';
import {validateContext} from '../server/qwen.mjs';
const scenario=JSON.parse(readFileSync(new URL('../data/scenarios/demo.json',import.meta.url))),profiles=JSON.parse(readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const world=()=>new World(scenario,profiles);
const task={unitId:'blue-1',action:'fly_heading',headingDeg:270,altitudeM:6096,speedMps:154.33333333333334,eastM:null,northM:null,distanceM:18520,append:false};
const plan={status:'accepted',summary:'西飞',tasks:[task]};
test('默认公制，英制准确往返换算，马赫始终通用',()=>{
 assert.equal(getUnitSystem(),'metric');assert.equal(formatSpeed(200),'720 km/h');assert.equal(formatAltitude(8000),'8000 m');
 assert.equal(speedValue(1852/3600,'imperial'),1);assert.equal(altitudeValue(3048,'imperial'),10000);assert.equal(distanceValue(1852,'imperial'),1);
 for(const system of ['metric','imperial']){assert.ok(Math.abs(speedMps(speedValue(217,system),system)-217)<1e-9);assert.ok(Math.abs(altitudeMeters(altitudeValue(6500,system),system)-6500)<1e-9);assert.equal(distanceMeters(distanceValue(18520,system),system),18520);setUnitSystem(system);assert.equal(formatMach(.84),'M 0.84');}
 setUnitSystem('metric');assert.match(modelUnitInstruction('imperial'),/马赫数M是无量纲/);
});
test('切换显示不改变物理状态，UI与指令上下文共享设置',()=>{
 const w=world(),before=JSON.stringify(w);setUnitSystem('imperial');assert.equal(JSON.stringify(w),before);
 assert.equal(commandContext(w,'blue-1').unitSystem,'imperial');assert.equal(validateContext(commandContext(w,'blue-1')).unitSystem,'imperial');
 assert.throws(()=>validateContext({...commandContext(w,'blue-1'),unitSystem:'invalid'}),/单位/);setUnitSystem('metric');
});
test('英制命令、复诵与结果检查一致，执行器保持SI',()=>{
 const w=world();w.unitSystem='imperial';applyPlan(w,plan,0);
 const facts=inspectCommandResult(commandContext(w,'blue-1'),plan,null,captureCommandResult(w));
 assert.equal(facts[0].requiredReadback,'航向270度，高度20000英尺，真空速300节，前出10海里');assert.equal(facts[0].expectedVerdict,'executing');
 assert.equal(facts[0].modelFacts.installation.find(c=>c.field==='目标真空速').actual,300);
 const text=facts[0].requiredReadback+'，已装订，正在执行。';validateResultReadbacks({checks:[{unitId:'blue-1',verdict:'executing',readbackText:text}]},facts);
 assert.match(radioReadback(plan,w.units,'pla','imperial'),/20000英尺，真空速300节/);
 const exchange=createCommandExchange(plan,w.units,'nato','imperial');assert.match(exchange.commander.text,/FEET/);assert.match(exchange.commander.text,/KNOTS/);assert.match(exchange.commander.text,/NAUTICAL MILES/);
 assert.equal(w.units[0].holdAltitude,6096);assert.equal(w.units[0].targetSpeed,task.speedMps);
 const context=commandContext(w,'blue-1'),receipt=captureCommandResult(w);context.units[0].position[2]=6096;context.units[0].speedMps=task.speedMps;context.units[0].headingDeg=270;
 assert.equal(inspectCommandResult(context,plan,null,receipt)[0].expectedVerdict,'executing','有距离的航段仅参数到位时不能报告完成');
 receipt.units[0].waypoints=[];assert.equal(inspectCommandResult(context,plan,null,receipt)[0].expectedVerdict,'reached');
});
test('机场与编队结果不会误当普通飞行数值，差异复述只能引用真实数据',()=>{
 const w=world();w.spawnAtStand('blue-1','G1');
 const airport={status:'accepted',summary:'滑行',tasks:[{unitId:'blue-1',action:'airport',airportOrder:{intent:'taxi',airportId:'BAY',runway:'09L',taxiways:[],gate:null,altitudeM:null,mode:null}}]};applyPlan(w,airport,w.revision);
 const f=inspectCommandResult(commandContext(w,'blue-1'),airport,null,captureCommandResult(w))[0];assert.equal(f.expectedVerdict,'executing');assert.doesNotMatch(f.requiredReadback,/NaN|undefined/);
 const w2=world();applyPlan(w2,plan,0);const receipt=captureCommandResult(w2);receipt.units[0].headingRoute.headingDeg=90;
 const facts=inspectCommandResult(commandContext(w2,'blue-1'),plan,null,receipt);validateResultReadbacks({checks:[{unitId:'blue-1',verdict:'mismatch',readbackText:facts[0].requiredReadback+'，装订不一致，程序实际航向90度。'}]},facts);
 assert.throws(()=>validateResultReadbacks({checks:[{unitId:'blue-1',verdict:'mismatch',readbackText:facts[0].requiredReadback+'，装订不一致，实际航向123.45度。'}]},facts),/没有要求/);
});
