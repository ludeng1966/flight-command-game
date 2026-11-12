import {basis,cross,dot,norm} from './flight.js';
import {observedContact} from './battle-observation.js';
import {notePlayerOrder} from './command-scope.js';
import {V2_DEFAULTS,initializeV2,validateV2Config,updateV2,v2Context,parseV2Contact,setScanPolicy} from './radar-v2.js';
import {groundVelocity,trackUsable,radarTarget} from './radar-quality.js';

// Game parameters, not claimed AN/APG-66 specifications. The gate is a half width.
export const RADAR_DEFAULTS=Object.freeze({rangeM:60000,minRangeM:150,azimuthHalfDeg:60,elevationHalfDeg:30,
  beamHalfDeg:3,sweepSec:2,acquireSec:.8,coastSec:1.5,memorySec:4,speedGateHalfWidthMps:80,effectiveEarthRadiusM:8500000});
export const RADAR_MODES=Object.freeze(['off','pd','pulse']);
export const RADAR_REASONS=Object.freeze({notch:'进入地面杂波速度门',ground_clutter:'脉冲模式受地面杂波遮蔽',terrain:'地形遮挡',
  horizon:'超出雷达视距',range:'超出探测距离',gimbal:'超出天线角度范围',destroyed:'目标失效',grounded:'地面待机',off:'雷达关闭',signal_lost:'回波丢失，原因尚不确定'});
const rad=d=>d*Math.PI/180,deg=r=>r*180/Math.PI,clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const vec=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);
export const RADAR_HISTORY={maxSamples:8,intervalSec:.75,windowSec:12};
const copySample=s=>({observedAt:s.observedAt,position:[...s.position],velocity:[...s.velocity],observerPosition:[...s.observerPosition],observerVelocity:[...s.observerVelocity]});
function parseHistory(c){
  if(c.history===undefined)return [];
  if(!Array.isArray(c.history)||c.history.length>RADAR_HISTORY.maxSamples)throw Error('雷达历史样本无效');
  let previous=-Infinity;
  return c.history.map(s=>{
    if(!s||!Number.isFinite(s.observedAt)||s.observedAt<0||s.observedAt<=previous||s.observedAt>c.observedAt+.001||c.observedAt-s.observedAt>RADAR_HISTORY.windowSec+.001||![s.position,s.velocity,s.observerPosition,s.observerVelocity].every(vec))throw Error('雷达历史样本无效');
    previous=s.observedAt;return copySample(s);
  });
}
export function createRadar(profileId,override){
  const available=override===false?false:profileId==='f16'||!!override;
  const config={...RADAR_DEFAULTS,...(override&&typeof override==='object'?override:{})};
  if(config.sensorModelVersion===2)Object.assign(config,{...V2_DEFAULTS,...config});
  for(const key of Object.keys(RADAR_DEFAULTS))if(!Number.isFinite(config[key])||config[key]<=0)throw Error('雷达参数无效：'+key);
  if(config.azimuthHalfDeg>85||config.elevationHalfDeg>85||config.minRangeM>=config.rangeM)throw Error('雷达范围配置无效');
  const r={available,config,mode:'off',phase:available?'off':'unavailable',targetId:null,contacts:[],events:[],sequence:0,
    scanPhase:0,accumulator:0,acquiredSec:0,missingSec:0,established:false,canIlluminate:false,lastReason:null};
  if(config.sensorModelVersion===2){validateV2Config(config);initializeV2(r);}return r;
}
function event(r,time,text,type){r.events.push({sequence:++r.sequence,time,text,type});if(type==='locked')r.lastLockSequence=r.sequence;if(type==='lost')r.lastLostSequence=r.sequence;if(r.events.length>32)r.events.shift();}
export const recordRadarEvent=event;
function clearLock(r){r.targetId=null;r.acquiredSec=0;r.missingSec=0;r.established=false;r.canIlluminate=false;r.phase=r.mode==='off'?'off':'search';}
function height(terrain,p){return terrain?.heightAt?.(p[0],p[1])??0;}
export function radarGeometry(own,target,config=RADAR_DEFAULTS,terrain=null){
  const delta=target.position.map((v,i)=>v-own.position[i]),rangeM=Math.hypot(...delta),los=norm(delta);
  const pose=own.sensorPose??basis(own),right=norm(cross(pose.forward,pose.up));
  const forward=dot(los,pose.forward),azimuthDeg=deg(Math.atan2(dot(los,right),forward));
  const elevationDeg=deg(Math.atan2(dot(los,pose.up),Math.hypot(forward,dot(los,right))));
  const ownV=groundVelocity(own),targetV=groundVelocity(target);
  const closureMps=dot(ownV.map((v,i)=>v-targetV[i]),los),clutterClosureMps=dot(ownV,los);
  const clutterSeparationMps=closureMps-clutterClosureMps;
  const ownAgl=Math.max(0,own.position[2]-height(terrain,own.position));
  const horizontalM=Math.hypot(delta[0],delta[1]),radius=config.effectiveEarthRadiusM;
  const reference=terrain?.meta?.waterLevel??0;
  const horizonM=Math.sqrt(2*radius*Math.max(0,own.position[2]-reference))+Math.sqrt(2*radius*Math.max(0,target.position[2]-reference));
  const worldElevation=Math.asin(clamp(los[2],-1,1));
  const horizonDepression=Math.acos(radius/(radius+ownAgl));
  const groundClutter=worldElevation-rad(config.beamHalfDeg)<=-horizonDepression;
  return {rangeM,azimuthDeg,elevationDeg,closureMps,clutterClosureMps,clutterSeparationMps,
    groundClutter,withinHorizon:horizontalM<=horizonM,los,horizontalM};
}
export function radarVisibility(own,target,r,terrain=null,measuredGeometry=null){
  const g=measuredGeometry??radarGeometry(own,target,r.config,terrain);let reason=null;
  if(target.alive===false)reason='destroyed';
  else if(g.rangeM<r.config.minRangeM||g.rangeM>r.config.rangeM)reason='range';
  else if(Math.abs(g.azimuthDeg)>r.config.azimuthHalfDeg||Math.abs(g.elevationDeg)>r.config.elevationHalfDeg)reason='gimbal';
  else if(!g.withinHorizon)reason='horizon';
  if(!reason&&terrain?.heightAt){
    // LOS clearance is zero, unlike the navigation system's 100 m safety margin.
    const steps=Math.min(512,Math.max(2,Math.ceil(g.horizontalM/Math.min(250,terrain.meta?.step??250))));
    for(let i=1;i<steps;i++){const t=i/steps,p=own.position.map((v,k)=>v+(target.position[k]-v)*t),h=terrain.heightAt(p[0],p[1]);
      if(h!==null&&p[2]<=h+g.horizontalM*g.horizontalM*t*(1-t)/(2*r.config.effectiveEarthRadiusM)){reason='terrain';break;}}
  }
  if(!reason&&g.groundClutter&&r.sensorModelVersion!==2){
    if(r.mode==='pulse')reason='ground_clutter';
    else if(r.mode==='pd'&&Math.abs(g.clutterSeparationMps)<r.config.speedGateHalfWidthMps)reason='notch';
  }
  return {...g,visible:reason===null,reason};
}
export function radarCandidates(world){return [...world.units,...(world.radarTargets??[])];}
export function validateRadarOrder(world,unit,order){
  const r=unit?.radar;
  if(!unit||unit.alive===false||!r?.available)throw Error('该机没有可用的搜索雷达');
  if(!order||Object.keys(order).length!==3||!['operation','mode','targetId'].every(k=>Object.hasOwn(order,k))||
    !['mode','lock','unlock'].includes(order.operation))throw Error('雷达口令格式无效');
  if(order.operation==='mode'){
    if(!RADAR_MODES.includes(order.mode)||order.targetId!==null)throw Error('雷达模式无效');
  }else{
    if(order.mode!==null)throw Error('锁定操作不能隐式切换雷达模式');
    if(order.operation==='unlock'){if(order.targetId!==null)throw Error('解除锁定不接受目标参数');}
    else{
      if(r.mode==='off'||unit.surface?.grounded)throw Error('请先在空中开启雷达搜索');
      const track=r.contacts.find(c=>c.id===order.targetId&&(r.sensorModelVersion===2?trackUsable(c,world.time):world.time-c.observedAt<=r.config.sweepSec+.25));
      if(!track)throw Error('目标不在本机新鲜雷达航迹中，请先搜索发现目标');
      if(r.sensorModelVersion===2)return order; // Acquisition is a search job, not a truth visibility oracle.
      const target=radarTarget(world,unit,order.targetId);
      const visibility=target?radarVisibility(unit,target,r,world.terrain):null;
      if(!visibility?.visible)throw Error('目标当前不可锁定：'+(RADAR_REASONS[visibility?.reason]??'目标失效')+'，请按当前条件调整后重新截获');
    }
  }
  return order;
}
export function applyRadarOrder(world,unit,order,{autonomous=false}={}){
  validateRadarOrder(world,unit,order);const r=unit.radar;
  if(!autonomous)notePlayerOrder(world,[unit.id]);
  if(!autonomous&&unit.radarTask)unit.radarTask.active=false;
  if(!autonomous&&unit.attackTask?.active){unit.attackTask.active=false;unit.attackTask.status='cancelled';unit.attackTask.pending=false;}
  r.controlSequence=(r.controlSequence??0)+1;
  if(order.operation==='mode'){
    r.mode=order.mode;clearLock(r);r.lastReason=null;
    if(r.sensorModelVersion===2){for(const t of r.tracks){t.awaitingValidation=true;t.state='coasting';}for(const c of r.contacts)c.awaitingValidation=true;r.scheduledTrackIds=[];r.canIlluminate=false;r.emissions=[];}
    else{r.contacts=[];r.scanPhase=0;}
    unit.pilotContacts=(unit.pilotContacts??[]).filter(c=>c.source!=='radar');
    event(r,world.time,r.mode==='off'?'雷达关闭，解除锁定':`雷达${r.mode==='pd'?'PD 脉冲多普勒':'SRC 脉冲'}搜索`,r.mode==='off'?'off':'search');
  }else if(order.operation==='unlock'){clearLock(r);r.lastReason=null;event(r,world.time,'解除锁定，恢复搜索','search');}
  else{clearLock(r);r.targetId=order.targetId;r.phase='acquiring';r.lastReason=null;event(r,world.time,'开始截获目标 '+order.targetId,'acquiring');}
}
function recordContact(r,own,target,g,time){
  const old=r.contacts.find(c=>c.id===target.id),team=own.team??own.faction??'blue',otherTeam=target.team??target.faction??'blue';
  const history=(old?.history??[]).filter(s=>time-s.observedAt<=RADAR_HISTORY.windowSec);
  // Only called after the sensor obtained a measurement. Never advance a lost track's history.
  if(!history.length||time-history.at(-1).observedAt>=RADAR_HISTORY.intervalSec-1e-8)history.push(copySample({observedAt:time,position:target.position,velocity:target.velocity,observerPosition:own.position,observerVelocity:own.velocity}));
  if(history.length>RADAR_HISTORY.maxSamples)history.splice(0,history.length-RADAR_HISTORY.maxSamples);
  const contact={id:target.id,callsign:target.callsign??target.id,classification:otherTeam===team?'friendly':'unknown',
    practice:target.radarPractice===true,source:'radar',observedAt:time,position:[...target.position],velocity:[...target.velocity],
    observerPosition:[...own.position],observerVelocity:[...own.velocity],history,
    rangeM:g.rangeM,azimuthDeg:g.azimuthDeg,elevationDeg:g.elevationDeg,closureMps:g.closureMps,clutterSeparationMps:g.clutterSeparationMps};
  if(old)Object.assign(old,contact);else if(r.contacts.length<32)r.contacts.push(contact);
}
function updateRadar(world,own,dt,time){
  const r=own.radar;if(!r?.available)return;
  if(r.sensorModelVersion===2)return updateV2(world,own,dt,time,{geometry:radarGeometry,visibility:radarVisibility,event,clearLock});
  if(r.mode==='off'||own.alive===false||own.surface?.grounded){
    if(r.targetId)event(r,time,'停止跟踪：'+(own.alive===false?'本机失效':own.surface?.grounded?'地面待机':'雷达关闭'),'lost');
    clearLock(r);r.contacts=[];own.pilotContacts=(own.pilotContacts??[]).filter(c=>c.source!=='radar');r.phase=r.mode==='off'?'off':own.alive===false?'unavailable':'standby';r.lastReason=own.surface?.grounded?'grounded':r.mode==='off'?'off':null;return;
  }
  const candidates=radarCandidates(world).filter(t=>t.id!==own.id);
  if(r.targetId){
    const target=candidates.find(t=>t.id===r.targetId),g=target?radarVisibility(own,target,r,world.terrain):{visible:false,reason:'destroyed'};
    if(g.visible){
      recordContact(r,own,target,g,time);r.missingSec=0;r.lastReason=null;
      if(!r.established){r.acquiredSec+=dt;r.phase='acquiring';if(r.acquiredSec+1e-8>=r.config.acquireSec){r.established=true;event(r,time,'目标 '+r.targetId+'，雷达锁定','locked');}}
      if(r.established)r.phase='locked';r.canIlluminate=r.established;
    }else{
      r.missingSec+=dt;r.acquiredSec=0;r.canIlluminate=false;r.lastReason=g.reason;r.phase=r.established?'coasting':'acquiring';
      if(r.missingSec+1e-8>=r.config.coastSec){const id=r.targetId;clearLock(r);event(r,time,'目标 '+id+' 掉锁：'+(RADAR_REASONS[g.reason]??g.reason),'lost');}
    }
  }else{
    r.phase='search';r.canIlluminate=false;
    const from=r.scanPhase,increment=dt/r.config.sweepSec,to=from+increment,width=r.config.beamHalfDeg/(2*r.config.azimuthHalfDeg);
    for(const target of candidates){
      if(target.alive===false)continue;
      const direction=radarGeometry(own,target,r.config,world.terrain),phase=(direction.azimuthDeg+r.config.azimuthHalfDeg)/(2*r.config.azimuthHalfDeg);
      const passed=increment>=1||[phase-1,phase,phase+1].some(p=>p>=from-width&&p<=to+width);
      if(passed){const g=radarVisibility(own,target,r,world.terrain);if(g.visible)recordContact(r,own,target,g,time);}
    }
    r.scanPhase=to%1;
  }
  r.contacts=r.contacts.filter(c=>time-c.observedAt<=r.config.memorySec);
  own.pilotContacts=[...(own.pilotContacts??[]).filter(c=>c.source!=='radar'),...r.contacts.map(c=>({...c,position:[...c.position],velocity:[...c.velocity],threat:false,missileWarning:false}))];
}
export function stepRadars(world,dt){
  for(const own of world.units){const r=own.radar;if(!r)continue;r.accumulator+=dt;
    while(r.accumulator+1e-9>=.05){r.accumulator-=.05;updateRadar(world,own,.05,world.time-r.accumulator);}}
}
export function radarView(unit,time){
  const r=unit.radar;if(!r)return null;
  return {...(r.sensorModelVersion===2?v2Context(r,time):{}),available:r.available,mode:r.mode,phase:r.phase,targetId:r.targetId,canIlluminate:r.canIlluminate,lastReason:r.lastReason,
    speedGateHalfWidthMps:r.config.speedGateHalfWidthMps,rangeM:r.config.rangeM,azimuthHalfDeg:r.config.azimuthHalfDeg,
    scanAzimuthDeg:r.sensorModelVersion===2?r.antenna.azimuthDeg:-r.config.azimuthHalfDeg+2*r.config.azimuthHalfDeg*r.scanPhase,
    acquireProgress:clamp(r.acquiredSec/r.config.acquireSec,0,1),coastRemainingSec:Math.max(0,r.config.coastSec-r.missingSec),
    contacts:r.contacts.map(c=>({...c,position:[...c.position],velocity:[...c.velocity],history:(c.history??[]).map(copySample),
      ...(c.uncertainty?{uncertainty:{positionSigmaM:[...c.uncertainty.positionSigmaM],velocitySigmaMps:[...c.uncertainty.velocitySigmaMps],radialSigmaMps:c.uncertainty.radialSigmaMps},usable:{...c.usable}}:{}),
      ...(c.observerPosition&&c.observerVelocity?{observerPosition:[...c.observerPosition],observerVelocity:[...c.observerVelocity]}:{}),ageSec:Math.max(0,time-c.observedAt),
      predictedPosition:c.position.map((v,i)=>v+c.velocity[i]*Math.max(0,time-c.observedAt))})),events:r.events.map(e=>({...e}))};
}
// Compact, observed sensor state for the language model; never add hidden target positions.
export function radarContext(unit,time){const v=radarView(unit,time);if(!v)return null;
  const {available,mode,phase,targetId,canIlluminate,speedGateHalfWidthMps,lastReason}=v;
  return {...(unit.radar.sensorModelVersion===2?v2Context(unit.radar,time):{}),available,mode,phase,targetId,canIlluminate,speedGateHalfWidthMps,lastReason,
    controlSequence:unit.radar.controlSequence??0,lastLockSequence:unit.radar.lastLockSequence??0,lastLostSequence:unit.radar.lastLostSequence??0,
    contacts:v.contacts.map(c=>c.sensorModelVersion===2?observedContact(parseV2Contact(c,time),time,'radar'):c).map(c=>{if(c.sensorModelVersion===2)return c;const {id,callsign,classification,position,velocity,observedAt,observerPosition,observerVelocity,history}=c;return observedContact({id,callsign,classification,position,velocity,observedAt,
      ...(observerPosition&&observerVelocity?{observerPosition:[...observerPosition],observerVelocity:[...observerVelocity]}:{}),history:(history??[]).map(copySample)},time,'radar');})};
}
export function parseRadarContext(v,time){
  if(v==null)return null;
  if(typeof v.available!=='boolean'||!RADAR_MODES.includes(v.mode)||typeof v.phase!=='string'||v.phase.length>32||
    !(v.targetId===null||typeof v.targetId==='string'&&v.targetId.length<=64)||typeof v.canIlluminate!=='boolean'||
    !Number.isFinite(v.speedGateHalfWidthMps)||v.speedGateHalfWidthMps<=0||v.speedGateHalfWidthMps>500||!Array.isArray(v.contacts)||v.contacts.length>32)throw Error('雷达上下文无效');
  const ids=new Set(),contacts=v.contacts.map(c=>{if(v.sensorModelVersion===2){if(ids.has(c?.id))throw Error('重复航迹');ids.add(c?.id);return observedContact(parseV2Contact(c,time),time,'radar');}if(!c||typeof c.id!=='string'||!c.id||c.id.length>64||ids.has(c.id)||typeof c.callsign!=='string'||c.callsign.length>80||
    !['friendly','unknown'].includes(c.classification)||!vec(c.position)||!vec(c.velocity)||!Number.isFinite(c.observedAt)||c.observedAt<0||c.observedAt>time+.001)throw Error('雷达航迹无效');ids.add(c.id);
    if((c.observerPosition!==undefined||c.observerVelocity!==undefined)&&![c.observerPosition,c.observerVelocity].every(vec))throw Error('雷达观测机位无效');
    return observedContact({id:c.id,callsign:c.callsign,classification:c.classification,position:[...c.position],velocity:[...c.velocity],observedAt:c.observedAt,
      ...(c.observerPosition?{observerPosition:[...c.observerPosition],observerVelocity:[...c.observerVelocity]}:{}),history:parseHistory(c)},time,'radar');});
  for(const key of ['controlSequence','lastLockSequence','lastLostSequence'])if(v[key]!==undefined&&(!Number.isSafeInteger(v[key])||v[key]<0))throw Error('雷达序号无效');
  if(!(v.lastReason==null||typeof v.lastReason==='string'&&Object.hasOwn(RADAR_REASONS,v.lastReason)))throw Error('雷达状态原因无效');
  let extension={};if(v.sensorModelVersion===2){
    if(!Number.isFinite(v.scanFrameSec)||v.scanFrameSec<=0||v.scanFrameSec>600||!Array.isArray(v.coverage)||v.coverage.length>288||!Number.isSafeInteger(v.policyRevision)||v.policyRevision<0)throw Error('雷达扫描上下文无效');
    const sanitized=createRadar('f16',{sensorModelVersion:2});
    // Strict policy validation and explicit capability reconstruction prevent hidden fields crossing the boundary.
    setScanPolicy({radar:sanitized},v.scanPolicy);
    if(!v.capabilities||typeof v.capabilities.supportsTws!=='boolean')throw Error('雷达能力无效');
    const capabilities={supportsTws:v.capabilities.supportsTws};for(const k of ['maxScheduledTracks','maxDatalinkChannels','maxIlluminationChannels']){if(!Number.isInteger(v.capabilities[k])||v.capabilities[k]<0||v.capabilities[k]>16)throw Error('雷达能力无效');capabilities[k]=v.capabilities[k];}
    extension={sensorModelVersion:2,policyRevision:v.policyRevision,scanFrameSec:v.scanFrameSec,scanPolicy:sanitized.scanPolicy,capabilities,
      scanAzimuthDeg:Number.isFinite(v.scanAzimuthDeg)?v.scanAzimuthDeg:0,scanElevationDeg:Number.isFinite(v.scanElevationDeg)?v.scanElevationDeg:0,coverageLimited:v.coverageLimited===true,
      coverage:v.coverage.map(c=>{if(!Number.isInteger(c.cell)||c.cell<0||c.cell>=288||!Number.isFinite(c.ageSec)||c.ageSec<0||!Number.isFinite(c.dwellSec)||c.dwellSec<0||c.dwellSec>120)throw Error('雷达覆盖无效');return {cell:c.cell,ageSec:c.ageSec,dwellSec:c.dwellSec};})};
  }
  return {...extension,available:v.available,mode:v.mode,phase:v.phase,targetId:v.targetId,canIlluminate:v.canIlluminate,speedGateHalfWidthMps:v.speedGateHalfWidthMps,
    lastReason:v.lastReason??null,controlSequence:v.controlSequence??0,lastLockSequence:v.lastLockSequence??0,lastLostSequence:v.lastLostSequence??0,contacts};
}
export function radarTaskFor(order,context){
  const p=order.parameters,allowed=order.intent==='lock_target'?['targetId','targetRef']:['mode'];
  if(Object.entries(p).some(([k,v])=>v!==null&&v!==false&&!allowed.includes(k)))throw Error('当前雷达口令仅支持工作模式或指定单个航迹；扫描定制、航向与武器要求请分条下达');
  const mode=(p.mode??'search').trim().toLowerCase();let radarOrder;
  if(order.intent==='lock_target'){
    let targetId=p.targetId;
    if(!targetId&&p.targetRef){const ref=p.targetRef.trim().toLowerCase(),matches=context.units.flatMap(u=>u.radar?.contacts??[]).filter(c=>[c.id,c.callsign].some(s=>s.toLowerCase()===ref));const ids=[...new Set(matches.map(c=>c.id))];if(ids.length===1)targetId=ids[0];}
    if(!targetId)throw Error('请明确本机雷达已发现的目标编号，例如 TGT 01');
    radarOrder={operation:'lock',mode:null,targetId};
  }else if(order.intent==='emcon'){
    if(p.mode!==null&&!['off','silent','silence','静默','关闭'].includes(mode))throw Error('当前电磁管制支持关闭主动雷达；其他管制方式尚未接入');
    radarOrder={operation:'mode',mode:'off',targetId:null};
  }else if(['unlock','break_lock','解除锁定','取消锁定'].includes(mode))radarOrder={operation:'unlock',mode:null,targetId:null};
  else{
    const mapped=['off','关闭'].includes(mode)?'off':['search','on','pd','src_pd','pulse_doppler','脉冲多普勒','搜索'].includes(mode)?'pd':['pulse','src','脉冲'].includes(mode)?'pulse':null;
    if(!mapped)throw Error('当前雷达仅支持 PD 搜索、SRC 脉冲搜索、解除锁定及关闭；TWS、ACM 和 HDN 尚未接入');
    radarOrder={operation:'mode',mode:mapped,targetId:null};
  }
  return order.unitIds.map(unitId=>{
    const unit=context.units.find(u=>u.id===unitId);if(!unit?.radar?.available)throw Error('受令机未配置搜索雷达');
    if(radarOrder.operation==='lock'&&(unit.radar.mode==='off'||!unit.radar.contacts.some(c=>c.id===radarOrder.targetId&&trackUsable(c,context.simTimeSec))))throw Error('受令机尚未发现该目标的有效航迹，请先开启雷达搜索');
    return {unitId,action:'radar',radarOrder:{...radarOrder}};
  });
}
