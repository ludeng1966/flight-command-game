import {stepFlight,flightSafety} from './flight.js';
import {updatePilot} from './pilot.js';
// Validate a model's recovery with the real force integrator, without touching
// the live aircraft or replacing its destination. No speed/position correction.
export function traceRecovery(original,power){
  const u={...original,position:[...original.position],velocity:[...original.velocity],control:{...original.control},
    guidance:original.guidance?{...original.guidance}:undefined,energy:undefined,pilotPowerPlan:structuredClone(power),flightState:'stall-recovery',
    waypoints:original.waypoints.map(p=>[...p]),navLegs:[],orbit:[...original.orbit]};
  for(let i=0;i<900;i++){
    updatePilot(u,.1);
    for(let j=0;j<6;j++){
      const before=[...u.position];stepFlight(u,1/60);
      const ground=u.terrain?.heightAt?.(u.position[0],u.position[1]);
      if(!u.position.every(Number.isFinite)||ground===null||u.position[2]<(ground??0)+150||u.terrain?.collision?.(before,u.position))return {valid:false,reason:'改出方案无法保持地形净空'};
    }
    if(u.flightState==='normal'&&!flightSafety(u).lowSpeed)return {valid:true,seconds:(i+1)*.1,speedMps:u.speed,altitudeM:u.position[2]};
  }
  return {valid:false,reason:'所选推力与卸载方案不能在90秒内恢复稳定飞行'};
}
