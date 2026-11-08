import {G,thrustAt,dryFraction,dragAt} from './flight.js';
import {energyEnvelope} from './energy.js';
import {runwayWeatherLimits,brakingDeceleration} from './airport-weather.js';
export function takeoffPerformance(airport,runway,unit,power=unit.departurePowerPlan){
  const limits=runwayWeatherLimits(airport.weather,runway,unit.profile),p=unit.profile;
  if(!limits.valid)return {valid:false,reason:limits.reason};
  if(unit.fuel?.massKg===0)return {valid:false,reason:'燃油耗尽，无法起飞'};
  const throttle=power?.throttle??1,afterburner=power?.afterburner??1;
  let speed=0,distance=0,time=0,rotation=0;
  for(;time<120;time+=.1){
    const airSpeed=Math.max(1,speed+limits.headwindMps);rotation=Math.max(p.airportRotationSpeed??105,energyEnvelope(p,airport.elevation,Math.max(60,airSpeed)).safeSpeed(1)*1.45);
    if(airSpeed>=rotation)break;
    const rolling=(airport.weather.runwayCondition==='wet'?.025:.02)*p.mass*G;
    speed=Math.max(0,speed+(thrustAt(p,airport.elevation,airSpeed,afterburner)*dryFraction(p,throttle)-dragAt(p,airport.elevation,airSpeed,.2)-rolling)/p.mass*.1);
    distance+=speed*.1;if(distance>runway.length-250)break;
  }
  const valid=time<120&&distance<=runway.length-350&&speed+limits.headwindMps>=rotation;
  return {valid,reason:valid?null:'当前质量、气象及推力下可用跑道不足',groundRollM:Math.round(distance),rotationSpeedMps:rotation,
    rotationGroundSpeedMps:speed,takeoffTimeSec:Math.round(time),runwayOccupancySec:Math.round(time+(runway.length-distance)/Math.max(60,speed)),massKg:p.mass,storesMassKg:unit.storesMassKg??0,...limits};
}
export function landingPerformance(airport,runway,unit){
  const limits=runwayWeatherLimits(airport.weather,runway,unit.profile),env=energyEnvelope(unit.profile,airport.elevation+100,Math.max(90,unit.speed));
  const referenceSpeedMps=Math.max(78,env.safeSpeed(1)*1.1),groundSpeed=Math.max(40,referenceSpeedMps-limits.headwindMps),deceleration=brakingDeceleration(airport.weather);
  const landingDistanceM=450+groundSpeed*groundSpeed/(2*deceleration)+150,valid=limits.valid&&landingDistanceM<runway.length;
  return {valid,reason:!limits.valid?limits.reason:valid?null:'当前跑道制动状况下着陆停止距离不足',referenceSpeedMps,landingDistanceM:Math.round(landingDistanceM),decelerationMps2:deceleration,massKg:unit.profile.mass,...limits};
}
