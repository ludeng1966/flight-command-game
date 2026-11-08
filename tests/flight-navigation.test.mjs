import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {TerrainHeight} from '../sim/terrain.js';
import {aeroAt,atmosphere,thrustAt,dryFraction,throttleForFraction,stepFlight} from '../sim/flight.js';
import {energyEnvelope,controlEnergy} from '../sim/energy.js';
import {runJob} from '../sim/planner-worker.js';
import {plannerUnit,PlannerClient} from '../game/planner-client.js';
import {throughWaypoints} from '../sim/route-continuity.js';
import {RouteReplanner,routeDraft} from '../game/route-replanner.js';

const read=name=>JSON.parse(fs.readFileSync(new URL(name,import.meta.url)));
const profiles=read('../data/aircraft.json'),scenario=read('../data/scenarios/demo.json');
const bytes=fs.readFileSync(new URL('../terrain/air_skyscraper_city_height.f32',import.meta.url));
const terrain=new TerrainHeight(read('../terrain/air_skyscraper_city_height.json'),new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4));
const run=(world,until,seconds=900)=>{for(let i=0;i<seconds*60&&!until();i++)world.step(1/60);};

test('马赫数系数在临界点连续，加力推力随高度和速度变化',()=>{
  const p=profiles.f16,h=10000,sound=atmosphere(h).soundSpeed;
  for(const m of [.7,.85,.9,.96,1,1.05,1.3,1.4]){
    const a=aeroAt(p,h,(m-1e-6)*sound),b=aeroAt(p,h,(m+1e-6)*sound);
    for(const key of ['cd0','clAlpha','clMax'])assert(Math.abs(a[key]-b[key])<.0001);
    assert(thrustAt(p,h,m*sound,1)>thrustAt(p,h,m*sound));
  }
  assert(aeroAt(p,h,sound).cd0>aeroAt(p,h,.7*sound).cd0);
  assert(atmosphere(15000).density<atmosphere(11000).density);
});

test('电脑自动开加力跨过音速，并在降低速度需求后退出',()=>{
  const w=new World(scenario,profiles),u=w.units[0];u.targetSpeed=1600/3.6;let peak=0;
  for(let i=0;i<240*60;i++){w.step(1/60);peak=Math.max(peak,u.afterburner);assert(!u.stalled);}
  assert(peak>.9);assert(u.mach>1.2);
  u.targetSpeed=650/3.6;run(w,()=>u.speed<185&&u.afterburner<.02,240);
  assert(u.afterburner<.02);assert(u.speed<185);
});

test('近乎正上方的目标由盘旋爬升到达，不修改真实状态做预估',()=>{
  const w=new World(scenario,profiles,terrain),u=w.units[0],goal=[-8000,-7000,10000],before=JSON.stringify(u);
  const forecast=w.planRoute(u.id,[goal]);assert(forecast.valid);assert(forecast.detour);assert.equal(JSON.stringify(u),before);
  w.command(u.id,goal);run(w,()=>u.completedWaypoints===1||!u.alive);
  assert(u.alive);assert.equal(u.completedWaypoints,1);assert.equal(u.flightState,'normal');
});

test('实际山脉阻断直线时生成替代航路，并安全到达',()=>{
  const s=structuredClone(scenario);s.units[0].position=[2000,-9000,terrain.heightAt(2000,-9000)+1200];s.units[0].heading=90;
  const goal=[22000,-9000,terrain.heightAt(22000,-9000)+1200],w=new World(s,profiles,terrain),u=w.units[0];
  assert.equal(terrain.checkSegment(u.position,goal).valid,false);assert(w.planRoute(u.id,[goal]).valid);
  w.command(u.id,goal);let minAgl=Infinity;
  for(let i=0;i<900*60&&u.waypoints.length&&u.alive;i++){w.step(1/60);minAgl=Math.min(minAgl,u.position[2]-terrain.heightAt(u.position[0],u.position[1]));assert(!u.stalled);}
  assert(u.alive);assert.equal(u.completedWaypoints,1);assert(minAgl>100);
});

test('航路编辑、删除及撤销重做保留飞机物理状态；地下航点不提交',()=>{
  const w=new World(scenario,profiles,terrain),u=w.units[0],position=[...u.position],velocity=[...u.velocity];
  w.replaceRoute(u.id,[[-8000,3000,6500],[0,7000,7000]]);w.moveWaypoint(u.id,0,[-7000,3000,6800]);
  assert(w.undoRoute(u.id));assert.equal(u.waypoints[0][2],6500);assert(w.undoRoute(u.id,true));assert.equal(u.waypoints[0][2],6800);
  const route=JSON.stringify(u.waypoints);assert.throws(()=>w.moveWaypoint(u.id,0,[0,0,-100]));assert.equal(JSON.stringify(u.waypoints),route);
  w.replaceRoute(u.id,u.waypoints.slice(1));assert.equal(u.waypoints.length,1);assert(w.undoRoute(u.id));assert.equal(u.waypoints.length,2);
  assert.deepEqual(u.position,position);assert.deepEqual(u.velocity,velocity);
});

test('载荷能量包线限制无法维持的4G机动，低能量时先卸载增速',()=>{
  const w=new World(scenario,profiles),u=w.units[0],envelope=energyEnvelope(u.profile,6500,180);
  assert(envelope.dragFor(4)>envelope.maximum);assert(envelope.budgetG<4);
  assert(Math.abs(envelope.safeSpeed(4)/envelope.safeSpeed(1)-2)<1e-10);
  const result=controlEnergy(u,{gamma:.2,loadFactor:4,targetSpeed:180},.1);
  assert(result.underSpeed);assert(result.gamma<=.015);assert.equal(result.afterburner,1);
  assert(u.effectiveTargetSpeed>180);assert.match(u.energyReason,/保护/);
});

test('军推以下使用现有发动机模式反算油门，慢车仍有推力',()=>{
  const p=profiles.f16;assert(dryFraction(p,0)>0);
  for(const fraction of [.05,.15,.4,.8,1])assert(Math.abs(dryFraction(p,throttleForFraction(p,fraction))-fraction)<1e-9);
  const w=new World(scenario,profiles),u=w.units[0];for(let i=0;i<180*60;i++)w.step(1/60);
  assert(Math.abs(u.speed-180)<1);assert(Math.abs(u.position[2]-6500)<30);assert(u.afterburner<.01);
  assert(u.thrustN<thrustAt(u.profile,u.position[2],u.speed)*.8);assert(Math.abs(u.energyRate)<1);
});

test('普通爬升优先直接到达，近侧目标也不再固定补整圈',()=>{
  for(const [goal,maxLength] of [[[-8000,3000,8000],12000],[[-7000,-7000,6500],9000]]){
    const w=new World(scenario,profiles),plan=w.planRoute('blue-1',[goal]);assert(plan.valid);assert(plan.routeLength<maxLength);
    assert(plan.legs.every(leg=>leg.every(p=>p.every(Number.isFinite))));
  }
});

test('后台快照与真实控制器隔离，已验证的新鲜结果可直接提交',()=>{
  const w=new World(scenario,profiles,terrain),u=w.units[0],route=[[-8000,3000,8000]],snapshot=plannerUnit(u);
  snapshot.energy.integral=123;assert.notEqual(u.energy.integral,123);
  const job={type:'plan',unit:plannerUnit(u),route},before=JSON.stringify(u),plan=runJob(job,terrain);
  assert(plan.valid);assert.equal(JSON.stringify(u),before);
  w.planRoute=()=>{throw Error('提交不得再次同步完整试飞');};w.command(u.id,route[0],false,plan);assert.equal(u.waypoints.length,1);
  u.position=[u.position[0]+2000,u.position[1],u.position[2]];assert.throws(()=>w.resolvePlan(u,route,plan),/重新规划/);
});

test('提交独立于积压预览，排队任务在发送时读取最新姿态',async()=>{
  const PreviousWorker=globalThis.Worker,workers=[];
  globalThis.Worker=class {constructor(){workers.push(this);this.sent=[];}postMessage(job){this.sent.push(job);}};
  try{
    const client=new PlannerClient(terrain),worker=workers[0],u=new World(scenario,profiles).units[0];
    const a=client.request('live',u,[[0,1000,6500]],'trace'),b=client.request('preview',u,[[1,2000,6500]]),c=client.request('preview',u,[[2,3000,6500]]),commit=client.request('commit',u,[[3,4000,6500]]);
    assert.equal(await b,null);assert.equal(worker.sent.length,2);
    const commitWorker=workers[1];assert.equal(commitWorker.sent.at(-1).channel,'commit');
    commitWorker.onmessage({data:{id:commitWorker.sent.at(-1).id,result:{valid:true}}});assert((await commit).valid);
    u.position[0]+=30;u.bank=.4;
    const active=worker.sent.at(-1);worker.onmessage({data:{id:active.id,result:{valid:true}}});assert((await a).valid);
    assert.equal(worker.sent.at(-1).route[0][0],2);assert.equal(worker.sent.at(-1).unit.bank,.4);assert.equal(worker.sent.at(-1).unit.position[0],u.position[0]);
    worker.onmessage({data:{id:worker.sent.at(-1).id,result:{valid:true}}});assert((await c).valid);
  }finally{globalThis.Worker=PreviousWorker;}
});

test('连续直角航路在到点前建立转弯，依次穿过所有到达范围',()=>{
  const w=new World(scenario,profiles,terrain),u=w.units[0],goals=[[-8000,-1000,6500],[-1000,-1000,6500],[-1000,7000,6500]];
  const plan=w.replaceRoute(u.id,goals);assert(plan.continuous);
  let length=0,anticipatoryBank=0,minSpeed=Infinity,maxG=0,passed=0;const distances=goals.map(()=>Infinity),crossings=[];
  for(let i=0;i<240*60&&u.waypoints.length&&u.alive;i++){
    const before=[...u.position];w.step(1/60);length+=Math.hypot(...u.position.map((v,k)=>v-before[k]));minSpeed=Math.min(minSpeed,u.speed);maxG=Math.max(maxG,u.loadFactor);
    goals.forEach((g,k)=>{distances[k]=Math.min(distances[k],Math.hypot(...g.map((v,j)=>v-u.position[j])));});
    if(!u.completedWaypoints&&Math.hypot(...u.position.map((v,k)=>v-goals[0][k]))>1000)anticipatoryBank=Math.max(anticipatoryBank,Math.abs(u.bank));
    if(u.completedWaypoints!==passed){crossings.push({bank:u.bank,time:w.time});passed=u.completedWaypoints;}
    assert(!u.stalled);
  }
  assert(u.alive);assert.equal(u.completedWaypoints,3);assert(distances.every(d=>d<=250));assert(length<23500);
  assert(anticipatoryBank>15*Math.PI/180);assert(Math.abs(crossings[0].bank)>25*Math.PI/180);
  assert(minSpeed>160);assert(maxG<3.5);assert(crossings[2].time<135);
});

test('连续爬升不在中间航点逐点改平，控制状态不因切换重置',()=>{
  const w=new World(scenario,profiles),u=w.units[0],goals=[[-8000,-1000,6800],[-8000,6000,7300],[-8000,14000,7800]];
  assert(w.replaceRoute(u.id,goals).continuous);let passed=0;const climb=[];
  for(let i=0;i<180*60&&u.waypoints.length;i++){
    const energy=u.energy,guidance=u.guidance,speedRef=energy.speedRef,gamma=energy.gammaRef;w.step(1/60);
    if(u.completedWaypoints!==passed){assert.equal(u.energy,energy);assert.equal(u.guidance,guidance);assert(Math.abs(energy.speedRef-speedRef)<.4);assert(Math.abs(energy.gammaRef-gamma)<.004);climb.push(u.velocity[2]);passed=u.completedWaypoints;}
  }
  assert.equal(u.completedWaypoints,3);assert(climb[0]>7&&climb[1]>7);assert(Math.abs(u.speed-180)<3);
});

test('连续升降和交替转弯保持航点顺序及真实地形净空',()=>{
  const w=new World(scenario,profiles,terrain),u=w.units[0],goals=[[-6500,-1000,6800],[-1000,2000,7500],[-4000,8500,7000],[3000,13000,7800]];
  const before=JSON.stringify(u),plan=w.planRoute(u.id,goals);assert(plan.valid&&plan.continuous);assert.equal(JSON.stringify(u),before);
  w.replaceRoute(u.id,goals);let minAgl=Infinity,length=0;
  for(let i=0;i<240*60&&u.waypoints.length&&u.alive;i++){
    const b=[...u.position];w.step(1/60);length+=Math.hypot(...u.position.map((v,k)=>v-b[k]));minAgl=Math.min(minAgl,u.position[2]-terrain.heightAt(u.position[0],u.position[1]));assert(!u.stalled);
  }
  assert(u.alive);assert.equal(u.completedWaypoints,4);assert(minAgl>100);assert(length<31000);
});

test('后台前视保留已进入航点范围的证据，避免门点之后重新掉头',()=>{
  const w=new World(scenario,profiles),u=w.units[0],goal=[-8000,-1000,6500];
  u.waypoints=[goal];u.navLegs=throughWaypoints(u,[goal]);u.gateEntered=goal;u.position=[-8000,-700,6500];
  const snapshot=plannerUnit(u,true);assert(snapshot.gateCaptured);
  const trace=runJob({type:'trace',unit:snapshot,route:[goal]},null);assert(trace.completed);assert(trace.time<17);
  assert.equal(u.waypoints.length,1);assert.equal(u.gateEntered,goal);
});

test('滚转中追加远端航点保留当前航段和控制状态，不额外绕圈',()=>{
  const goals=[[-8000,-1000,6500],[-1000,-1000,6500],[-1000,7000,6500]],w=new World(scenario,profiles,terrain),u=w.units[0];
  w.replaceRoute(u.id,goals);run(w,()=>w.time>=25,30);assert(u.bank>.4);
  const position=[...u.position],velocity=[...u.velocity],bank=u.bank,energy=u.energy,guidance=u.guidance,control=u.control;
  const remaining=u.navLegs[0].slice(u.navCursor),plan=w.command(u.id,[6000,12000,7500],true);
  assert(plan.continuous);assert(plan.routeLength<27500);assert.deepEqual(u.navLegs[0],remaining);
  assert.deepEqual(u.position,position);assert.deepEqual(u.velocity,velocity);assert.equal(u.bank,bank);assert.equal(u.energy,energy);assert.equal(u.guidance,guidance);assert.equal(u.control,control);
  let previous=bank,maxStep=0,maxG=0,minSpeed=Infinity,travel=0;const passed=[];
  for(let i=0;i<200*60&&u.waypoints.length&&u.alive;i++){
    const before=[...u.position],completed=u.completedWaypoints;w.step(1/60);
    travel+=Math.hypot(...u.position.map((v,k)=>v-before[k]));if(completed!==u.completedWaypoints)passed.push(u.completedWaypoints);
    maxStep=Math.max(maxStep,Math.abs(u.bank-previous));previous=u.bank;maxG=Math.max(maxG,u.loadFactor);minSpeed=Math.min(minSpeed,u.speed);assert(!u.stalled);
  }
  assert(u.alive);assert.equal(u.completedWaypoints,4);assert.deepEqual(passed,[1,2,3,4]);
  assert(maxStep<.02);assert(maxG<3.5);assert(minSpeed>160);assert(travel<27500);assert(w.time<180);
});

test('10Hz滚转目标分摊到物理帧，30/60/120Hz均保持连续响应',()=>{
  const results=[];
  for(const fps of [30,60,120]){
    const u=new World(scenario,profiles).units[0],target=.05;u.control.bank=target;
    stepFlight(u,1/fps);assert(u.bank>0&&u.bank<target/2);
    let previous=u.bank;
    for(let i=1;i<fps;i++){stepFlight(u,1/fps);assert(u.bank>=previous&&u.bank<target);assert(u.bank-previous<u.profile.bankRate/fps);previous=u.bank;}
    assert(Math.abs(u.bank-target)<.001);results.push(u.bank);
  }
  assert(Math.max(...results)-Math.min(...results)<1e-6);
});

test('左右转弯及过点前后追加航点，均按序通过且实际航迹不多绕圈',()=>{
  for(const {at,side}of [{at:10,side:1},{at:35,side:1},{at:25,side:-1},{at:50,side:-1}]){
    const w=new World(scenario,profiles,terrain),u=w.units[0];
    w.replaceRoute(u.id,[[-8000,-1000,6500],[-8000+7000*side,-1000,6500],[-8000+7000*side,7000,6500]]);run(w,()=>w.time>=at,at+1);
    const completed=u.completedWaypoints,start=w.time,before=structuredClone({position:u.position,velocity:u.velocity,bank:u.bank}),energy=u.energy,guidance=u.guidance;
    const plan=w.command(u.id,[-8000+14000*side,12000,7500],true);
    assert.deepEqual({position:u.position,velocity:u.velocity,bank:u.bank},before);assert.equal(u.energy,energy);assert.equal(u.guidance,guidance);
    let travel=0,previous=u.bank,maxStep=0,minAgl=Infinity;const passed=[];
    for(let i=0;i<200*60&&u.waypoints.length&&u.alive;i++){
      const position=[...u.position],count=u.completedWaypoints;w.step(1/60);travel+=Math.hypot(...u.position.map((v,k)=>v-position[k]));
      maxStep=Math.max(maxStep,Math.abs(u.bank-previous));previous=u.bank;minAgl=Math.min(minAgl,u.position[2]-terrain.heightAt(u.position[0],u.position[1]));
      if(count!==u.completedWaypoints)passed.push(u.completedWaypoints);assert(!u.stalled);
    }
    assert(u.alive);assert.deepEqual(passed,Array.from({length:4-completed},(_,i)=>completed+i+1));
    assert(maxStep<.02);assert(travel<plan.routeLength*1.03+250);assert(w.time-start<180);assert(minAgl>100);
  }
});

test('转弯中拖动当前航点从真实姿态衔接，维持航点顺序且不补整圈',()=>{
  const w=new World(scenario,profiles,terrain),u=w.units[0];w.replaceRoute(u.id,[[-8000,-1000,6500],[-1000,-1000,6500],[-1000,7000,6500]]);
  run(w,()=>w.time>=25,30);const start=w.time,position=[...u.position],bank=u.bank;
  const plan=w.moveWaypoint(u.id,0,[-7000,-500,6800]);assert(plan.continuous);assert(plan.routeLength<18500);assert.deepEqual(plan.legs[0][0],position);assert.equal(u.bank,bank);
  let maxG=0;for(let i=0;i<150*60&&u.waypoints.length&&u.alive;i++){w.step(1/60);maxG=Math.max(maxG,u.loadFactor);assert(!u.stalled);}
  assert(u.alive);assert.equal(u.completedWaypoints,3);assert(w.time-start<105);assert(maxG<4);
});

test('等待追加规划期间通过的航点被剔除，旧结果不导致回头',async()=>{
  const w=new World(scenario,profiles),u=w.units[0];w.replaceRoute(u.id,[[-8000,-3000,6500],[-8000,5000,7000]]);
  const pending=[],planner={request(channel,unit,route){return new Promise(resolve=>pending.push({unit:plannerUnit(unit,true),route:structuredClone(route),resolve}));}};
  const edits=new RouteReplanner({getWorld:()=>w,planner}),task=edits.apply(u.id,{kind:'append',point:[-3000,12000,7500]});
  run(w,()=>u.completedWaypoints===1,40);assert.equal(u.completedWaypoints,1);
  pending[0].resolve({valid:false,reason:'旧路线已经过期'});await Promise.resolve();assert.equal(pending.length,2);assert.equal(pending[1].route.length,2);assert.deepEqual(pending[1].route[0],[-8000,5000,7000]);
  pending[1].resolve(runJob({type:'plan',...pending[1]}));const accepted=await task;assert(accepted.valid);
  assert.equal(w.prediction.points,accepted.points);assert.equal(w.prediction.unitId,u.id);assert(w.prediction.points.length>2);
  assert.equal(u.waypoints[0].number,2);assert.equal(u.waypoints[1].number,3);
  run(w,()=>u.completedWaypoints===3||!u.alive,180);assert(u.alive);assert.equal(u.completedWaypoints,3);
});

test('旧拖动结果不会覆盖较新的编辑；局部草稿自动移除等待期间经过的前缀',async()=>{
  const w=new World(scenario,profiles),u=w.units[0];w.replaceRoute(u.id,[[-8000,-3000,6500],[-8000,5000,7000]]);
  const pending=[],planner={request(channel,unit,route){return new Promise(resolve=>pending.push({unit:plannerUnit(unit,true),route:structuredClone(route),resolve}));}};
  const edits=new RouteReplanner({getWorld:()=>w,planner}),draft=routeDraft(u,[u.waypoints[0],[-6000,6000,7400]]);
  const older=edits.apply(u.id,{kind:'move',reference:u.waypoints[1],point:[-7000,5000,7200]}),newer=edits.apply(u.id,{kind:'replace',draft});
  pending[0].resolve({valid:false});assert.equal(await older,null);
  run(w,()=>u.completedWaypoints===1,40);pending[1].resolve({valid:false});await Promise.resolve();assert.equal(pending.length,3);assert.deepEqual(pending[2].route,[[-6000,6000,7400]]);
  pending[2].resolve(runJob({type:'plan',...pending[2]}));assert((await newer).valid);assert.deepEqual(u.waypoints[0].slice(0,3),[-6000,6000,7400]);
});

test('后台结果允许从已沿路径前进的当前位置接入，跳过旧起点而不瞬移',()=>{
  const w=new World(scenario,profiles),u=w.units[0];w.replaceRoute(u.id,[[-8000,-1000,6500],[-1000,-1000,6500],[-1000,7000,6500]]);
  run(w,()=>w.time>=20,25);const goal=[6000,12000,7500],route=[...u.waypoints.map(p=>p.slice(0,3)),goal];
  const plan=runJob({type:'plan',unit:plannerUnit(u,true),route});run(w,()=>w.time>=23,5);const position=[...u.position];
  w.planRoute=()=>{throw Error('不应在主线程再次完整试飞');};w.command(u.id,goal,true,plan);
  assert(u.navCursor>0);assert.deepEqual(u.position,position);assert(u.waypoints.length===4);
});

test('同机新编辑终止尚未完成的旧提交，旧后台回包不能占用新结果',async()=>{
  const PreviousWorker=globalThis.Worker,workers=[];
  globalThis.Worker=class {constructor(){workers.push(this);this.sent=[];}postMessage(job){this.sent.push(job);}terminate(){this.stopped=true;}};
  try{
    const client=new PlannerClient(terrain),u=new World(scenario,profiles).units[0],old=client.request('commit:'+u.id,u,[[-8000,3000,6500]]),first=workers[1];
    u.bank=.5;const newer=client.request('commit:'+u.id,u,[[-4000,4000,7000]]),next=workers[2];
    assert.equal(await old,null);assert(first.stopped);assert.equal(next.sent.at(-1).unit.bank,.5);
    first.onmessage({data:{id:first.sent.at(-1).id,result:{valid:false}}});
    next.onmessage({data:{id:next.sent.at(-1).id,result:{valid:true}}});assert((await newer).valid);
  }finally{globalThis.Worker=PreviousWorker;}
});
