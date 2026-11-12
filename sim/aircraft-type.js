import {G,density,aeroAt,clamp,hasAfterburner} from './flight.js';
import {energyEnvelope} from './energy.js';
import {initializeMass} from './aircraft-mass.js';
import {createRadar} from './radar.js';
import {createWeapons} from './weapons.js';
import {createRwr} from './rwr.js';
import {createRwrDefense} from './rwr-defense.js';
import {leaveFormation} from './formation.js';
import {createDatalink} from './datalink.js';
export function setAircraftType(world,unitId,profileId,{restoring=false}={}){
  const u=world.units.find(u=>u.id===unitId),profile=world.profiles[profileId];
  if(!u||!Object.hasOwn(world.profiles,profileId))throw Error('未知机型');if(!u.alive&&!restoring)throw Error('飞机已坠毁，请重新开始后更换机型');
  if(u.profileId===profileId){u.visualModel=profileId;return u;}
  leaveFormation(u,'更换机型，退出当前编队');
  u.weapons=createWeapons(profileId);u.radar=createRadar(profileId,profile.radar===false?false:profileId==='f16'||profile.radar?{...(profile.radar??{}),sensorModelVersion:world.sensorModelVersion??1}:undefined);u.rwr=createRwr(profileId,profile.rwr);u.rwrDefense=createRwrDefense();
  initializeMass(u,profile,profileId);u.visualModel=profileId;u.aircraftTypeVersion=1;
  u.datalink=createDatalink(profileId,undefined,u.team??u.faction??'blue');
  const speed=Math.max(1,Math.hypot(...u.velocity)),q=.5*density(u.position[2])*(u.profile.densityScale??1)*speed*speed,a=aeroAt(u.profile,u.position[2],speed,u),envelope=energyEnvelope(u.profile,u.position[2],speed,u);
  u.cl=Math.min(a.clMax*.84,u.profile.mass*G*Math.max(.5,Math.min(u.profile.maxG*.9,u.loadFactor??1))/(q*u.profile.area));
  u.targetSpeed=clamp(Math.max(u.targetSpeed,envelope.safeSpeed(1)*1.12),envelope.safeSpeed(1),envelope.maxSpeed);
  if(!hasAfterburner(u.profile))u.afterburner=0;
  u.control={bank:clamp(u.bank,-(profile.controlLimits?.bankRad??1.36),profile.controlLimits?.bankRad??1.36),cl:u.cl,maxG:profile.maxG,throttle:u.throttle,afterburner:u.afterburner??0};
  u.energy=undefined;u.guidance={bank:u.bank,n:Math.min(u.loadFactor??1,profile.maxG*.9)};
  u.pilotPowerPlan=null;u.departurePowerPlan=null;u.pilotExecution=null;u.pilotMission=null;u.radarTask=null;u.attackTask=null;u.formationGuidance=null;
  u.navLegs=[];u.navCursor=0;u.navigationKey=null;u.navigationPending=false;u.navigationBlocked=null;u.navigationRetryAt=0;u.routeRevision=(u.routeRevision??0)+1;
  world.prediction={points:[],warnings:[]};world.pilotPreview=null;world.revision++;
  if(u.alive)u.lastIncident='已换装 '+profile.name+'，按新机型重新规划';return u;
}
