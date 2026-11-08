import {G,atmosphere,aeroAt,dragAt,thrustAt,dryFraction,hasAfterburner} from './flight.js';
const finite=(n,lo,hi)=>Number.isFinite(n)&&n>=lo&&n<=hi;
export function performanceAt(profile,{altitudeM=6500,speedMps=180,loadG=1,afterburner=0,throttle=1,massKg=profile.mass,gearDown=false,flaps='up',speedBrake=false}={}){
  if(!finite(altitudeM,0,20000)||!finite(speedMps,20,1000)||!finite(loadG,.1,20)||!finite(afterburner,0,1)||!finite(throttle,0,1)||!finite(massKg,100,500000)||!['up','takeoff','landing'].includes(flaps))throw Error('性能查询参数超出范围');
  const p={...profile,mass:massKg},config={gearDown,flaps,speedBrake},air=atmosphere(altitudeM),a=aeroAt(p,altitudeM,speedMps,config),q=.5*air.density*speedMps**2,weight=massKg*G;
  const cl=loadG*weight/(q*p.area),drag=dragAt(p,altitudeM,speedMps,cl,config),thrust=thrustAt(p,altitudeM,speedMps,p.engine?afterburner:0)*dryFraction(p,throttle);
  const liftLimitG=q*p.area*a.clMax/weight,structuralMaxG=a.maxG,instantaneousMaxG=Math.max(0,Math.min(liftLimitG,structuralMaxG));
  const baseDrag=dragAt(p,altitudeM,speedMps,0,config),induced=p.k*weight**2/(q*p.area);
  const sustainedMaxG=Math.max(0,Math.min(instantaneousMaxG,Math.sqrt(Math.max(0,(thrust-baseDrag)/Math.max(1e-9,induced)))));
  const turn=n=>n>1?{rateDegSec:G*Math.sqrt(n*n-1)/speedMps*180/Math.PI,radiusM:speedMps**2/(G*Math.sqrt(n*n-1))}:{rateDegSec:0,radiusM:null};
  const iasMps=speedMps*Math.sqrt(air.density/1.225),withinSpeedLimits=(!p.limits?.ias||iasMps<=p.limits.ias)&&(!p.limits?.mach||a.mach<=p.limits.mach),liftFeasible=loadG<=instantaneousMaxG;
  const excessPowerMps=(thrust-drag)*speedMps/weight;
  return {altitudeM,speedMps,massKg,loadG,afterburner:hasAfterburner(p)?afterburner:0,throttle,configuration:config,mach:a.mach,iasMps,thrustN:thrust,dragN:drag,
    specificEnergyHeightM:altitudeM+speedMps**2/(2*G),specificExcessPowerMps:excessPowerMps,accelerationMps2:(thrust-drag)/massKg,
    liftLimitG,structuralMaxG,instantaneousMaxG,sustainedMaxG,instantaneousTurn:turn(instantaneousMaxG),sustainedTurn:turn(sustainedMaxG),
    stallSpeedMps:Math.sqrt(2*weight/(air.density*p.area*a.clMax)),withinSpeedLimits,liftFeasible,levelSustainable:liftFeasible&&withinSpeedLimits&&excessPowerMps>=0,
    source:'Computed with current game FM, not measured War Thunder telemetry; coordinated level-turn estimates, no instructor margin'};
}
export function performanceGrid(profile,{altitudes=[0,2000,5000,6500,10000,12000,15000],speeds=Array.from({length:31},(_,i)=>100+i*20)}={}){
  if(altitudes.length*speeds.length>2000)throw Error('包线采样过多');
  return altitudes.flatMap(altitudeM=>speeds.map(speedMps=>({altitudeM,speedMps,dry:performanceAt(profile,{altitudeM,speedMps}),wet:performanceAt(profile,{altitudeM,speedMps,afterburner:1})})));
}
