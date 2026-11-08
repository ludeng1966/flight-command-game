import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {TerrainHeight} from '../sim/terrain.js';
import {TRAINING_MISSIONS} from '../sim/training-missions.js';
import {TrainingWalkthrough} from '../sim/training-walkthrough.js';
import {commandContext} from '../sim/orders.js';
import {compileMilitaryInterpretation,EMPTY_PARAMETERS} from '../server/military-planner.mjs';
import {runCommandSession} from '../game/command-session.js';
const read=p=>JSON.parse(fs.readFileSync(new URL('../'+p,import.meta.url)));
const makeWorld=terrain=>new World(read('data/scenarios/demo.json'),read('data/aircraft.json'),terrain,{spawnMode:'stands'});
test('16个短任务逐个解锁；示范、下令、观察与空间小游戏均有独立步骤',()=>{
  assert.equal(TRAINING_MISSIONS.length,16);assert.equal(new Set(TRAINING_MISSIONS.map(m=>m.id)).size,16);
  for(const s of TRAINING_MISSIONS){assert(s.text.length<130,s.id);assert(s.success);if(s.choices)assert(s.choices.some(c=>c[0]===s.answer));}
  for(const kind of ['select','demo','command','choice','compass','map','bullseye','tacan','dme'])assert(TRAINING_MISSIONS.some(s=>s.kind===kind));
  const w=makeWorld(),t=new TrainingWalkthrough(w,'blue-1');assert.equal(t.next(),false);t.tick();assert.equal(t.phase,'brief');
  t.select('blue-2');assert.equal(t.phase,'brief');t.select('blue-1');assert.equal(t.phase,'success');assert.equal(t.score,10);t.select('blue-1');assert.equal(t.score,10);
  assert(t.next());assert.equal(t.step.id,'demo');assert.equal(t.phase,'brief');
});
async function executeAI(w,t,intent,parameters={},options={}){
  const interpretation={version:'1.0',status:'understood',summary:'AI 已理解任务',orders:[{id:'order-1',intent,unitIds:['blue-1'],speechAct:'directive',timing:'now',condition:null,parameters:{...EMPTY_PARAMETERS,...parameters}}]};
  const compiled=compileMilitaryInterpretation(interpretation,commandContext(w,'blue-1'));assert.equal(compiled.plan.status,'accepted');
  return runCommandSession({world:w,reply:{...compiled,interpretation},expectedRevision:w.revision,radio:{phase(){},async transmit(){}},pause:async()=>{},onCommitted:()=>t.observeExecuted(interpretation,options)});
}
test('玩家自主AI报告也能完成示范；报告不移动飞机，也不代替滑行',async()=>{
  const w=makeWorld(),t=new TrainingWalkthrough(w,'blue-1'),u=w.units[0],before=[...u.position];t.select(u.id);t.next();
  await executeAI(w,t,'report_status');assert.equal(t.phase,'success');assert.deepEqual(u.position,before);t.next();
  await executeAI(w,t,'report_status');assert.equal(t.phase,'success');t.next();assert.equal(t.step.id,'taxi');
  await executeAI(w,t,'report_status');assert.equal(t.phase,'brief');assert.equal(t.status,'active');
  await executeAI(w,t,'taxi',{runway:'09L'});t.tick();assert.equal(t.phase,'working');assert.equal(t.next(),false);
});
test('错误跑道和错误高度先实际装订，再判任务失败',async()=>{
  const w=makeWorld(),t=new TrainingWalkthrough(w,'blue-1');t.index=3;
  await executeAI(w,t,'taxi',{runway:'09R'});assert.equal(w.units[0].surface.runway,'09R');assert.equal(t.status,'failed');assert.match(t.result().reason,/已执行.*其他跑道/);
  const air=makeWorld(),a=new TrainingWalkthrough(air,'blue-1');a.index=8;air.units[0].surface={grounded:false,phase:'climb'};air.units[0].position[2]=2000;
  await executeAI(air,a,'set_flight',{altitudeM:3048});assert.equal(air.units[0].holdAltitude,3048);assert.equal(a.status,'failed');assert.match(a.result().reason,/已设置错误高度/);
});
test('错误选择原地重试；正确后才解锁；不能反复刷分',()=>{
  const w=makeWorld(),t=new TrainingWalkthrough(w,'blue-1');t.index=4;
  assert.equal(t.answer('起飞'),false);assert.match(t.feedback,/还没有进入跑道/);assert.equal(t.phase,'brief');assert.equal(t.score,0);assert.equal(t.attempts,1);
  assert(t.answer('lineup'));assert.equal(t.phase,'success');assert.equal(t.score,10);assert.equal(t.answer('lineup'),false);assert.equal(t.score,10);
  assert(t.next());assert.equal(t.step.id,'lineup');
});
test('清掉目标点后通过别的点，不能冒充本关到达；模拟重开立即结束',()=>{
  const w=makeWorld(),t=new TrainingWalkthrough(w,'blue-1'),u=w.units[0];t.index=10;
  const point=[0,0,6096];u.waypoints=[point];t.waypoint(point);u.surface={phase:'climb',grounded:false};u.position=[0,0,6096];
  u.waypoints=[];t.tick();assert.equal(t.phase,'working');u.completedWaypoints++;t.tick();assert.equal(t.phase,'working');
  t.tick(makeWorld());assert.equal(t.status,'invalid');
});
test('复飞后重新开放本关输入，不会永久锁在等待状态',()=>{
  const w=makeWorld(),t=new TrainingWalkthrough(w,'blue-1'),u=w.units[0];t.index=15;t.phase='working';t.issued={intent:'land'};u.surface={phase:'missed',grounded:false};u.position[2]=2000;u.speed=180;
  t.tick();assert.equal(t.phase,'brief');assert.match(t.feedback,/再次发送降落命令/);assert.equal(t.issued,null);
});
test('AI结构化指令经统一通联与执行后评分，真实地图完成16个教学目标',async()=>{
  const bytes=fs.readFileSync(new URL('../terrain/air_skyscraper_city_height.f32',import.meta.url));
  const terrain=new TerrainHeight(read('terrain/air_skyscraper_city_height.json'),new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4));
  const w=makeWorld(terrain),u=w.units[0],t=new TrainingWalkthrough(w,u.id),report=[];
  function observe(seconds=1800){for(let i=0;i<seconds*60&&t.phase!=='success'&&t.status==='active';i++){w.step(1/60);t.tick();}assert.equal(t.phase,'success',JSON.stringify({step:t.step.id,status:t.status,phase:u.surface.phase,position:u.position,feedback:t.feedback}));}
  while(t.status==='active'){
    const s=t.step;
    if(s.kind==='select')t.select(u.id);
    else if(s.kind==='demo'||s.kind==='command'){
      const demo=s.kind==='demo',intent=demo?'report_status':s.intent;
      const parameters={...EMPTY_PARAMETERS,...(['taxi','line_up','takeoff','land'].includes(intent)?{runway:'09L'}:{}),...(['cruise','bullseye'].includes(intent)?{altitudeM:6096,speedMps:350*1852/3600}:{}),...(intent==='bullseye'?{mode:'bullseye',bearingDeg:90,rangeM:18520}:{})};
      const interpretation={version:'1.0',status:'understood',summary:s.title,orders:[{id:s.id,intent:intent==='bullseye'?'fly_to':intent,unitIds:[u.id],speechAct:'directive',timing:'now',condition:null,parameters}]};
      const compiled=compileMilitaryInterpretation(interpretation,commandContext(w,u.id));assert.equal(compiled.plan.status,'accepted',s.id);
      await runCommandSession({world:w,reply:{...compiled,interpretation},expectedRevision:w.revision,radio:{phase(){},async transmit(){}},pause:async()=>{},onCommitted:()=>t.observeExecuted(interpretation,{demo})});
      if(t.phase!=='success')observe();
    }else if(s.choices){assert(t.answer(s.answer));}
    else if(s.kind==='map'){
      const v=Math.hypot(u.velocity[0],u.velocity[1]),point=[u.position[0]+u.velocity[0]/v*5000,u.position[1]+u.velocity[1]/v*5000,6096];
      assert.equal(t.waypoint(point),false);w.command(u.id,point,false);assert(t.waypoint(point));assert.equal(t.phase,'working');observe(600);
    }
    assert.equal(t.phase,'success');report.push({step:s.id,at:w.time,phase:u.surface.phase,points:t.score});assert(t.next());
  }
  assert.equal(t.status,'passed');assert.equal(t.completed.length,16);assert.equal(t.score,160);assert.equal(u.surface.phase,'parked');assert.equal(u.speed,0);assert(u.alive);assert(t.flight.completed.recovery);
  fs.mkdirSync(new URL('../.game-server/',import.meta.url),{recursive:true});fs.writeFileSync(new URL('../.game-server/training-walkthrough.json',import.meta.url),JSON.stringify({steps:report,result:t.result(),final:{position:u.position,speed:u.speed,phase:u.surface.phase,alive:u.alive}},null,2));
});
