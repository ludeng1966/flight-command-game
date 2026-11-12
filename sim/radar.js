import {basis,cross,dot,norm} from './flight.js';

// Game parameters, not claimed AN/APG-66 specifications. The gate is a half width.
export const RADAR_DEFAULTS=Object.freeze({rangeM:60000,minRangeM:150,azimuthHalfDeg:60,elevationHalfDeg:30,
  beamHalfDeg:3,sweepSec:2,acquireSec:.8,coastSec:1.5,memorySec:4,speedGateHalfWidthMps:80,effectiveEarthRadiusM:8500000,warmupSec:0,rcsBase:1});
export const RADAR_MODES=Object.freeze(['off','pd','pulse']);
export const IFF_MODES=Object.freeze(['auto','manual','off']);
// 非协作目标识别（NCTR）：按型号开关；识别需要持续跟踪、距离与置信度。
export const RADAR_FEATURES=Object.freeze({nctr:false,nctrSec:4,nctrRangeM:35000,nctrConfidence:.8,scanType:'mechanical'});
export const RADAR_SCAN_TYPES=Object.freeze(['mechanical','aesa']);
export const RADAR_REASONS=Object.freeze({notch:'进入地面杂波速度门',ground_clutter:'脉冲模式受地面杂波遮蔽',terrain:'地形遮挡',
  horizon:'超出雷达视距',range:'超出探测距离',gimbal:'超出天线角度范围',destroyed:'目标失效',grounded:'地面待机',off:'雷达关闭',silent:'电磁静默'});
const rad=d=>d*Math.PI/180,deg=r=>r*180/Math.PI,clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const vec=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);
export function createRadar(profileId,override){
  const available=override===false?false:profileId==='f16'||!!override;
  const config={...RADAR_DEFAULTS,...RADAR_FEATURES,...(override&&typeof override==='object'?override:{})};
  for(const key of Object.keys(RADAR_DEFAULTS))if(!Number.isFinite(config[key])||(key==='warmupSec'?config[key]<0:config[key]<=0))throw Error('雷达参数无效：'+key);
  for(const key of ['nctrSec','nctrRangeM','nctrConfidence'])if(!Number.isFinite(config[key])||config[key]<=0)throw Error('雷达识别参数无效：'+key);
  if(!RADAR_SCAN_TYPES.includes(config.scanType))throw Error('雷达扫描方式无效');
  if(config.azimuthHalfDeg>85||config.elevationHalfDeg>85||config.minRangeM>=config.rangeM)throw Error('雷达范围配置无效');
  return {available,config,mode:'off',phase:available?'off':'unavailable',targetId:null,contacts:[],events:[],sequence:0,
    scanPhase:0,accumulator:0,acquiredSec:0,missingSec:0,established:false,canIlluminate:false,lastReason:null,
    silent:false,warmingSec:0,identifySec:0,iffMode:'auto',iffInterrogatedAt:-1e9,radarOnSec:0,scanCenterDeg:0,scanHalfDeg:config.azimuthHalfDeg,scanElevationCenterDeg:0,scanElevationHalfDeg:config.elevationHalfDeg,twsTrackedIds:[]};
}
function event(r,time,text,type){r.events.push({sequence:++r.sequence,time,text,type});if(type==='locked')r.lastLockSequence=r.sequence;if(type==='lost')r.lastLostSequence=r.sequence;if(r.events.length>32)r.events.shift();}
export const recordRadarEvent=event;
function clearLock(r){r.targetId=null;r.acquiredSec=0;r.missingSec=0;r.established=false;r.canIlluminate=false;r.identifySec=0;r.phase=r.mode==='off'?(r.silent?'silent':'off'):'search';}
function height(terrain,p){return terrain?.heightAt?.(p[0],p[1])??0;}
export function radarGeometry(own,target,config=RADAR_DEFAULTS,terrain=null){
  const delta=target.position.map((v,i)=>v-own.position[i]),rangeM=Math.hypot(...delta),los=norm(delta);
  const pose=own.sensorPose??basis(own),right=norm(cross(pose.forward,pose.up));
  const forward=dot(los,pose.forward),azimuthDeg=deg(Math.atan2(dot(los,right),forward));
  const elevationDeg=deg(Math.atan2(dot(los,pose.up),Math.hypot(forward,dot(los,right))));
  const closureMps=dot(own.velocity.map((v,i)=>v-target.velocity[i]),los),clutterClosureMps=dot(own.velocity,los);
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
export function radarVisibility(own,target,r,terrain=null){
  const g=radarGeometry(own,target,r.config,terrain);let reason=null;
  // RCS → 探测距离：基准距离 × (RCS/基准 RCS)^0.25；数据未定时 RCS=1，不改变现状。
  const rcsBase=r.config.rcsBase??1,effectiveRangeM=r.config.rangeM*Math.pow(Math.max(.01,target.rcs??rcsBase)/rcsBase,.25);
  if(target.alive===false)reason='destroyed';
  else if(g.rangeM<r.config.minRangeM||g.rangeM>effectiveRangeM)reason='range';
  else if(Math.abs(g.azimuthDeg)>r.config.azimuthHalfDeg||Math.abs(g.elevationDeg)>r.config.elevationHalfDeg)reason='gimbal';
  else if(!g.withinHorizon)reason='horizon';
  if(!reason&&terrain?.heightAt){
    // LOS clearance is zero, unlike the navigation system's 100 m safety margin.
    const steps=Math.min(512,Math.max(2,Math.ceil(g.horizontalM/Math.min(250,terrain.meta?.step??250))));
    for(let i=1;i<steps;i++){const t=i/steps,p=own.position.map((v,k)=>v+(target.position[k]-v)*t),h=terrain.heightAt(p[0],p[1]);
      if(h!==null&&p[2]<=h+g.horizontalM*g.horizontalM*t*(1-t)/(2*r.config.effectiveEarthRadiusM)){reason='terrain';break;}}
  }
  if(!reason&&g.groundClutter){
    if(r.mode==='pulse')reason='ground_clutter';
    else if(r.mode==='pd'&&Math.abs(g.clutterSeparationMps)<r.config.speedGateHalfWidthMps)reason='notch';
  }
  return {...g,effectiveRangeM,visible:reason===null,reason};
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
      const track=r.contacts.find(c=>c.id===order.targetId&&world.time-c.observedAt<=r.config.sweepSec+.25);
      if(!track)throw Error('目标不在本机新鲜雷达航迹中，请先搜索发现目标');
      const target=radarCandidates(world).find(t=>t.id===order.targetId&&t.id!==unit.id);
      const visibility=target?radarVisibility(unit,target,r,world.terrain):null;
      if(!visibility?.visible)throw Error('目标当前不可锁定：'+(RADAR_REASONS[visibility?.reason]??'目标失效')+'，请按当前条件调整后重新截获');
    }
  }
  return order;
}
export function applyRadarOrder(world,unit,order,{autonomous=false}={}){
  validateRadarOrder(world,unit,order);const r=unit.radar;
  if(!autonomous&&unit.radarTask)unit.radarTask.active=false;
  if(!autonomous&&unit.attackTask?.active){unit.attackTask.active=false;unit.attackTask.status='cancelled';unit.attackTask.pending=false;}
  r.controlSequence=(r.controlSequence??0)+1;  if(order.operation==='mode'){
    const wasOn=r.mode!=='off';r.mode=order.mode;r.silent=false;r.contacts=[];r.scanPhase=0;r.lastReason=null;
    unit.pilotContacts=(unit.pilotContacts??[]).filter(c=>c.source!=='radar');
    if(order.mode==='off'){clearLock(r);r.warmingSec=0;event(r,world.time,'雷达关闭，解除锁定','off');}
    else if(!wasOn&&r.config.warmupSec>0){clearLock(r);r.warmingSec=r.config.warmupSec;r.phase='warming';event(r,world.time,`雷达${order.mode==='pd'?'PD 脉冲多普勒':'SRC 脉冲'}开机预热 ${r.config.warmupSec} 秒`,'warming');}
    else{clearLock(r);event(r,world.time,`雷达${order.mode==='pd'?'PD 脉冲多普勒':'SRC 脉冲'}搜索`,'search');}
  }else if(order.operation==='unlock'){clearLock(r);r.lastReason=null;event(r,world.time,'解除锁定，恢复搜索','search');}
  else{clearLock(r);r.targetId=order.targetId;r.phase='acquiring';r.lastReason=null;event(r,world.time,'开始截获目标 '+order.targetId,'acquiring');}
}
function iffFriend(r,time){
  if(r.iffMode==='off')return false;
  if(r.iffMode==='auto')return true;
  return time-(r.iffInterrogatedAt??-1e9)<=5;
}
function recordContact(r,own,target,g,time){
  const old=r.contacts.find(c=>c.id===target.id),team=own.team??own.faction??'blue',otherTeam=target.team??target.faction??'blue';
  const contact={id:target.id,callsign:target.callsign??target.id,classification:otherTeam===team&&iffFriend(r,time)?'friendly':'unknown',
    practice:target.radarPractice===true,source:'radar',observedAt:time,position:[...target.position],velocity:[...target.velocity],
    rcs:target.rcs??null,
    rangeM:g.rangeM,azimuthDeg:g.azimuthDeg,elevationDeg:g.elevationDeg,closureMps:g.closureMps,clutterSeparationMps:g.clutterSeparationMps};
  if(old){Object.assign(old,contact);if(old.identification)contact.identification=old.identification;}else if(r.contacts.length<32)r.contacts.push(contact);
  if(old&&old.identification)old.identification=old.identification;
}
function tryIdentify(r,target,rangeM){
  if(!r.config.nctr||!r.established)return;
  if(rangeM>r.config.nctrRangeM)return;
  const contact=r.contacts.find(c=>c.id===target.id);
  if(!contact||contact.identification)return;
  if(r.identifySec+1e-8<r.config.nctrSec)return;
  contact.identification={category:target.aircraftCategory??'战斗机',type:target.aircraftType??null,confidence:r.config.nctrConfidence,at:null};
}
function updateRadar(world,own,dt,time){
  const r=own.radar;if(!r?.available)return;
  if(r.mode==='off'||own.alive===false||own.surface?.grounded){
    if(r.targetId)event(r,time,'停止跟踪：'+(own.alive===false?'本机失效':own.surface?.grounded?'地面待机':'雷达关闭'),'lost');
    clearLock(r);r.contacts=[];own.pilotContacts=(own.pilotContacts??[]).filter(c=>c.source!=='radar');r.phase=r.mode==='off'?(r.silent?'silent':'off'):own.alive===false?'unavailable':'standby';r.lastReason=own.surface?.grounded?'grounded':r.mode==='off'?(r.silent?'silent':'off'):null;return;
  }
  if(r.warmingSec>0){
    r.warmingSec=Math.max(0,r.warmingSec-dt);r.phase='warming';r.contacts=[];
    if(r.warmingSec===0){r.phase='search';event(r,time,'雷达预热完成，开始搜索','search');}
    return;
  }
  const candidates=radarCandidates(world).filter(t=>t.id!==own.id);
  if(r.targetId){
    const target=candidates.find(t=>t.id===r.targetId),g=target?radarVisibility(own,target,r,world.terrain):{visible:false,reason:'destroyed'};
    if(g.visible){
      recordContact(r,own,target,g,time);r.missingSec=0;r.lastReason=null;
      if(!r.established){r.acquiredSec+=dt;r.phase='acquiring';if(r.acquiredSec+1e-8>=r.config.acquireSec){r.established=true;event(r,time,'目标 '+r.targetId+'，雷达锁定','locked');}}
      if(r.established){r.phase='locked';r.identifySec+=dt;tryIdentify(r,target,g.rangeM);}r.canIlluminate=r.established;
    }else{
      r.missingSec+=dt;r.acquiredSec=0;r.identifySec=0;r.canIlluminate=false;r.lastReason=g.reason;r.phase=r.established?'coasting':'acquiring';
      if(r.missingSec+1e-8>=r.config.coastSec){const id=r.targetId;clearLock(r);event(r,time,'目标 '+id+' 掉锁：'+(RADAR_REASONS[g.reason]??g.reason),'lost');}
    }
  }else{
    r.phase='search';r.canIlluminate=false;
    const sweepSec=r.config.scanType==='aesa'?r.config.sweepSec*.5:r.config.sweepSec;
    const center=r.scanCenterDeg??0,half=r.scanHalfDeg??r.config.azimuthHalfDeg;
    const from=r.scanPhase,increment=dt/sweepSec,to=from+increment,width=r.config.beamHalfDeg/(2*half);
    for(const target of candidates){
      if(target.alive===false)continue;
      const direction=radarGeometry(own,target,r.config,world.terrain),phase=(direction.azimuthDeg-(center-half))/(2*half);
      const elevationOk=Math.abs(direction.elevationDeg-(r.scanElevationCenterDeg??0))<=(r.scanElevationHalfDeg??r.config.elevationHalfDeg)+r.config.beamHalfDeg;
      const passed=elevationOk&&(increment>=1||[phase-1,phase,phase+1].some(p=>p>=from-width&&p<=to+width));
      if(passed){const g=radarVisibility(own,target,r,world.terrain);if(g.visible)recordContact(r,own,target,g,time);}
    }
    r.scanPhase=to%1;
  }
  r.contacts=r.contacts.filter(c=>time-c.observedAt<=r.config.memorySec);
  r.twsTrackedIds=(r.twsTrackedIds??[]).filter(id=>r.contacts.some(c=>c.id===id));
  r.radarOnSec=(r.radarOnSec??0)+dt;
  own.pilotContacts=[...(own.pilotContacts??[]).filter(c=>c.source!=='radar'),...r.contacts.map(c=>({...c,position:[...c.position],velocity:[...c.velocity],threat:false,missileWarning:false}))];
}
export function stepRadars(world,dt){
  for(const own of world.units){const r=own.radar;if(!r)continue;r.accumulator+=dt;
    while(r.accumulator+1e-9>=.05){r.accumulator-=.05;updateRadar(world,own,.05,world.time-r.accumulator);}}
}
// 手动雷达扫描：中心方位与半宽，必须在天线最大方位范围内。
export function setRadarScan(world,unit,{centerDeg,halfWidthDeg,elevationCenterDeg,elevationHalfWidthDeg}={}){
  const r=unit?.radar;if(!unit||unit.alive===false||!r?.available)throw Error('该机没有可用的搜索雷达');
  const max=r.config.azimuthHalfDeg,half=Number(halfWidthDeg??r.scanHalfDeg??max),center=Number(centerDeg??r.scanCenterDeg??0);
  if(!Number.isFinite(half)||!Number.isFinite(center)||half<r.config.beamHalfDeg||half>max)throw Error('扫描扇区宽度无效');
  const maxEl=r.config.elevationHalfDeg,elHalf=Number(elevationHalfWidthDeg??r.scanElevationHalfDeg??maxEl),elCenter=Number(elevationCenterDeg??r.scanElevationCenterDeg??0);
  if(!Number.isFinite(elHalf)||!Number.isFinite(elCenter)||elHalf<r.config.beamHalfDeg||elHalf>maxEl)throw Error('俯仰扫描范围无效');
  const clamped=Math.max(-max+half,Math.min(max-half,center));
  const elClamped=Math.max(-maxEl+elHalf,Math.min(maxEl-elHalf,elCenter));
  r.scanHalfDeg=half;r.scanCenterDeg=clamped;r.scanElevationHalfDeg=elHalf;r.scanElevationCenterDeg=elClamped;r.scanPhase=0;
  event(r,world.time,`手动扫描扇区：中心 ${clamped.toFixed(0)}°，宽度 ±${half.toFixed(0)}°；俯仰 ${elClamped.toFixed(0)}° ±${elHalf.toFixed(0)}°`,'scan');
  unit.radar.controlSequence=(unit.radar.controlSequence??0)+1;
  world.revision=(world.revision??0)+1;return {centerDeg:clamped,halfWidthDeg:half,elevationCenterDeg:elClamped,elevationHalfWidthDeg:elHalf};
}
// TWS 多目标跟踪：只管理多目标航迹列表，不改变单一火控锁定 targetId。
export function setRadarTws(world,unit,targetIds){
  const r=unit?.radar;if(!unit||unit.alive===false||!r?.available)throw Error('该机没有可用的搜索雷达');
  if(!Array.isArray(targetIds)||targetIds.length>8)throw Error('TWS 跟踪目标数量无效');
  const ids=[...new Set(targetIds)];
  if(ids.some(id=>typeof id!=='string'||!id))throw Error('TWS 跟踪目标无效');
  const fresh=new Set(r.contacts.filter(c=>world.time-c.observedAt<=r.config.sweepSec+.25).map(c=>c.id));
  if(ids.some(id=>!fresh.has(id)))throw Error('TWS 只能跟踪当前新鲜雷达航迹');
  r.twsTrackedIds=ids;
  event(r,world.time,ids.length?`TWS 多目标跟踪 ${ids.length} 个`:'TWS 多目标跟踪已清空','tws');
  unit.radar.controlSequence=(unit.radar.controlSequence??0)+1;
  world.revision=(world.revision??0)+1;return [...ids];
}
// 电磁静默：关雷达 + 主动通信/数据链只收不发（信息孤岛）；RWR 仍接收。
export function setRadarSilence(world,unit,silent){
  const r=unit?.radar;if(!unit||unit.alive===false||!r?.available)throw Error('该机没有可用的搜索雷达');
  if(silent){
    if(r.mode!=='off')applyRadarOrder(world,unit,{operation:'mode',mode:'off',targetId:null});
    r.silent=true;r.phase='silent';r.lastReason='silent';r.contacts=[];
    event(r,world.time,'进入电磁静默：雷达关闭，主动通信与数据链停止，RWR 仍在接收','silent');
  }else{
    r.silent=false;if(r.phase==='silent'){r.phase='off';}r.lastReason=null;
    event(r,world.time,'解除电磁静默','silent');
  }
  world.revision=(world.revision??0)+1;
  return r.silent;
}
// 敌我识别：自动 / 手动问询 / 关闭。关闭时同阵营目标也显示为未知。
export function setIffMode(world,unit,mode){
  const r=unit?.radar;if(!unit||!r?.available)throw Error('该机没有可用的搜索雷达');
  if(!IFF_MODES.includes(mode))throw Error('敌我识别模式无效');
  r.iffMode=mode;r.iffInterrogatedAt=-1e9;for(const c of r.contacts)c.classification='unknown';
  event(r,world.time,mode==='auto'?'敌我识别：自动问询':mode==='manual'?'敌我识别：手动问询（按 I 询问）':'敌我识别：关闭','iff');
  world.revision=(world.revision??0)+1;return mode;
}
export function interrogateIff(world,unit){
  const r=unit?.radar;if(!unit||!r?.available)throw Error('该机没有可用的搜索雷达');
  if(r.iffMode!=='manual')throw Error('当前不是手动问询模式');
  r.iffInterrogatedAt=world.time;
  const friendlies=r.contacts.filter(c=>c.classification==='unknown').length;
  event(r,world.time,`IFF 问询完成：${friendlies} 个目标重新比对`,'iff');
  for(const c of r.contacts){const target=radarCandidates(world).find(t=>t.id===c.id);const team=unit.team??unit.faction??'blue',otherTeam=target?.team??target?.faction??'blue';if(otherTeam===team)c.classification='friendly';}
  world.revision=(world.revision??0)+1;return r.iffInterrogatedAt;
}
export function radarView(unit,time){
  const r=unit.radar;if(!r)return null;
  return {available:r.available,mode:r.mode,phase:r.phase,targetId:r.targetId,canIlluminate:r.canIlluminate,lastReason:r.lastReason,
    speedGateHalfWidthMps:r.config.speedGateHalfWidthMps,rangeM:r.config.rangeM,azimuthHalfDeg:r.config.azimuthHalfDeg,
    silent:r.silent===true,warmupRemainingSec:Math.max(0,r.warmingSec??0),iffMode:r.iffMode??'auto',radarOnSec:r.radarOnSec??0,scanType:r.config.scanType??'mechanical',
    scanCenterDeg:r.scanCenterDeg??0,scanHalfDeg:r.scanHalfDeg??r.config.azimuthHalfDeg,
    scanElevationCenterDeg:r.scanElevationCenterDeg??0,scanElevationHalfDeg:r.scanElevationHalfDeg??r.config.elevationHalfDeg,
    scanAzimuthDeg:(r.scanCenterDeg??0)-(r.scanHalfDeg??r.config.azimuthHalfDeg)+2*(r.scanHalfDeg??r.config.azimuthHalfDeg)*r.scanPhase,
    acquireProgress:clamp(r.acquiredSec/r.config.acquireSec,0,1),coastRemainingSec:Math.max(0,r.config.coastSec-r.missingSec),
    twsTrackedIds:[...(r.twsTrackedIds??[])],
    contacts:r.contacts.map(c=>({...c,position:[...c.position],velocity:[...c.velocity],ageSec:Math.max(0,time-c.observedAt),
      predictedPosition:c.position.map((v,i)=>v+c.velocity[i]*Math.max(0,time-c.observedAt))})),events:r.events.map(e=>({...e}))};
}
// Compact, observed sensor state for the language model; never add hidden target positions.
export function radarContext(unit,time){const v=radarView(unit,time);if(!v)return null;
  const {available,mode,phase,targetId,canIlluminate,speedGateHalfWidthMps,lastReason}=v;
  return {available,mode,phase,targetId,canIlluminate,speedGateHalfWidthMps,lastReason,
    controlSequence:unit.radar.controlSequence??0,lastLockSequence:unit.radar.lastLockSequence??0,lastLostSequence:unit.radar.lastLostSequence??0,
    contacts:v.contacts.map(({id,callsign,classification,position,velocity,observedAt})=>({id,callsign,classification,position,velocity,observedAt}))};
}
export function parseRadarContext(v,time){
  if(v==null)return null;
  if(typeof v.available!=='boolean'||!RADAR_MODES.includes(v.mode)||typeof v.phase!=='string'||v.phase.length>32||
    !(v.targetId===null||typeof v.targetId==='string'&&v.targetId.length<=64)||typeof v.canIlluminate!=='boolean'||
    !Number.isFinite(v.speedGateHalfWidthMps)||v.speedGateHalfWidthMps<=0||v.speedGateHalfWidthMps>500||!Array.isArray(v.contacts)||v.contacts.length>32)throw Error('雷达上下文无效');
  const ids=new Set(),contacts=v.contacts.map(c=>{if(!c||typeof c.id!=='string'||!c.id||c.id.length>64||ids.has(c.id)||typeof c.callsign!=='string'||c.callsign.length>80||
    !['friendly','unknown'].includes(c.classification)||!vec(c.position)||!vec(c.velocity)||!Number.isFinite(c.observedAt)||c.observedAt<0||c.observedAt>time+.001)throw Error('雷达航迹无效');ids.add(c.id);
    return {id:c.id,callsign:c.callsign,classification:c.classification,position:[...c.position],velocity:[...c.velocity],observedAt:c.observedAt};});
  for(const key of ['controlSequence','lastLockSequence','lastLostSequence'])if(v[key]!==undefined&&(!Number.isSafeInteger(v[key])||v[key]<0))throw Error('雷达序号无效');
  if(!(v.lastReason==null||typeof v.lastReason==='string'&&Object.hasOwn(RADAR_REASONS,v.lastReason)))throw Error('雷达状态原因无效');
  return {available:v.available,mode:v.mode,phase:v.phase,targetId:v.targetId,canIlluminate:v.canIlluminate,speedGateHalfWidthMps:v.speedGateHalfWidthMps,
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
    if(radarOrder.operation==='lock'&&(unit.radar.mode==='off'||!unit.radar.contacts.some(c=>c.id===radarOrder.targetId&&context.simTimeSec-c.observedAt<=RADAR_DEFAULTS.sweepSec+.25)))throw Error('受令机尚未发现该目标的有效航迹，请先开启雷达搜索');
    return {unitId,action:'radar',radarOrder:{...radarOrder}};
  });
}
