import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {World} from '../sim/world.js';
import {commandContext,applyPlan} from '../sim/orders.js';

const base=process.env.BENCHMARK_GAME_URL||'http://127.0.0.1:8000',root=new URL('../',import.meta.url);
const scenario=JSON.parse(await readFile(new URL('data/scenarios/demo.json',root))),profiles=JSON.parse(await readFile(new URL('data/aircraft.json',root)));
const cases=[
  {name:'中文航向',instruction:'Alpha，航向两拐洞。',intents:['fly_heading'],heading:270},
  {name:'组合高度速度',instruction:'Alpha，航向九十度，高度八千米，速度六百公里每小时。',intents:['fly_heading'],heading:90,altitude:8000,speed:600/3.6,fly:true},
  {name:'独立高度',instruction:'二号机，爬升到九千米。',intents:['set_flight'],unit:'blue-2',altitude:9000},
  {name:'英语逐位航向',instruction:'Bravo, heading zero nine zero, maintain current altitude, proceed ten kilometers.',intents:['fly_heading'],unit:'blue-2',heading:90,altitude:6500,distance:10000},
  {name:'相对转向',instruction:'Alpha，向右转三十度。',intents:['fly_heading'],heading:30},
  {name:'全体盘旋',instruction:'全体，原地盘旋待命。',intents:['orbit'],all:true},
  {name:'测量值保持',instruction:'Alpha，保持当前高度和速度。',intents:['set_flight'],altitude:6500,speed:180},
  {name:'飞往标记',instruction:'Alpha，飞往标记点。',mapPoint:[15000,5000,8000],intents:['fly_to']},
  {name:'缺少标记',instruction:'Alpha，飞往标记点。',status:'needs_clarification'},
  {name:'未知呼号',instruction:'Delta，航向九十度。',status:'needs_clarification'},
  {name:'起飞后集合',instruction:'Alpha，二七跑道起飞，起飞后和Bravo集合。',intents:['takeoff','join_formation'],unavailable:true,sequence:true},
  {name:'条件防御',instruction:'Alpha，航向九十度，如果遭袭则立即防御。',intents:['fly_heading','defend'],unavailable:true,condition:true},
  {name:'FOX仅通报',instruction:'Alpha，FOX THREE。',intents:['report_event'],informational:true},
  {name:'交战规则',instruction:'全体，WEAPONS FREE。',intents:['weapons_free'],unavailable:true,all:true},
  {name:'雷达搜索模式',instruction:'Alpha，雷达切换搜索模式。',intents:['radar_mode'],unavailable:true},
  {name:'状态报告',instruction:'Alpha，报告本机状态。',intents:['report_status']},
  {name:'暂停',instruction:'暂停模拟。',intents:['pause']},
  {name:'多机分工',instruction:'Alpha，航向九十度；Bravo，航向二百七十度。',intents:['fly_heading','fly_heading'],split:true},
  {name:'额外过载约束',instruction:'Alpha，航向九十度，保持四G转弯。',intents:['fly_heading'],unavailable:true,constraints:true},
  {name:'复合指令重复',instruction:'Alpha，航向九十度，高度八千米，速度六百公里每小时。',intents:['fly_heading'],heading:90,altitude:8000,speed:600/3.6}
];
const report={createdAt:new Date().toISOString(),base,model:'Qwen3.5-2B-Q4_K_M',cases:[],measurement:'Process DedicatedUsage sampled by Windows CIM every >=500ms; excludes game renderer and shared system RAM'};
await mkdir(new URL('.game-server/',root),{recursive:true});
const save=()=>writeFile(new URL('.game-server/local-ai-benchmark.json',root),JSON.stringify(report,null,2));
const getHealth=async()=>{const response=await fetch(base+'/api/health');return response.json();};
let initial=await getHealth();assert.equal(initial.provider,'local');
for(let attempt=0;!initial.commandReady&&initial.ai?.status==='loading'&&attempt<180;attempt++){
  await new Promise(resolve=>setTimeout(resolve,500));initial=await getHealth();
}
assert.equal(initial.commandReady,true,initial.ai?.error||'Model is not ready');report.initialHealth=initial;
async function post(route,input){const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(70000)});
  const value=await response.json();if(!response.ok)throw Error(value.error||`HTTP ${response.status}`);return value;}
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<.02,`${actual} != ${expected}`);
for(const [index,c]of cases.entries()){
  const world=new World(scenario,profiles),context=commandContext(world,'blue-1',c.mapPoint??null),requestId=`bench-${Date.now()}-${index}`;
  const row={name:c.name,instruction:c.instruction,passed:false},started=performance.now();
  try{
    const reply=await post('/api/tactical/interpret',{requestId,instruction:c.instruction,context});row.commanderMs=Math.round(performance.now()-started);row.reply=reply;
    const interpretation=reply.interpretation;
    assert.equal(interpretation.status,c.status||'understood');
    if(c.intents)assert.deepEqual(interpretation.orders.map(o=>o.intent).sort(),[...c.intents].sort());
    if(c.unavailable)assert.equal(reply.execution.status,'capability_unavailable');
    if(c.informational)assert.equal(reply.execution.status,'informational');
    if(c.sequence)assert.equal(interpretation.orders[1].timing,'after_previous');
    if(c.condition){const order=interpretation.orders.find(o=>o.intent==='defend');assert.equal(order.timing,'on_condition');assert.ok(order.condition);assert.equal(reply.plan.tasks.length,0);}
    if(c.constraints)assert.ok(interpretation.orders[0].parameters.constraints);
    if(c.all)assert.deepEqual([...new Set(interpretation.orders.flatMap(o=>o.unitIds))].sort(),['blue-1','blue-2']);
    if(c.split){assert.equal(interpretation.orders.find(o=>o.unitIds.includes('blue-1')).parameters.headingDeg,90);assert.equal(interpretation.orders.find(o=>o.unitIds.includes('blue-2')).parameters.headingDeg,270);}
    const task=reply.plan.tasks[0];
    if(c.heading!==undefined)near(task.headingDeg,c.heading);if(c.altitude!==undefined)near(task.altitudeM,c.altitude);if(c.speed!==undefined)near(task.speedMps,c.speed);if(c.distance!==undefined)near(task.distanceM,c.distance);if(c.unit)assert.equal(task.unitId,c.unit);
    if(reply.plan.status==='accepted'){
      const before=JSON.stringify(world),pilotAt=performance.now();
      row.pilot=await post('/api/tactical/pilot',{requestId,plan:reply.plan,context});row.pilotMs=Math.round(performance.now()-pilotAt);assert.equal(row.pilot.review.decision,'accept');
      assert.equal(JSON.stringify(world),before);const positions=world.units.map(u=>[...u.position]);applyPlan(world,reply.plan,world.revision);
      assert.deepEqual(world.units.map(u=>u.position),positions);row.applied=true;
      if(c.fly){for(let i=0;i<240*60;i++)world.step(1/60);const u=world.units[0];row.flown={altitudeM:u.position[2],speedKph:u.speed*3.6,headingDeg:(Math.atan2(u.velocity[0],u.velocity[1])*180/Math.PI+360)%360,alive:u.alive};assert.equal(u.alive,true);near(Math.round(u.position[2]/50)*50,8000);assert.ok(Math.abs(u.speed*3.6-600)<5);assert.ok(Math.abs(row.flown.headingDeg-90)<1);}
    }
    row.passed=true;
  }catch(error){row.error=error.message;}
  row.totalMs=Math.round(performance.now()-started);row.memory=(await getHealth()).ai?.memory;report.cases.push(row);await save();
  console.log(JSON.stringify({name:row.name,passed:row.passed,commanderMs:row.commanderMs,pilotMs:row.pilotMs,error:row.error,peakMiB:row.memory?.peakDedicatedMiB}));
}
report.finalHealth=await getHealth();
const summary=values=>{const sorted=values.sort((a,b)=>a-b);return {count:sorted.length,minMs:sorted[0],medianMs:sorted[Math.floor(sorted.length/2)],p95Ms:sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*.95)-1)],maxMs:sorted.at(-1)};};
report.summary={passed:report.cases.filter(c=>c.passed).length,total:cases.length,commander:summary(report.cases.map(c=>c.commanderMs).filter(Number.isFinite)),pilot:summary(report.cases.map(c=>c.pilotMs).filter(Number.isFinite)),peakDedicatedMiB:report.finalHealth.ai?.memory?.peakDedicatedMiB};
await save();console.log(JSON.stringify(report.summary));
if(report.summary.peakDedicatedMiB>=1900||report.summary.passed!==report.summary.total)process.exitCode=1;
