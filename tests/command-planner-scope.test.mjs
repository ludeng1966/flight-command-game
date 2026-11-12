import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Worker} from 'node:worker_threads';
import {World} from '../sim/world.js';
import {CommandPlanner} from '../game/command-planner.js';
import {commitPilotPlan} from '../sim/orders.js';
import {notePlayerOrder} from '../sim/command-scope.js';

const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const create=()=>new World({units:[
  {id:'blue-1',callsign:'ALPHA',profile:'f16',position:[0,0,6500],heading:0,speed:250},
  {id:'blue-2',callsign:'BRAVO',profile:'f16',position:[2000,0,6500],heading:0,speed:250}
]},profiles);
const plan=id=>({status:'accepted',summary:'继续搜索',tasks:[{unitId:id,action:'sensor_task',sensorTask:{goal:'search',targetId:null,targetRef:null}}]});
function factory(){
  const worker=new Worker(new URL('./helpers/command-planner-worker.mjs',import.meta.url));
  const bridge={postMessage:(...args)=>worker.postMessage(...args),terminate:()=>worker.terminate()};
  worker.on('message',data=>bridge.onmessage?.({data}));worker.on('error',error=>bridge.onerror?.(error));return bridge;
}

test('separate aircraft can prepare concurrently with isolated worker results',async t=>{
  const world=create(),planner=new CommandPlanner(null,{workerFactory:factory});t.after(()=>planner.cancel());
  const alpha=planner.request('prepare',world,{plan:plan('blue-1'),expectedRevision:0,options:{scoped:true}}),bravo=planner.request('prepare',world,{plan:plan('blue-2'),expectedRevision:0,options:{scoped:true}});
  assert.equal(planner.jobs.size,2);const [a,b]=await Promise.all([alpha,bravo]);
  assert.equal(a.plan.tasks[0].unitId,'blue-1');assert.equal(b.plan.tasks[0].unitId,'blue-2');
  assert.equal(a.world,world);assert.equal(b.world,world);assert.equal(a.committed,false);assert.equal(b.committed,false);
  assert.equal(planner.jobs.size,0);assert.equal(world.revision,0);assert.equal(world.units[0].radarTask,undefined);assert.equal(world.units[1].radarTask,undefined);
});

test('manual Alpha change rejects its worker while Bravo preparation and commit remain valid',async t=>{
  const world=create(),planner=new CommandPlanner(null,{workerFactory:factory});t.after(()=>planner.cancel());
  const alpha=planner.request('prepare',world,{plan:plan('blue-1'),expectedRevision:0,options:{scoped:true}}),bravo=planner.request('prepare',world,{plan:plan('blue-2'),expectedRevision:0,options:{scoped:true}});
  const alphaRejected=assert.rejects(alpha,/新操作/);
  notePlayerOrder(world,['blue-1']);world.revision++;
  const draft=await bravo;await alphaRejected;assert.equal(draft.expectedRevision,world.revision);
  commitPilotPlan(draft);assert.equal(world.units[1].radarTask.active,true);assert.equal(world.units[0].radarTask,undefined);
});

test('autonomous revision changes do not invalidate scoped worker preparation',async t=>{
  const world=create(),planner=new CommandPlanner(null,{workerFactory:factory});t.after(()=>planner.cancel());
  const result=planner.request('prepare',world,{plan:plan('blue-2'),expectedRevision:0,options:{scoped:true}});
  world.autonomousCommand=true;notePlayerOrder(world,['blue-2']);world.revision+=5;world.autonomousCommand=false;
  const draft=await result;assert.equal(draft.expectedRevision,5);commitPilotPlan(draft);assert.equal(world.units[1].radarTask.active,true);
});

test('aborting one worker does not terminate the other aircraft planning job',async t=>{
  const world=create(),planner=new CommandPlanner(null,{workerFactory:factory}),abort=new AbortController();t.after(()=>planner.cancel());
  const alpha=planner.request('prepare',world,{plan:plan('blue-1'),expectedRevision:0,options:{scoped:true}},abort.signal),bravo=planner.request('prepare',world,{plan:plan('blue-2'),expectedRevision:0,options:{scoped:true}});
  const rejected=assert.rejects(alpha,{name:'AbortError'});abort.abort();assert.equal(planner.jobs.size,1);
  const draft=await bravo;await rejected;assert.equal(draft.plan.tasks[0].unitId,'blue-2');assert.equal(planner.jobs.size,0);
});

test('battle task preparation avoids workers while retaining parameter, revision, and abort validation',async()=>{
  let workers=0;const world=create(),planner=new CommandPlanner(null,{workerFactory:()=>{workers++;throw Error('战斗任务无需航路worker');}});
  const sensor=plan('blue-1'),attack={status:'accepted',summary:'搜索并攻击前方目标',tasks:[{unitId:'blue-2',action:'attack_task',
    attackOrder:{targetId:null,targetRef:'前方目标',weaponRef:null,shotLimit:2,altitudeM:null,speedMps:null,headingDeg:null}}]};
  for(const order of [sensor,attack]){
    const draft=await planner.prepare(world,order,0,{scoped:true});assert.equal(draft.status,'prepared');assert.equal(draft.committed,false);
    assert.equal(draft.flightPlans.size,0);
    const abort=new AbortController();abort.abort();await assert.rejects(planner.prepare(world,order,0,{scoped:true},abort.signal),{name:'AbortError'});
    await assert.rejects(planner.prepare(world,order,1,{scoped:true}),/新操作/);
  }
  const invalidSensor=structuredClone(sensor);invalidSensor.tasks[0].sensorTask.goal='unsupported';
  const invalidAttack=structuredClone(attack);invalidAttack.tasks[0].attackOrder.shotLimit=-1;
  await assert.rejects(planner.prepare(world,invalidSensor,0,{scoped:true}));
  await assert.rejects(planner.prepare(world,invalidAttack,0,{scoped:true}));
  assert.equal(workers,0);assert.equal(planner.jobs.size,0);assert.equal(world.revision,0);
  assert.equal(world.units[0].radarTask,undefined);assert.equal(world.units[1].attackTask,undefined);
});
