import {transmitHandoff} from '../game/control-handoff.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {TerrainHeight} from '../sim/terrain.js';
import {TRAINING_LEVELS} from '../sim/training-levels.js';
import {TrainingWalkthrough} from '../sim/training-walkthrough.js';
import {captureWorld,restoreWorld,encodeState,decodeState} from '../sim/save-state.js';
import {captureTraining,restoreTraining} from '../sim/training-state.js';
import {commandContext} from '../sim/orders.js';
import {compileMilitaryInterpretation,EMPTY_PARAMETERS} from '../server/military-planner.mjs';
import {runCommandSession} from '../game/command-session.js';
import {recordResult,loadProgress} from '../game/training-store.js';
const read=name=>JSON.parse(fs.readFileSync(new URL('../'+name,import.meta.url)));
const scenario=read('data/scenarios/demo.json'),profiles=read('data/aircraft.json');
const bytes=fs.readFileSync(new URL('../terrain/air_skyscraper_city_height.f32',import.meta.url));
const terrain=new TerrainHeight(read('terrain/air_skyscraper_city_height.json'),new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4));
const make=level=>new World(scenario,profiles,terrain,{spawnMode:level.entry});
async function command(w,t,step){
  const intent=step.kind==='demo'?'report_status':step.intent;
  const parameters={...EMPTY_PARAMETERS,
    ...(['taxi','line_up','takeoff','approach','land'].includes(intent)?{runway:'09L',airportRef:'BAY'}:{}),
    ...(intent==='taxi'?{mode:'A,A1'}:{}),
    ...(['cruise','bullseye','orbit','fly_heading'].includes(intent)?{altitudeM:6096,speedMps:350*1852/3600}:{}),
    ...(intent==='fly_heading'?{headingDeg:step.headingDeg}:{}),...(intent==='bullseye'?{mode:'bullseye',bearingDeg:90,rangeM:18520}:{})};
  const interpretation={version:'1.0',status:'understood',summary:step.title,orders:[{id:'order-1',intent:intent==='bullseye'?'fly_to':intent,unitIds:[step.requiredUnitId??t.unit.id],speechAct:'directive',timing:'now',condition:null,parameters}]};
  const compiled=compileMilitaryInterpretation(interpretation,commandContext(w,t.unit.id));assert.equal(compiled.plan.status,'accepted',step.id+' '+compiled.plan.summary);
  return runCommandSession({world:w,reply:{...compiled,interpretation},expectedRevision:w.revision,radio:{phase(){},async transmit(){}},pause:async()=>{},onCommitted:()=>t.observeExecuted(interpretation,{demo:step.kind==='demo'})});
}
test('三个独立教学关卡按零基础概念展开，每个步骤都有解释、任务与反馈',()=>{
  assert.deepEqual(TRAINING_LEVELS.map(l=>l.missions.length),[15,16,21]);
  for(const level of TRAINING_LEVELS){
    assert.equal(new Set(level.missions.map(s=>s.id)).size,level.missions.length);
    for(const s of level.missions){assert(s.learn?.term,s.id);assert(s.learn?.meaning,s.id);assert(s.text.length<=150,s.id);assert(s.success,s.id);if(s.choices){assert(s.choices.some(c=>c[0]===s.answer));assert(s.choices.filter(c=>c[0]!==s.answer).every(c=>c[2]));}}
  }
  assert(TRAINING_LEVELS[0].missions.some(s=>s.requiredUnitId==='blue-2'));
  assert(TRAINING_LEVELS[1].missions.some(s=>s.intent==='orbit'&&s.assessment));
  assert.deepEqual(TRAINING_LEVELS[2].missions.filter(s=>s.kind==='observe').map(s=>s.targetPhase),['rollout','exit','parked']);
});
test('各关可单独开始；空中练习不伪造一次起飞，旧16步进度仍可恢复',()=>{
  for(const level of TRAINING_LEVELS){const w=make(level),before=[...w.units[0].position],t=new TrainingWalkthrough(w,'blue-1',{levelId:level.id});assert.deepEqual(t.unit.position,before);assert.equal(t.level.id,level.id);assert.equal(t.missions.length,level.missions.length);assert.equal(t.flight.completed.departure,undefined);}
  const w=make(TRAINING_LEVELS[0]),legacy=new TrainingWalkthrough(w,'blue-1');legacy.select('blue-1');legacy.next();const state=decodeState(JSON.parse(JSON.stringify(encodeState({world:captureWorld(w),training:captureTraining(legacy.flight,legacy)}))));
  const restored=restoreTraining(restoreWorld(state.world,scenario,profiles,terrain),state.training);assert.equal(restored.walkthrough.missions.length,16);assert.equal(restored.walkthrough.step.id,'demo');
});
for(const level of TRAINING_LEVELS)test(`独立完整通过第${level.number}关：${level.title}；统一AI执行通路与真实地形积分`,async()=>{
  let w=make(level),t=new TrainingWalkthrough(w,'blue-1',{levelId:level.id});const evidence=[];
  const observe=(seconds=1800)=>{for(let i=0;i<seconds*60&&t.phase!=='success'&&t.status==='active';i++){w.step(1/60);t.tick();}assert.equal(t.phase,'success',JSON.stringify({level:level.id,step:t.step?.id,feedback:t.feedback,phase:t.unit.surface?.phase,position:t.unit.position,speed:t.unit.speed,issued:t.issued}));};
  while(t.status==='active'){
    const step=t.step;
    if(step.kind==='select')t.select(t.unit.id);
    else if(step.choices){assert(t.answer(step.answer));}
    else if(step.kind==='handoff-mode')assert(t.chooseControlMode('strict'));
    else if(step.kind==='handoff'){assert(t.handoff());await transmitHandoff(w,t.unit,{phase(){},async transmit(){}});t.tick();}
    else if(step.kind==='demo'||step.kind==='command'){
      await command(w,t,step);
      if(step.intent==='orbit'){
        t.tick();assert.equal(t.phase,'working','收到盘旋命令不直接通关');
        const state=decodeState(JSON.parse(JSON.stringify(encodeState({world:captureWorld(w),training:captureTraining(t.flight,t)}))));w=restoreWorld(state.world,scenario,profiles,terrain);t=restoreTraining(w,state.training).walkthrough;assert.equal(t.levelId,level.id);
      }
      if(t.phase!=='success')observe();
    }else if(step.kind==='map'){
      const u=t.unit,h=Math.hypot(u.velocity[0],u.velocity[1]),point=[u.position[0]+u.velocity[0]/h*5000,u.position[1]+u.velocity[1]/h*5000,6096];w.command(u.id,point);assert(t.waypoint(point));observe();
    }else if(step.kind==='observe'){assert(t.observe());observe();}
    evidence.push({step:step.id,time:w.time,phase:t.unit.surface?.phase??'airborne',...(step.intent==='orbit'?{orbitAngle:t.issued.angle}: {})});assert.equal(t.phase,'success');assert(t.next());
  }
  assert.equal(t.status,'passed');assert.equal(t.completed.length,level.missions.length);assert.equal(t.score,level.missions.length*10);assert.equal(t.result().levelId,level.id);
  if(level.id==='communications')assert(w.units.every(u=>u.speed===0&&u.surface.phase==='parked'));
  if(level.id==='departure'){assert(t.flight.completed.departure);assert(!t.unit.surface.grounded);assert(Math.abs(evidence.find(s=>s.step==='orbit').orbitAngle)>=Math.PI*2);}
  if(level.id==='navigation'){assert.equal(t.flight.completed.departure,undefined);assert(t.flight.completed.cruise);assert(t.flight.completed.waypoint);assert(t.flight.completed.recovery);assert.equal(t.unit.surface.phase,'parked');assert.equal(t.unit.speed,0);}
  fs.mkdirSync(new URL('../.game-server/',import.meta.url),{recursive:true});fs.writeFileSync(new URL(`../.game-server/training-level-${level.id}.json`,import.meta.url),JSON.stringify({result:t.result(),steps:evidence},null,2));
});
test('分关通过记录不随最近十条报告淘汰而丢失',t=>{
  const original=globalThis.localStorage,memory=new Map();globalThis.localStorage={getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v)};t.after(()=>{globalThis.localStorage=original;});
  recordResult({mode:'guided',status:'passed',levelId:'communications',score:150,steps:[]});
  for(let i=0;i<15;i++)recordResult({mode:'guided',status:'invalid',score:0,steps:[]});
  const progress=loadProgress();assert.equal(progress.results.length,10);assert.equal(progress.levelProgress.communications.passed,true);assert.equal(progress.levelProgress.communications.bestScore,150);
});
