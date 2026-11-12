import {MISSILE_MODELS} from './missiles.js';
import {density,thrustAt,dryFraction} from './flight.js';
export function initializeMass(unit,profile,profileId,configuration={}){
  unit.profileId=profileId;unit.referenceFuelKg=configuration.referenceFuelKg??profile.referenceFuelKg??2000;
  unit.operatingMassKg=profile.emptyMassKg!==undefined?profile.emptyMassKg+(profile.payloadMassKg??0)+unit.referenceFuelKg:profile.mass;
  const capacityKg=configuration.fuelCapacityKg??profile.fuelCapacityKg??3200;
  unit.fuel={capacityKg,massKg:Math.min(capacityKg,configuration.fuelKg??unit.referenceFuelKg),bingoKg:profile.category==='transport'?capacityKg*.1:700,emergencyKg:profile.category==='transport'?capacityKg*.04:300};
  unit.profile={...profile};updateAircraftMass(unit,0);
}
export function updateAircraftMass(unit,dt=0){
  if(!unit.fuel)return;
  if(unit.alive!==false&&dt>0&&(unit.throttle??0)>.01){
    const flow=unit.profile.fuelFlow,thrust=unit.thrustN??thrustAt(unit.profile,unit.position[2],unit.speed,unit.afterburner)*dryFraction(unit.profile,unit.throttle);
    const rate=flow?Math.max(flow.idleKgS,Math.max(0,thrust)*flow.tsfcKgPerNs*(1+(unit.afterburner??0)*((flow.afterburnerMultiplier??1)-1))*Math.pow(1.225/density(unit.position[2]),flow.altitudeExponent??0)):(unit.surface?.grounded?.08:.25+.7*(unit.throttle??0)+3.2*(unit.afterburner??0));
    unit.fuel.massKg=Math.max(0,unit.fuel.massKg-rate*dt);
  }
  unit.storesMassKg=Object.entries(unit.weapons?.inventory??{}).reduce((sum,[id,n])=>sum+(MISSILE_MODELS.get(id)?.massKg??0)*n,0);
  const count=Object.values(unit.weapons?.inventory??{}).reduce((sum,n)=>sum+n,0);
  unit.profile.mass=unit.operatingMassKg+unit.fuel.massKg-unit.referenceFuelKg+unit.storesMassKg;
  unit.profile.storesCd0=count*.00065;unit.profile.fuelThrustFactor=unit.fuel.massKg>0&&!unit.engineFailed?1:0;
  unit.fuel.status=unit.fuel.massKg<=unit.fuel.emergencyKg?'emergency':unit.fuel.massKg<=unit.fuel.bingoKg?'bingo':'normal';
}
