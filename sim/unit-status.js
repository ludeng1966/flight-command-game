import {basis,flightSafety} from './flight.js';
const PHASES={parked:'机位待命',taxi:'滑行',holding:'跑道外等待',lineup_taxi:'进入跑道',lined_up:'对正待命',takeoff_roll:'起飞滑跑',climb:'空中飞行',approach:'进近',final:'最后进近',rollout:'着陆滑跑',exit:'脱离跑道',missed:'复飞',waiting_gate:'等待机位',rejected:'中断起飞'};
export function selectedAircraftStatus(unit){
  const pose=unit.alive===false?unit.lastPose:basis(unit),f=pose?.forward??[0,1,0];
  const safety=flightSafety(unit),recovering=unit.flightState==='stall-recovery';
  const alert=unit.alive===false||safety.stalled||safety.severeLowSpeed?'danger':recovering||safety.lowSpeed?'warning':null;
  return {id:unit.id,callsign:unit.callsign,model:unit.profile?.name??'飞机',color:unit.color??'#9cdfb7',
    phase:unit.alive===false?'飞机损毁':recovering?(unit.recoveryCause==='low-speed'?'低速改出':'失速改出'):safety.stalled?'失速':safety.severeLowSpeed?'严重低速':safety.lowSpeed?'低速警告':unit.navigationBlocked?'航路暂缓':PHASES[unit.surface?.phase]??'空中飞行',alert,
    headingDeg:(Math.atan2(f[0],f[1])*180/Math.PI+360)%360,speed:unit.speed,altitudeM:unit.position[2],mach:unit.mach??0,
    targetAltitudeM:unit.headingRoute?.targetAltitudeM??unit.holdAltitude,targetSpeed:unit.targetSpeed,
    role:unit.flightRole?.role==='lead'?'长机':unit.flightRole?.role==='wingman'?'僚机':'独立飞行',
    completed:unit.completedWaypoints??0,remaining:unit.waypoints?.length??0,alive:unit.alive!==false};
}
