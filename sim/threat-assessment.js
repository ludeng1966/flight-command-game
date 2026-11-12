import {trackUsable} from './radar-quality.js';
// Sensor-derived game assessment. No world/target lookup, emitterKey, hidden
// lock target, missile flight state or claimed probability is read here.
// Thresholds below are game display heuristics, not calibrated sensor errors,
// operational doctrine or probabilities. "medium" means repeated evidence.
const vec=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);
const clamp=v=>Math.max(-1,Math.min(1,v)),degrees=v=>v*180/Math.PI;
const heading=v=>(degrees(Math.atan2(v[0],v[1]))+360)%360;
const angle=(a,b)=>((a-b+540)%360)-180;
const round=n=>Number.isFinite(n)?Math.round(n*10)/10||0:null;
const age=(sample,time)=>time-sample.observedAt;
const measured=(sample,time)=>sample&&Number.isFinite(sample.observedAt)&&age(sample,time)>=-.001&&vec(sample.position)&&vec(sample.velocity);
const recent=(sample,time,limit)=>measured(sample,time)&&age(sample,time)<=limit;
function sampleGeometry(unit,sample){
  const hasObserver=vec(sample.observerPosition)&&vec(sample.observerVelocity);
  const ownPosition=hasObserver?sample.observerPosition:unit.position,ownVelocity=hasObserver?sample.observerVelocity:unit.velocity;
  const delta=sample.position.map((v,i)=>v-ownPosition[i]),rangeM=Math.hypot(...delta),speed=Math.hypot(...sample.velocity);
  const los=delta.map(v=>v/Math.max(1,rangeM));
  const closure=los.reduce((sum,v,i)=>sum+v*(ownVelocity[i]-sample.velocity[i]),0);
  const aspect=speed>1?degrees(Math.acos(clamp(-los.reduce((sum,v,i)=>sum+v*sample.velocity[i],0)/speed))):null;
  return {rangeM,bearingDeg:heading(delta),closureMps:closure,targetSpeedMps:speed,targetHeadingDeg:speed>1?heading(sample.velocity):null,targetAspectDeg:aspect,observerPose:hasObserver?'measured':'current_ownship_approximation'};
}
function trackAssessment(unit,contact,time){
  const history=(contact.history??[]).filter(s=>recent(s,time,contact.sensorModelVersion===2?120:12)&&s.observedAt<=contact.observedAt&&vec(s.observerPosition)&&vec(s.observerVelocity)).slice(contact.sensorModelVersion===2?-16:-8);
  const unique=new Map(history.map(s=>[s.observedAt,s]));unique.set(contact.observedAt,contact);
  const samples=[...unique.values()].sort((a,b)=>a.observedAt-b.observedAt),first=samples[0],last=samples.at(-1),span=last.observedAt-first.observedAt;
  const g=sampleGeometry(unit,contact),fresh=trackUsable(contact,time)&&(contact.sensorModelVersion!==2||contact.state==='confirmed'),trend=(contact.sensorModelVersion!==2||Math.max(...contact.uncertainty.velocitySigmaMps)<=30)&&history.length>=2&&samples.length>=3&&span>=2&&samples.every(s=>Math.hypot(...s.velocity)>10);
  let turn=null,acceleration=null;
  if(trend){
    let rotation=0;for(let i=1;i<samples.length;i++)rotation+=angle(heading(samples[i].velocity),heading(samples[i-1].velocity));
    turn=rotation/span;acceleration=(Math.hypot(...last.velocity)-Math.hypot(...first.velocity))/span;
  }
  const hypotheses=[],add=(intent,confidence,evidence,summary)=>hypotheses.push({intent,confidence,evidence,summary});
  if(contact.classification==='friendly')add('friendly','unknown',['friendly_identification'],'已识别友机；运动趋势不构成敌对意图证据');
  else if(!fresh)add('unknown','unknown',['stale_track'],'航迹已老化，当前意图未知');
  else if(!trend)add('unknown','unknown',['insufficient_history'],'可读当前速度和方向；样本不足以判断转向趋势或意图');
  else{
    const geometry=samples.map(s=>sampleGeometry(unit,s)),closing=geometry.filter(s=>s.closureMps>30).length/samples.length>=.75;
    const opening=geometry.filter(s=>s.closureMps< -30).length/samples.length>=.75;
    if(closing&&g.targetAspectDeg!==null&&g.targetAspectDeg<60)add('possible_approach','medium',['repeated_positive_closure','target_velocity_toward_ownship'],'持续接近且航向朝向本机，可能正在接近或拦截；不能确认攻击意图');
    else if(opening)add('possible_separation','low',['repeated_negative_closure'],'持续远离，可能脱离、重新定位或维持其他任务；不能确认撤退');
    else if(g.targetAspectDeg!==null&&g.targetAspectDeg>60&&g.targetAspectDeg<120)add('possible_crossing','low',['crossing_velocity_geometry'],'速度方向呈横切几何，可能转场或机动；不能仅凭横切断言规避');
    if(Math.abs(turn)>=2)add('observed_turn','medium',['multiple_velocity_samples'],`多次速度观测显示${turn>0?'右':'左'}转趋势；机动目的未知`);
    if(!hypotheses.length)add('unknown','unknown',['no_distinct_pattern'],'目前运动证据不足以区分意图');
  }
  return {contactId:contact.id,callsign:contact.callsign??contact.id,classification:contact.classification??'unknown',
    observation:{observedAt:contact.observedAt,ageSec:round(Math.max(0,age(contact,time))),sampleCount:samples.length,spanSec:round(span),source:contact.source??'radar'},
    kinematics:{...Object.fromEntries(Object.entries(g).map(([k,v])=>[k,typeof v==='number'?round(v):v])),
      turnRateDegSec:turn===null?null:round(turn),speedTrendMps2:acceleration===null?null:round(acceleration),rangeTrend:g.closureMps>30?'closing':g.closureMps< -30?'opening':'approximately_steady'},hypotheses};
}
function signalMeaning(signal){
  if(signal.signalType==='active_seeker')return '检测到主动导引头类辐射；不提供导弹位置、能量、距离、到达时间或发射载机身份';
  if(signal.level==='launch')return '检测到照射或发射特征；不能据此确认导弹数量、轨迹或必然命中';
  if(signal.level==='track')return '检测到雷达跟踪类辐射，可能正在被持续关注；不能确认对方已发射';
  return '检测到搜索类雷达辐射；不证明对方已发现或锁定本机';
}
export function assessThreats(unit,time){
  const empty={sampledAt:time,contacts:[],signals:[],limitations:['意图是假设，置信度是证据充分程度，不是命中概率','RWR只有方位和信号类型，不能证明发射源身份或对方锁定对象','信号消失不代表威胁解除']};
  if(!unit||!vec(unit.position)||!vec(unit.velocity)||!Number.isFinite(time))return empty;
  const latest=new Map();
  for(const c of [...(unit.radar?.contacts??[]),...(unit.weapons?.contacts??[])]){
    if(!(c.sensorModelVersion===2?trackUsable(c,time):recent(c,time,4))||typeof c.id!=='string')continue;
    const old=latest.get(c.id);if(!old||c.observedAt>old.observedAt)latest.set(c.id,old?.history&&!c.history?{...c,history:old.history}:c);
  }
  const observed=[...latest.values()].slice(0,32),contacts=observed.map(c=>trackAssessment(unit,c,time));
  const signals=(unit.rwr?.enabled?unit.rwr.contacts??[]:[]).filter(s=>Number.isFinite(s.observedAt)&&age(s,time)>=-.001&&age(s,time)<=2.5&&Number.isFinite(s.bearingDeg)).slice(0,32).map(s=>{
    // Extrapolation is used only to find bearing-sector candidates. Its result
    // is never exposed as a confirmed radar-emitter identity.
    const candidates=s.signalType==='active_seeker'?[]:observed.filter(c=>trackUsable(c,time)&&c.classification!=='friendly').filter(c=>{
      const elapsed=s.observedAt-c.observedAt,ownElapsed=time-s.observedAt;
      const delta=c.position.map((v,i)=>v+c.velocity[i]*elapsed-(unit.position[i]-unit.velocity[i]*ownElapsed));
      return Math.abs(angle(heading(delta),s.bearingDeg))<=12;
    }).map(c=>c.id);
    const status=candidates.length>1?'ambiguous':candidates.length===1?'possible':'unassociated';
    return {rwrId:s.id,level:s.level,signalType:s.signalType,
      threatType:s.signalType==='active_seeker'?'missile':'radar_emitter',sourceModelId:null,sourceModelLabel:s.signalType==='active_seeker'?'型号未知':'平台未识别',
      bearingDeg:s.bearingDeg,ageSec:round(Math.max(0,age(s,time))),
      association:{status,candidateContactIds:candidates,confidence:status==='possible'?'low':'unknown',
        reason:s.signalType==='active_seeker'?'主动导引头信号不能按方位归属给某架飞机':status==='possible'?'仅方位接近，仍可能来自未观测发射源':status==='ambiguous'?'同一方位内有多个候选，无法唯一归属':'没有可关联的新鲜航迹；发射源可能尚未被雷达发现'},meaning:signalMeaning(s)};
  });
  for(const c of contacts){
    const tracking=signals.filter(s=>s.association.status==='possible'&&s.association.candidateContactIds[0]===c.contactId&&s.level==='track');
    if(tracking.length&&c.observation.ageSec<=2.25)c.hypotheses.push({intent:'possible_radar_attention',confidence:'low',evidence:tracking.map(s=>'rwr:'+s.rwrId),summary:'航迹方位附近有跟踪类辐射，可能与该机有关；来源及其真正锁定对象未确认'});
  }
  return {...empty,contacts,signals};
}
