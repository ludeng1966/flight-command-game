import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {World} from '../sim/world.js';
import {commandContext,applyPlan} from '../sim/orders.js';
import {createCommandExchange,formatIntentCommand} from '../sim/radio-procedure.js';
import {captureCommandResult,inspectCommandResult} from '../sim/pilot-result.js';
import {englishResultReadback} from '../sim/result-language.js';
import {radioAltitude,radioSpeed} from '../sim/units.js';
import {runCommandSession} from '../game/command-session.js';
import {createCommanderTransmission,receivedCommanderMessage,normalizedCommanderTranscript,verifyCommanderHeading,verifyCommanderNumbers,verifyCommanderAirportInstruction,parseRadioNumber,decodedCommanderParameters,bindCommanderNumbers} from '../sim/commander-message.js';
import {militarySchemaFor} from '../server/military-planner.mjs';
import {PilotAssistant} from '../server/pilot-assistant.mjs';
import {EMPTY_PARAMETERS,compileMilitaryInterpretation} from '../server/military-planner.mjs';
const scenario=JSON.parse(readFileSync(new URL('../data/scenarios/demo.json',import.meta.url))),profiles=JSON.parse(readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const world=()=>new World(scenario,profiles),task={unitId:'blue-1',action:'fly_heading',altitudeM:6096,speedMps:350*1852/3600,headingDeg:90,eastM:null,northM:null,distanceM:null,append:false};
const plan={status:'accepted',summary:'航向90，高度20000英尺，速度350节',tasks:[task]},heard='幺洞幺，指挥台。航向洞勾洞，下降至六千一百米，真空速六百四十八公里每小时。';
const message={id:'radio-test',speaker:'commander',text:heard,language:'zh-CN',unitSystem:'metric'};
const interpretation={version:'1.0',status:'understood',summary:'执行指挥台通话',orders:[{id:'order-1',intent:'fly_heading',unitIds:['blue-1'],speechAct:'directive',timing:'now',condition:null,parameters:{...EMPTY_PARAMETERS,headingDeg:90,altitudeM:6100,speedMps:648/3.6}}]};
const runtime=complete=>({health:()=>({status:'ready',memory:{}}),async start(){},async stop(){},complete});
test('自由巡航不把默认高度速度播报成硬性命令，模型选择后实际装订',async()=>{
 const w=world(),raw={...interpretation,orders:[{...interpretation.orders[0],intent:'cruise',parameters:{...EMPTY_PARAMETERS}}]},compiled=compileMilitaryInterpretation(raw,commandContext(w,'blue-1'));
 const transmission=createCommanderTransmission({...compiled,interpretation:raw},w.units);assert.deepEqual(decodedCommanderParameters(transmission),{});assert.match(transmission.text,/巡航/);
 const assistant=new PilotAssistant('.',{runtimeFactory:()=>runtime(async(_role,messages)=>{
  assert.match(messages[0].content,/界面不再提供高度和速度滑块/);
  return {value:{...raw,orders:[{...raw.orders[0],parameters:{...EMPTY_PARAMETERS,altitudeM:7500,speedMps:210}}]},timing:{}};
 })});
 const planned=await assistant.planCommand({requestId:'autonomous-cruise',commanderMessage:{...transmission,id:'autonomous-message'},context:commandContext(w,'blue-1')});
 assert.equal(planned.plan.tasks[0].altitudeM,7500);assert.equal(planned.plan.tasks[0].speedMps,210);applyPlan(w,planned.plan,w.revision);assert.equal(w.units[0].holdAltitude,7500);assert.equal(w.units[0].targetSpeed,210);
});

test('转换播报高度近似到10米或10英尺，速度取整；格式化不改动原始SI数据',()=>{
 const w=world(),original=JSON.stringify(plan),zh=createCommandExchange(plan,w.units,'pla','metric').commander.text;
 assert.match(zh,/六千一百米/);assert.match(zh,/六百四十八公里每小时/);assert.doesNotMatch(zh,/点|六千零九十六/);
 assert.equal(radioAltitude(6096,'metric'),6100);assert.equal(radioAltitude(8000,'imperial'),26250);assert.equal(radioSpeed(task.speedMps,'metric'),648);assert.equal(JSON.stringify(plan),original);
 const en=createCommandExchange({...plan,tasks:[{...task,altitudeM:8000}]},w.units,'nato','imperial').commander.text;assert.match(en,/TWENTY SIX THOUSAND TWO HUNDRED FIFTY FEET/);assert.doesNotMatch(en,/DECIMAL/);
 applyPlan(w,plan,0);const context=commandContext(w,'blue-1'),facts=inspectCommandResult(context,plan,null,captureCommandResult(w));assert.match(facts[0].requiredReadback,/高度6100米，真空速648公里每小时/);assert.match(englishResultReadback(facts[0],plan,context),/altitude 6100 METERS, true airspeed 648 KILOMETERS PER HOUR/);assert.equal(w.units[0].holdAltitude,6096);
});
test('指挥员发话完成后才调用飞行员，采用实际语音文本，之后才装订且不重复播报',async()=>{
 const w=world(),events=[],reply={requestId:'source-test',plan:{...plan,tasks:[{...task,headingDeg:270}]}},pilotPlan={...plan,tasks:[{...task,altitudeM:6100,speedMps:648/3.6}]};
 await runCommandSession({world:w,reply,expectedRevision:0,pause:async()=>{},radio:{phase(){},async transmit(m){events.push(m.speaker);return {id:'actual-radio',text:m.text,speechText:m.speaker==='commander'?heard:m.text,speechLanguage:'zh-CN'};}},
  async planPilotCommand({commanderMessage}){events.push('plan');assert.equal(w.units[0].waypoints.length,0);assert.equal(commanderMessage.text,heard);return {plan:pilotPlan,interpretation,execution:{status:'ready'}};},
  onCommitted(){events.push('commit');},async checkPilotResult(payload){events.push('check');assert.equal(payload.commanderMessage.text,heard);return {checks:[{unitId:'blue-1',verdict:'executing',readbackText:'航向90度，高度6100米，真空速648公里每小时，正在执行。'}]};}});
 assert.deepEqual(events,['commander','plan','commit','check','pilot']);assert.equal(w.units[0].headingRoute.headingDeg,90);assert.equal(w.units[0].holdAltitude,6100);assert.equal(reply.commanderMessage.id,'actual-radio');
});
test('播报中取消或接令期间人工改令，不允许旧计划装订',async()=>{
 for(const stage of ['broadcast','planning']){const w=world(),controller=new AbortController();let called=0;
  await assert.rejects(runCommandSession({world:w,reply:{requestId:'cancel-source',plan},expectedRevision:0,signal:controller.signal,pause:async()=>{},radio:{phase(){},async transmit(){if(stage==='broadcast'){controller.abort();controller.signal.throwIfAborted();}}},
   async planPilotCommand(){called++;w.revision++;return {plan,interpretation,execution:{status:'ready'}};}}));assert.equal(w.units[0].waypoints.length,0);assert.equal(called,stage==='broadcast'?0:1);
 }
});
test('指挥员尚不具备执行方案时仍完整播报约束，不丢油门、目标和条件',()=>{
 const i={orders:[{...interpretation.orders[0],intent:'takeoff',condition:'跑道空闲',timing:'on_condition',parameters:{...EMPTY_PARAMETERS,runway:'09L',mode:'reduced_thrust',altitudeM:6096,constraints:'油门85%，不使用加力'}}]};
 const text=formatIntentCommand(i,world().units,'pla','metric');assert.match(text,/85%/);assert.match(text,/不使用加力/);assert.match(text,/六千一百米/);assert.match(text,/当跑道空闲时/);
});
test('飞行员API忽略附带的玩家原文和未播报候选，只向模型提供指挥通话',async()=>{
 const w=world();let calls=0;const assistant=new PilotAssistant('.',{runtimeFactory:()=>runtime(async(_role,messages)=>{
  calls++;const data=JSON.parse(messages[1].content);assert.deepEqual(data.commanderMessage,message);assert.equal(data.instruction,undefined);assert.equal(data.commanderCandidate,undefined);assert.doesNotMatch(messages[1].content,/玩家暗令|航向270/);assert.match(messages[0].content,/只处理指挥员(?:或塔台)?已经播报/);return {value:interpretation,timing:{}};
 })});
 const r=await assistant.planCommand({requestId:'received-only',commanderMessage:message,instruction:'玩家暗令：航向270',interpretation:{orders:[{intent:'attack'}]},context:commandContext(w,'blue-1')});assert.equal(calls,1);assert.equal(r.commanderMessageId,message.id);assert.equal(r.receivedFrom,'commander');assert.equal(r.plan.tasks[0].headingDeg,90);assert.equal(r.plan.tasks[0].altitudeM,6100);
 assert.throws(()=>receivedCommanderMessage({commanderMessage:{...message,speaker:'player'}}),/指挥员/);
});
test('逐位通联数字从同一段播报规范化，飞行员不能把090误作270',()=>{
 assert.match(normalizedCommanderTranscript(message),/航向090/);assert.doesNotThrow(()=>verifyCommanderHeading(interpretation,message));
 const wrong=structuredClone(interpretation);wrong.orders[0].parameters.headingDeg=270;assert.throws(()=>verifyCommanderHeading(wrong,message),/实际播报.*090/);
});
test('从中英通话解码明确数值并约束SI字段，保留小于一单位的负坐标方向',()=>{
 const english={...message,text:'FLY HEADING TWO SEVEN ZERO. CLIMB TO TWENTY SIX THOUSAND TWO HUNDRED FIFTY FEET. TRUE AIRSPEED THREE HUNDRED TWENTY FOUR KNOTS.'},chinese={...message,text:'航向两拐洞，爬升至二万六千二百五十英尺，真空速三百二十四节。'};
 for(const m of [english,chinese])assert.deepEqual(decodedCommanderParameters(m),{headingDeg:270,altitudeM:8001,speedMps:166.68});
 assert.equal(parseRadioNumber('负零点五'),-.5);assert.equal(parseRadioNumber('MINUS ZERO DECIMAL FIVE'),-.5);
 const schema=bindCommanderNumbers(militarySchemaFor(commandContext(world(),'blue-1')),english);assert.deepEqual(schema.properties.orders.items.anyOf[1].properties.parameters.properties.speedMps.enum,[null,166.68]);
 const coordinates={...plan,tasks:[{...task,action:'fly_to',headingDeg:null,eastM:-500,northM:1000}]};assert.match(createCommandExchange(coordinates,world().units,'pla','metric').commander.text,/东向负零点五公里/);
});
test('起飞规划和结果检查继承同一次指挥通话，不重新读取玩家输入',async()=>{
 const w=world();w.spawnAtStand('blue-1','G1');let calls=0;
 const assistant=new PilotAssistant('.',{runtimeFactory:()=>runtime(async(_role,messages,schema)=>{
  calls++;const data=JSON.parse(messages[1].content);assert.equal(data.commanderMessage.text,heard);assert.doesNotMatch(messages[1].content,/玩家暗令/);
  if(schema.properties.customPlan)return {value:{decision:'execute',customPlan:{throttle:.85,afterburner:0,climbSpeedMps:180,altitudeM:1300,distanceM:14000},message:'拟采用指挥台要求的方案'},timing:{}};
  return {value:{instructionReadback:schema.properties.instructionReadback.enum[0],verdict:'executing',resultText:'正在执行，尚未达到目标。'},timing:{}};
 })});
 await assistant.planDeparture({requestId:'source-departure',commanderMessage:message,instruction:'玩家暗令',context:commandContext(w,'blue-1'),unitId:'blue-1',options:[]});
 const airborne=world();applyPlan(airborne,plan,0);await assistant.checkResult({requestId:'source-result',commanderMessage:message,context:commandContext(airborne,'blue-1'),plan,result:captureCommandResult(airborne)});assert.equal(calls,2);
});

test('坐标通话统一解码海里与公里，零点小数及负号不会变成地图外的目标',()=>{
 const zh=decodedCommanderParameters({text:'飞往坐标，东向零点两八海里，北向零海里，高度二万英尺，真空速三百五十节。'});assert.equal(zh.eastM,518.56);assert.equal(zh.northM,0);
 const en=decodedCommanderParameters({text:'PROCEED TO COORDINATES, EAST MINUS ZERO DECIMAL FIVE KILOMETERS, NORTH ONE NAUTICAL MILES.'});assert.equal(en.eastM,-500);assert.equal(en.northM,1852);
 const schema=bindCommanderNumbers(militarySchemaFor(commandContext(world(),'blue-1')),{text:'东向零点两八海里，北向零海里'});const branches=schema.properties.orders.items.anyOf??[schema.properties.orders.items];for(const b of branches)assert.deepEqual(b.properties.parameters.properties.eastM.enum,[null,518.56]);
});

test('盘旋保留玩家明确的保持高度和节数，不能将350节擅自变成300节',()=>{
 const instruction={text:'Alpha，在当前区域盘旋，保持20000英尺和350节。'};
 assert.deepEqual(decodedCommanderParameters(instruction),{altitudeM:6096,speedMps:Number((350*1852/3600).toFixed(8))});
 for(const intent of ['orbit','clear_waypoints']){
  const value={status:'understood',orders:[{intent,parameters:{altitudeM:6096,speedMps:300*1852/3600}}]};
  assert.throws(()=>verifyCommanderNumbers(value,instruction),/speedMps/);
  value.orders[0].parameters.speedMps=350*1852/3600;assert.doesNotThrow(()=>verifyCommanderNumbers(value,instruction));
 }
});

test('AI误把已播报的滑行或对正许可扩成起飞时退回重解，不构造替代指令',()=>{
 const value=intent=>({status:'understood',orders:[{intent}]});
 for(const text of ['ALPHA ZERO ONE，BAY塔台。滑行，BAY机场，跑道09L，经A、A1。','ALPHA ZERO ONE. BAY TOWER. LINE UP AND WAIT. RUNWAY ZERO NINER LEFT.']){
  assert.throws(()=>verifyCommanderAirportInstruction(value('takeoff'),{text}),/不能改成takeoff/);
 }
 assert.doesNotThrow(()=>verifyCommanderAirportInstruction(value('taxi'),{text:'滑行，跑道09L，经A、A1。'}));
 assert.doesNotThrow(()=>verifyCommanderAirportInstruction(value('takeoff'),{text:'起飞，跑道09L。'}));
 assert.throws(()=>verifyCommanderAirportInstruction(value('takeoff'),{text:'中断起飞。'}),/不能改成takeoff/);
});
