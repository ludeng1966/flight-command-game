import {MISSILE_DATA} from '../data/missile-runtime.js';
import {G,atmosphere,density,dot,cross,norm,basis} from './flight.js';
import {radarVisibility,radarGeometry,RADAR_DEFAULTS} from './radar.js';
import {radarSupport} from './radar-quality.js';
import {V2_DEFAULTS,measurement} from './radar-v2.js';
import {initializeFilter,predictFilter,filterInnovation,correctFilter} from './radar-filter.js';

export const MISSILE_MODELS=new Map(MISSILE_DATA.map(m=>[m.id,m]));
export const GUIDANCE_LABELS={infrared:'红外寻的',semi_active_radar:'半主动雷达',active_radar:'惯导/数据链 → 主动雷达'};
export const MISSILE_PHASES={inertial:'惯性外推',datalink:'数据链中段',active:'主动雷达寻的',semi_active:'半主动照射寻的',infrared:'红外寻的',lost:'失去制导',hit:'近炸命中',impact:'触地',expired:'寿命结束',spent:'超出航程'};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),rad=d=>d*Math.PI/180;
const sub=(a,b)=>a.map((v,i)=>v-b[i]),add=(a,b)=>a.map((v,i)=>v+b[i]);
const mul=(a,k)=>a.map(v=>v*k),length=a=>Math.hypot(...a);
export const missileModel=id=>{const m=MISSILE_MODELS.get(id);if(!m)throw Error('导弹型号未装入游戏');return m;};
export function motorState(model,age){
  let massKg=model.massKg,thrustN=0;
  for(const s of model.motorStages){if(age<s.startSec)break;
    massKg=s.initialMassKg+(s.finalMassKg-s.initialMassKg)*clamp((age-s.startSec)/s.durationSec,0,1);
    if(age<s.startSec+s.durationSec){thrustN=s.thrustN;break;}}
  return {massKg,thrustN};
}
// Explicit game approximation: source dragCx on a length*diameter reference area.
// WT CxK, fin coefficients and PID values have no verified solver mapping here.
export function missileDragArea(model,mach){
  return Math.max(.0001,model.aerodynamics.dragCx*model.lengthM*model.diameterM)*(1+.55*Math.exp(-(((mach-1)/.3)**2)));
}
export function lineClear(terrain,a,b){
  if(!terrain?.heightAt)return true;
  const d=sub(b,a),steps=Math.min(512,Math.max(2,Math.ceil(length(d)/200)));
  for(let i=1;i<steps;i++){const t=i/steps,h=terrain.heightAt(a[0]+d[0]*t,a[1]+d[1]*t);if(h!==null&&h!==undefined&&a[2]+d[2]*t<=h)return false;}
  return true;
}
export function seekerObservation(model,position,forward,target,terrain,{launch=false,previousLos=null,dt=.05}={}){
  if(!target||target.alive===false)return null;
  const delta=sub(target.position,position),rangeM=length(delta),los=norm(delta),angle=Math.acos(clamp(dot(forward,los),-1,1));
  const limit=launch?model.seeker.lockAngleDeg:model.seeker.gimbalAngleDeg;
  if(angle>rad(limit??30)||!lineClear(terrain,position,target.position))return null;
  if(previousLos&&Math.acos(clamp(dot(previousLos,los),-1,1))/Math.max(.001,dt)>rad(model.seeker.trackingRateDegSec??60))return null;
  if(model.kind==='infrared'){
    // Optical range cap from source; detailed heat/aspect/sun/decoy signature is not modelled.
    if(rangeM>(model.guidance.optical?.rangeMax??10000))return null;
  }else{
    const radar=model.guidance.radar,config={...RADAR_DEFAULTS,minRangeM:1,rangeM:radar?.receiver?.range??16000,
      azimuthHalfDeg:Math.min(85,model.seeker.gimbalAngleDeg??55),elevationHalfDeg:Math.min(85,model.seeker.gimbalAngleDeg??55),
      speedGateHalfWidthMps:radar?.dopplerSpeed?.refWidth??80};
    const right=norm(cross(forward,[0,0,1])),up=norm(cross(right,forward));
    const pseudo={position,velocity:mul(forward,1),sensorPose:{forward,up}};
    if(!radarVisibility(pseudo,target,{config,mode:'pd'},terrain).visible)return null;
  }
  return {position:[...target.position],velocity:[...target.velocity],los,rangeM};
}
export function spawnMissile(world,own,target,model,observation){
  const forward=norm(own.velocity),position=add(own.position,mul(forward,5));position[2]-=2;
  const velocity=add(model.launch.useStartSpeed?own.velocity:[0,0,0],mul(forward,model.launch.initialSpeedMps??0));
  const missile={id:'missile-'+(++world.missileSequence),modelId:model.id,ownerId:own.id,targetId:observation.trackId??target.id,truthTargetId:target.id,sensorModelVersion:own.radar?.sensorModelVersion??1,team:own.team??own.faction??'blue',
    position,velocity,forward,ageSec:0,travelM:0,alive:true,phase:model.kind==='infrared'?'infrared':model.kind==='semi_active_radar'?'semi_active':'datalink',
    active:false,massKg:model.massKg,thrustN:0,speedMps:length(velocity),mach:0,loadFactor:0,dragN:0,
    observation:{position:[...observation.position],velocity:[...observation.velocity],ageSec:Math.max(0,world.time-(observation.measuredAt??world.time))},lastLos:null,lostSec:0,trail:[position.slice()],trailClock:0,
    launchedAt:world.time,endedAt:null,minMissM:null,sensorClock:0,sensorGuiding:true};
  world.missiles.push(missile);return missile;
}
function finish(world,m,phase){m.alive=false;m.phase=phase;m.endedAt=world.time;m.thrustN=0;}
function seekerV2Observation(world,m,model){
  const time=m.launchedAt+m.ageSec,slot=Math.floor((time+1e-8)/.1);
  if(m.seekerVisit===slot)return null;m.seekerVisit=slot;
  const predicted=add(m.observation.position,mul(m.observation.velocity,m.observation.ageSec)),aim=norm(sub(predicted,m.position));
  const right=norm(cross(m.forward,Math.abs(m.forward[2])>.99?[0,1,0]:[0,0,1])),up=norm(cross(right,m.forward));
  const own={id:m.id,position:m.position,velocity:m.velocity,groundVelocity:m.velocity,sensorPose:{forward:m.forward,up}};
  const config={...RADAR_DEFAULTS,...V2_DEFAULTS,minRangeM:1,rangeM:model.guidance.radar?.receiver?.range??16000,
    azimuthHalfDeg:Math.min(85,model.seeker.gimbalAngleDeg??55),elevationHalfDeg:Math.min(85,model.seeker.gimbalAngleDeg??55)};
  const r={sensorModelVersion:2,config,mode:'pd'},choices=[];
  if(m.seekerTrack)predictFilter(m.seekerTrack,time);
  for(const target of [...world.units,...(world.radarTargets??[])]){
    if(target.id===m.ownerId||target.alive===false)continue;
    const g=radarGeometry(own,target,config,world.terrain);
    // Prediction-centred acquisition aperture, never steer at the hidden entity.
    if(dot(aim,g.los)<Math.cos(rad(m.seekerTrack?6:10))||!radarVisibility(own,target,r,world.terrain).visible)continue;
    const hit=measurement(world,own,target,r,g,`${world.sensorSeed??1}|${m.id}|${slot}|${target.id}`);if(!hit)continue;
    const fit=m.seekerTrack?filterInnovation(m.seekerTrack,hit):null;
    if(m.seekerTrack&&(!fit||fit.d2>18.5))continue;
    choices.push({hit,fit,score:fit?.d2??length(sub(hit.position,predicted))});
  }
  choices.sort((a,b)=>a.score-b.score);const chosen=choices[0];if(!chosen)return null;
  if(!m.seekerTrack)m.seekerTrack=initializeFilter(chosen.hit.position,chosen.hit.z[3]+dot(m.velocity,chosen.hit.los),chosen.hit.los,time,Math.max(chosen.hit.sigma[0],chosen.hit.z[0]*chosen.hit.sigma[1]));
  else correctFilter(m.seekerTrack,chosen.hit,chosen.fit);
  m.seekerLastMeasuredAt=time;
  return {position:m.seekerTrack.x.slice(0,3),velocity:m.seekerTrack.x.slice(3),los:chosen.hit.los};
}
function guidanceObservation(world,m,model,dt){
  if(m.ageSec>(model.seeker.workSec??model.lifetimeSec)){m.phase=model.guidance.inertialNavigation?'inertial':'lost';return model.guidance.inertialNavigation;}
  const own=world.units.find(u=>u.id===m.ownerId),target=[...world.units,...(world.radarTargets??[])].find(t=>t.id===(m.truthTargetId??m.targetId));
  const support=own?radarSupport(own,m.targetId,model.kind,world.time):{};
  const supported=model.kind==='semi_active_radar'?support.illuminationAvailable:support.midcourseAvailable;
  let observation=null;
  if(model.kind==='infrared'){
    observation=seekerObservation(model,m.position,m.forward,target,world.terrain,{previousLos:m.lastLos,dt});m.phase=observation?'infrared':'lost';
  }else if(model.kind==='semi_active_radar'){
    if(supported)observation=m.sensorModelVersion===2?seekerV2Observation(world,m,model):seekerObservation(model,m.position,m.forward,target,world.terrain,{previousLos:m.lastLos,dt});
    m.phase=observation||m.sensorModelVersion===2&&supported&&m.seekerLastMeasuredAt!=null&&m.launchedAt+m.ageSec-m.seekerLastMeasuredAt<.15?'semi_active':model.guidance.inertialNavigation?'inertial':'lost';
  }else{
    // Activation is based on the last received track, never the hidden target range.
    const estimated=add(m.observation.position,mul(m.observation.velocity,m.observation.ageSec));
    if(length(sub(estimated,m.position))<=(model.guidance.lockDistanceM??model.guidance.radar?.receiver?.range??16000))m.active=true;
    if(m.active)observation=m.sensorModelVersion===2?seekerV2Observation(world,m,model):seekerObservation(model,m.position,m.forward,target,world.terrain,{previousLos:m.lastLos,dt});
    if(observation)m.phase='active';
    else if(supported&&model.guidance.datalink){
      const c=own.radar.contacts.find(c=>c.id===m.targetId);
      if(c&&(m.sensorModelVersion===2?support.midcourseAvailable:world.time-c.observedAt<=.2)){const age=Math.max(0,world.time-c.observedAt);observation={position:c.position.map((v,i)=>v+c.velocity[i]*age),velocity:c.velocity,los:null};m.phase='datalink';m.lastUpdateMeasuredAt=c.observedAt;}
    }
    if(!observation)m.phase=m.sensorModelVersion===2&&m.seekerLastMeasuredAt!=null&&m.launchedAt+m.ageSec-m.seekerLastMeasuredAt<.15?'active':'inertial';
  }
  if(observation){m.observation={position:[...observation.position],velocity:[...observation.velocity],ageSec:0};m.lastLos=observation.los;m.lostSec=0;}
  else{m.lostSec+=dt;m.lastLos=null;}
  const work=model.seeker.workSec??model.lifetimeSec;
  if(m.ageSec>work){m.phase=model.guidance.inertialNavigation?'inertial':'lost';return model.guidance.inertialNavigation;}
  return !!observation||model.guidance.inertialNavigation||m.lostSec<=(model.guidance.optical?.prolongationTimeMax??model.guidance.radar?.prolongationTimeMax??0);
}
function requestedAcceleration(m,model,canGuide){
  const q=.5*density(m.position[2])*m.speedMps*m.speedMps;
  const maxAccel=(model.simulationLimits.autopilotMaxG??20)*G*clamp(q/(.5*1.225*500**2),0,1);
  if(!canGuide||m.ageSec<(model.simulationLimits.guidanceDelaySec??0))return [0,0,0];
  let target=add(m.observation.position,mul(m.observation.velocity,m.observation.ageSec)),delta=sub(target,m.position),range=length(delta);
  const relative=sub(m.observation.velocity,m.velocity),closure=-dot(relative,norm(delta)),timeToGo=range/Math.max(100,closure);
  if(model.flightControl.loftEnabled&&!m.active&&range>18000&&timeToGo>15){
    target[2]+=Math.min(9000,Math.tan(rad(model.flightControl.loftElevation??20))*range*.35);delta=sub(target,m.position);
  }
  const omega=mul(cross(delta,relative),1/Math.max(1,dot(delta,delta))),navigation=model.flightControl.propNavMult??4;
  let accel=mul(cross(omega,m.forward),navigation*Math.max(0,closure));
  // Small pursuit correction also converges when the target is initially receding.
  const lead=norm(sub(add(target,mul(m.observation.velocity,Math.min(8,timeToGo)*.35)),m.position));
  accel=add(accel,mul(sub(lead,mul(m.forward,dot(lead,m.forward))),m.speedMps*.3));
  accel=add(accel,[0,0,G]);accel=sub(accel,mul(m.forward,dot(accel,m.forward)));
  return mul(accel,Math.min(1,maxAccel/Math.max(.001,length(accel))));
}
function closestSegment(a,b){const d=sub(b,a),t=clamp(-dot(a,d)/Math.max(1e-12,dot(d,d)),0,1);return {distance:length(add(a,mul(d,t))),t};}
export function stepMissiles(world,dt,previousTargets=new Map()){
  for(const m of world.missiles){if(!m.alive)continue;const model=missileModel(m.modelId),before=[...m.position],ageBefore=m.ageSec;
    const steps=Math.max(1,Math.ceil(dt/(1/120))),h=dt/steps;
    for(let i=0;i<steps&&m.alive;i++){
      const old=[...m.position];m.observation.ageSec+=h;m.sensorClock=(m.sensorClock??0)+h;
      if(m.sensorClock+1e-9>=.05){m.sensorGuiding=guidanceObservation(world,m,model,m.sensorClock);m.sensorClock=0;}
      const canGuide=m.sensorGuiding,motor=motorState(model,m.ageSec+h/2);
      m.massKg=motor.massKg;m.thrustN=motor.thrustN;m.speedMps=length(m.velocity);m.mach=m.speedMps/atmosphere(m.position[2]).soundSpeed;
      const accel=requestedAcceleration(m,model,canGuide),turn=add(m.velocity,mul(accel,h)),turnDirection=norm(turn);
      m.loadFactor=length(accel)/G;
      const q=.5*density(m.position[2])*m.speedMps**2;
      m.dragN=q*missileDragArea(model,m.mach)+motor.massKg*length(accel)**2/(Math.max(100,m.speedMps)*12);
      const speed=Math.max(0,m.speedMps+(motor.thrustN-m.dragN)/motor.massKg*h);
      m.velocity=add(mul(turnDirection,speed),[0,0,-G*h]);
      if(model.simulationLimits.speedLimitMps&&length(m.velocity)>model.simulationLimits.speedLimitMps)m.velocity=mul(norm(m.velocity),model.simulationLimits.speedLimitMps);
      m.forward=norm(m.velocity);
      m.position=add(m.position,mul(m.velocity,h));m.ageSec+=h;m.travelM+=length(sub(m.position,old));
      const hit=world.terrain?.collision?.(old,m.position);
      if(hit||m.position[2]<=(world.terrain?.heightAt?.(m.position[0],m.position[1])??0)){if(hit)m.position=[...hit];finish(world,m,'impact');}
      else if(m.ageSec>=model.lifetimeSec)finish(world,m,'expired');
      else if(model.simulationLimits.maxTravelM&&m.travelM>=model.simulationLimits.maxTravelM)finish(world,m,'spent');
    }
    Object.assign(m,motorState(model,m.ageSec));if(!m.alive)m.thrustN=0;m.speedMps=length(m.velocity);m.mach=m.speedMps/atmosphere(m.position[2]).soundSpeed;
    // Swept relative-motion fuse prevents tunnelling, and checks arming at closest approach.
    if(m.alive)for(const target of [...world.units,...(world.radarTargets??[])]){
      if(target.id===m.ownerId||target.alive===false)continue;
      const previous=previousTargets.get(target.id)??sub(target.position,mul(target.velocity,dt));
      const approach=closestSegment(sub(before,previous),sub(m.position,target.position));
      if(target.id===(m.truthTargetId??m.targetId))m.minMissM=Math.min(m.minMissM??Infinity,approach.distance);
      const armed=ageBefore+approach.t*dt>=(model.proximityFuse.armingDelaySec??0);
      const radius=model.proximityFuse.enabled?model.proximityFuse.radiusM:2;
      if(armed&&approach.distance<=radius){
        target.lastPose=target.profile?basis(target):{forward:norm(target.velocity),up:[0,0,1]};
        target.alive=false;target.flightState='destroyed';target.lastIncident='导弹近炸命中';target.velocity=[0,0,0];target.speed=0;target.mach=0;
        if(target.control){target.throttle=0;target.afterburner=0;target.control.throttle=0;}
        m.position=before.map((v,k)=>v+(m.position[k]-v)*approach.t);m.hitTargetId=target.id;finish(world,m,'hit');
        world.weaponEvents.push({id:m.id,time:world.time,type:'hit',ownerId:m.ownerId,targetId:target.id,text:model.familyName+' 命中 '+target.callsign});break;
      }
    }
    m.trailClock+=dt;if(m.trailClock>=.1||!m.alive){m.trail.push([...m.position]);if(m.trail.length>240)m.trail.shift();m.trailClock=0;}
  }
  world.missiles=world.missiles.filter(m=>m.alive||world.time-(m.endedAt??world.time)<15);
  if(world.weaponEvents.length>48)world.weaponEvents.splice(0,world.weaponEvents.length-48);
}
