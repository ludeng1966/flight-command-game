import {teamOf} from './battle-observation.js';
import {attackContacts} from './attack-task.js';
import {applyRadarOrder} from './radar.js';
import {applyWeaponOrder,launchAssessment,engagementPermission} from './weapons.js';
import {MISSILE_MODELS} from './missiles.js';
import {estimateShotQuality} from './shot-quality.js';
import {navigationEnvelope} from './energy.js';
const bearing=(a,b)=>(Math.atan2(b[0]-a[0],b[1]-a[1])*180/Math.PI+360)%360;
const heading=u=>(Math.atan2(u.velocity[0],u.velocity[1])*180/Math.PI+360)%360;
const distance=(u,c)=>Math.hypot(...c.position.map((v,i)=>v-u.position[i]));
function steer(unit,headingDeg,altitudeM){
  // Set the existing heading controller's reference, never position/velocity.
  // Its terrain look-ahead and energy envelope remain active.
  unit.headingTarget=headingDeg*Math.PI/180;unit.holdAltitude=altitudeM;
  const envelope=navigationEnvelope(unit);
  unit.targetSpeed=Math.max(envelope.safeLevelSpeedMps*1.15,Math.min(280,unit.targetSpeed??unit.speed));
}
export function makeOpponentScenario(base){
  const scenario=structuredClone(base),lead=scenario.units.find(u=>teamOf(u)==='blue')??scenario.units[0];
  if(!lead)throw Error('对抗演练需要至少一架玩家飞机');
  if(scenario.units.some(u=>u.opponent?.enabled))return scenario;
  const h=(lead.heading??0)*Math.PI/180;
  scenario.defaultSpawnMode='airborne';scenario.battleMode='opponent_training';scenario.playerTeam='blue';
  scenario.units.push({id:'red-training-1',callsign:'RED TRAINER',team:'red',controllable:false,profile:'f16',color:'#ff706e',
    position:[lead.position[0]+Math.sin(h)*28000,lead.position[1]+Math.cos(h)*28000,Math.max(6500,lead.position[2])],
    heading:((lead.heading??0)+180)%360,speed:250,opponent:{enabled:true,policy:'observed_intercept_v1'}});
  return scenario;
}
export function initializeOpponents(world){
  for(const unit of world.units)if(unit.opponent?.enabled){unit.controllable=false;unit.weapons.roe='free';
    unit.opponentState??={phase:'patrol',nextDecisionAt:0,patrolHeadingDeg:heading(unit),targetId:null,lastSeenAt:null,lastShotAt:-100,lastError:null};}
}
// Call once per World.step after radar/weapons/RWR updates. It makes one
// decision every 0.5 sim seconds and never calls an LLM or reads enemy truth.
export function stepOpponents(world){
  for(const unit of world.units){
    if(!unit.opponent?.enabled||unit.alive===false||unit.surface?.grounded)continue;
    const state=unit.opponentState??={phase:'patrol',nextDecisionAt:0,patrolHeadingDeg:heading(unit),targetId:null,lastSeenAt:null,lastShotAt:-100,lastError:null};
    if(world.time<state.nextDecisionAt)continue;state.nextDecisionAt=world.time+.5;
    try{
      if(unit.rwrDefense?.active){state.phase='defend';continue;}
      const contacts=attackContacts(unit,world.time).filter(c=>c.classification!=='friendly'),target=contacts.find(c=>c.id===state.targetId)??contacts.sort((a,b)=>distance(unit,a)-distance(unit,b))[0];
      const ammunition=Object.entries(unit.weapons?.inventory??{}).filter(([,n])=>n>0);
      const flights=(world.missiles??[]).filter(m=>m.ownerId===unit.id&&m.alive);
      if(flights.length){state.phase='support';continue;}
      if(!ammunition.length){state.phase='disengage';steer(unit,target?(bearing(unit.position,target.position)+180)%360:(state.patrolHeadingDeg+180)%360,unit.holdAltitude??unit.position[2]);continue;}
      if(unit.radar?.available&&unit.radar.mode==='off'){applyRadarOrder(world,unit,{operation:'mode',mode:'pd',targetId:null},{autonomous:true});state.phase='search';steer(unit,state.patrolHeadingDeg,unit.position[2]);continue;}
      if(!target){
        state.phase=state.targetId?'reacquire':'search';
        if(state.lastSeenAt!==null&&world.time-state.lastSeenAt>5){state.patrolHeadingDeg=(heading(unit)+45)%360;state.lastSeenAt=world.time;}
        steer(unit,state.patrolHeadingDeg,unit.holdAltitude??unit.position[2]);continue;
      }
      state.targetId=target.id;state.lastSeenAt=world.time;state.phase='intercept';
      const estimate=target.position.map((v,i)=>v+target.velocity[i]*Math.max(0,world.time-target.observedAt));
      steer(unit,bearing(unit.position,estimate),Math.max(500,Math.min(navigationEnvelope(unit).ceilingM,estimate[2])));
      // The training scenario is explicit opposing-side engagement authority.
      // Identification is still observed; it never reads a target's hidden team.
      unit.weapons.roe='free';
      if(!engagementPermission(unit,target).allowed)continue;
      const options=ammunition.map(([id])=>({id,quality:estimateShotQuality(unit,target,MISSILE_MODELS.get(id),world.time,world.terrain)}));
      const ranks={favorable:0,marginal:1,poor:2,blocked:3,unknown:4};options.sort((a,b)=>ranks[a.quality.rating]-ranks[b.quality.rating]||(a.quality.interceptSec??Infinity)-(b.quality.interceptSec??Infinity));
      const choice=options[0],model=MISSILE_MODELS.get(choice.id);
      if(model.kind!=='infrared'&&(!unit.radar?.canIlluminate||unit.radar.targetId!==target.id)){
        if(unit.radar?.phase!=='acquiring'||unit.radar.targetId!==target.id)applyRadarOrder(world,unit,{operation:'lock',mode:null,targetId:target.id},{autonomous:true});
        state.phase='acquire';continue;
      }
      if(unit.weapons.selectedModelId!==choice.id)applyWeaponOrder(world,unit,{operation:'select',modelId:choice.id,targetId:null,quantity:null},{autonomous:true});
      if(unit.weapons.targetId!==target.id)applyWeaponOrder(world,unit,{operation:'designate',modelId:null,targetId:target.id,quantity:null},{autonomous:true});
      const assessment=launchAssessment(world,unit,choice.id,target.id);state.phase='prepare';state.shotQuality=choice.quality.rating;
      if(assessment.ready&&choice.quality.rating==='favorable'&&world.time-state.lastShotAt>=8){applyWeaponOrder(world,unit,{operation:'launch',modelId:choice.id,targetId:target.id,quantity:1},{autonomous:true});state.lastShotAt=world.time;state.phase='support';}
      state.lastError=null;
    }catch(error){state.lastError=String(error.message??error).slice(0,160);}
  }
}
