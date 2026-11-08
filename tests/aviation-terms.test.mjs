import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {once} from 'node:events';
import {aviationTermStats,searchAviationTerms,aviationReading} from '../server/aviation-terms.mjs';
import {pilotReading} from '../server/pilot-handbook.mjs';
import {World} from '../sim/world.js';
import {commandContext,applyPlan} from '../sim/orders.js';
import {COMMAND_CATALOG} from '../sim/military-commands.js';
import {EMPTY_PARAMETERS} from '../server/military-planner.mjs';
import {createQwenClient} from '../server/qwen.mjs';
import {PilotAssistant} from '../server/pilot-assistant.mjs';
import {captureCommandResult} from '../sim/pilot-result.js';
import {pilotObservation} from '../sim/pilot-watch.js';
import {createGameServer,readConfig} from '../server/game-server.mjs';
const scenario=JSON.parse(readFileSync(new URL('../data/scenarios/demo.json',import.meta.url))),profiles=JSON.parse(readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const world=()=>new World(scenario,profiles);
const runtime=complete=>({health:()=>({status:'ready',memory:{}}),async start(){},async stop(){},complete});

test('完整公开词库有来源和中文简释，游戏全部意图另有索引',()=>{
 const stats=aviationTermStats();assert.ok(stats.referenceTerms>=2000);assert.ok(stats.counts.faa>=1300);assert.ok(stats.counts.alssa>=500);assert.equal(stats.counts.game,COMMAND_CATALOG.length);
 for(const query of ['VOR','ILS','RUNWAY INCURSION','PRECISION APPROACH PATH INDICATOR','PITBULL']){
  const matches=searchAviationTerms(query,{limit:8});assert.ok(matches.some(t=>t.source==='faa'||t.source==='alssa'),query);assert.ok(matches.every(t=>/[\u3400-\u9fff]/.test(t.meaning)),query);
 }
 for(const command of COMMAND_CATALOG)assert.ok(searchAviationTerms(command.id).length,command.id);
 assert.equal(stats.sources.length,2);
});
test('易混词保留游戏边界，英文缩写按完整词匹配，传统单位不会覆盖游戏设置',()=>{
 const terms=searchAviationTerms('FOX THREE，WEAPONS FREE，ROGER，IAS，AGL，BULLSEYE',{limit:20});
 for(const id of ['core-fox-three','core-weapons-free','core-roger','core-ias','core-agl','core-bullseye'])assert.ok(terms.some(t=>t.id===id),id);
 assert.match(terms.find(t=>t.id==='core-fox-three').meaning,/不.*发射三枚/);
 assert.match(terms.find(t=>t.id==='core-ias').meaning,/不等于真空速/);
 assert.match(terms.find(t=>t.id==='core-bullseye').meaning,/本游戏/);
 assert.ok(!searchAviationTerms('NEGATE').some(t=>t.id==='core-gate'));
 assert.ok(searchAviationTerms('M0.9').some(t=>t.id==='core-mach'));assert.ok(searchAviationTerms('FL200').some(t=>t.id==='core-fl'));
});
test('按需给词义而非整本词典，2B与Flash都有明确的长度上限',()=>{
 const query='TAS IAS AGL MSL ANGELS FL200 MACH BULLSEYE BRAA FOX THREE NO JOY ROGER WILCO CRANK NOTCH BINGO JOKER';
 const small=aviationReading(query,{compact:true}),large=aviationReading(query);
 assert.ok(small.text.length<=900);assert.ok(small.terms.length<=4);assert.ok(large.text.length<=4200);assert.ok(large.terms.length<=14);assert.ok(large.terms.length>small.terms.length);
 assert.ok(aviationReading('没有匹配词的普通句子').text.length<200);
 for(const compact of [true,false]){const reading=pilotReading('FOX THREE，NO JOY',{compact});assert.match(reading.text,/航空术语简释/);assert.match(reading.text,/主动雷达/);assert.ok(reading.files.some(f=>f.id==='aviation_terms'&&f.termIds.includes('core-fox-three')));assert.doesNotMatch(reading.text,/AERONAUTICAL INFORMATION SERVICES/);}
});
test('指挥员真实请求带相关术语，FOX通报仍为只读通报',async()=>{
 const w=world();let count=0;const client=createQwenClient({apiKey:'test-only',baseUrl:'http://test',commandModel:'flash',timeoutMs:5000},async(_url,options)=>{
  count++;const request=JSON.parse(options.body);assert.match(request.messages[0].content,/航空术语简释/);assert.match(request.messages[0].content,/不要解释成发射三枚/);
  return Response.json({choices:[{message:{content:JSON.stringify({version:'1.0',status:'understood',summary:'FOX THREE通报',orders:[{id:'order-1',intent:'report_event',unitIds:['blue-1'],speechAct:'report',timing:'now',condition:null,parameters:{...EMPTY_PARAMETERS,mode:'FOX THREE'}}]})}}]});
 });
 const before=JSON.stringify(w),reply=await client.interpret({requestId:'terms-commander',instruction:'Alpha FOX THREE',context:commandContext(w,'blue-1')});assert.equal(count,1);assert.equal(reply.execution.status,'informational');assert.deepEqual(reply.plan.tasks,[]);assert.equal(JSON.stringify(w),before);assert.ok(reply.knowledgeUsed.some(f=>f.termIds?.includes('core-fox-three')));
});
test('飞行员事件判断与结果复述都收到词义，词库本身不会触发推理',async()=>{
 const w=world(),u=w.units[0];let calls=0;
 const assistant=new PilotAssistant('.',{runtimeFactory:()=>runtime(async(_role,messages,schema)=>{
  calls++;assert.match(messages[0].content,/航空术语简释/);
  if(schema.properties.decision)return {value:{decision:'notify_commander',message:'已理解偏置支持，执行能力尚未接入',missingData:[]},timing:{}};
  return {value:{instructionReadback:schema.properties.instructionReadback.enum[0],verdict:'executing',resultText:'已装订，正在执行，尚未达到目标。'},timing:{}};
 })});
 const normal=await assistant.assess({requestId:'terms-normal',context:commandContext(w,u.id),observation:{unitId:u.id,blockedSince:null,blockedReason:null,mission:null,contacts:[]}});assert.equal(normal.modelInvoked,false);assert.equal(calls,0);
 u.pilotMission={id:'crank-1',intent:'crank',timing:'now',condition:null,parameters:{side:'left',targetRef:'test'},revision:w.revision};
 const event=await assistant.assess({requestId:'terms-event',context:commandContext(w,u.id),observation:pilotObservation(w,u)});assert.ok(event.knowledgeUsed.some(f=>f.termIds?.includes('core-crank')));
 const plan={status:'accepted',summary:'保持真空速600公里每小时',tasks:[{unitId:u.id,action:'set_flight',altitudeM:8000,speedMps:600/3.6,headingDeg:null,eastM:null,northM:null,distanceM:null,append:false}]};applyPlan(w,plan,w.revision);
 const reply=await assistant.checkResult({requestId:'terms-result',context:commandContext(w,u.id),plan,result:captureCommandResult(w)});assert.ok(reply.knowledgeUsed.some(f=>f.termIds?.includes('core-tas')));assert.equal(calls,2);assert.equal(assistant.health().status,'sleeping');
});
test('飞行员起飞候选选择也带词义，并保留候选边界',async()=>{
 const w=world();w.spawnAtStand('blue-1','G1');let calls=0;
 const assistant=new PilotAssistant('.',{provider:'cloud',runtimeFactory:()=>runtime(async(_role,messages)=>{calls++;assert.match(messages[0].content,/航空术语简释/);assert.match(messages[0].content,/BUSTER/);return {value:{decision:'execute',optionId:'option-1',message:'拟采用已校验的离场方案'},timing:{}};})});
 const reply=await assistant.planDeparture({requestId:'terms-departure',unitId:'blue-1',instruction:'起飞后按BUSTER要求飞行',context:commandContext(w,'blue-1'),options:[{id:'option-1',throttle:.9,afterburner:0,groundRollM:1500,climbSpeedMps:180,altitudeM:3000,points:[[0,0,500],[1000,0,3000]]}]});assert.equal(calls,1);assert.ok(reply.knowledgeUsed.some(f=>f.termIds?.includes('core-buster')));assert.equal(reply.optionId,'option-1');
});
test('HTTP可查词库来源和相关释义，不产生模型调用或GPU占用',async t=>{
 const server=createGameServer(readConfig({DASHSCOPE_API_KEY:'test-only'}),{fetchImpl:()=>{throw Error('不应推理');}});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});const base='http://127.0.0.1:'+server.address().port;
 const r=await fetch(base+'/api/tactical/terms?q=IAS&limit=3');assert.equal(r.status,200);const reply=await r.json();assert.ok(reply.total>2000);assert.ok(reply.terms.some(t=>t.id==='core-ias'));assert.equal(reply.loadMode,'on_demand');
 assert.equal((await fetch(base+'/api/tactical/terms?limit=999')).status,400);const health=await(await fetch(base+'/api/health')).json();assert.equal(health.pilotAssistant.modelCalls,0);
 const full=await(await fetch(base+'/api/tactical/handbook?id=aviation_faa')).json();assert.match(full.text,/FAA/);
});
