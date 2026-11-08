// Live semantic checks. Explicitly selects cloud/local, never switches providers on failure.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {World} from '../sim/world.js';
import {commandContext} from '../sim/orders.js';
import {loadEnv,readConfig} from '../server/game-server.mjs';
import {createQwenClient} from '../server/qwen.mjs';
import {createLocalAiClient} from '../server/local-ai-client.mjs';
import {LocalAiRuntime} from '../server/local-ai-runtime.mjs';
const root=new URL('../',import.meta.url),provider=process.argv[2]||'cloud';
assert.ok(['cloud','local'].includes(provider),'Use cloud or local');
loadEnv(fileURLToPath(new URL('.env',root)));
const config=readConfig(),scenario=JSON.parse(await readFile(new URL('data/scenarios/demo.json',root))),profiles=JSON.parse(await readFile(new URL('data/aircraft.json',root)));
const runtime=provider==='local'?new LocalAiRuntime(fileURLToPath(root),{gpuLayers:config.localGpuLayers}):null;
const cloud=createQwenClient(config),client=runtime?createLocalAiClient(runtime,cloud):cloud;
const cases=[
  {name:'右梯队与间隔',text:'Bravo，加入Alpha右梯队，间隔两公里。',orders:[['join_formation','blue-2',{targetId:'blue-1',formation:'echelon',side:'right',rangeM:2000}]]},
  {name:'横队',text:'全体，改为左右横队，间隔一公里。',orders:[['formation_change',null,{formation:'line_abreast',rangeM:1000}]]},
  {name:'双机楔形',text:'全体，改为楔形编队。',orders:[['formation_change',null,{formation:'wedge'}]]},
  {name:'双机自由配合',text:'全体，采用双机自由配合。',orders:[['cooperate',null,{mode:'loose_deuce'}]]},
  {name:'角色分工',text:'Alpha为长机，Bravo为僚机。',orders:[['assign_role','blue-1',{role:'lead'}],['assign_role','blue-2',{role:'wingman'}]]},
  {name:'攻防对象分离',text:'Alpha攻击敌机一号；Bravo掩护Alpha，同时进行。',orders:[['attack','blue-1',{targetRef:'敌机一号'}],['cover','blue-2',{targetId:'blue-1'}]]},
  {name:'萨奇剪',text:'全体，采用萨奇剪交叉掩护。',orders:[['cooperate',null,{mode:'thach_weave'}]]},
  {name:'四指人数不足',text:'Alpha和Bravo两架飞机，改为四指队形。',clarify:true},
  {name:'导航回归',text:'Alpha，航向270，高度8000米，速度600公里每小时。',orders:[['fly_heading','blue-1',{headingDeg:270,altitudeM:8000}]],ready:true}
];
const report={provider,model:runtime?'Qwen3.5-2B-Q4_K_M':config.commandModel,createdAt:new Date().toISOString(),cases:[]};
await mkdir(new URL('.game-server/',root),{recursive:true});
const save=()=>writeFile(new URL(`.game-server/formation-benchmark-${provider}.json`,root),JSON.stringify(report,null,2));
try{
  if(runtime){await runtime.start();assert.equal(runtime.health().status,'ready',runtime.health().error);}
  for(const c of cases){
    const at=performance.now(),row={name:c.name,instruction:c.text,passed:false};
    try{
      row.reply=await client.interpret({requestId:`formation-${provider}-${report.cases.length}`,instruction:c.text,context:commandContext(new World(scenario,profiles),'blue-1')});
      const reply=row.reply,orders=reply.interpretation.orders;
      if(c.clarify)assert.equal(reply.execution.status,'needs_clarification');
      else{
        assert.equal(reply.interpretation.status,'understood');assert.equal(orders.length,c.orders.length);
        for(const [intent,unit,params]of c.orders){
          const o=orders.find(o=>o.intent===intent&&(!unit||o.unitIds.length===1&&o.unitIds[0]===unit));assert.ok(o,`${intent}:${unit}`);
          if(!unit)assert.deepEqual([...o.unitIds].sort(),['blue-1','blue-2']);
          for(const [k,v]of Object.entries(params))assert.deepEqual(o.parameters[k],v,k);
          assert.equal(o.timing,'now');
        }
        const ready=c.ready||['join_formation','formation_change','follow_unit','assign_role','cover','escort'].includes(c.orders[0][0]);
        assert.equal(reply.execution.status,ready?'ready':'capability_unavailable');
        if(!ready)assert.equal(reply.plan.tasks.length,0);
      }
      row.passed=true;
    }catch(error){row.error=error.message;}
    row.elapsedMs=Math.round(performance.now()-at);report.cases.push(row);await save();
    console.log(JSON.stringify({provider,name:row.name,passed:row.passed,elapsedMs:row.elapsedMs,error:row.error}));
  }
}finally{
  if(runtime){report.runtime=runtime.health();await runtime.stop();}
  report.passed=report.cases.filter(c=>c.passed).length;report.total=cases.length;await save();
}
console.log(JSON.stringify({provider,passed:report.passed,total:report.total}));
if(report.passed!==report.total)process.exitCode=1;
