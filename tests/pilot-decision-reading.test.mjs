import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {decisionReading} from '../server/pilot-decision-reading.mjs';
import {readPilotFile} from '../server/pilot-handbook.mjs';
import {TACTICAL_AWARENESS_RULES} from '../server/tactical-awareness.mjs';
import {pilotReading} from '../server/pilot-handbook.mjs';
import {manualSection} from '../server/pilot-manual.mjs';
import {World} from '../sim/world.js';
import {commandContext} from '../sim/orders.js';
import {installAttackTask} from '../sim/attack-task.js';
import {installRadarTask} from '../sim/radar-task.js';
import {createAttackPilot} from '../server/attack-pilot.mjs';
import {createRadarPilot} from '../server/radar-pilot.mjs';

const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
function setup(){
  const world=new World({units:[{id:'a',callsign:'ALPHA',team:'blue',profile:'f16',position:[0,0,6500],heading:0,speed:250}]},profiles);
  world.time=5;return {world,unit:world.units[0]};
}
function shared(context){
  context.units[0].datalink.contacts=[{id:'DL:b:T1',kind:'track',sourceUnitId:'b',sourceTrackId:'T1',sourceCallsign:'BRAVO',callsign:'T1',classification:'unknown',position:[0,30000,6500],velocity:[0,-200,0],observedAt:4,receivedAt:4.5,positionErrorM:100,velocityErrorMps:5,fireControl:true,binding:'SECRET_TRUTH'}];
  return context;
}
test('role-specific cards have one evidence authority, bounded hot-path reading and a directly readable source',()=>{
  for(const role of ['attack','radar','defense']){
    const r=decisionReading(role,{datalink:{available:true}},{search:true});
    assert.equal(r.text.split(TACTICAL_AWARENESS_RULES).length,2);
    for(const file of r.files)assert(r.text.includes(readPilotFile(file.id).text.trim()));
    assert(r.chars<(role==='defense'?1500:2700));assert.match(r.version,/^[a-f0-9]{16}$/);
    assert.equal(r.files.some(f=>f.id==='decision_search'),role!=='defense');
    if(role!=='attack')assert(!r.files.some(f=>f.id==='decision_attack'));
  }
  const plain=decisionReading('attack',{},{}),search=decisionReading('attack',{},{search:true});
  assert.notEqual(plain.version,search.version);assert.equal(new Set(search.files.map(f=>f.file)).size,1);
  assert.throws(()=>decisionReading('commander',{}));
});
test('related command topics share a single copy of their rules and preserve the planning interface',()=>{
  const r=pilotReading('Alpha攻击前方目标并搜索、跟踪，武器自由');
  assert.equal(r.text.split(manualSection('orders')).length,2);
  assert(!r.text.includes('【参考文件：'));assert(!r.text.includes('message≤120'));
  assert(r.files.filter(f=>f.section).every(f=>f.file==='23_对局操作手册.txt'));
});
test('attack receives shared observations for search but they never enter its local targeting enum',async()=>{
  const {world,unit}=setup();
  installAttackTask(world,unit,{targetId:null,targetRef:null,weaponRef:null,shotLimit:2,altitudeM:null,speedMps:null,headingDeg:null});
  let calls=0;
  const pilot=createAttackPilot({async completePilot(messages,schema){
    calls++;const data=JSON.parse(messages[1].content);
    assert.equal(data.datalink.contacts[0].fireControl,false);assert.equal(data.contacts.length,0);
    assert(!schema.properties.targetId.enum.includes('DL:b:T1'));assert(!schema.properties.operation.enum.includes('launch'));
    assert(!messages[1].content.includes('SECRET_TRUTH'));assert.match(messages[0].content,/本机重探测/);
    return {value:{operation:'wait',mode:null,modelId:null,targetId:null,quantity:null,headingDeg:null,altitudeM:null,speedMps:null,message:'拟保持当前航段继续搜索'}};
  }});
  const result=await pilot({requestId:'reading-attack',unitId:unit.id,taskId:unit.attackTask.id,context:shared(commandContext(world,unit.id)),observation:{launchOptions:[],flights:[]}});
  assert.equal(calls,1);assert(result.knowledgeUsed.some(f=>f.id==='decision_search'));assert(result.promptVersion);
});
test('radar does not reuse a decision after delivered datalink observations change at the same task revision',async()=>{
  const {world,unit}=setup();installRadarTask(world,unit,{goal:'search',targetId:null,targetRef:null});
  const seen=[];const pilot=createRadarPilot({async completePilot(messages){
    seen.push(JSON.parse(messages[1].content).datalink.contacts.map(c=>c.id));
    return {value:{operation:'hold',mode:null,targetId:null,headingDeg:null,altitudeM:null,speedMps:null,scanPolicy:null,message:'拟保持扫描'}};
  }});
  const context=commandContext(world,unit.id),input={requestId:'reading-radar',unitId:unit.id,taskId:unit.radarTask.id,context};
  await pilot(input);await pilot(input);assert.equal(seen.length,1);
  shared(context);await pilot(input);assert.deepEqual(seen,[[],['DL:b:T1']]);
});
