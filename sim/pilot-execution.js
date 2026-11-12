import {energyEnvelope} from './energy.js';
import {thrustAt,dryFraction,dragAt,density,G,flightSafety} from './flight.js';
import {planSafeRoute} from './safe-navigation.js';
import {traceRecovery} from './recovery-plan.js';

const distance=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));
// A mission survives saving and unrelated world revisions. New orders replace its
// identity; inference never owns aircraft position, airport clearance or flight role.
export function beginPilotExecution(world,u){
  u.pilotPowerPlan=null;
  const departure=u.departurePowerPlan,afterburnerCap=['dry','military_power'].includes(departure?.mode)?0:1;
  u.pilotExecution={id:`${u.id}:${u.pilotTaskSequence=(u.pilotTaskSequence??0)+1}`,startedAt:world.time,flightStarted:!u.surface?.grounded,attempt:0,
    targetSpeedMps:departure?.climbSpeedMps??u.targetSpeed,targetAltitudeM:departure?.altitudeM??u.headingRoute?.targetAltitudeM??u.waypoints.at(-1)?.[2]??(u.surface?.depart?u.surface.climbAltitude:null)??u.holdAltitude??u.targetAltitude,
    orbit:!u.waypoints.length&&u.headingTarget==null&&!u.formation&&!u.surface?.grounded?[...u.orbit]:null,
    instruction:null,constraints:{afterburnerCap},issue:null,issueSince:null,lastError:null};
}

export function setPilotInstruction(u,instruction){
  const execution=u.pilotExecution;if(!execution)return;
  execution.instruction=instruction.slice(0,4000);
  execution.instructionSource='commander';
  // Limits in the received commander transmission remain hard limits during replanning.
  const power=instruction.match(/(?:油门|推力|throttle|thrust)\s*(?:为|至|到|设为|at|to|=)?\s*(\d+(?:\.\d+)?)\s*[%％]/i)??instruction.match(/(\d+(?:\.\d+)?)\s*[%％]\s*(?:的)?\s*(?:油门|推力|throttle|thrust)/i);
  if(power)execution.constraints.throttleCap=Number(power[1])/100;
  if(/减推力|降低推力|reduced[ _-]?thrust|\bderated\b|\bflex\b/i.test(instruction))execution.constraints.maximumThrustFraction=.95;
  if(/(?:关闭|不用|禁止|不使用|不|无)\s*加力|\b(?:no|without)(?:\s+using)?\s+(?:the\s+)?afterburner\b|\b(?:do not|don't)\s+(?:use|engage)\s+(?:the\s+)?afterburner\b/i.test(instruction))execution.constraints.afterburnerCap=0;
  const mode=u.departurePowerPlan?.mode;
  if(['dry','military_power'].includes(mode))execution.constraints.afterburnerCap=0;
}

export function monitorPilotExecution(world,u){
  if(!u.pilotExecution)beginPilotExecution(world,u);
  const e=u.pilotExecution,t=world.time;
  if(!u.alive||u.surface?.grounded||['final','approach'].includes(u.surface?.phase))return;
  if(!e.flightStarted){e.flightStarted=true;e.targetSpeedMps=u.targetSpeed;e.targetAltitudeM=u.surface?.climbAltitude??u.holdAltitude;e.issue=null;e.issueSince=null;}
  if(e.lastAdjustment?.via.length&&!u.waypoints.length){u.holdAltitude=e.targetAltitudeM;if(e.orbit)u.orbit=[...e.orbit];}
  if(u.pilotPowerPlan?.active&&t-e.lastAppliedAt>30&&Math.abs(u.position[2]-e.targetAltitudeM)<100&&Math.abs(u.velocity[2])<3&&Math.abs(u.speed-u.targetSpeed)<10&&!u.navigationBlocked&&!u.waypoints.some(w=>w.pilotTemporary)){
    u.targetSpeed=e.targetSpeedMps;u.pilotPowerPlan.active=false;
  }
  const env=energyEnvelope(u.profile,u.position[2],u.speed),power=u.pilotPowerPlan?.active?u.pilotPowerPlan:u.departurePowerPlan;
  const available=power?.active?thrustAt(u.profile,u.position[2],u.speed,power.afterburner)*dryFraction(u.profile,power.throttle):env.maximum;
  const recovering=u.flightState==='stall-recovery';
  e.recoveries=(e.recoveries??[]).filter(at=>t>=at&&t-at<180);
  if(recovering&&!e.wasRecovering)e.recoveries.push(t);e.wasRecovering=recovering;
  let issue=null;
  if(u.navigationBlocked&&!u.navigationPending)issue='route_blocked';
  else if(u.requiredThrustN>available*1.06&&(u.speed<Math.max(u.targetSpeed-10,env.safeSpeed(1)*1.1)||e.targetAltitudeM-u.position[2]>200&&u.velocity[2]<2))issue='energy_shortfall';
  else if(u.speed<env.safeSpeed(1)*.98||u.flightState==='stall-recovery')issue='energy_shortfall';
  else if(e.recoveries.length>=2&&t-e.recoveries.at(-1)<60)issue='energy_shortfall';
  const goal=u.waypoints?.find(w=>!w.pilotTemporary);
  if(goal){
    const key=JSON.stringify(goal.slice(0,3)),remaining=distance(u.position,goal);
    if(e.progress?.key!==key||t<e.progress.time)e.progress={key,time:t,distance:remaining};
    else if(t-e.progress.time>=60){
      if(e.progress.distance-remaining<Math.max(150,u.speed*2))e.stagnant=true;else e.stagnant=false;
      e.progress={key,time:t,distance:remaining};
    }
    if(!issue&&e.stagnant)issue='progress_stalled';
  }else{e.progress=null;e.stagnant=false;}
  if(issue!==e.issue||t<(e.issueSince??0)){e.issue=issue;e.issueSince=issue?t:null;}
  e.feedback={time:t,speedMps:u.speed,verticalSpeedMps:u.velocity[2],throttle:u.throttle,afterburner:u.afterburner,
    recoveryCause:u.recoveryCause??null,stalled:!!u.stalled,flightPathDeg:Math.asin(Math.max(-1,Math.min(1,u.velocity[2]/Math.max(1,u.speed))))*180/Math.PI,bankDeg:u.bank*180/Math.PI,
    requiredThrustN:u.requiredThrustN??0,availableThrustN:available,safeSpeedMps:env.safeSpeed(1),
    militaryThrustN:env.military,maximumThrustN:env.maximum,maxSpeedMps:env.maxSpeed,
    levelFlightThrustN:env.dragFor(1),climbReserveThrustN:u.profile.mass*G*.025,
    recentRecoveryCount:e.recoveries.length,
    targetSpeedMps:u.targetSpeed,targetAltitudeM:e.targetAltitudeM,flightState:u.flightState,
    powerPlan:power?.active?{throttle:power.throttle,afterburner:power.afterburner}:null};
}

export function executionEvent(unit,time){
  const e=unit.pilotExecution;
  const urgent=e?.feedback&&(e.feedback.speedMps<e.feedback.safeSpeedMps*.78||e.feedback.flightState==='stall-recovery'&&['stall','low-speed'].includes(e.feedback.recoveryCause));
  if(!e?.issue||!Number.isFinite(e.issueSince)||unit.surface?.grounded||unit.grounded===true||!urgent&&time-e.issueSince<(e.issue==='route_blocked'?10:20))return null;
  return {key:`execution:${e.id}:${e.issue}:${e.issueSince}:${e.attempt}`,reason:'execution_deviation',
    urgent:!!urgent,summary:urgent?'严重低速，飞行员正在选择推力与卸载改出方案':e.issue==='route_blocked'?'航路持续受阻，自主重新规划':e.issue==='energy_shortfall'?'持续能量不足，调整推力和航路':'任务进展停滞，自主重新规划'};
}

export function executionObservation(unit){
  const e=unit.pilotExecution;if(!e?.issue||!e.feedback)return null;
  return structuredClone({id:e.id,attempt:e.attempt,issue:e.issue,issueSince:e.issueSince,instruction:e.instruction,
    constraints:e.constraints,feedback:e.feedback,lastError:e.lastError,targetAltitudeM:e.targetAltitudeM,targetSpeedMps:e.targetSpeedMps,
    remainingGoals:unit.waypoints.filter(w=>!w.pilotTemporary).slice(0,32).map(w=>w.slice(0,3)),
    heading:unit.headingRoute?.headingDeg??(unit.headingTarget==null?null:unit.headingTarget*180/Math.PI),formation:unit.formation?.intent??null});
}

export function validatePilotAdjustment(a){
  if(!a||!Number.isFinite(a.throttle)||a.throttle<0||a.throttle>1||!Number.isFinite(a.afterburner)||a.afterburner<0||a.afterburner>1||
    !Number.isFinite(a.speedMps)||a.speedMps<60||a.speedMps>600||!Array.isArray(a.via)||a.via.length>6||
    a.via.some(p=>!Array.isArray(p)||p.length!==3||!p.every(Number.isFinite)||Math.abs(p[0])>200000||Math.abs(p[1])>200000||p[2]<100||p[2]>20000))throw Error('重新规划参数无效');
  const r=a.recovery;if(r!=null&&(!Number.isFinite(r.flightPathDeg)||r.flightPathDeg< -20||r.flightPathDeg>0||!Number.isFinite(r.bankDeg)||Math.abs(r.bankDeg)>20||!Number.isFinite(r.unloadG)||r.unloadG<.2||r.unloadG>.8))throw Error('改出俯仰、坡度或卸载参数无效');
}

export function validateExecutionObservation(e,time){
  if(e==null)return null;
  const finite=Number.isFinite,vec=p=>Array.isArray(p)&&p.length===3&&p.every(finite);
  if(typeof e.id!=='string'||e.id.length>100||!Number.isInteger(e.attempt)||e.attempt<0||e.attempt>100000||
    !['route_blocked','energy_shortfall','progress_stalled'].includes(e.issue)||!finite(e.issueSince)||e.issueSince<0||e.issueSince>time||
    !(e.instruction===null||typeof e.instruction==='string'&&e.instruction.length<=4000)||
    !e.constraints||Object.keys(e.constraints).some(k=>!['throttleCap','afterburnerCap','maximumThrustFraction'].includes(k)||!finite(e.constraints[k])||e.constraints[k]<0||e.constraints[k]>1)||
    !e.feedback||!finite(e.feedback.time)||e.feedback.time>time||time-e.feedback.time>5||
    e.feedback.recoveryCause!=null&&!['stall','low-speed'].includes(e.feedback.recoveryCause)||
    ['speedMps','verticalSpeedMps','throttle','afterburner','requiredThrustN','availableThrustN','safeSpeedMps','targetSpeedMps','targetAltitudeM'].some(k=>!finite(e.feedback[k]))||
    !finite(e.targetAltitudeM)||!finite(e.targetSpeedMps)||!Array.isArray(e.remainingGoals)||e.remainingGoals.length>32||!e.remainingGoals.every(vec)||
    !(e.heading===null||finite(e.heading))||!(e.lastError===null||typeof e.lastError==='string'&&e.lastError.length<=600)||
    !(e.formation===null||typeof e.formation==='string'&&e.formation.length<50))throw Error('执行监控快照无效');
  return structuredClone(e);
}

// Validate against CURRENT flight state, not the model's old snapshot. Route
// validation includes the same power ceiling and physics used by live flight.
export function applyPilotAdjustment(world,u,a,executionId,{prepared=null}={}){
  validatePilotAdjustment(a);
  if(prepared&&(prepared.executionId!==executionId||prepared.adjustment!==JSON.stringify(a)||prepared.seed?.profileId!==u.profileId||world.time-prepared.sampledAt<0||world.time-prepared.sampledAt>8))throw Error('后台修订方案已过期或不匹配');
  const e=u.pilotExecution;
  if(!u.alive||!e||e.id!==executionId||u.surface?.grounded||['final','approach'].includes(u.surface?.phase))throw Error('任务或飞行阶段已变化，旧规划作废');
  if(a.throttle>(e.constraints.throttleCap??1)+1e-6||a.afterburner>(e.constraints.afterburnerCap??1)+1e-6)throw Error('规划超过原指令的推力限制');
  if(u.formation&&a.via.length)throw Error('保持长僚机分工，不能以独立航路替代编队');
  const env=energyEnvelope(u.profile,u.position[2],u.speed);
  if(a.speedMps<env.safeSpeed(1)*1.08||a.speedMps>env.maxSpeed)throw Error('规划速度超出当前安全包线');
  if(u.surface?.phase==='climb'&&u.position[2]<(world.airportOps?.airport.elevation??0)+300&&a.via.length)throw Error('低空离场先保持跑道航向，达到安全高度后再调整航路');
  if(u.flightState==='stall-recovery'||flightSafety(u).severeLowSpeed){
    if(a.via.length)throw Error('严重低速时先用recovery参数卸载增速，恢复后再接回原航路');
    for(const v of [u.speed,a.speedMps])if(thrustAt(u.profile,u.position[2],v,a.afterburner)*dryFraction(u.profile,a.throttle)>thrustAt(u.profile,u.position[2],v,1)*(e.constraints.maximumThrustFraction??1)+1)throw Error('改出推力超过原指令的推力限制');
    const power={active:true,recoveryOnly:true,throttle:a.throttle,afterburner:a.afterburner,recovery:a.recovery??null,executionId:e.id,
      resumeTargetSpeedMps:u.pilotPowerPlan?.recoveryOnly?u.pilotPowerPlan.resumeTargetSpeedMps:u.targetSpeed};
    if(prepared&&(Math.hypot(...u.position.map((v,i)=>v-prepared.seed.position[i]))>Math.max(150,u.speed*.8)||Math.abs(u.speed-prepared.seed.speed)>Math.max(5,u.speed*.05)))throw Error('改出期间飞行状态已变化，等待重新评估');
    const outcome=prepared?{valid:true,seconds:prepared.result.predictedRecoverySeconds}:traceRecovery({...u,targetSpeed:a.speedMps},power);if(!outcome.valid||!Number.isFinite(outcome.seconds))throw Error(outcome.reason??'后台改出验证无效');
    u.pilotPowerPlan=power;u.targetSpeed=a.speedMps;e.lastAppliedAt=world.time;e.lastAdjustment=structuredClone(a);e.lastError=null;e.issue=null;e.issueSince=null;e.attempt=Math.max(0,e.attempt);
    return {throttle:a.throttle,afterburner:a.afterburner,speedMps:a.speedMps,viaCount:0,recovery:power.recovery,predictedRecoverySeconds:outcome.seconds};
  }
  const speed=a.speedMps,p=u.profile,cl=p.mass*G/(.5*density(u.position[2])*speed*speed*p.area),drag=dragAt(p,u.position[2],speed,cl,u);
  const thrust=thrustAt(p,u.position[2],speed,a.afterburner)*dryFraction(p,a.throttle),needed=drag+(e.targetAltitudeM>u.position[2]+150?p.mass*G*.015:0);
  if(thrust>thrustAt(p,u.position[2],speed,1)*(e.constraints.maximumThrustFraction??1)+1)throw Error('修订推力超过原指令要求的减推力范围');
  if(e.targetAltitudeM>=u.position[2]-100&&thrust<needed)throw Error(`修订推力不足以维持本段飞行，至少需${Math.ceil(needed/1000)}千牛，方案仅${Math.floor(thrust/1000)}千牛`);
  const power={active:true,throttle:a.throttle,afterburner:a.afterburner,executionId:e.id};
  const remaining=u.waypoints.filter(w=>!w.pilotTemporary),points=[...a.via,...remaining];
  let navigation=null;
  if(a.via.length||u.navigationBlocked){
    if(!points.length)throw Error('缺少可重新接入的原任务航路');
    const check=world.checkRoute(u.id,points);if(!check.valid)throw Error(check.reason);
    const candidate={...u,targetSpeed:a.speedMps,pilotPowerPlan:power};
    if(prepared&&!prepared.navigation)throw Error('后台没有提供有效的修订航路');
    navigation=prepared?world.resolvePlan(candidate,points,prepared.navigation):planSafeRoute(candidate,points,world.terrain);
    if(!navigation.valid)throw Error(navigation.reason||'新航路无法按所规划推力飞行');
  }
  // All fallible work precedes the commit. Preserve every remaining original goal.
  u.pilotPowerPlan=power;u.targetSpeed=a.speedMps;
  if(navigation){
    u.waypoints=[...a.via.map(p=>Object.assign([...p],{pilotTemporary:true})),...remaining];
    u.waypoints.forEach((w,i)=>{w.number=(u.completedWaypoints??0)+i+1;});
    u.nextWaypointNumber=(u.completedWaypoints??0)+u.waypoints.length+1;
    u.routeRevision=(u.routeRevision??0)+1;world.installNavigation(u,navigation);
  }
  e.lastAppliedAt=world.time;e.lastAdjustment=structuredClone(a);e.lastError=null;e.issue=null;e.issueSince=null;e.stagnant=false;e.progress=null;e.recoveries=[];
  return {throttle:a.throttle,afterburner:a.afterburner,speedMps:a.speedMps,viaCount:a.via.length};
}
