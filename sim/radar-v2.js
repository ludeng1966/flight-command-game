import {basis,cross,dot,norm} from './flight.js';
import {groundVelocity,trackUsable} from './radar-quality.js';
import {initializeFilter,predictFilter,filterInnovation,correctFilter,correctSearchFilter} from './radar-filter.js';
import {beamGate,inBeam} from './radar-beam.js';
import {DATALINK_DEFAULTS} from './datalink.js';
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),rad=d=>d*Math.PI/180,deg=r=>r*180/Math.PI;
export const V2_DEFAULTS=Object.freeze({sensorModelVersion:2,referenceRangeM:40000,referenceRcsM2:1,referencePd:.8,
  referenceDwellSec:.1,snrSlopeDb:3,scanRateDegSec:60,elevationRateDegSec:60,barSpacingDeg:4,barCount:4,
  settleSec:.05,supportsTws:false,trackKnownFriendlies:false,maxScheduledTracks:4,maxDatalinkChannels:2,maxIlluminationChannels:1,
  positionNoiseM:50,angleNoiseDeg:.15,radialNoiseMps:3,processAccelerationMps2:5,noiseKernelVersion:2});
export const SCAN_POLICY_SCHEMA={type:'object',additionalProperties:false,required:['frame','azCenterDeg','azWidthDeg','elevationCenterDeg','barCount','rangeBandM','altitudeBandM'],properties:{
  frame:{enum:['body','world']},azCenterDeg:{type:'number',minimum:-360,maximum:360},azWidthDeg:{type:'number',minimum:6,maximum:120},elevationCenterDeg:{type:'number',minimum:-30,maximum:30},barCount:{enum:[2,4,6,8,10,12,14]},rangeBandM:{type:'array',items:{type:'number'},minItems:2,maxItems:2},altitudeBandM:{anyOf:[{type:'null'},{type:'array',items:{type:'number'},minItems:2,maxItems:2}]}}};
export function initializeV2(r){
  Object.assign(r,{sensorModelVersion:2,antenna:{azimuthDeg:-r.config.azimuthHalfDeg,elevationDeg:-6,bar:0,direction:1,settle:0,frame:0},
    tracks:[],bindings:{},trackSequence:0,visitSequence:0,sampled:{},coverage:Array(288).fill(null),scheduledTrackIds:[],
    scanPolicy:{frame:'body',azCenterDeg:0,azWidthDeg:120,elevationCenterDeg:0,barCount:4,rangeBandM:[r.config.minRangeM,r.config.rangeM]},
    policyRevision:0,emissions:[],lastSenseAt:0});return r;
}
export function validateV2Config(config){
  for(const [k,v]of Object.entries(V2_DEFAULTS)){const value=config[k]??(k==='noiseKernelVersion'?1:undefined);if(typeof v==='number'&&(!Number.isFinite(value)||value<=0))throw Error('雷达v2参数无效：'+k);}
  if(config.noiseKernelVersion!==undefined&&![1,2].includes(config.noiseKernelVersion))throw Error('雷达噪声版本无效');
  if(typeof config.supportsTws!=='boolean'||typeof (config.trackKnownFriendlies??false)!=='boolean'||config.barCount>15||!Number.isInteger(config.barCount)||config.referencePd>=1||config.angleNoiseDeg>10||config.maxScheduledTracks>16||!Number.isInteger(config.maxScheduledTracks)||config.maxDatalinkChannels>16||!Number.isInteger(config.maxDatalinkChannels))throw Error('雷达v2能力配置无效');
}
export function setScanPolicy(unit,policy){
  const r=unit.radar;if(r?.sensorModelVersion!==2)throw Error('该机未启用三维搜索');
  if(!policy||Object.keys(policy).some(k=>!['frame','azCenterDeg','azWidthDeg','elevationCenterDeg','barCount','rangeBandM','altitudeBandM'].includes(k)))throw Error('扫描策略字段无效');
  const p={...r.scanPolicy,...policy};
  if(!['body','world'].includes(p.frame)||!Number.isFinite(p.azCenterDeg)||Math.abs(p.azCenterDeg)>360||!Number.isFinite(p.azWidthDeg)||p.azWidthDeg<6||p.azWidthDeg>2*r.config.azimuthHalfDeg||!Number.isFinite(p.elevationCenterDeg)||Math.abs(p.elevationCenterDeg)>r.config.elevationHalfDeg||![2,4,6,8,10,12,14].includes(p.barCount)||!Array.isArray(p.rangeBandM)||p.rangeBandM.length!==2||!p.rangeBandM.every(Number.isFinite)||p.rangeBandM[0]<r.config.minRangeM||p.rangeBandM[1]>r.config.rangeM||p.rangeBandM[0]>=p.rangeBandM[1])throw Error('扫描范围超出本机能力');
  if(p.altitudeBandM&&(!Array.isArray(p.altitudeBandM)||p.altitudeBandM.length!==2||!p.altitudeBandM.every(Number.isFinite)||p.altitudeBandM[0]<0||p.altitudeBandM[0]>=p.altitudeBandM[1]||p.altitudeBandM[1]>30000))throw Error('搜索高度带无效');
  r.scanPolicy=p;r.policyRevision++;r.sampled={};r.antenna.bar=0;r.antenna.frame++;r.antenna.direction=1;return p;
}
export function scanFrameSec(r){
  const n=r.scanPolicy?.barCount??4,w=r.scanPolicy?.azWidthDeg??120,c=r.config,quantized=seconds=>Math.ceil((seconds-1e-10)/.05)*.05;
  const cycle=n*quantized(w/c.scanRateDegSec)+(n-1)*quantized(c.barSpacingDeg/c.elevationRateDegSec)+quantized((n-1)*c.barSpacingDeg/c.elevationRateDegSec)+n*quantized(c.settleSec);
  return cycle*(c.supportsTws&&r.scheduledTrackIds?.length?2:1);
}
function random(key){let h=2166136261;for(const c of key){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}h^=h>>>16;h=Math.imul(h,0x7feb352d);h^=h>>>15;h=Math.imul(h,0x846ca68b);return ((h^(h>>>16))>>>0)/4294967296;}
function normal(key){return Math.sqrt(-2*Math.log(Math.max(1e-12,random(key+'a'))))*Math.cos(2*Math.PI*random(key+'b'));}
function normalFour(key){
  let state=(random(key+'noise')*4294967296)>>>0;state||=0x9e3779b9;
  const next=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return ((state>>>0)+.5)/4294967296;},out=[];
  for(let i=0;i<2;i++){const radius=Math.sqrt(-2*Math.log(next())),angle=2*Math.PI*next();out.push(radius*Math.cos(angle),radius*Math.sin(angle));}return out;
}
const qualityConstants=new WeakMap();
export function detectionQuality(r,target,g,dwell=r.config.referenceDwellSec){
  const c=r.config,rcs=Math.max(.00001,target.radarRcsM2??target.profile?.radarRcsM2??1);
  let clutterLossDb=0;
  if(g.groundClutter){if(r.mode==='pulse')clutterLossDb=-20;else{const u=clamp((Math.abs(g.clutterSeparationMps)-(c.speedGateHalfWidthMps-20))/40,0,1);clutterLossDb=10*Math.log10(.01+.99*u*u*(3-2*u));}}
  let constants=qualityConstants.get(c);
  if(!constants||constants.range!==c.referenceRangeM||constants.pd!==c.referencePd){constants={range:c.referenceRangeM,pd:c.referencePd,rangeDb:40*Math.log10(c.referenceRangeM),odds:Math.log(c.referencePd/(1-c.referencePd))};qualityConstants.set(c,constants);}
  const marginDb=constants.rangeDb-40*Math.log10(Math.max(1,g.rangeM))+(rcs===c.referenceRcsM2?0:10*Math.log10(rcs/c.referenceRcsM2))+(dwell===c.referenceDwellSec?0:10*Math.log10(Math.max(.001,dwell)/c.referenceDwellSec))+clutterLossDb;
  const pd=1/(1+Math.exp(-(constants.odds+marginDb/c.snrSlopeDb)));
  return {pd,marginDb};
}
export function measurement(world,own,target,r,g,key,includeCovariance=true){
  const q=detectionQuality(r,target,g);if(random(key+'hit')>=q.pd)return null;
  const k=q.marginDb>=0?1:Math.min(8,10**(-q.marginDb/20)),sigma=[r.config.positionNoiseM*k,rad(r.config.angleNoiseDeg)*k,rad(r.config.angleNoiseDeg)*k,r.config.radialNoiseMps*k];
  const raw=[g.rangeM,Math.atan2(g.los[0],g.los[1]),Math.atan2(g.los[2],Math.hypot(g.los[0],g.los[1])),-g.closureMps];
  const noise=r.config.noiseKernelVersion===2?normalFour(key):raw.map((_,i)=>normal(key+'noise'+i));
  const z=raw.map((v,i)=>v+sigma[i]*noise[i]);z[0]=Math.max(1,z[0]);z[2]=clamp(z[2],-Math.PI/2,Math.PI/2);
  const los=[Math.sin(z[1])*Math.cos(z[2]),Math.cos(z[1])*Math.cos(z[2]),Math.sin(z[2])];
  return {z,R:includeCovariance?sigma.map((s,i)=>sigma.map((_,j)=>i===j?s*s:0)):null,observerPosition:[...own.position],observerVelocity:groundVelocity(own),
    position:own.position.map((v,i)=>v+los[i]*z[0]),los,sigma,quality:q};
}
// Reuse only the live internal projection; radarContext/radarView clone snapshots.
// Samples stay immutable until a new actual measurement arrives.
const publicTracks=new WeakMap();
function publicTrack(t,r,time){
  let c=publicTracks.get(t);
  if(!c){c={sensorModelVersion:2,id:t.id,source:'radar',predictedPosition:[0,0,0],
    uncertainty:{positionSigmaM:[0,0,0],velocitySigmaMps:[0,0,0],radialSigmaMps:0},usable:{},threat:false,missileWarning:false};publicTracks.set(t,c);}
  const priority=r.targetId===t.id||r.scheduledTrackIds?.includes(t.id);
  if(!priority&&c.observedAt===t.observedAt&&c.state===t.state&&c.awaitingValidation===t.awaitingValidation&&time-c.estimatedAt<.1-1e-8)return c;
  if(c.observedAt!==t.observedAt){
    c.position=[...t.lastPosition];c.velocity=[...t.lastVelocity];c.measuredPositionM=[...t.measuredPosition];
    c.observerPosition=[...t.observerPosition];c.observerVelocity=[...t.observerVelocity];c.observedAt=t.observedAt;
    c.velocityEstimateMps=t.hits<2?null:[...t.lastVelocity];
    c.rangeM=t.rangeM;c.azimuthDeg=t.azimuthDeg;c.elevationDeg=t.elevationDeg;c.closureMps=t.closureMps;c.clutterSeparationMps=t.clutterSeparationMps;
  }
  c.callsign=t.callsign;c.classification=t.classification;c.practice=t.practice;c.estimatedAt=time;c.expectedRevisitAt=t.expectedRevisitAt;c.estimationModel=t.filterMode==='search_axes'?'axis_search':'full_ekf';
  c.state=t.state;c.awaitingValidation=t.awaitingValidation;c.associationQuality=t.ambiguous?'ambiguous':'unique';c.history=t.history;
  let positionMax=0,velocityMax=0;const horizon=priority?0:.1;
  for(let i=0;i<3;i++){c.predictedPosition[i]=t.x[i];const ps=Math.sqrt(Math.max(0,t.P[i][i]+2*horizon*t.P[i][i+3]+horizon*horizon*t.P[i+3][i+3]+25*horizon**4/4)),vs=Math.sqrt(Math.max(0,t.P[i+3][i+3]+25*horizon*horizon));
    c.uncertainty.positionSigmaM[i]=ps;c.uncertainty.velocitySigmaMps[i]=vs;positionMax=Math.max(positionMax,ps);velocityMax=Math.max(velocityMax,vs);}
  c.uncertainty.radialSigmaMps=t.radialSigmaMps;
  const age=Math.max(0,time-t.observedAt),valid=t.state!=='lost'&&!t.awaitingValidation;
  c.usable.acquisition=valid&&age<=45&&positionMax<=5000;
  const fireControl=valid&&t.state==='confirmed'&&!t.ambiguous&&positionMax<=300&&velocityMax<=30;
  c.usable.fireControl=fireControl&&age<=.25;c.usable.midcourse=fireControl&&age<=2;
  return c;
}
function bounds(own,r){
  const p=r.scanPolicy,c=r.config,heading=deg(Math.atan2(own.velocity[0],own.velocity[1]));
  const desired=p.frame==='world'?((p.azCenterDeg-heading+540)%360)-180:((p.azCenterDeg+540)%360)-180;
  const center=clamp(desired,-c.azimuthHalfDeg+p.azWidthDeg/2,c.azimuthHalfDeg-p.azWidthDeg/2);
  let elevation=p.elevationCenterDeg;
  let requestedAngles=null;
  if(p.altitudeBandM){const ranges=[Math.max(1000,p.rangeBandM[0]),p.rangeBandM[1]];requestedAngles=p.altitudeBandM.flatMap(h=>ranges.map(d=>deg(Math.atan2(h-own.position[2],d))));
    // When one frame cannot cover the entire altitude/range volume, prioritize
    // the outer search range and report the actual gap instead of aiming at an
    // almost vertical near-range ray and missing the distant altitude band.
    const far=p.altitudeBandM.map(h=>deg(Math.atan2(h-own.position[2],p.rangeBandM[1])));elevation=(far[0]+far[1])/2;}
  const half=(p.barCount-1)*c.barSpacingDeg/2;elevation=clamp(elevation,-c.elevationHalfDeg+half,c.elevationHalfDeg-half);
  r.coverageLimited=Math.abs(desired-center)>.1||!!requestedAngles&&(Math.min(...requestedAngles)<elevation-half-c.beamHalfDeg||Math.max(...requestedAngles)>elevation+half+c.beamHalfDeg);
  return {left:center-p.azWidthDeg/2,right:center+p.azWidthDeg/2,elevation:elevation-half};
}
function moveToward(a,b,step){return a+clamp(b-a,-step,step);}
function scanBeam(own,r,dt,geometry){
  const a=r.antenna,c=r.config,from={az:a.azimuthDeg,el:a.elevationDeg};let job='search';
  let track=r.targetId?r.tracks.find(t=>t.id===r.targetId):null;
  if(!track&&c.supportsTws&&r.scheduledTrackIds.length&&Math.floor((r.lastSenseAt+.00001)*10)%2===0){track=r.tracks.find(t=>t.id===r.scheduledTrackIds[Math.floor(r.lastSenseAt)%r.scheduledTrackIds.length]);job='track_update';}
  if(track){
    if(r.targetId)job='track';const g=geometry(own,{position:track.x.slice(0,3),velocity:track.x.slice(3),velocityFrame:'world'},c);
    a.azimuthDeg=moveToward(a.azimuthDeg,clamp(g.azimuthDeg,-c.azimuthHalfDeg,c.azimuthHalfDeg),c.scanRateDegSec*dt);
    a.elevationDeg=moveToward(a.elevationDeg,clamp(g.elevationDeg,-c.elevationHalfDeg,c.elevationHalfDeg),c.elevationRateDegSec*dt);
  }else{
    const b=bounds(own,r),el=b.elevation+a.bar*c.barSpacingDeg;
    if(Math.abs(a.elevationDeg-el)>.001){a.elevationDeg=moveToward(a.elevationDeg,el,c.elevationRateDegSec*dt);job='slew';}
    else if(a.settle>0){a.settle=Math.max(0,a.settle-dt);job='slew';}
    else{a.azimuthDeg=clamp(a.azimuthDeg+a.direction*c.scanRateDegSec*dt,b.left,b.right);
      if(a.azimuthDeg===(a.direction>0?b.right:b.left)){a.direction*=-1;a.bar++;if(a.bar>=r.scanPolicy.barCount){a.bar=0;a.frame++;}a.settle=c.settleSec;r.sampled={};r.visitSequence++;}}
  }
  r.scanPhase=clamp((a.azimuthDeg+c.azimuthHalfDeg)/(2*c.azimuthHalfDeg),0,.99999999);
  return {from,to:{az:a.azimuthDeg,el:a.elevationDeg},job};
}
function inside(g,beam,half){return g.azimuthDeg>=Math.min(beam.from.az,beam.to.az)-half&&g.azimuthDeg<=Math.max(beam.from.az,beam.to.az)+half&&g.elevationDeg>=Math.min(beam.from.el,beam.to.el)-half&&g.elevationDeg<=Math.max(beam.from.el,beam.to.el)+half;}
const receivedFriendlies=new WeakMap();
function receivedFriendlyIds(world,own){
  const link=own.datalink;
  if(own.radar.config.trackKnownFriendlies||!link?.config.available||link.config.mode==='off'||!link.contacts.length)return null;
  let cached=receivedFriendlies.get(link);
  if(!cached||cached.contacts!==link.contacts||cached.count!==link.contacts.length||cached.network!==link.config.networkId||world.time>=cached.expiresAt){
    const ids=new Set();let expiresAt=Infinity;
    for(const c of link.contacts)if(c.kind==='participant'&&(c.channelId??link.config.networkId)===link.config.networkId&&c.observedAt<=world.time&&world.time-c.observedAt<=DATALINK_DEFAULTS.freshSec){ids.add(c.sourceUnitId);expiresAt=Math.min(expiresAt,c.observedAt+DATALINK_DEFAULTS.freshSec+1e-8);}
    cached={contacts:link.contacts,count:link.contacts.length,network:link.config.networkId,ids,expiresAt};receivedFriendlies.set(link,cached);
  }
  return cached.ids;
}
function telemetryFriendly(own,target,known){
  if(!known?.has(target.id))return false;
  // Only a position report actually RECEIVED on this terminal's channel can
  // replace duplicate friendly radar tracking; team membership is insufficient.
  const r=own.radar,task=own.radarTask;if(r.bindings[r.targetId]===target.id)return false;
  if(task?.goal==='track_target'){
    if(task.targetId===target.id||r.bindings[task.targetId]===target.id)return false;
    const canonical=v=>String(v??'').replace(/[\s_-]/g,'').toUpperCase(),ref=canonical(task.targetRef);
    if(ref&&[target.id,target.callsign,...(target.aliases??[])].some(v=>canonical(v)===ref))return false;
  }
  return true;
}
function updateMeasurement(r,own,target,g,m,time,visit,matched){
  const sigmaPos2=Math.max(m.sigma[0],g.rangeM*m.sigma[1])**2;
  // Ordinary search uses a bounded geometric shortlist. Fire-control/TWS keeps
  // the exhaustive gate. Truncation is explicitly ambiguous, never certainty.
  const full=!!r.targetId||r.config.supportsTws,limit=full?32:4,nearest=[];let gated=0;
  for(const t of r.tracks){
    if(matched.has(t.id)||t.lastVisit===visit||t.state==='lost')continue;
    let score=0;for(let i=0;i<3;i++){const diff=m.position[i]-t.x[i];score+=diff*diff/(t.P[i][i]+sigmaPos2);}
    if(score>18.5)continue;gated++;
    let at=nearest.length;while(at>0&&nearest[at-1].score>score)at--;
    if(at<limit){nearest.splice(at,0,{t,score});if(nearest.length>limit)nearest.pop();}
  }
  const candidates=[];for(const {t,score}of nearest){const fit=full?filterInnovation(t,m):{d2:score};if(fit&&fit.d2<=18.5)candidates.push({t,fit});}candidates.sort((a,b)=>a.fit.d2-b.fit.d2);
  let t=candidates[0]?.t;
  if(t){t.ambiguous=gated>limit||candidates.length>1&&candidates[1].fit.d2-candidates[0].fit.d2<4;if(full)correctFilter(t,m,candidates[0].fit);else correctSearchFilter(t,m,sigmaPos2);}
  else{if(r.tracks.length>=32)return null;const id=`${own.id}-T${++r.trackSequence}`;t={id,...initializeFilter(m.position,m.z[3]+dot(m.observerVelocity,m.los),m.los,time,Math.max(m.sigma[0],g.rangeM*m.sigma[1])),hits:0,history:[],firstSeen:time,misses:0};r.tracks.push(t);}
  t.filterMode??=full?'full_ekf':'search_axes';matched.add(t.id);r.bindings[t.id]=target.id;t.hits++;t.hitHistory=[...(t.hitHistory??[]),1].slice(-3);t.misses=0;t.state=t.hitHistory.reduce((a,b)=>a+b,0)>=2?'confirmed':'tentative';t.awaitingValidation=false;
  t.observedAt=time;t.expectedRevisitAt=time+(r.targetId===t.id ? .1 : scanFrameSec(r));t.lastVisit=visit;
  t.lastPosition=t.x.slice(0,3);t.lastVelocity=t.x.slice(3);t.measuredPosition=m.position;t.observerPosition=m.observerPosition;t.observerVelocity=m.observerVelocity;t.radialSigmaMps=m.sigma[3];
  t.practice=target.radarPractice===true;t.classification=(target.team??target.faction??'blue')===(own.team??own.faction??'blue')?'friendly':'unknown';
  t.callsign=t.classification==='friendly'?target.callsign??t.id:t.id;t.rangeM=m.z[0];t.azimuthDeg=g.azimuthDeg;t.elevationDeg=g.elevationDeg;t.closureMps=-m.z[3];t.clutterSeparationMps=m.z[3]+dot(m.observerVelocity,m.los);
  if(!t.history.length||time-t.history.at(-1).observedAt>=.75){t.history.push({observedAt:time,position:[...t.lastPosition],velocity:[...t.lastVelocity],observerPosition:[...m.observerPosition],observerVelocity:[...m.observerVelocity]});t.history=t.history.filter(s=>time-s.observedAt<=120).slice(-16);}
  return t;
}
export function updateV2(world,own,dt,time,{geometry,visibility,event,clearLock}){
  const r=own.radar;r.lastSenseAt=time;r.emissions=[];
  const rawGeometry=geometry,posedOwn={position:own.position,velocity:own.velocity,groundVelocity:groundVelocity(own),sensorPose:own.sensorPose??basis(own)};
  r.antennaPose=posedOwn.sensorPose;
  geometry=(observer,target,config,terrain)=>rawGeometry(observer===own?posedOwn:observer,target,config,terrain);
  for(const t of r.tracks)predictFilter(t,time);
  if(r.mode==='off'||!own.alive||own.surface?.grounded){
    clearLock(r);r.phase=!own.alive?'unavailable':own.surface?.grounded?'standby':'off';r.contacts=r.tracks.filter(t=>time-t.observedAt<=45).map(t=>{t.awaitingValidation=true;t.state='coasting';return publicTrack(t,r,time);});return;
  }
  r.scheduledTrackIds=r.config.supportsTws?r.tracks.filter(t=>t.state==='confirmed').slice(0,r.config.maxScheduledTracks).map(t=>t.id):[];
  const beam=scanBeam(own,r,dt,geometry),visit=beam.job==='track'||beam.job==='track_update'?`track-${Math.floor((time+1e-8)/.1)}`:`search-${r.visitSequence}`;
  const gate=beamGate(own.position,posedOwn.sensorPose,beam,r.config.beamHalfDeg,r.config);
  if(beam.job!=='slew')r.emissions.push({startAt:time-dt,endAt:time,from:beam.from,to:beam.to,job:beam.job,beamHalfDeg:r.config.beamHalfDeg,role:r.targetId&&r.canIlluminate?'illumination':beam.job});
  if(beam.job==='search'){
    const heading=deg(Math.atan2(own.velocity[0],own.velocity[1])),az=((heading+beam.to.az+360)%360),ai=Math.floor(az/30),ei=clamp(Math.floor((beam.to.el+30)/10),0,5);
    for(let ri=0;ri<4;ri++){const i=ai*24+ei*4+ri;r.coverage[i]={measuredAt:time,dwellSec:Math.min(120,(r.coverage[i]?.dwellSec??0)+dt)};}
    r.searchScannedSec=(r.searchScannedSec??0)+dt;
  }
  const matched=new Set();let targetHit=false;
  const knownFriendlies=receivedFriendlyIds(world,own);
  if(beam.job!=='slew')for(const target of [...world.units,...(world.radarTargets??[])]){
    if(target===own||target.alive===false)continue;
    if(!inBeam(gate,target.position[0],target.position[1],target.position[2]))continue;
    if(telemetryFriendly(own,target,knownFriendlies))continue;
    const key=target.id+'|'+visit;if(r.sampled[key])continue;r.sampled[key]=true;
    const g=geometry(own,target,r.config,world.terrain);if(!inside(g,beam,r.config.beamHalfDeg)){delete r.sampled[key];continue;}
    if(!visibility(own,target,r,world.terrain,g).visible)continue;
    const m=measurement(world,own,target,r,g,`${world.sensorSeed??1}|${own.id}|${visit}|${target.id}|${r.mode}`,!!r.targetId||r.config.supportsTws);if(!m)continue;
    const t=updateMeasurement(r,own,target,g,m,time,visit,matched);if(t?.id===r.targetId)targetHit=true;
  }
  // Bounded scratch state; STT visit ids otherwise accumulate forever.
  if(Object.keys(r.sampled).length>512)r.sampled={};
  for(const t of r.tracks){
    if((beam.job==='search'||beam.job==='track_update')&&t.lastVisit!==visit&&t.lastMissVisit!==visit){
      if(inBeam(gate,t.x[0],t.x[1],t.x[2])){t.lastMissVisit=visit;t.misses++;t.hitHistory=[...(t.hitHistory??[]),0].slice(-3);if(t.misses>=(t.state==='tentative'?2:3))t.state='lost';}
    }
    if(t.state!=='lost'&&time>t.expectedRevisitAt+.1)t.state='coasting';
    if(time-t.observedAt>45||t.state==='tentative'&&time-t.observedAt>15||(t.P[0][0]>25000000||t.P[1][1]>25000000||t.P[2][2]>25000000))t.state='lost';
  }
  if(r.targetId){const t=r.tracks.find(t=>t.id===r.targetId);
    if(targetHit){r.missingSec=0;r.acquiredSec+=.1;if(!r.established&&r.acquiredSec>=r.config.acquireSec&&t?.state==='confirmed'){r.established=true;event(r,time,'目标 '+r.targetId+'，雷达锁定','locked');}}
    else if(!t||time-t.observedAt>.2)r.missingSec+=dt;
    r.contacts=r.tracks.filter(t=>t.state!=='lost').map(t=>publicTrack(t,r,time));
    const c=r.contacts.find(c=>c.id===r.targetId);r.canIlluminate=r.established&&trackUsable(c,time,'fireControl');r.phase=r.canIlluminate?'locked':r.established?'coasting':'acquiring';r.lastReason=r.missingSec>0?'signal_lost':null;
    if(r.missingSec>=r.config.coastSec){const id=r.targetId;clearLock(r);event(r,time,'目标 '+id+' 丢波，恢复搜索；原因尚不确定','lost');}
  }else{r.canIlluminate=false;r.phase='search';r.contacts=r.tracks.filter(t=>t.state!=='lost').map(t=>publicTrack(t,r,time));}
  const oldCount=r.tracks.length;r.tracks=r.tracks.filter(t=>t.state!=='lost');
  r.nextBindingCleanupAt??=time+.05*Math.floor(random(own.id+'cleanup')*10);
  if(oldCount!==r.tracks.length||time>=r.nextBindingCleanupAt){
    const active=new Set([...r.tracks.map(t=>t.id),...(own.weapons?.contacts??[]).map(c=>c.id)]);for(const id of Object.keys(r.bindings))if(!active.has(id))delete r.bindings[id];r.nextBindingCleanupAt=time+.5;
  }
  own.pilotContacts=[...(own.pilotContacts??[]).filter(c=>c.source!=='radar'),...r.contacts];
}
export function v2Context(r,time){return {sensorModelVersion:2,policyRevision:r.policyRevision,rangeM:r.config.rangeM,azimuthHalfDeg:r.config.azimuthHalfDeg,
  scanPolicy:structuredClone(r.scanPolicy),scanFrameSec:scanFrameSec(r),scanAzimuthDeg:r.antenna.azimuthDeg,scanElevationDeg:r.antenna.elevationDeg,
  barIndex:r.antenna.bar,coverageLimited:r.coverageLimited===true,coverage:r.coverage.map((c,i)=>c?{cell:i,ageSec:Math.max(0,time-c.measuredAt),dwellSec:c.dwellSec}:null).filter(Boolean),
  capabilities:{supportsTws:r.config.supportsTws,maxScheduledTracks:r.config.maxScheduledTracks,maxDatalinkChannels:r.config.maxDatalinkChannels,maxIlluminationChannels:r.config.maxIlluminationChannels}};}
export function parseV2Contact(c,time){
  const vector=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite),stamp=n=>Number.isFinite(n)&&n>=0;
  if(!c||c.sensorModelVersion!==2||typeof c.id!=='string'||c.id.length>64||typeof c.callsign!=='string'||c.callsign.length>80||!['friendly','unknown','hostile'].includes(c.classification)||!['tentative','confirmed','coasting','lost'].includes(c.state)||!stamp(c.observedAt)||c.observedAt>time+.001||!stamp(c.expectedRevisitAt)||!vector(c.position)||!vector(c.velocity)||!c.uncertainty||![c.uncertainty.positionSigmaM,c.uncertainty.velocitySigmaMps].every(v=>vector(v)&&v.every(n=>n>=0))||!stamp(c.uncertainty.radialSigmaMps)||!['unique','ambiguous'].includes(c.associationQuality))throw Error('雷达v2观测无效');
  const out={sensorModelVersion:2,id:c.id,callsign:c.callsign,classification:c.classification,state:c.state,source:'radar',observedAt:c.observedAt,expectedRevisitAt:c.expectedRevisitAt,estimationModel:c.estimationModel==='axis_search'?'axis_search':'full_ekf',
    position:[...c.position],velocity:[...c.velocity],velocityEstimateMps:c.velocityEstimateMps===null?null:vector(c.velocityEstimateMps)?[...c.velocityEstimateMps]:null,
    uncertainty:{positionSigmaM:[...c.uncertainty.positionSigmaM],velocitySigmaMps:[...c.uncertainty.velocitySigmaMps],radialSigmaMps:c.uncertainty.radialSigmaMps},associationQuality:c.associationQuality,awaitingValidation:c.awaitingValidation===true};
  if(!Array.isArray(c.history??[])||(c.history??[]).length>16)throw Error('雷达v2历史无效');
  out.history=(c.history??[]).slice(-16).map(s=>{if(!stamp(s.observedAt)||s.observedAt>c.observedAt+.001||![s.position,s.velocity,s.observerPosition,s.observerVelocity].every(vector))throw Error('雷达v2历史无效');return {observedAt:s.observedAt,position:[...s.position],velocity:[...s.velocity],observerPosition:[...s.observerPosition],observerVelocity:[...s.observerVelocity]};});
  out.usable={acquisition:trackUsable(out,time),fireControl:trackUsable(out,time,'fireControl'),midcourse:trackUsable(out,time,'midcourse')};return out;
}
export function validateV2State(r,time){
  validateV2Config(r.config);
  if(!r.antenna||!['azimuthDeg','elevationDeg','bar','direction','settle','frame'].every(k=>Number.isFinite(r.antenna[k]))||Math.abs(r.antenna.azimuthDeg)>r.config.azimuthHalfDeg+.001||Math.abs(r.antenna.elevationDeg)>r.config.elevationHalfDeg+.001||!Number.isSafeInteger(r.trackSequence)||r.trackSequence<0||!Number.isSafeInteger(r.visitSequence)||r.visitSequence<0||!Array.isArray(r.tracks)||r.tracks.length>32||!Array.isArray(r.coverage)||r.coverage.length!==288||!r.bindings||Object.values(r.bindings).some(v=>typeof v!=='string'||v.length>64))throw Error('雷达v2存档无效');
  const ids=new Set();for(const t of r.tracks){
    if(ids.has(t.id)||!Array.isArray(t.x)||t.x.length!==6||!t.x.every(Number.isFinite)||!Array.isArray(t.P)||t.P.length!==6||t.P.some(row=>!Array.isArray(row)||row.length!==6||!row.every(Number.isFinite))||!Number.isFinite(t.filterAt)||t.filterAt<0||t.filterAt>time+.001)throw Error('雷达v2滤波存档无效');ids.add(t.id);
    const l=Array.from({length:6},()=>Array(6).fill(0));for(let i=0;i<6;i++)for(let j=0;j<=i;j++){if(Math.abs(t.P[i][j]-t.P[j][i])>1e-5)throw Error('雷达协方差不对称');let sum=t.P[i][j];for(let k=0;k<j;k++)sum-=l[i][k]*l[j][k];if(i===j){if(sum< -1e-6)throw Error('雷达协方差非半正定');l[i][j]=Math.sqrt(Math.max(1e-12,sum));}else l[i][j]=sum/l[j][j];}
    parseV2Contact(publicTrack(t,r,time),time);
  }
  for(const c of r.coverage)if(c&&(!Number.isFinite(c.measuredAt)||c.measuredAt<0||c.measuredAt>time+.001||!Number.isFinite(c.dwellSec)||c.dwellSec<0||c.dwellSec>120))throw Error('雷达覆盖存档无效');
}
export function migrateRadarV2(unit,time){
  const r=unit.radar;if(!r?.available||r.sensorModelVersion===2)return;
  const old=[...r.contacts],mode=r.mode;r.config={...r.config,...V2_DEFAULTS};initializeV2(r);r.mode=mode;r.targetId=null;r.canIlluminate=false;r.established=false;r.phase=mode==='off'?'off':'search';
  const aliases=new Map();for(const c of old){const id=`${unit.id}-T${++r.trackSequence}`;aliases.set(c.id,id);r.bindings[id]=c.id;
    r.tracks.push({id,...initializeFilter(c.position,0,[0,1,0],time,1000),lastPosition:[...c.position],lastVelocity:[...c.velocity],measuredPosition:[...c.position],observerPosition:[...unit.position],observerVelocity:groundVelocity(unit),radialSigmaMps:100,
      callsign:id,classification:c.classification,practice:c.practice===true,observedAt:c.observedAt,expectedRevisitAt:time,state:'coasting',awaitingValidation:true,hits:0,misses:0,history:[],rangeM:c.rangeM??0,azimuthDeg:c.azimuthDeg??0,elevationDeg:c.elevationDeg??0,closureMps:0,clutterSeparationMps:0});}
  r.contacts=r.tracks.map(t=>publicTrack(t,r,time));
  for(const task of [unit.radarTask,unit.attackTask,unit.weapons])if(task){for(const key of ['targetId','engagedTargetId'])if(aliases.has(task[key]))task[key]=aliases.get(task[key]);}
}
export function upgradeWorldSensors(world){
  world.sensorModelVersion=2;world.sensorSeed??=1;
  for(const u of world.units)migrateRadarV2(u,world.time);
  for(const m of world.missiles??[]){if(m.sensorModelVersion===2)continue;const u=world.units.find(u=>u.id===m.ownerId);m.truthTargetId=m.targetId;
    const id=Object.keys(u?.radar?.bindings??{}).find(id=>u.radar.bindings[id]===m.targetId);if(id)m.targetId=id;m.sensorModelVersion=2;}
}
