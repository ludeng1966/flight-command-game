import {MISSILE_MODELS,MISSILE_PHASES,motorState} from './missiles.js';
import {G} from './flight.js';

export const MISSILE_SAMPLE_MIN_SEC=.25;
export const MISSILE_SAMPLE_MAX_SEC=10;
const memories=new WeakMap();
const finite=(value,min,max)=>Number.isFinite(value)&&value>=min&&value<=max;
const optionalAltitude=value=>value==null||finite(value,-2000,200000);
const round=value=>Math.round(value*10)/10;
const id=value=>typeof value==='string'&&/^missile-\d+$/.test(value)&&value.length<=80;
const targetId=value=>value==null||typeof value==='string'&&value.length>0&&value.length<=64;
const endedPhases=new Set(['hit','impact','expired','spent']);

// This is declared own-weapon game telemetry, not a radar observation of an
// opponent missile. No positions, target truth, fuel or hit countdown survive.
export function parseOwnMissileFlights(flights,{maxCount=8,ownerId=null}={}){
  if(!Number.isInteger(maxCount)||maxCount<0||maxCount>32||!Array.isArray(flights)||flights.length>maxCount)throw Error('己方导弹遥测数量无效');
  const seen=new Set();
  return flights.map(flight=>{
    const model=MISSILE_MODELS.get(flight?.modelId);
    if(!flight||!id(flight.id)||seen.has(flight.id)||!model||!targetId(flight.targetId)||!targetId(flight.ownerId)||
      (ownerId!==null&&flight.ownerId!==ownerId)||typeof flight.alive!=='boolean'||
      !Object.hasOwn(MISSILE_PHASES,flight.phase)||!finite(flight.ageSec,0,model.lifetimeSec+1)||!finite(flight.speedMps,0,10000)||
      typeof flight.active!=='boolean'||typeof flight.needsRadarSupport!=='boolean'||!optionalAltitude(flight.altitudeM)||
      (flight.alive&&endedPhases.has(flight.phase))||(!flight.alive&&!endedPhases.has(flight.phase)))throw Error('己方导弹遥测无效');
    seen.add(flight.id);
    let previousSpeedSample=null;
    if(flight.previousSpeedSample!=null){
      const sample=flight.previousSpeedSample,dt=flight.ageSec-sample.ageSec;
      if(!finite(sample.ageSec,0,flight.ageSec)||!finite(sample.speedMps,0,10000)||!optionalAltitude(sample.altitudeM)||
        dt<MISSILE_SAMPLE_MIN_SEC-1e-6||dt>MISSILE_SAMPLE_MAX_SEC+1e-6)throw Error('己方导弹历史遥测无效');
      previousSpeedSample={ageSec:sample.ageSec,speedMps:sample.speedMps,altitudeM:sample.altitudeM??null};
    }
    return {id:flight.id,ownerId:flight.ownerId??null,modelId:flight.modelId,targetId:flight.targetId??null,alive:flight.alive,phase:flight.phase,
      ageSec:flight.ageSec,speedMps:flight.speedMps,altitudeM:flight.altitudeM??null,active:flight.active,
      needsRadarSupport:flight.alive&&(model.kind==='semi_active_radar'||model.kind==='active_radar'&&!flight.active),previousSpeedSample};
  });
}

// Capture only the receiver's own missiles, even if the caller passes enemy ids.
// Samples are observer-local and never enter world physics or enemy rendering.
export function captureOwnMissileFlights(world,unit,ids=unit?.attackTask?.firedMissileIds??[]){
  if(!unit||!Array.isArray(ids))return [];
  let state=memories.get(world);
  if(!state||world.time<state.time){state={time:world.time,samples:new Map()};memories.set(world,state);}
  state.time=world.time;
  const present=new Set((world.missiles??[]).map(m=>m.id));
  for(const key of state.samples.keys())if(!present.has(key))state.samples.delete(key);
  const allowed=new Set(ids);
  const flights=(world.missiles??[]).filter(m=>m.ownerId===unit.id&&allowed.has(m.id)).slice(-8).map(m=>{
    const current={ageSec:m.ageSec,speedMps:m.speedMps,altitudeM:Number.isFinite(m.position?.[2])?m.position[2]:null};
    let memory=state.samples.get(m.id);
    if(!memory||memory.ownerId!==unit.id||m.ageSec<memory.anchor.ageSec){memory={ownerId:unit.id,anchor:current,previous:null};state.samples.set(m.id,memory);}
    else if(m.ageSec-memory.anchor.ageSec>=MISSILE_SAMPLE_MIN_SEC-1e-6){
      memory.previous=m.ageSec-memory.anchor.ageSec<=MISSILE_SAMPLE_MAX_SEC+1e-6?memory.anchor:null;memory.anchor=current;
    }
    const previous=memory.previous;
    const previousSpeedSample=previous&&m.ageSec-previous.ageSec<=MISSILE_SAMPLE_MAX_SEC+1e-6?{...previous}:null;
    const model=MISSILE_MODELS.get(m.modelId);
    return {id:m.id,ownerId:unit.id,modelId:m.modelId,targetId:m.targetId,alive:m.alive,phase:m.phase,...current,active:m.active,
      needsRadarSupport:!!model&&m.alive&&(model.kind==='semi_active_radar'||model.kind==='active_radar'&&!m.active),previousSpeedSample};
  });
  return parseOwnMissileFlights(flights,{ownerId:unit.id});
}

function support(flight,model){
  if(!flight.alive)return 'none';
  if(model.kind==='semi_active_radar')return 'continuous_radar';
  if(model.kind==='infrared')return 'none';
  // An active seeker can subsequently lose its own track. Do not confuse
  // activation with permanent independence from updates, or with a hit.
  if(flight.phase==='active')return 'autonomous_seeker';
  if(!flight.active)return 'radar_until_active';
  return model.guidance.datalink?'radar_update_if_available':'inertial_only';
}

export function assessOwnMissile(input){
  const flight=parseOwnMissileFlights([input],{maxCount:1})[0],model=MISSILE_MODELS.get(flight.modelId),previous=flight.previousSpeedSample;
  const powered=flight.alive&&motorState(model,flight.ageSec).thrustN>0;
  const ignitionPending=flight.alive&&!powered&&model.motorStages.some(stage=>stage.startSec>flight.ageSec&&stage.thrustN>0);
  const propulsionPhase=!flight.alive?'ended':powered?'powered':ignitionPending?'ignition_pending':'coasting';
  const sampleIntervalSec=previous?flight.ageSec-previous.ageSec:null;
  const acceleration=previous?(flight.speedMps-previous.speedMps)/sampleIntervalSec:null;
  // This small deadband is for the game's sampled display, not a missile
  // performance or manoeuvrability threshold.
  const speedTrend=!flight.alive?'ended':acceleration===null?'unknown':acceleration>1?'accelerating':acceleration< -1?'decelerating':'steady';
  const kinetic=.5*flight.speedMps**2/1000;
  const mechanical=flight.altitudeM===null?null:kinetic+G*flight.altitudeM/1000;
  const previousMechanical=previous?.altitudeM==null?null:(.5*previous.speedMps**2+G*previous.altitudeM)/1000;
  const mechanicalRate=mechanical===null||previousMechanical===null?null:(mechanical-previousMechanical)/sampleIntervalSec;
  const mechanicalEnergyTrend=!flight.alive?'ended':mechanicalRate===null?'unknown':mechanicalRate>.5?'increasing':mechanicalRate<-.5?'decreasing':'steady';
  const requirement=support(flight,model);
  const limitations=['己方遥测来自本游戏的简化弹体状态，不能当成真实武器性能',
    '发动机停止不等于能量耗尽；主动导引头开机不等于命中或威胁解除',
    '速度与高度仅描述当前能量，剩余射程还受后续转弯、阻力、目标运动和制导影响',
    '没有生成命中概率、剩余射程或命中倒计时'];
  if(!previous)limitations.push('历史样本不足或间隔过长，变化趋势未知');
  if(mechanical===null)limitations.push('未提供导弹高度，仅可评估动能，不能推断总机械能');
  if(requirement==='radar_update_if_available'||requirement==='inertial_only')limitations.push('导引头已开机但当前未报告自主跟踪，仍需观察后续制导状态');
  const phaseLabel={powered:'发动机工作',ignition_pending:'等待动力段点火',coasting:'无动力滑行',ended:'飞行已结束'}[propulsionPhase];
  const trendLabel={accelerating:'速度上升',decelerating:'速度下降',steady:'速度大致稳定',unknown:'速度趋势待采样',ended:'以仿真结束记录为准'}[speedTrend];
  return {id:flight.id,modelId:flight.modelId,source:'own_weapon_game_telemetry',confidence:'game_telemetry',
    propulsionPhase,speedTrend,mechanicalEnergyTrend,speedMps:round(flight.speedMps),
    specificKineticEnergyKJkg:round(kinetic),specificMechanicalEnergyKJkg:mechanical===null?null:round(mechanical),
    speedChangeMps2:acceleration===null?null:round(acceleration),sampleIntervalSec:sampleIntervalSec===null?null:round(sampleIntervalSec),
    supportRequirement:requirement,guidanceState:flight.phase,remainingRangeM:null,timeToImpactSec:null,
    reserveAssessment:'unknown',summaryZh:`${phaseLabel} · ${trendLabel} · 剩余拦截余量未知`,limitations};
}

// RWR is a bearing-only warning in this game. Even when the display draws an
// enemy missile as a gameplay hint, that coordinate is not sensor evidence.
export function incomingRwrAssessment(contacts,time){
  if(!Array.isArray(contacts)||!Number.isFinite(time))return [];
  return contacts.slice(0,32).filter(contact=>contact&&/^RWR-\d+$/.test(contact.id)&&
    ['radar','active_seeker'].includes(contact.signalType)&&['search','track','launch'].includes(contact.level)&&
    (contact.level==='launch'||contact.signalType==='active_seeker')&&finite(contact.bearingDeg,0,359.999999999)&&
    finite(contact.observedAt,0,time)).map(contact=>({
      contactId:contact.id,source:'rwr_bearing_only',signalType:contact.signalType,bearingDeg:contact.bearingDeg,
      ageSec:round(time-contact.observedAt),freshness:time-contact.observedAt<=2.5?'recent':'memory',
      energyState:'unknown',propulsionPhase:'unknown',speedTrend:'unknown',confidence:'insufficient_evidence',
      speedMps:null,rangeM:null,closingMps:null,remainingRangeM:null,timeToImpactSec:null,
      summaryZh:`${contact.signalType==='active_seeker'?'主动导引头信号':'发射相关辐射信号'} · 导弹能量未知`,
      limitations:['RWR只有方位与辐射类别，不能测出导弹速度、距离、剩余推力或能量',
        '导引头开机不代表低能量；信号消失不代表导弹失效',
        '地图中的导弹位置提示不是测量，不能据此计算能量或命中倒计时']
    }));
}
