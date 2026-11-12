import {radioAltitude,radioSpeed,radioDistance} from './units.js';
import {G,thrustAt,dryFraction,dragAt,density,hasAfterburner} from './flight.js';
import {rotationSpeed} from './airport-performance.js';
import {energyEnvelope} from './energy.js';
import {distanceValue,speedValue,altitudeValue,unitLabels} from './units.js';
export const needsDeparturePlan=order=>order?.intent==='takeoff'&&['reduced_thrust','derated','flex','dry','military_power','full_thrust','afterburner'].includes(order.mode);
export function evaluateDeparturePlan(world,unit,order,request){
  if(!needsDeparturePlan(order)||!world.airportOps||!request)return null;
  const a=world.airportOps.airport,r=world.airportOps.runway(order.runway),p=unit.profile;
  const {throttle,afterburner,distanceM}=request,altitudeM=request.altitudeM??order.altitudeM??a.elevation+1200;
  if(![throttle,afterburner,distanceM,altitudeM].every(Number.isFinite)||throttle<0||throttle>1||afterburner<0||afterburner>1||distanceM<3000||distanceM>60000||altitudeM<a.elevation+300||altitudeM>15000||order.altitudeM!==null&&order.altitudeM!==undefined&&Math.abs(altitudeM-order.altitudeM)>1)return null;
  if(order.mode==='afterburner'&&!hasAfterburner(p))return null;
  if(order.mode==='military_power'&&(throttle!==1||afterburner!==0)||order.mode==='dry'&&afterburner!==0||['full_thrust','afterburner'].includes(order.mode)&&(throttle!==1||afterburner!==(hasAfterburner(p)?1:0)))return null;
  let speed=0,distance=0,time=0,rotation=0;
  while(time<120){rotation=rotationSpeed(unit,a.elevation,speed);if(speed>=rotation)break;
    const acceleration=(thrustAt(p,a.elevation,Math.max(1,speed),afterburner)*dryFraction(p,throttle)-dragAt(p,a.elevation,speed,.2)-p.mass*.02*G)/p.mass;
    speed=Math.max(0,speed+acceleration*.1);distance+=speed*.1;time+=.1;if(distance>r.length-350)break;}
  if(speed<rotation||distance>r.length-350)return null;
  const climbSpeedMps=request.climbSpeedMps??Math.max(150,rotation+30);if(!Number.isFinite(climbSpeedMps)||climbSpeedMps<rotation+15||climbSpeedMps>300)return null;
  const q=.5*density(a.elevation+300)*climbSpeedMps**2,cl=p.mass*G/(q*p.area),available=thrustAt(p,a.elevation+300,climbSpeedMps,afterburner)*dryFraction(p,throttle),drag=dragAt(p,a.elevation+300,climbSpeedMps,cl,{gearDown:false,flaps:'takeoff'});
  if(['reduced_thrust','derated','flex'].includes(order.mode)&&available>=thrustAt(p,a.elevation+300,climbSpeedMps,1)*.95)return null;
  const gradient=(available-drag)/(p.mass*G)*.55;if(gradient<=.025||(altitudeM-a.elevation)/distanceM>gradient)return null;
  const end=r.direction===1?r.x1:r.x0,points=[.4,1].map(f=>[end+r.direction*distanceM*f,r.y,a.elevation+(altitudeM-a.elevation)*f]);
  if(points.some(p=>p.some(v=>!Number.isFinite(v))||Math.abs(p[0])>200000||Math.abs(p[1])>200000)||world.terrain?.checkPoint&&points.some(point=>!world.terrain.checkPoint(point).valid))return null;
  const extra=climbSpeedMps===Math.max(150,rotation+30)&&altitudeM===(order.altitudeM??a.elevation+1200)?'':`-${climbSpeedMps}-${altitudeM}`;
  return {id:`power-${Math.round(throttle*10000)/100}-${Math.round(afterburner*10000)/100}-${distanceM}${extra}`,throttle,afterburner,climbSpeedMps,altitudeM,distanceM,points,rotationSpeedMps:Number(rotation.toFixed(2)),groundRollM:Math.round(distance),runway:r.designator,mode:order.mode};
}
export function departureOptions(world,unit,order){
  if(!needsDeparturePlan(order)||!world.airportOps)return [];
  const reduced=['reduced_thrust','derated','flex','dry','military_power'].includes(order.mode),options=[];
  const powers=order.mode==='military_power'?[[1,0]]:reduced?[[.8,0],[.9,0],[1,0]]:[[1,hasAfterburner(unit.profile)?1:0]];
  for(const [throttle,afterburner]of powers)for(const distanceM of [6000,10000,14000]){
    const option=evaluateDeparturePlan(world,unit,order,{throttle,afterburner,distanceM});if(option)options.push(option);
  }
  return options;
}
export function departurePlanReadback(plan,system='metric',language='zh'){
  const labels=unitLabels(system),n=value=>String(Math.round(value*100)/100),throttle=Math.round(plan.throttle*100),distance=n(distanceValue(plan.distanceM,system)),speed=n(radioSpeed(plan.climbSpeedMps,system)),altitude=n(radioAltitude(plan.altitudeM,system));
  return language==='en'?`Planned throttle ${throttle} percent, ${plan.afterburner?'afterburner '+Math.round(plan.afterburner*100)+' percent':'no afterburner'}, departure route ${distance} ${labels.distanceEnglish}, climb speed ${speed} ${labels.speedEnglish}, initial climb altitude ${altitude} ${labels.altitudeEnglish}`:`计划油门${throttle}%，${plan.afterburner?'加力'+Math.round(plan.afterburner*100)+'%':'不使用加力'}，离场航路${distance}${labels.distanceSpoken}，爬升速度${speed}${labels.speedSpoken}，初始爬升高度${altitude}${labels.altitudeSpoken}`;
}
export function verifyDeparturePlan(world,unit,order,procedure){
  const match=evaluateDeparturePlan(world,unit,order,procedure);
  if(!match||JSON.stringify(match)!==JSON.stringify(procedure))throw Error('飞行员起飞方案缺失、过期或未通过推力/跑道校验');
  return structuredClone(match);
}
