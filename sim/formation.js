import {clamp} from './flight.js';
import {energyEnvelope} from './energy.js';
import {doctrineLabel,FORMATIONS} from './formation-doctrine.js';
import {formatDistance,formatAltitude} from './units.js';
export const FORMATION_ACTIONS=Object.freeze(['join_formation','follow_unit','formation_change','cover','escort']);
export const PROTECTION_MODES=Object.freeze({cover:{label:'掩护',shape:'fighting_wing',heightM:300,rangeM:1500},escort:{label:'护航',shape:'echelon',heightM:150,rangeM:1200}});
export const FORMATION_LIMITS=Object.freeze({rangeM:[400,5000],defaultRangeM:1200,minSeparationM:250});
export const DUAL_FORMATIONS=Object.freeze(FORMATIONS.filter(f=>f.minUnits===2).map(f=>f.id));
const delta=(a,b)=>a.map((v,k)=>v-b[k]);
const heading=u=>u.velocity?Math.atan2(u.velocity[0],u.velocity[1]):u.headingDeg*Math.PI/180;
const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
export function formationOffset(shape,side,spacing){
  const s=side==='left'?-1:1;
  if(shape==='trail')return [-spacing,0];
  if(['line_abreast','combat_spread'].includes(shape))return [0,s*spacing];
  const aft=shape==='wedge'?.8:shape==='fighting_wing'?.9:Math.SQRT1_2;
  return [-aft*spacing,s*Math.sqrt(1-aft*aft)*spacing];
}
export function formationTask(order,context){
  const p=order.parameters,ids=order.unitIds;let lead=p.targetId;
  if(!lead&&p.targetRef){
    const key=p.targetRef.trim().toLowerCase(),matches=context.units.filter(u=>[u.id,u.callsign,...(u.aliases??[])].some(v=>v.toLowerCase()===key));
    if(matches.length===1)lead=matches[0].id;
  }
  if(order.intent==='formation_change'&&!lead){
    const current=ids.map(id=>context.units.find(u=>u.id===id)?.formation?.leaderId).filter(Boolean);
    lead=current.find(id=>ids.includes(id))??(ids.length===1?current[0]:null)??(ids.includes(context.selectedUnitId)?context.selectedUnitId:ids[0]);
  }
  if(!lead)throw Error(PROTECTION_MODES[order.intent]?'请明确当前场景中已存在的受保护友机':'请明确集合或跟随的友机');
  const members=[...new Set([...ids,lead])];if(members.length!==2)throw Error('当前仅支持一个长机和一个僚机的双机编队');
  const follower=members.find(id=>id!==lead),existing=context.units.find(u=>u.id===follower)?.formation;
  if(['cover','escort'].includes(order.intent)&&ids.length!==1)throw Error('掩护和护航必须明确一架受令机及另一架受保护友机');
  const mode=PROTECTION_MODES[order.intent];
  const shape=p.formation??mode?.shape??(order.intent==='follow_unit'?'trail':order.intent==='formation_change'?null:existing?.shape??'echelon');
  if(!DUAL_FORMATIONS.includes(shape))throw Error('请指定已接入的双机队形（梯队、纵队、横队、战斗疏开、楔形或战斗翼队）');
  return {unitId:follower,action:order.intent,altitudeM:null,speedMps:null,headingDeg:null,eastM:null,northM:null,distanceM:null,append:false,
    targetId:lead,formation:shape,side:p.side??existing?.side??'right',rangeM:p.rangeM??(mode?mode.rangeM:existing?.rangeM)??FORMATION_LIMITS.defaultRangeM};
}
export function bindFlightRoles(world,leaderId,wingmanId){
  const lead=world.units.find(u=>u.id===leaderId),wing=world.units.find(u=>u.id===wingmanId);
  lead.flightRole={role:'lead',partnerId:wingmanId};wing.flightRole={role:'wingman',partnerId:leaderId};
}
export function roleTasks(orders,context){
  const assignments=orders.filter(o=>o.intent==='assign_role');if(!assignments.length)return [];
  const alive=context.units.filter(u=>u.alive!==false);
  if(alive.length!==2)throw Error('当前长僚机分工需要恰好两架存活的友机');
  const wanted=new Map();
  for(const o of assignments){
    if(o.unitIds.length!==1||!['lead','wingman'].includes(o.parameters.role))throw Error('请分别指定一架长机和一架僚机');
    const id=o.unitIds[0],role=o.parameters.role;
    if(wanted.has(id)&&wanted.get(id)!==role)throw Error('同一架飞机的长僚机角色互相冲突');wanted.set(id,role);
    const other=alive.find(u=>u.id!==id);if(!other)throw Error('角色对象无效');
    if(o.parameters.targetId&&o.parameters.targetId!==other.id)throw Error('长僚机搭档必须是另一架友机');
    if(o.parameters.targetRef&&![other.id,other.callsign,...(other.aliases??[])].some(v=>v.toLowerCase()===o.parameters.targetRef.trim().toLowerCase()))throw Error('长僚机搭档不在当前友机中');
  }
  if(wanted.size===1){const [id,role]=[...wanted][0];wanted.set(alive.find(u=>u.id!==id).id,role==='lead'?'wingman':'lead');}
  if(new Set(wanted.values()).size!==2)throw Error('双机分工必须是一架长机、一架僚机');
  return alive.map(u=>({unitId:u.id,action:'assign_role',targetId:alive.find(v=>v.id!==u.id).id,role:wanted.get(u.id)}));
}
export function validateRoleTasks(tasks,units){
  const roles=tasks.filter(t=>t.action==='assign_role');if(!roles.length)return;
  if(roles.length!==2||roles[0].unitId===roles[1].unitId||new Set(roles.map(t=>t.role)).size!==2||roles.some(t=>!['lead','wingman'].includes(t.role)))throw Error('长僚机角色必须成对、互补且不重复');
  for(const t of roles){const u=units.find(u=>u.id===t.unitId),peer=units.find(u=>u.id===t.targetId);
    if(!u||!peer||u.id===peer.id||u.alive===false||peer.alive===false||u.grounded||peer.grounded||u.surface?.grounded||peer.surface?.grounded||(u.team??u.faction??'blue')!==(peer.team??peer.faction??'blue')||!roles.some(v=>v.unitId===t.targetId&&v.targetId===t.unitId))throw Error('长僚机必须是互为搭档的两架空中友机');
  }
  const lead=roles.find(t=>t.role==='lead').unitId,wing=roles.find(t=>t.role==='wingman').unitId;
  for(const t of tasks.filter(t=>FORMATION_ACTIONS.includes(t.action)))if(t.targetId!==lead||t.unitId!==wing)throw Error('编队/保护对象与本次长僚机分工冲突');
}
export function validateFormationTasks(tasks,units){
  validateRoleTasks(tasks,units);
  const reassigned=new Set(tasks.filter(t=>t.action==='assign_role').map(t=>t.unitId));
  const graph=new Map(units.filter(u=>u.alive!==false&&u.formation&&!reassigned.has(u.id)).map(u=>[u.id,u.formation.leaderId]));
  for(const t of tasks.filter(t=>FORMATION_ACTIONS.includes(t.action)))if(tasks.filter(v=>v.unitId===t.unitId&&!['report_status','assign_role'].includes(v.action)).length>1)throw Error('同一僚机的编队与独立控制任务请分批下达');
  for(const t of tasks){
    if(['report_status','pause','resume','assign_role'].includes(t.action))continue;
    graph.delete(t.unitId);if(!FORMATION_ACTIONS.includes(t.action))continue;
    const leader=units.find(u=>u.id===t.targetId),follower=units.find(u=>u.id===t.unitId);
    if(!leader||leader.alive===false||leader.id===follower?.id||leader.grounded||follower?.grounded||leader.surface?.grounded||follower?.surface?.grounded||leader.surfacePhase==='final'||follower?.surfacePhase==='final'||leader.surface?.phase==='final'||follower?.surface?.phase==='final')throw Error('编队须由两架不同且存活、不在最后进近的空中友机组成');
    if(!DUAL_FORMATIONS.includes(t.formation)||!['left','right'].includes(t.side)||!Number.isFinite(t.rangeM)||t.rangeM<400||t.rangeM>5000)throw Error(`双机队形、左右侧或间隔无效；间隔须为${formatDistance(400,{digits:2})}–${formatDistance(5000,{digits:2})}`);
    if((leader.team??leader.faction??'blue')!==(follower.team??follower.faction??'blue'))throw Error('不能加入敌方编队');
    graph.set(t.unitId,t.targetId);
  }
  for(const lead of graph.values()){
    if(graph.has(lead))throw Error('双机编队不能相互跟随或让僚机再带僚机');
    if([...graph.values()].filter(v=>v===lead).length>1)throw Error('当前一个长机只能带一架僚机');
  }
}
export function leaveFormation(u,reason='已退出编队'){
  if(!u.formation)return;
  u.formation=null;u.formationGuidance=null;u.protectionWatch=null;u.navigationBlocked=null;u.safetyOrbit=null;u.navigationMessage=reason;
}
export function installFormation(world,u,t){
  const leader=world.units.find(v=>v.id===t.targetId),h=heading(leader),d=delta(u.position,leader.position);
  const along=d[0]*Math.sin(h)+d[1]*Math.cos(h),lateral=d[0]*Math.cos(h)-d[1]*Math.sin(h);
  const side=formationOffset(t.formation,t.side,t.rangeM)[1],clear=Math.max(800,t.rangeM*.75);
  const crossing=lateral*side<0&&Math.abs(lateral)>250&&Math.abs(side)>250&&along>-clear;
  u.waypoints=[];u.navLegs=[];u.headingRoute=null;u.headingTarget=null;u.navigationPending=false;u.navigationBlocked=null;u.safetyOrbit=null;
  u.routeRevision=(u.routeRevision??0)+1;
  const intent=t.action==='formation_change'&&u.formation?.leaderId===t.targetId&&PROTECTION_MODES[u.formation.intent]?u.formation.intent:t.action;
  bindFlightRoles(world,t.targetId,u.id);u.protectionWatch=null;
  u.formation={leaderId:t.targetId,shape:t.formation,side:t.side,rangeM:t.rangeM,intent,heightOffsetM:Math.min(PROTECTION_MODES[intent]?.heightM??0,Math.max(0,15000-leader.position[2])),status:'joining',settled:0,
    stage:crossing?'astern':null,crossLateral:lateral,slotErrorM:null};
  u.formationGuidance=null;u.navigationMessage=`正在集合：${leader.callsign} · ${doctrineLabel(FORMATIONS,t.formation)} · ${formatDistance(t.rangeM,{digits:2})}`;
}
export function formationStatus(u,units){
  const f=u.formation;if(!f)return null;
  const lead=units.find(v=>v.id===f.leaderId),phase={joining:'集合中',holding:'保持编队',transition:'换位中',blocked:'编队暂缓',avoiding:'避让长机'}[f.status]??'编队';
  const duty=PROTECTION_MODES[f.intent]?.label;
  return `${duty?`${duty} · `:''}${phase} · ${lead?.callsign??f.leaderId} · ${doctrineLabel(FORMATIONS,f.shape)} · ${formatDistance(f.rangeM,{digits:2})}${duty?` · 高差+${formatAltitude(f.heightOffsetM??PROTECTION_MODES[f.intent].heightM)}`:''}${f.slotErrorM===null?'':` · 位置偏差${formatDistance(f.slotErrorM,{digits:2})}`}${u.protectionWatch?.contactId?' · 收到威胁通报':''}`;
}
// Moving station guidance corrects a leader-velocity feed-forward term. Pilot/Flight
// remain the only continuous controllers; positions and velocities are never set here.
export function updateFormation(world,u,dt=.1){
  const f=u.formation;if(!f||!u.alive)return;
  if(u.surface?.grounded||u.surface?.phase==='final'){leaveFormation(u,'机场飞行阶段接管，已退出编队');return;}
  const lead=world.units.find(v=>v.id===f.leaderId);
  if(!lead?.alive||lead.formation||lead.surface?.grounded||lead.surface?.phase==='final'){
    leaveFormation(u,'长机失效，已退出编队并安全待命');u.holdAltitude=u.position[2];
    const h=heading(u);u.orbit=[u.position[0]+Math.cos(h)*4000,u.position[1]-Math.sin(h)*4000];return;
  }
  const h=heading(lead),forward=[Math.sin(h),Math.cos(h)],right=[Math.cos(h),-Math.sin(h)],relative=delta(u.position,lead.position);
  const along=relative[0]*forward[0]+relative[1]*forward[1],lateral=relative[0]*right[0]+relative[1]*right[1];
  let [aft,side]=formationOffset(f.shape,f.side,f.rangeM);const clear=Math.max(800,f.rangeM*.75);
  if(f.stage==='astern'){if(along<-clear*.85)f.stage='cross';else{aft=-clear;side=f.crossLateral;}}
  if(f.stage==='cross'){aft=-clear;if(Math.abs(lateral-side)<Math.max(100,f.rangeM*.12)&&along<-clear*.65)f.stage=null;}
  const duty=PROTECTION_MODES[f.intent];
  if(duty){
    const threat=[...(u.pilotContacts??[]),...(lead.pilotContacts??[])].find(c=>c&&typeof c.id==='string'&&typeof c.source==='string'&&c.source&&c.classification==='hostile'&&c.threat===true&&Number.isFinite(c.observedAt)&&world.time>=c.observedAt&&world.time-c.observedAt<=5);
    u.protectionWatch={task:f.intent,protectedId:lead.id,sector:f.intent==='cover'?'rear':'perimeter',contactId:threat?.id??null,source:threat?.source??null,observedAt:threat?.observedAt??null};
  }else u.protectionWatch=null;
  const station=[lead.position[0]+forward[0]*aft+right[0]*side,lead.position[1]+forward[1]*aft+right[1]*side,Math.min(15000,lead.position[2]+(duty?.heightM??0))];
  f.heightOffsetM=station[2]-lead.position[2];
  const error=delta(station,u.position),distance=Math.hypot(...error),omega=clamp(lead.formationTurnRate??0,-.12,.12);
  const stationV=[lead.velocity[0]+omega*(right[0]*aft-forward[0]*side),lead.velocity[1]+omega*(right[1]*aft-forward[1]*side),lead.velocity[2]];
  const tau=clamp(distance/Math.max(40,lead.speed*.4),25,60);
  const v=stationV.map((x,k)=>x+clamp(error[k]/(k===2?18:tau),k===2?-35:-90,k===2?35:90));
  const rv=delta(u.velocity,lead.velocity),vv=rv.reduce((s,x)=>s+x*x,0),cpa=clamp(-relative.reduce((s,x,k)=>s+x*rv[k],0)/Math.max(1,vv),0,10);
  const threat=Math.hypot(...relative.map((x,k)=>x+rv[k]*cpa))<FORMATION_LIMITS.minSeparationM;
  if(threat){const sign=lateral>=0?1:-1;v[0]+=right[0]*sign*70;v[1]+=right[1]*sign*70;v[2]=Math.max(v[2],20);}
  const horizontal=Math.max(1,Math.hypot(v[0],v[1])),envelope=energyEnvelope(u.profile,u.position[2],Math.max(50,u.speed));
  const speed=clamp(Math.hypot(...v),Math.max(400/3.6,envelope.safeSpeed(1)*1.12),Math.min(2400/3.6,Math.max(lead.speed+90,200)));
  const gamma=clamp(Math.atan2(v[2],horizontal),-.22,.22),desired=[v[0]/horizontal*Math.cos(gamma),v[1]/horizontal*Math.cos(gamma),Math.sin(gamma)];
  // The pursuit controller needs a heading lead to generate the station's angular
  // acceleration. Without it, a steady orbit leaves a persistent inside-turn error.
  const anticipate=omega*2,x=desired[0],y=desired[1];desired[0]=x*Math.cos(anticipate)+y*Math.sin(anticipate);desired[1]=y*Math.cos(anticipate)-x*Math.sin(anticipate);
  const terrain=world.terrain;let blocked=null;
  if(terrain){
    const slot=terrain.checkPoint?.(station,300);if(slot&&!slot.valid)blocked=slot.reason;
    for(let t=0;!blocked&&t<=12;t+=2){const point=u.position.map((x,k)=>x+desired[k]*speed*t),ground=terrain.heightAt?.(point[0],point[1]);
      if(ground===null)blocked='编队引导超出地形范围';else if(ground!==undefined&&point[2]-ground<300)blocked='编队引导前方地形净空不足';}
  }
  if(blocked){
    f.status='blocked';f.settled=0;f.slotErrorM=distance;u.formationGuidance=null;u.navigationBlocked=blocked;
    u.safetyOrbit??=[u.position[0]+right[0]*4000,u.position[1]+right[1]*4000];
    u.safetyAltitude=Math.max(u.position[2],(terrain?.heightAt?.(u.position[0],u.position[1])??0)+800);u.navigationMessage='编队暂缓：'+blocked;return;
  }
  u.navigationBlocked=null;u.safetyOrbit=null;
  f.settled=u.flightState==='normal'&&distance<Math.max(90,f.rangeM*.12)&&Math.abs(wrap(heading(u)-Math.atan2(stationV[0],stationV[1])))<.15&&Math.abs(u.speed-Math.hypot(...stationV))<12&&!threat&&!f.stage?f.settled+dt:0;
  f.status=threat?'avoiding':f.stage?'transition':f.settled>=3?'holding':'joining';f.slotErrorM=distance;
  u.formationGuidance={desired,speedMps:speed,altitudeM:station[2],station,distance:Math.max(u.speed*4,400)};u.navigationMessage=formationStatus(u,world.units);
}
