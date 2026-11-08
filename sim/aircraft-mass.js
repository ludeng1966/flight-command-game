import {MISSILE_MODELS} from './missiles.js';
export function initializeMass(unit,profile,profileId,configuration={}){
  unit.profileId=profileId;unit.operatingMassKg=profile.mass;unit.referenceFuelKg=configuration.referenceFuelKg??2000;
  unit.fuel={capacityKg:configuration.fuelCapacityKg??3200,massKg:configuration.fuelKg??unit.referenceFuelKg,bingoKg:700,emergencyKg:300};
  unit.profile={...profile};updateAircraftMass(unit,0);
}
export function updateAircraftMass(unit,dt=0){
  if(!unit.fuel)return;
  if(unit.alive!==false&&dt>0&&(unit.throttle??0)>.01){
    const rate=unit.surface?.grounded?.08:.25+.7*(unit.throttle??0)+3.2*(unit.afterburner??0);
    unit.fuel.massKg=Math.max(0,unit.fuel.massKg-rate*dt);
  }
  unit.storesMassKg=Object.entries(unit.weapons?.inventory??{}).reduce((sum,[id,n])=>sum+(MISSILE_MODELS.get(id)?.massKg??0)*n,0);
  const count=Object.values(unit.weapons?.inventory??{}).reduce((sum,n)=>sum+n,0);
  unit.profile.mass=unit.operatingMassKg+unit.fuel.massKg-unit.referenceFuelKg+unit.storesMassKg;
  unit.profile.storesCd0=count*.00065;unit.profile.fuelThrustFactor=unit.fuel.massKg>0&&!unit.engineFailed?1:0;
  unit.fuel.status=unit.fuel.massKg<=unit.fuel.emergencyKg?'emergency':unit.fuel.massKg<=unit.fuel.bingoKg?'bingo':'normal';
}
