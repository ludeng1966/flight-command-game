import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {World} from '../sim/world.js';
import {commandContext,applyPlan} from '../sim/orders.js';
import {loadEnv,readConfig} from '../server/game-server.mjs';
import {createQwenClient} from '../server/qwen.mjs';
import {createLocalAiClient} from '../server/local-ai-client.mjs';
import {LocalAiRuntime} from '../server/local-ai-runtime.mjs';
const root=new URL('../',import.meta.url),provider=process.argv[2]??'local';assert.ok(['cloud','local'].includes(provider));
loadEnv(fileURLToPath(new URL('.env',root)));const config=readConfig();
const scenario=JSON.parse(await readFile(new URL('data/scenarios/demo.json',root))),profiles=JSON.parse(await readFile(new URL('data/aircraft.json',root)));
const cloud=createQwenClient(config),runtime=provider==='local'?new LocalAiRuntime(fileURLToPath(root),{gpuLayers:config.localGpuLayers}):null,client=runtime?createLocalAiClient(runtime,cloud):cloud;
const cases=[
 {name:'掩护',text:'Bravo，掩护Alpha。',duty:'cover'},
 {name:'反向掩护',text:'Alpha，掩护Bravo。',duty:'cover',reverse:true},
 {name:'默认护航',text:'Bravo，护航Alpha。',duty:'escort',side:'right',range:1200},
 {name:'左侧护航间隔',text:'Bravo，护航Alpha，保持左侧，间隔2000米。',duty:'escort',side:'left',range:2000},
 {name:'长僚分工',text:'Alpha为长机，Bravo为僚机。',role:true},
 {name:'分工加掩护',text:'Alpha为长机，Bravo为僚机，Bravo掩护Alpha。',role:true,duty:'cover'},
 {name:'交换长僚',text:'Bravo为长机，Alpha为僚机，Alpha掩护Bravo。',role:true,duty:'cover',reverse:true},
 {name:'未知运输机',text:'Bravo，护航运输机。',clarify:true},
 {name:'不能掩护自己',text:'Bravo，掩护Bravo。',clarify:true}
];
const report={createdAt:new Date().toISOString(),provider,cases:[]};await mkdir(new URL('.game-server/',root),{recursive:true});
const save=()=>writeFile(new URL(`.game-server/protection-benchmark-${provider}.json`,root),JSON.stringify(report,null,2));
try{
 if(runtime){await runtime.start();assert.equal(runtime.health().status,'ready',runtime.health().error);}
 for(const c of cases){const row={name:c.name,instruction:c.text,passed:false},w=new World(scenario,profiles),started=performance.now();
  try{
   row.reply=await client.interpret({requestId:`protection-${provider}-${report.cases.length}`,instruction:c.text,context:commandContext(w,'blue-1')});
   const r=row.reply;if(c.clarify)assert.equal(r.execution.status,'needs_clarification');else{
    assert.equal(r.execution.status,'ready',r.plan.summary);const before=w.units.map(u=>[...u.position]);applyPlan(w,r.plan,w.revision);assert.deepEqual(w.units.map(u=>u.position),before);
    const lead=c.reverse?w.units[1]:w.units[0],wing=c.reverse?w.units[0]:w.units[1];assert.equal(wing.formation.leaderId,lead.id);
    if(c.duty)assert.equal(wing.formation.intent,c.duty);if(c.side)assert.equal(wing.formation.side,c.side);if(c.range)assert.equal(wing.formation.rangeM,c.range);
    if(c.role){assert.ok(r.plan.tasks.some(t=>t.action==='assign_role'));assert.equal(lead.flightRole.role,'lead');assert.equal(wing.flightRole.role,'wingman');}
   }row.passed=true;
  }catch(error){row.error=error.message;}
  row.elapsedMs=Math.round(performance.now()-started);report.cases.push(row);await save();console.log(JSON.stringify({provider,name:c.name,passed:row.passed,error:row.error}));
 }
}finally{if(runtime){report.runtime=runtime.health();await runtime.stop();}report.passed=report.cases.filter(c=>c.passed).length;report.total=cases.length;await save();}
console.log(JSON.stringify({provider,passed:report.passed,total:report.total}));if(report.passed!==report.total)process.exitCode=1;
