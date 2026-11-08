// Synthetic missions exercise the event-driven 2B endpoint without editing the live game.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {World} from '../sim/world.js';
import {commandContext} from '../sim/orders.js';
import {pilotObservation} from '../sim/pilot-watch.js';
const root=new URL('../',import.meta.url),base=process.env.BENCHMARK_GAME_URL||'http://127.0.0.1:8000';
const scenario=JSON.parse(await readFile(new URL('data/scenarios/demo.json',root))),profiles=JSON.parse(await readFile(new URL('data/aircraft.json',root)));
const report={createdAt:new Date().toISOString(),source:'Synthetic mission events: advanced cooperation requires notification; implemented cover runs without a background model call',cases:[]};
for(const [intent,parameters]of [['cooperate',{mode:'loose_deuce'}],['cooperate',{mode:'thach_weave'}],['cover',{targetId:'blue-2'}]]){
  const w=new World(scenario,profiles),u=w.units[0],index=report.cases.length;
  u.pilotMission={id:`formation-live-${index}`,intent,timing:'now',condition:null,parameters,revision:w.revision};
  const started=performance.now(),response=await fetch(base+'/api/tactical/pilot/assess',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({requestId:`formation-pilot-${index}`,context:commandContext(w,u.id),observation:pilotObservation(w,u)??{unitId:u.id,mission:u.pilotMission,contacts:[],blockedSince:null,blockedReason:null}}),signal:AbortSignal.timeout(120000)});
  const reply=await response.json();assert.equal(response.status,200,reply.error);assert.equal(reply.modelInvoked,intent!=='cover');
  if(intent!=='cover'){assert.ok(reply.knowledgeUsed.some(f=>f.id==='formation_compact'));assert.ok(!reply.knowledgeUsed.some(f=>f.id==='formation'));}
  assert.equal(reply.assessment.decision,intent==='cover'?'continue_autopilot':'notify_commander');assert.deepEqual(reply.assessment.missingData,[]);
  const health=await(await fetch(base+'/api/health')).json();assert.equal(health.pilotAssistant.status,'sleeping');assert.equal(health.pilotAssistant.memory.dedicatedMiB,0);
  report.cases.push({intent,parameters,elapsedMs:Math.round(performance.now()-started),reply,after:health.pilotAssistant});
  await writeFile(new URL('.game-server/formation-pilot-live.json',root),JSON.stringify(report,null,2));
  console.log(JSON.stringify({intent,parameters,decision:reply.assessment.decision,message:reply.assessment.message,inferenceMs:reply.timing?.inferenceMs,after:'sleeping'}));
}
console.log(JSON.stringify({passed:report.cases.length,total:3}));
