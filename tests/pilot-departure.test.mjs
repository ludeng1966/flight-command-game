import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {World} from '../sim/world.js';import {TerrainHeight} from '../sim/terrain.js';
import {commandContext,applyPlan,preparePilotPlan,commitPilotPlan} from '../sim/orders.js';
import {departureOptions,evaluateDeparturePlan} from '../sim/departure-plan.js';import {createCommandExchange} from '../sim/radio-procedure.js';
import {captureCommandResult,inspectCommandResult} from '../sim/pilot-result.js';import {encodeState,decodeState,captureWorld,restoreWorld} from '../sim/save-state.js';
import {traceFlight} from '../sim/safe-navigation.js';import {PilotAssistant} from '../server/pilot-assistant.mjs';import {compileMilitaryInterpretation,EMPTY_PARAMETERS} from '../server/military-planner.mjs';
const scenario=JSON.parse(fs.readFileSync(new URL('../data/scenarios/demo.json',import.meta.url))),profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const order={intent:'takeoff',airportId:'BAY',runway:'09L',taxiways:[],gate:null,altitudeM:null,mode:'reduced_thrust'},plan={status:'accepted',summary:'Alpha减推力起飞',tasks:[{unitId:'blue-1',action:'airport',airportOrder:order}]};
const interpretation={version:'1.0',status:'understood',summary:'Alpha使用09L减推力起飞',orders:[{id:'order-1',unitIds:['blue-1'],intent:'takeoff',timing:'now',condition:null,speechAct:'directive',parameters:{...EMPTY_PARAMETERS,runway:'09L',mode:'reduced_thrust'}}]};
const world=terrain=>new World(scenario,profiles,terrain??null,{spawnMode:'stands'});
test('常规指令交给飞行员规划，指挥员的候选澄清不会提前终止合理任务',async()=>{
  const w=world();let calls=0,stops=0;
  const pilot=new PilotAssistant('.',{model:'flash',provider:'cloud',runtimeFactory:()=>({start:async()=>{},stop:async()=>{stops++;},health:()=>({status:'ready',memory:{}}),complete:async(role,messages)=>{
    calls++;assert.equal(role,'pilot');assert.match(messages[0].content,/飞行员规划角色/);assert.match(messages[0].content,/常规推力/);return {value:interpretation};
  }})});
  const result=await pilot.planCommand({requestId:'pilot-interpret',instruction:'Alpha，09L减推力起飞。',context:commandContext(w,'blue-1'),interpretation:{status:'needs_clarification',orders:[]}});
  assert.equal(result.execution.status,'ready');assert.equal(result.plan.tasks[0].airportOrder.mode,'reduced_thrust');assert.equal(result.plannedBy,'flash');assert.equal(calls,1);assert.equal(stops,1);
});
test('非起飞的附加要求也由模型组合已有动作，听不懂则点名不执行且不下默认任务',async()=>{
  const w=world(),flight={...interpretation,summary:'保持东向，爬升至八千米并减速',orders:[{...interpretation.orders[0],intent:'fly_heading',parameters:{...EMPTY_PARAMETERS,headingDeg:90,altitudeM:8000,speedMps:162}}]};let next=flight;
  const pilot=new PilotAssistant('.',{runtimeFactory:()=>({start:async()=>{},stop:async()=>{},health:()=>({status:'ready',memory:{}}),complete:async(_role,messages,schema)=>{assert.match(messages[0].content,/所有特定要求/);assert(schema.properties.orders.items.anyOf);return {value:next};}})});
  const request={requestId:'free-plan',instruction:'Alpha，朝东平缓爬升到八千米，速度比当前慢一点。',context:commandContext(w,'blue-1')};
  const planned=await pilot.planCommand(request);assert.equal(planned.plan.status,'accepted');assert.equal(planned.plan.tasks[0].headingDeg,90);assert.equal(planned.plan.tasks[0].speedMps,162);
  next={version:'1.0',status:'needs_clarification',summary:'未理解“咕噜空间舞”的具体动作，本次不执行该要求',orders:[]};
  const unclear=await pilot.planCommand({...request,requestId:'unclear',instruction:'Alpha，执行咕噜空间舞。'});assert.equal(unclear.plan.tasks.length,0);assert.match(unclear.plan.summary,/无法执行.*咕噜空间舞/);assert.equal(w.revision,0);
});
test('飞行员可提出候选外的连续推力和航路方案，由物理检查后装订',async()=>{
  const w=world(),customPlan={throttle:.85,afterburner:0,climbSpeedMps:150,altitudeM:1300,distanceM:12500};
  const pilot=new PilotAssistant('.',{runtimeFactory:()=>({start:async()=>{},stop:async()=>{},health:()=>({status:'ready',memory:{}}),complete:async()=>({value:{decision:'execute',optionId:null,customPlan,message:'拟采用85%油门与12.5公里离场航路'}})})});
  const planned=await pilot.planDeparture({requestId:'free-controls',unitId:'blue-1',instruction:'用85%油门起飞并自行规划航路',context:commandContext(w,'blue-1'),options:[]});
  const procedure=evaluateDeparturePlan(w,w.units[0],order,planned.customPlan);assert(procedure);assert.equal(procedure.throttle,.85);assert.equal(procedure.distanceM,12500);
  applyPlan(w,plan,0,{pilotProcedures:{'blue-1':procedure}});assert.equal(w.units[0].departurePowerPlan.throttle,.85);assert.equal(w.units[0].surface.phase,'taxi');
  const decimalWorld=world(),decimal=evaluateDeparturePlan(decimalWorld,decimalWorld.units[0],order,{...customPlan,climbSpeedMps:150.1234});assert(decimal);assert.doesNotThrow(()=>applyPlan(decimalWorld,plan,0,{pilotProcedures:{'blue-1':decimal}}));
});
test('飞行员明确UNABLE时返回原因和空方案，不因缺少旧optionId字段而误报接口失败',async()=>{
  const w=world(),pilot=new PilotAssistant('.',{runtimeFactory:()=>({start:async()=>{},stop:async()=>{},health:()=>({status:'ready',memory:{}}),complete:async()=>({value:{decision:'unable',customPlan:null,message:'无法执行所报离场方案，指令不明，请重新指示'}})})});
  const result=await pilot.planDeparture({requestId:'unable-plan',instruction:'未明确的离场要求',unitId:'blue-1',context:commandContext(w,'blue-1'),options:[]});assert.equal(result.decision,'unable');assert.equal(result.customPlan,null);assert.match(result.message,/无法执行/);assert.equal(w.revision,0);
});
test('飞行员从可行候选选择真实推力和路线；未知方案无法装订且整批保持原状',async()=>{
  const w=world(),options=departureOptions(w,w.units[0],order);assert(options.length>1);const selected=options[0];assert.equal(selected.throttle,.8);assert.equal(selected.afterburner,0);
  const pilot=new PilotAssistant('.',{runtimeFactory:()=>({start:async()=>{},stop:async()=>{},health:()=>({status:'ready',memory:{}}),complete:async(_role,messages,schema)=>{assert.match(messages[0].content,/自由提出customPlan/);assert(schema.properties.customPlan);return {value:{decision:'execute',customPlan:{throttle:selected.throttle,afterburner:selected.afterburner,climbSpeedMps:selected.climbSpeedMps,altitudeM:selected.altitudeM,distanceM:selected.distanceM},message:'拟采用较低推力与较长离场航路'}};}})});
  const response=await pilot.planDeparture({requestId:'power-plan',instruction:'Alpha减推力起飞',unitId:'blue-1',context:commandContext(w,'blue-1'),options});assert.equal(response.customPlan.throttle,selected.throttle);
  const before=JSON.stringify(w);assert.throws(()=>applyPlan(w,plan,0),/方案缺失/);assert.equal(JSON.stringify(w),before);
  assert.throws(()=>applyPlan(w,plan,0,{pilotProcedures:{'blue-1':{...selected,throttle:1.5}}}),/校验/);assert.equal(JSON.stringify(w),before);
  const draft=preparePilotPlan(w,plan,0,{pilotProcedures:{'blue-1':selected}});draft.departurePlans.get('blue-1').afterburner=1;assert.throws(()=>commitPilotPlan(draft),/校验/);assert.equal(JSON.stringify(w),before);
});
test('中文通联不混读TAKEOFF或内部模式码，减推力方案进入真实结果检查',()=>{
  const w=world(),compiled=compileMilitaryInterpretation(interpretation,commandContext(w,'blue-1'));assert.equal(compiled.execution.status,'ready');assert.doesNotMatch(compiled.plan.summary,/reduced_thrust|TAKEOFF/);
  const zh=createCommandExchange(plan,w.units,'pla').commander.text,en=createCommandExchange(plan,w.units,'nato').commander.text;
  assert.match(zh,/起飞/);assert.match(zh,/减推力起飞/);assert.doesNotMatch(zh,/TAKEOFF|reduced_thrust/);assert.match(en,/REDUCED-THRUST TAKEOFF/);assert.doesNotMatch(en,/[\u3400-\u9fff]|reduced_thrust/);
  const selected=departureOptions(w,w.units[0],order)[0];applyPlan(w,plan,0,{pilotProcedures:{'blue-1':selected}});
  const facts=inspectCommandResult(commandContext(w,'blue-1'),plan,null,captureCommandResult(w));assert.equal(facts[0].expectedVerdict,'executing');assert.match(facts[0].requiredReadback,/计划油门80%/);assert.match(facts[0].requiredReadback,/不使用加力/);assert.doesNotMatch(facts[0].requiredReadback,/reduced_thrust/);
  const receipt=captureCommandResult(w);receipt.units[0].departurePowerPlan=null;assert.equal(inspectCommandResult(commandContext(w,'blue-1'),plan,null,receipt)[0].expectedVerdict,'mismatch');
});
test('真实地图从机位减推力起飞并爬升，滑跑与爬升均实际限制油门和加力，预测与存档保持方案',()=>{
  const bytes=fs.readFileSync(new URL('../terrain/air_skyscraper_city_height.f32',import.meta.url)),meta=JSON.parse(fs.readFileSync(new URL('../terrain/air_skyscraper_city_height.json',import.meta.url))),terrain=new TerrainHeight(meta,new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength))),w=world(terrain),u=w.units[0];
  const selected=departureOptions(w,u,order)[0];assert(selected);applyPlan(w,plan,0,{pilotProcedures:{'blue-1':selected}});let airborne=false,rollThrottle=0,rollBoost=0,climbThrottle=0,climbBoost=0,predictionChecked=false;
  for(let i=0;i<900*60&&u.alive;i++){
    w.step(1/60);
    if(u.surface.phase==='takeoff_roll'){rollThrottle=Math.max(rollThrottle,u.throttle);rollBoost=Math.max(rollBoost,u.afterburner);}
    if(u.surface.phase==='climb'){
      airborne=true;if(u.position[2]<selected.altitudeM-100){climbThrottle=Math.max(climbThrottle,u.throttle);climbBoost=Math.max(climbBoost,u.afterburner);assert.equal(u.departurePowerPlan.active,true);}
      if(!predictionChecked&&u.position[2]>400){const before=JSON.stringify(u.departurePowerPlan);traceFlight(u,u.waypoints,u.navLegs??[],{duration:40});assert.equal(JSON.stringify(u.departurePowerPlan),before);predictionChecked=true;
        const restored=restoreWorld(decodeState(JSON.parse(JSON.stringify(encodeState(captureWorld(w))))),scenario,profiles,terrain);assert.deepEqual(restored.units[0].departurePowerPlan,u.departurePowerPlan);}
    }
    if(u.position[2]>=selected.altitudeM-50)break;
  }
  assert.equal(u.alive,true);assert.equal(airborne,true);assert.equal(predictionChecked,true);assert(u.position[2]>=selected.altitudeM-50,JSON.stringify({position:u.position,phase:u.surface.phase,blocked:u.navigationBlocked}));
  assert.equal(rollThrottle,.8);assert.equal(rollBoost,0);assert(climbThrottle<=.800001);assert.equal(climbBoost,0);assert(w.time<900);
  fs.writeFileSync(new URL('../.game-server/pilot-departure-physics.json',import.meta.url),JSON.stringify({time:w.time,position:u.position,selected,rollThrottle,climbThrottle,rollBoost,climbBoost,alive:u.alive},null,2));
});
