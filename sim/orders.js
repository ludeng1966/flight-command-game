import {getUnitSystem,formatDistance} from './units.js';
import {planHeadingRoute} from './navigation.js';
import {callsignAliases,radioReadback} from './radio.js';
import {AIRPORT_INTENTS} from './airport.js';
import {needsDeparturePlan,verifyDeparturePlan} from './departure-plan.js';
import {FORMATION_ACTIONS,DUAL_FORMATIONS,validateFormationTasks,installFormation,leaveFormation,bindFlightRoles} from './formation.js';
import {radarContext,validateRadarOrder,applyRadarOrder,RADAR_MODES} from './radar.js';
import {validateRadarTask,installRadarTask,radarTaskContext} from './radar-task.js';
import {beginPilotExecution} from './pilot-execution.js';
import {rwrContext} from './rwr.js';
import {defenseContext,DEFENSE_SCHEMA,validateDefenseOrder,validateDefenseTask,applyDefenseTask,notePlayerDefenseOrder} from './rwr-defense.js';
import {weaponsContext,validateWeaponOrder,applyWeaponOrder,WEAPON_OPERATIONS} from './weapons.js';
import {validateAttackOrder,validateAttackAssignment,installAttackTask,attackTaskContext,cancelAttackTask} from './attack-task.js';
import {ATTACK_ORDER_KEYS} from './attack-contract.js';
// AI 与游戏共用的命令契约。所有单位均为米、秒、弧度（headingDeg 除外）。
export const LIMITS = Object.freeze({altitudeM:[500,15000],speedMps:[400/3.6,2400/3.6],coordinateM:[-200000,200000]});
export const ACTIONS = ['set_flight','fly_to','fly_heading','orbit','clear_waypoints','report_status','pause','resume','airport','radar','sensor_task','attack_task','weapon','defense','assign_role',...FORMATION_ACTIONS];
const numericFields = ['altitudeM','speedMps','headingDeg','eastM','northM','distanceM'];
const taskKeys = ['unitId','action',...numericFields,'append'];
const formationKeys=['targetId','formation','side','rangeM'];
const taskSchema=(action,allowed,mandatory=[])=>({
  type:'object',additionalProperties:false,required:taskKeys,
  properties:{
    unitId:{type:['pause','resume'].includes(action)?'null':'string'},action:{type:'string',enum:[action]},
    ...Object.fromEntries(numericFields.map(k=>[k,{type:mandatory.includes(k)?'number':allowed.includes(k)?['number','null']:'null'}])),
    append:action==='fly_to'?{type:'boolean'}:{type:'boolean',enum:[false]}
  }
});
export const PLAN_SCHEMA = {
  type:'object',additionalProperties:false,required:['status','summary','tasks'],
  properties:{
    status:{type:'string',enum:['accepted','needs_clarification','unsupported']},
    summary:{type:'string'},
    tasks:{type:'array',items:{anyOf:[
      {type:'object',additionalProperties:false,required:['unitId','action','defenseOrder'],properties:{unitId:{type:'string'},action:{const:'defense'},defenseOrder:DEFENSE_SCHEMA}},
      {type:'object',additionalProperties:false,required:['unitId','action','attackOrder'],properties:{unitId:{type:'string'},action:{const:'attack_task'},attackOrder:{type:'object',additionalProperties:false,required:ATTACK_ORDER_KEYS,properties:{targetId:{type:['string','null']},targetRef:{type:['string','null']},weaponRef:{type:['string','null']},shotLimit:{type:'integer',minimum:1,maximum:4},altitudeM:{type:['number','null']},speedMps:{type:['number','null']},headingDeg:{type:['number','null']}}}}},
      {type:'object',additionalProperties:false,required:['unitId','action','sensorTask'],properties:{unitId:{type:'string'},action:{const:'sensor_task'},sensorTask:{type:'object',additionalProperties:false,required:['goal','targetId','targetRef'],properties:{goal:{enum:['search','track_target']},targetId:{type:['string','null']},targetRef:{type:['string','null']}}}}},
      {type:'object',additionalProperties:false,required:['unitId','action','weaponOrder'],properties:{unitId:{type:'string'},action:{const:'weapon'},weaponOrder:{type:'object',additionalProperties:false,required:['operation','modelId','targetId','quantity'],properties:{operation:{enum:WEAPON_OPERATIONS},modelId:{type:['string','null']},targetId:{type:['string','null']},quantity:{type:['integer','null'],minimum:1,maximum:4}}}}},
      {type:'object',additionalProperties:false,required:['unitId','action','radarOrder'],properties:{unitId:{type:'string'},action:{const:'radar'},radarOrder:{type:'object',additionalProperties:false,required:['operation','mode','targetId'],properties:{operation:{enum:['mode','lock','unlock']},mode:{enum:[null,...RADAR_MODES]},targetId:{type:['string','null']}}}}},
      {type:'object',additionalProperties:false,required:['unitId','action','role','targetId'],properties:{unitId:{type:'string'},action:{const:'assign_role'},role:{enum:['lead','wingman']},targetId:{type:'string'}}},
      {type:'object',additionalProperties:false,required:['unitId','action','airportOrder'],properties:{
        unitId:{type:'string'},action:{const:'airport'},airportOrder:{
          type:'object',additionalProperties:false,required:['intent','airportId','runway','taxiways','gate','altitudeM','mode'],
          properties:{intent:{enum:AIRPORT_INTENTS},airportId:{type:['string','null']},runway:{type:['string','null']},taxiways:{type:'array',items:{type:'string'}},gate:{type:['string','null']},altitudeM:{type:['number','null']},mode:{type:['string','null']}}
      }}},
      taskSchema('set_flight',['altitudeM','speedMps']),
      taskSchema('fly_to',['altitudeM','speedMps','eastM','northM'],['eastM','northM']),
      taskSchema('fly_heading',['altitudeM','speedMps','headingDeg','distanceM'],['headingDeg']),
      taskSchema('orbit',['altitudeM','speedMps','eastM','northM']),
      taskSchema('clear_waypoints',[]),taskSchema('report_status',[]),taskSchema('pause',[]),taskSchema('resume',[]),
      ...FORMATION_ACTIONS.map(action=>{const s=taskSchema(action,[]);s.required=[...taskKeys,...formationKeys];Object.assign(s.properties,{targetId:{type:'string'},formation:{type:'string',enum:DUAL_FORMATIONS},side:{type:'string',enum:['left','right']},rangeM:{type:'number',minimum:400,maximum:5000}});return s;})
    ]}}
  }
};
const fail = message => {throw new Error(message);};
const exactKeys = (obj,keys) => obj && typeof obj==='object' && !Array.isArray(obj) &&
  Object.keys(obj).length===keys.length && keys.every(k=>Object.hasOwn(obj,k));
const inRange = (v,[lo,hi]) => Number.isFinite(v) && v>=lo && v<=hi;

export function validatePlan(plan,units) {
  if(!exactKeys(plan,['status','summary','tasks']) || !['accepted','needs_clarification','unsupported'].includes(plan.status) ||
    typeof plan.summary!=='string' || !plan.summary.trim() || plan.summary.length>600 || !Array.isArray(plan.tasks) || plan.tasks.length>16) fail('AI 返回的任务格式无效');
  if(plan.status!=='accepted') {
    if(plan.tasks.length) fail('未接受的计划不能包含可执行任务');
    return plan;
  }
  if(!plan.tasks.length) fail('AI 没有返回可执行任务');
  for(const t of plan.tasks) {
    if(t.action==='defense'){if(!exactKeys(t,['unitId','action','defenseOrder'])||!units.some(u=>u.id===t.unitId&&u.alive!==false))fail('自卫规避任务无效');validateDefenseOrder(t.defenseOrder);continue;}
    if(t.action==='attack_task'){if(!exactKeys(t,['unitId','action','attackOrder'])||!units.some(u=>u.id===t.unitId&&u.alive!==false))fail('攻击任务对象无效');validateAttackOrder(t.attackOrder);continue;}
    if(t.action==='sensor_task'){if(!exactKeys(t,['unitId','action','sensorTask'])||!units.some(u=>u.id===t.unitId&&u.alive!==false))fail('雷达任务对象无效');validateRadarTask(t.sensorTask);continue;}
    if(t.action==='weapon'){
      const o=t.weaponOrder;
      if(!exactKeys(t,['unitId','action','weaponOrder'])||!units.some(u=>u.id===t.unitId&&u.alive!==false)||!exactKeys(o,['operation','modelId','targetId','quantity'])||!WEAPON_OPERATIONS.includes(o.operation)||![o.modelId,o.targetId].every(v=>v===null||typeof v==='string'&&v.length>0&&v.length<=80)||!(o.quantity===null||Number.isInteger(o.quantity)&&o.quantity>=1&&o.quantity<=4))fail('武器任务参数无效');
      continue;
    }
    if(t.action==='radar'){
      if(!exactKeys(t,['unitId','action','radarOrder'])||!units.some(u=>u.id===t.unitId&&u.alive!==false)||!exactKeys(t.radarOrder,['operation','mode','targetId'])||!['mode','lock','unlock'].includes(t.radarOrder.operation)||
        !(t.radarOrder.operation==='mode'?RADAR_MODES.includes(t.radarOrder.mode)&&t.radarOrder.targetId===null:t.radarOrder.mode===null&&(t.radarOrder.operation==='unlock'?t.radarOrder.targetId===null:typeof t.radarOrder.targetId==='string'&&t.radarOrder.targetId.length>0&&t.radarOrder.targetId.length<=64)))fail('雷达任务参数无效');
      continue;
    }
    if(t.action==='assign_role'){if(!exactKeys(t,['unitId','action','role','targetId']))fail('长僚机角色参数无效');continue;}
    if(t.action==='airport'){
      const o=t.airportOrder;
      if(!exactKeys(t,['unitId','action','airportOrder'])||!units.some(u=>u.id===t.unitId&&u.alive!==false)||!o||!exactKeys(o,['intent','airportId','runway','taxiways','gate','altitudeM','mode'])||!AIRPORT_INTENTS.includes(o.intent)||
        ![o.airportId,o.runway,o.gate,o.mode].every(v=>v===null||typeof v==='string'&&v.length<=80)||!Array.isArray(o.taxiways)||o.taxiways.some(v=>typeof v!=='string'||v.length>20)||!(o.altitudeM===null||inRange(o.altitudeM,[500,15000])))fail('机场任务参数无效');
      continue;
    }
    if(!exactKeys(t,FORMATION_ACTIONS.includes(t.action)?[...taskKeys,...formationKeys]:taskKeys) || !ACTIONS.includes(t.action) || typeof t.append!=='boolean' ||
      numericFields.some(k=>t[k]!==null&&!Number.isFinite(t[k]))) fail('AI 返回了未知命令或参数');
    const global=t.action==='pause'||t.action==='resume';
    const u=units.find(u=>u.id===t.unitId);
    if(u?.surface?.grounded&&!['report_status','pause','resume'].includes(t.action))fail('飞机在地面，请先下达机场离场任务');
    if(global ? t.unitId!==null : !u) fail('任务中的飞机编号无效');
    if(u?.alive===false&&t.action!=='report_status') fail('该飞机已触地停机，无法接收飞行指令');
    for(const k of ['altitudeM','speedMps']) {
      if(t[k]!==null&&!inRange(t[k],LIMITS[k])) fail(`${k} 超出本原型支持范围`);
    }
    if(t.headingDeg!==null&&!inRange(t.headingDeg,[0,360])) fail('航向必须在 0–360 度之间');
    if(t.distanceM!==null&&!inRange(t.distanceM,[1000,100000])) fail(`指定航段距离须为 ${formatDistance(1000)}–${formatDistance(100000)}`);
    for(const k of ['eastM','northM']) if(t[k]!==null&&!inRange(t[k],LIMITS.coordinateM)) fail('航点超出地图指令范围');
    const allowed=global?[]:t.action==='fly_to'?['eastM','northM','altitudeM','speedMps']:
      t.action==='fly_heading'?['headingDeg','altitudeM','speedMps','distanceM']:
      t.action==='orbit'?['eastM','northM','altitudeM','speedMps']:
      t.action==='set_flight'?['altitudeM','speedMps']:[];
    if(numericFields.some(k=>t[k]!==null&&!allowed.includes(k))) fail('动作与参数不匹配');
    if(t.append&&t.action!=='fly_to') fail('只有航点任务可以追加');
    if(t.action==='fly_to'&&(t.eastM===null||t.northM===null)) fail('缺少航点坐标');
    if(t.action==='fly_heading'&&t.headingDeg===null) fail('缺少目标航向');
    if(t.action==='orbit'&&((t.eastM===null)!==(t.northM===null))) fail('盘旋中心坐标不完整');
    if(t.action==='set_flight'&&['altitudeM','speedMps'].every(k=>t[k]===null)) fail('缺少飞行参数');
  }
  validateFormationTasks(plan.tasks,units);
  return plan;
}

export function commandContext(world,selectedId,mapPoint=null,radioStyle='pla') {
  return {simTimeSec:world.time,revision:world.revision,selectedUnitId:selectedId,radioStyle,unitSystem:world.unitSystem??getUnitSystem(),
    bullseye:world.bullseye?structuredClone(world.bullseye):null,executionMode:world.executionMode??'strict',
    mapPoint:mapPoint?[mapPoint[0],mapPoint[1],mapPoint[2]]:null,
    airports:world.airportOps?[{id:world.airportOps.airport.id,name:world.airportOps.airport.name,runways:world.airportOps.airport.runways.map(r=>r.designator),taxiways:[...new Set(world.airportOps.airport.edges.map(e=>e.name))],stands:world.airportOps.airport.stands}]:[],
    airportTraffic:world.airportOps?.traffic.snapshot(world)??null,
    units:world.units.map((u,i)=>({id:u.id,callsign:u.callsign,number:i+1,aliases:callsignAliases(u,i),radioNumber:u.radioNumber||String(101+i),
      position:[...u.position],headingDeg:(Math.atan2(u.velocity[0],u.velocity[1])*180/Math.PI+360)%360,
      speedMps:u.speed,targetAltitudeM:u.headingRoute?.targetAltitudeM??u.targetAltitude,targetSpeedMps:u.targetSpeed,maxG:u.profile.maxG,
      alive:u.alive!==false,task:u.formation?'formation':u.headingRoute||u.headingTarget!=null?'heading':u.waypoints.length?'waypoints':'orbit',
      grounded:u.surface?.grounded===true,surfacePhase:u.surface?.phase??'airborne',
      groundNode:u.surface?.node??null,groundRunway:u.surface?.runway??null,controlAuthority:u.controlAuthority?{owner:u.controlAuthority.owner,phase:u.controlAuthority.phase,target:u.controlAuthority.target,mode:u.controlAuthority.mode}:null,
      team:u.team??u.faction??'blue',radar:radarContext(u,world.time),radarTask:radarTaskContext(u),attackTask:attackTaskContext(u),weapons:weaponsContext(u,world.time),rwr:rwrContext(u,world.time),rwrDefense:defenseContext(u),flightRole:u.flightRole?{...u.flightRole}:null,
      formation:u.formation?{leaderId:u.formation.leaderId,shape:u.formation.shape,side:u.formation.side,rangeM:u.formation.rangeM,intent:u.formation.intent,status:u.formation.status,slotErrorM:u.formation.slotErrorM}:null,
      telemetry:{waypoints:u.waypoints.slice(0,32).map(w=>w.slice(0,3)),flightState:u.flightState||'normal',loadFactor:u.loadFactor,
        groundClearanceM:world.terrain?.heightAt?u.position[2]-(world.terrain.heightAt(u.position[0],u.position[1])??u.position[2]):null}}))};
}

// 先完整校验再执行，保证非法批次不会只改动一部分飞机。
export function preparePilotPlan(world,plan,expectedRevision,{radioStyle='pla',pilotProcedures={}}={}) {
  validatePlan(plan,world.units);
  if(world.revision!==expectedRevision) fail('指令分析期间已有新操作，本次结果已作废，请重新下令');
  if(plan.status!=='accepted') return {world,plan,expectedRevision,radioStyle,status:'not_executable'};
  // 预演整批航路，接入 World 的地形校验；任一航路失败时不修改任何飞机。
  const routes=new Map(world.units.map(u=>[u.id,{altitude:u.targetAltitude,speed:u.targetSpeed,points:u.waypoints.map(w=>w.slice(0,3))}]));
  const headingPlans=new Map(),flightPlans=new Map(),departurePlans=new Map();
  const weaponTasks=plan.tasks.filter(t=>t.action==='weapon');
  if(weaponTasks.some((t,i)=>weaponTasks.findIndex(x=>x.unitId===t.unitId&&x.weaponOrder.operation===t.weaponOrder.operation)!==i))fail('同机重复武器操作请分条下达，不能重复发射');
  if(plan.tasks.some(t=>t.action==='airport')&&plan.tasks.some(t=>t.action!=='airport'))fail('机场任务与空中导航请分批下达');
  if(plan.tasks.filter(t=>t.action==='airport').some((t,i,a)=>a.findIndex(x=>x.unitId===t.unitId)!==i))fail('同机机场阶段任务请逐条下达');
  for(const [index,t] of plan.tasks.entries()){
    if(t.action==='defense'){validateDefenseTask(world,world.units.find(u=>u.id===t.unitId),t.defenseOrder);continue;}
    if(t.action==='attack_task'){validateAttackAssignment(world,world.units.find(u=>u.id===t.unitId),t.attackOrder);continue;}
    if(t.action==='sensor_task'){if(!world.units.find(u=>u.id===t.unitId)?.radar?.available)fail('受令机没有可用的搜索雷达');continue;}
    if(t.action==='weapon'){validateWeaponOrder(world,world.units.find(u=>u.id===t.unitId),t.weaponOrder);continue;}
    if(t.action==='radar'){validateRadarOrder(world,world.units.find(u=>u.id===t.unitId),t.radarOrder);continue;}
    if(t.action==='assign_role')continue;
    if(FORMATION_ACTIONS.includes(t.action)){const route=routes.get(t.unitId);route.points=[];continue;}
    if(t.action==='airport'){if(!world.airportOps)fail('本场景无机场');const unit=world.units.find(u=>u.id===t.unitId);world.airportOps.validate(unit,t.airportOrder,world.executionMode);if(needsDeparturePlan(t.airportOrder))departurePlans.set(t.unitId,verifyDeparturePlan(world,unit,t.airportOrder,pilotProcedures[t.unitId]));continue;}
    if(t.action==='report_status')continue;
    const route=routes.get(t.unitId);if(!route)continue;
    const unit=world.units.find(u=>u.id===t.unitId);
    if(t.speedMps!==null)route.speed=t.speedMps;
    if(t.altitudeM!==null&&['set_flight','fly_heading','orbit'].includes(t.action)){
      const point=[t.action==='orbit'?(t.eastM??unit.position[0]):unit.position[0],t.action==='orbit'?(t.northM??unit.position[1]):unit.position[1],t.altitudeM];
      const groundCheck=world.terrain?.checkPoint?.(point);
      if(groundCheck&&!groundCheck.valid)fail(groundCheck.reason||'目标高度未通过地形校验');
    }
    if(t.altitudeM!==null){route.altitude=t.altitudeM;if(t.action==='set_flight')for(const p of route.points)p[2]=t.altitudeM;}
    if(t.action==='fly_to'){
      if(!t.append)route.points=[];
      route.points.push([t.eastM,t.northM,t.altitudeM??route.altitude]);
    }
    if(['orbit','clear_waypoints'].includes(t.action))route.points=[];
    if(t.action==='fly_heading'){
      const headingPlan=planHeadingRoute(world,unit,t.headingDeg,t.altitudeM??route.altitude,t.distanceM);
      headingPlans.set(index,headingPlan);route.points=headingPlan.points;
    }
    if(t.action==='orbit'&&t.eastM!==null){
      const orbitCheck=world.checkRoute?.(t.unitId,[[t.eastM,t.northM,route.altitude]]);
      if(orbitCheck&&!orbitCheck.valid)fail(orbitCheck.reason||'盘旋中心未通过地形校验');
    }
    const check=world.checkRoute?.(t.unitId,route.points);
    if(check&&!check.valid)fail(check.reason||'指令航路未通过地形校验');
    const flightCheck=world.planRoute?.(t.unitId,route.points,route.speed,{resetPower:true});
    if(flightCheck&&!flightCheck.valid)fail(flightCheck.reason||'指令航路无法安全飞行');
    if(flightCheck)flightPlans.set(t.unitId,flightCheck);
  }
  const affected=new Set(plan.tasks.filter(t=>t.unitId&&!['report_status','airport','assign_role','radar','sensor_task','attack_task','weapon','defense'].includes(t.action)).map(t=>t.unitId));
  const previews=[...routes].filter(([id,r])=>affected.has(id)&&r.points.length).map(([unitId,r])=>({unitId,points:r.points.map(p=>[...p]),flightPoints:flightPlans.get(unitId)?.points||[]}));
  return {world,plan,expectedRevision,radioStyle,headingPlans,flightPlans,departurePlans,previews,status:'prepared',committed:false};
}

export function commitPilotPlan(draft){
  const {world,plan,expectedRevision,radioStyle,headingPlans}=draft;
  if(draft.status!=='prepared'||draft.committed)fail('该飞行员任务尚未规划完成或已经执行');
  validatePlan(plan,world.units);
  if(world.revision!==expectedRevision)fail('规划期间收到新指令，旧航路已作废');
  const revisionBefore=world.revision;
  const missilesBefore=world.missiles?.length,missileSequenceBefore=world.missileSequence,weaponEventsBefore=world.weaponEvents?.length;
  const leasesBefore=world.airportOps?structuredClone(world.airportOps.leases):null,cooldownBefore=world.airportOps?structuredClone(world.airportOps.cooldown):null,eventsBefore=world.airportOps?.airport.events.length;
  const atcBefore=world.airportOps?structuredClone(world.airportOps.airport.atc):null,airportSequenceBefore=world.airportOps?.eventSequence;
  const saved=world.units.map(unit=>({unit,state:{...unit,attackTask:unit.attackTask?structuredClone(unit.attackTask):unit.attackTask,radarTask:unit.radarTask?structuredClone(unit.radarTask):unit.radarTask,weapons:unit.weapons?structuredClone(unit.weapons):unit.weapons,radar:unit.radar?structuredClone(unit.radar):unit.radar,routeLoop:unit.routeLoop?structuredClone(unit.routeLoop):unit.routeLoop,surface:unit.surface?structuredClone(unit.surface):unit.surface,waypoints:unit.waypoints.map(w=>Object.assign(w.slice(),w)),headingRoute:unit.headingRoute?{...unit.headingRoute}:unit.headingRoute}}));
  let simulation=null;
  for(const {unit,state}of saved){state.rwr=unit.rwr?structuredClone(unit.rwr):unit.rwr;state.rwrDefense=unit.rwrDefense?structuredClone(unit.rwrDefense):unit.rwrDefense;}
  try{
  for(const id of new Set(plan.tasks.filter(t=>t.unitId&&['fly_to','fly_heading','orbit','clear_waypoints','airport',...FORMATION_ACTIONS].includes(t.action)).map(t=>t.unitId)))cancelAttackTask(world,world.units.find(u=>u.id===id));
  for(const id of new Set(plan.tasks.filter(t=>t.unitId&&!['report_status','defense'].includes(t.action)).map(t=>t.unitId)))notePlayerDefenseOrder(world,world.units.find(u=>u.id===id));
  const roleLead=plan.tasks.find(t=>t.action==='assign_role'&&t.role==='lead');
  if(roleLead){for(const t of plan.tasks.filter(t=>t.action==='assign_role'))leaveFormation(world.units.find(u=>u.id===t.unitId),'长僚机重新分工');bindFlightRoles(world,roleLead.unitId,roleLead.targetId);}
  for(const [index,t] of plan.tasks.entries()) {
    if(t.action==='defense'){applyDefenseTask(world,world.units.find(u=>u.id===t.unitId),t.defenseOrder);continue;}
    if(t.action==='attack_task'){installAttackTask(world,world.units.find(u=>u.id===t.unitId),t.attackOrder);continue;}
    if(t.action==='sensor_task'){installRadarTask(world,world.units.find(u=>u.id===t.unitId),t.sensorTask);continue;}
    if(t.action==='weapon'){applyWeaponOrder(world,world.units.find(u=>u.id===t.unitId),t.weaponOrder);continue;}
    if(t.action==='radar'){applyRadarOrder(world,world.units.find(u=>u.id===t.unitId),t.radarOrder);continue;}
    if(t.action==='assign_role')continue;
    if(t.action==='airport'){const u=world.units.find(u=>u.id===t.unitId),departure=needsDeparturePlan(t.airportOrder)?verifyDeparturePlan(world,u,t.airportOrder,draft.departurePlans?.get(t.unitId)):null;leaveFormation(u);world.airportOps.apply(u,t.airportOrder,world,departure);continue;}
    if(t.action==='report_status')continue;
    if(t.action==='pause'||t.action==='resume'){simulation=t.action;continue;}
    const u=world.units.find(u=>u.id===t.unitId);
    if(FORMATION_ACTIONS.includes(t.action)){installFormation(world,u,t);continue;}
    leaveFormation(u,'独立飞行任务已接管，退出编队');
    u.departurePowerPlan=null;
    if(t.altitudeM!==null){u.targetAltitude=t.altitudeM;u.holdAltitude=t.altitudeM;if(t.action==='set_flight'){for(const w of u.waypoints)w[2]=t.altitudeM;if(u.routeLoop)for(const p of u.routeLoop.points)p[2]=t.altitudeM;if(u.headingRoute)u.headingRoute.targetAltitudeM=t.altitudeM;}}
    if(t.speedMps!==null)u.targetSpeed=t.speedMps;
    if(t.action==='fly_to')world.command(u.id,[t.eastM,t.northM,t.altitudeM??u.targetAltitude],t.append);
    if(t.action==='fly_heading'){
      const headingPlan=headingPlans.get(index);
      headingPlan.points.forEach((p,i)=>world.command(u.id,p,i>0));
      u.headingRoute={headingDeg:headingPlan.headingDeg,targetAltitudeM:headingPlan.targetAltitudeM,continuous:headingPlan.continuous,blockedReason:null};
      u.holdAltitude=headingPlan.targetAltitudeM;
    }
    if(t.action==='orbit'||t.action==='clear_waypoints'){
      u.waypoints=[];u.routeLoop=null;u.headingTarget=null;u.headingRoute=null;u.orbit=[t.eastM??u.position[0],t.northM??u.position[1]];u.holdAltitude=u.targetAltitude;
    }
  }
  if(plan.tasks.some(t=>t.action!=='report_status'))world.revision++;
  for(const id of new Set(plan.tasks.filter(t=>t.unitId&&!['report_status','radar','sensor_task','attack_task','weapon','defense','assign_role','pause','resume'].includes(t.action)).map(t=>t.unitId)))beginPilotExecution(world,world.units.find(u=>u.id===id));
  draft.committed=true;
  return {summary:radioReadback(plan,world.units,radioStyle,world.unitSystem),simulation};
  }catch(error){
    // 下层飞行可行性检查也可能拒绝任务；回滚整批，保留原有单位对象引用。
    for(const {unit,state}of saved){for(const key of Object.keys(unit))if(!Object.hasOwn(state,key))delete unit[key];Object.assign(unit,state);}
    if(world.airportOps){world.airportOps.leases=leasesBefore;world.airportOps.cooldown=cooldownBefore;world.airportOps.airport.events.length=eventsBefore;world.airportOps.airport.atc=atcBefore;world.airportOps.eventSequence=airportSequenceBefore;}
    if(world.missiles)world.missiles.length=missilesBefore;if(world.weaponEvents)world.weaponEvents.length=weaponEventsBefore;world.missileSequence=missileSequenceBefore;
    world.revision=revisionBefore;throw error;
  }
}

// 兼容已有调用；玩家通联界面分别调用准备与提交，展示飞行员规划阶段。
export function applyPlan(world,plan,expectedRevision,options={}){
  const draft=preparePilotPlan(world,plan,expectedRevision,options);
  return draft.status==='prepared'?commitPilotPlan(draft):{summary:plan.summary,simulation:null};
}
