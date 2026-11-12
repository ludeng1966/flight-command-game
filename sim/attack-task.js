import {trackUsable,radarTarget} from './radar-quality.js';
import {radarContext,applyRadarOrder,validateRadarOrder,recordRadarEvent} from './radar.js';
import {directOwnsFlight} from './tactical-guidance.js';
import {MISSILE_MODELS} from './missiles.js';
import {weaponsContext,launchAssessment,applyWeaponOrder,validateWeaponOrder,engagementPermission} from './weapons.js';
import {observedContact} from './battle-observation.js';
import {estimateShotQuality} from './shot-quality.js';
import {captureOwnMissileFlights} from './missile-assessment.js';
import {navigationEnvelope} from './energy.js';
import {parseEngagementIntent,engagementContact,cooperativeReleaseGate} from './engagement-intent.js';
import {createSearchState,updateSearchState,parseSearchState,searchAssessment,noteSearchManeuver,noteSearchWait} from './search-assessment.js';

import {ATTACK_ORDER_KEYS} from './attack-contract.js';
export {ATTACK_ORDER_KEYS} from './attack-contract.js';
const clean=s=>String(s??'').replace(/[^a-z0-9\u3400-\u9fff]/gi,'').toLowerCase();
const nullable=(s,max)=>s===null||typeof s==='string'&&s.length>0&&s.length<=max;
export function validateAttackOrder(t){
  if(!t||Object.keys(t).length!==ATTACK_ORDER_KEYS.length||!ATTACK_ORDER_KEYS.every(k=>Object.hasOwn(t,k))||!nullable(t.targetId,64)||!nullable(t.targetRef,160)||!nullable(t.weaponRef,160)||
    !Number.isInteger(t.shotLimit)||t.shotLimit<1||t.shotLimit>4||!(t.altitudeM===null||Number.isFinite(t.altitudeM)&&t.altitudeM>=500&&t.altitudeM<=15000)||
    !(t.speedMps===null||Number.isFinite(t.speedMps)&&t.speedMps>=400/3.6&&t.speedMps<=2400/3.6)||!(t.headingDeg===null||Number.isFinite(t.headingDeg)&&t.headingDeg>=0&&t.headingDeg<=360))throw Error('攻击任务参数无效');return t;
}
export function allowedAttackModels(unit,task){
  return Object.entries(unit.weapons?.inventory??{}).filter(([id,n])=>n>0&&(!task.weaponRef||[id,id.replace(/^(us|cn|su)_/,''),MISSILE_MODELS.get(id)?.familyName].some(s=>clean(s)===clean(task.weaponRef))||
    ['红外导弹','infrared'].includes(task.weaponRef)&&MISSILE_MODELS.get(id)?.kind==='infrared'||['雷达导弹','雷达制导导弹'].includes(task.weaponRef)&&MISSILE_MODELS.get(id)?.kind!=='infrared')).map(([id])=>id);
}
export function validateAttackAssignment(world,unit,order){
  validateAttackOrder(order);if(!unit?.alive||!unit.weapons||!allowedAttackModels(unit,order).length)throw Error('本机没有可用或符合任务要求的导弹');
  const known=world.units.find(u=>u.id===order.targetId);if(known&&(known.team??known.faction??'blue')===(unit.team??unit.faction??'blue'))throw Error('指定对象是友机，不能接受攻击任务');
}
function log(world,unit,type,text,extra={}){const t=unit.attackTask;if(!t)return;const e={sequence:++t.eventSequence,time:world.time,type,text,...extra};t.events.push(e);if(t.events.length>32)t.events.shift();recordRadarEvent(unit.radar,world.time,text,'attack_'+type);}
export function installAttackTask(world,unit,order){
  validateAttackAssignment(world,unit,order);if(unit.radarTask)unit.radarTask.active=false;
  const sequence=unit.attackTaskSequence=(unit.attackTaskSequence??0)+1;
  unit.attackTask={...order,id:`${unit.id}-attack-${sequence}`,active:true,status:'searching',issuedAt:world.time,decisionCount:0,retryCount:0,lastDecisionAt:null,
    lastSignature:null,lastError:null,pending:false,engagedTargetId:order.targetId,selectedModelId:null,engagement:null,searchHeadingDeg:(Math.atan2(unit.velocity[0],unit.velocity[1])*180/Math.PI+360)%360,searchLegEstablished:false,firedMissileIds:[],flightResults:{},lastDecision:null,eventSequence:0,events:[]};
  unit.attackTask.searchState=createSearchState(world.time);
  log(world,unit,'assigned','攻击任务已接收，自主搜索目标、准备武器并判断发射时机');
}
export function attackTaskContext(unit){
  const t=unit.attackTask;if(!t)return null;
  const keys=[...ATTACK_ORDER_KEYS,'id','active','status','issuedAt','decisionCount','retryCount','lastDecisionAt','lastSignature','lastError','engagedTargetId','selectedModelId','engagement','searchHeadingDeg','searchLegEstablished','firedMissileIds','flightResults'];
  return structuredClone({...Object.fromEntries(keys.map(k=>[k,t[k]])),searchState:t.searchState??null,lastOperation:t.lastDecision?.operation??t.lastOperation??null});
}
export function cancelAttackTask(world,unit){
  if(world.autonomousCommand||!unit?.attackTask?.active)return;
  unit.attackTask.active=false;unit.attackTask.status='cancelled';unit.attackTask.pending=false;
  log(world,unit,'cancelled','收到玩家新的飞行任务，停止自主攻击；已在空导弹继续按实际状态飞行');
}
export function recordAttackRejection(world,unit,error,operation=null){
  const t=unit.attackTask;if(!t?.active)return;
  const reason=String(error?.message??error).slice(0,300);t.lastError=reason;t.retryCount++;t.lastDecisionAt=world.time;
  const text=(operation==='launch'?'发射决定未执行，未扣弹：':'攻击判断未执行：')+reason;
  if(t.events.at(-1)?.type!=='rejected'||t.events.at(-1)?.text!==text||world.time-t.events.at(-1).time>=8)log(world,unit,'rejected',text,{decisionCount:t.decisionCount,operation});
}
export function parseAttackTaskContext(t,time){
  if(t==null)return null;validateAttackOrder(Object.fromEntries(ATTACK_ORDER_KEYS.map(k=>[k,t[k]])));
  if(t.lastOperation!=null&&!['radar_mode','radar_lock','radar_unlock','select','engage','launch','maneuver','wait','abort'].includes(t.lastOperation))throw Error('攻击任务上一步操作无效');
  if(typeof t.id!=='string'||t.id.length>100||!t.id||typeof t.active!=='boolean'||!['searching','preparing','engaging','supporting','completed','aborted','exhausted','cancelled'].includes(t.status)||!Number.isFinite(t.issuedAt)||t.issuedAt<0||t.issuedAt>time+.001||
    !['decisionCount','retryCount'].every(k=>Number.isSafeInteger(t[k])&&t[k]>=0)||!(t.lastDecisionAt===null||Number.isFinite(t.lastDecisionAt)&&t.lastDecisionAt>=0&&t.lastDecisionAt<=time+.001)||
    !(t.lastSignature===null||typeof t.lastSignature==='string'&&t.lastSignature.length<=12000)||!(t.lastError===null||typeof t.lastError==='string'&&t.lastError.length<=300)||!nullable(t.engagedTargetId,64)||
    !(t.selectedModelId==null||MISSILE_MODELS.has(t.selectedModelId))||!(t.searchHeadingDeg===undefined||Number.isFinite(t.searchHeadingDeg)&&t.searchHeadingDeg>=0&&t.searchHeadingDeg<=360)||!(t.searchLegEstablished===undefined||typeof t.searchLegEstablished==='boolean')||!Array.isArray(t.firedMissileIds)||t.firedMissileIds.length>t.shotLimit||new Set(t.firedMissileIds).size!==t.firedMissileIds.length||t.firedMissileIds.some(id=>!/^missile-\d+$/.test(id))||!t.flightResults||typeof t.flightResults!=='object'||Array.isArray(t.flightResults)||Object.keys(t.flightResults).some(id=>!t.firedMissileIds.includes(id)))throw Error('攻击任务状态无效');
  return {...structuredClone(t),engagement:parseEngagementIntent(t.engagement,time),searchState:parseSearchState(t.searchState,time)};
}
export function attackContacts(unit,time){
  const latest=new Map();
  for(const contact of [...(unit.radar?.contacts??[]),...(unit.weapons?.contacts??[])]){
    if(!Number.isFinite(contact.observedAt)||contact.observedAt>time||!trackUsable(contact,time))continue;
    if(!latest.has(contact.id)||contact.observedAt>latest.get(contact.id).observedAt)latest.set(contact.id,contact);
  }
  return [...latest.values()].map(c=>{const {history,...sample}=c;return observedContact({...sample,position:[...c.position],velocity:[...c.velocity]},time);});
}
function selectAttackWeapon(world,unit,modelId,targetId){
  const select={operation:'select',modelId,targetId:null,quantity:null},designate={operation:'designate',modelId:null,targetId,quantity:null};
  validateWeaponOrder(world,unit,select);validateWeaponOrder(world,unit,designate);
  if(unit.weapons.selectedModelId!==modelId)applyWeaponOrder(world,unit,select,{autonomous:true});
  if(unit.weapons.targetId!==targetId)applyWeaponOrder(world,unit,designate,{autonomous:true});
  unit.attackTask.selectedModelId=modelId;
}
// A model authorizes one bounded release intent; the simulator continuously
// evaluates its conditions. No model call or cached ready flag in this loop.
export function stepEngagementIntents(world){
  for(const unit of world.units){const t=unit.attackTask,e=t?.engagement;if(!t?.active||!e||!unit.alive)continue;
    if(e.launchedAt!==null){e.nextCheckAt=world.time+.05;const flights=world.missiles.filter(m=>t.firedMissileIds.includes(m.id)&&m.alive);
      e.phase=flights.some(m=>{const kind=MISSILE_MODELS.get(m.modelId)?.kind;return kind==='semi_active_radar'||kind==='active_radar'&&!m.active;})?'supporting':'released';continue;}
    if(world.time>=e.expiresAt){if(e.phase!=='expired'){e.phase='expired';e.lastReason='持续接战意图到期，等待模型复核';log(world,unit,'intent_expired',e.lastReason);}continue;}
    if(world.time+1e-8<e.nextCheckAt)continue;e.nextCheckAt=world.time+.05;
    const hold=(phase,reason)=>{e.phase=phase;e.lastReason=reason;};
    if(directOwnsFlight(unit)||unit.rwrDefense?.active||unit.surface?.grounded||unit.flightState&&unit.flightState!=='normal'){hold('defending','飞行接管、规避或改出中，暂缓持续接战');continue;}
    const c=engagementContact(unit,world.time);if(!c){hold('waiting','等待本机新鲜目标观测，不按旧火控发射');continue;}
    const permission=engagementPermission(unit,c,{authorization:'attack'});if(!permission.allowed){hold('blocked',permission.reason);continue;}
    try{
      selectAttackWeapon(world,unit,e.modelId,e.targetId);
      const model=MISSILE_MODELS.get(e.modelId),r=unit.radar;
      if(model.kind!=='infrared'){
        if(r.mode==='off'){applyRadarOrder(world,unit,{operation:'mode',mode:'pd',targetId:null},{autonomous:true});hold('acquiring','已开启本机搜索，等待可截获航迹');continue;}
        if(r.targetId!==e.targetId){
          if(!(r.contacts??[]).some(k=>k.id===e.targetId&&trackUsable(k,world.time))){hold('acquiring','等待本机雷达重探测');continue;}
          const order={operation:'lock',mode:null,targetId:e.targetId};validateRadarOrder(world,unit,order);applyRadarOrder(world,unit,order,{autonomous:true});
          log(world,unit,'intent_acquire','持续接战按本机观测请求截获');hold('acquiring','等待实际火控航迹');continue;
        }
      }
      const a=launchAssessment(world,unit,e.modelId,e.targetId);
      if(!a.ready){hold('aligning',a.reason);continue;}
      e.firstReadyAt??=world.time;
      const gate=cooperativeReleaseGate(unit,world.time);if(!gate.allowed){hold('waiting',gate.reason);continue;}
      const quality=estimateShotQuality(unit,c,model,world.time,world.terrain);
      if(['blocked','poor'].includes(quality.rating??quality.level)){hold('aligning','当前射击条件不佳，继续改善几何');continue;}
      const d={operation:'launch',mode:null,modelId:e.modelId,targetId:e.targetId,quantity:e.quantity,headingDeg:null,altitudeM:null,speedMps:null,message:'拟按持续接战意图与当前实测条件发射'};
      // Refresh mechanical readiness after selection; validation checks the
      // current world again, including roles, ROE, inventory and shot limit.
      unit.weapons.ready=a.ready;
      applyAttackDecision(world,unit,d,t.id,t.decisionCount);
      e.launchedAt=world.time;e.phase='supporting';e.lastReason=null;
      log(world,unit,'intent_release','实时发射条件成立，持续意图已执行',{readyAt:e.firstReadyAt,releaseDelaySec:world.time-e.firstReadyAt});
    }catch(error){hold('blocked',String(error.message??error).slice(0,300));}
  }
}
function observedTarget(unit,time,id){return attackContacts(unit,time).find(c=>c.id===id);}
export function monitorAttackTasks(world){
  for(const unit of world.units){const t=unit.attackTask;if(!t)continue;
    if(t.active)updateSearchState(unit,t,world.time);
    if(!unit.alive&&t.active){t.active=false;t.status='aborted';log(world,unit,'aborted','本机失效，攻击任务中止');}
    for(const m of world.missiles.filter(m=>t.firedMissileIds.includes(m.id))){
      // Adjudication maps a physical hit back to the pilot's local track ID;
      // bindings/truth IDs never enter the model's flight-result context.
      const hit=t.engagedTargetId&&(m.hitTargetId===t.engagedTargetId||unit.radar?.sensorModelVersion===2&&m.targetId===t.engagedTargetId&&radarTarget(world,unit,t.engagedTargetId)?.id===m.hitTargetId);
      const before=t.flightResults[m.id];t.flightResults[m.id]={phase:m.phase,alive:m.alive,hitTargetId:hit?t.engagedTargetId:null};
      if(m.phase==='hit'&&hit){if(before?.phase!=='hit'){const active=t.active;if(active){t.active=false;t.status='completed';}log(world,unit,'hit',active?'导弹命中已确认，攻击任务完成':'已在空导弹命中已确认，保持当前任务状态');}continue;}
      if(!m.alive&&before?.alive!==false)log(world,unit,'miss',`${m.id} 飞行结束，未确认命中，将根据实际航迹判断后续行动`);
    }
    if(t.active&&t.firedMissileIds.length>=t.shotLimit&&t.firedMissileIds.every(id=>t.flightResults[id]?.alive===false)){t.active=false;t.status='exhausted';log(world,unit,'exhausted','本次任务的发射额度已用完，未确认摧毁，等待后续指示');}
  }
}
export function attackTaskEvent(unit,time){
  if(directOwnsFlight(unit))return null;
  const t=unit.attackTask;if(!t?.active||unit.alive===false||unit.grounded||unit.surface?.grounded)return null;
  const r=unit.radar,w=unit.weapons,contacts=attackContacts(unit,time);
  const airborne=t.firedMissileIds.some(id=>t.flightResults[id]?.alive!==false);
  const geometry=contacts.map(c=>[c.id,c.classification,airborne?null:Math.floor(Math.hypot(...c.position.map((v,i)=>v-unit.position[i]))/1000)]);
  const signature=JSON.stringify([unit.tacticalGuidance?.revision??0,r?.mode,r?.phase,r?.targetId,r?.lastReason,w?.selectedModelId,w?.targetId,w?.ready,w?.inventory,geometry,t.flightResults]);
  const elapsed=time-(t.lastDecisionAt??t.issuedAt);
  if(t.lastError){if(elapsed<3)return null;return {key:`${t.id}:retry:${t.retryCount}`,reason:'retry',signature,summary:'修正上次未通过的攻击操作'};}
  if(t.engagement&&!['expired','released'].includes(t.engagement.phase)&&time<t.engagement.expiresAt){
    if(elapsed<20&&!t.lastError)return null;
    return {key:`${t.id}:intent:${t.decisionCount}`,reason:'intent_review',signature,summary:'复核持续接战意图；程序持续跟踪并按实时条件执行'};
  }
  if(!t.decisionCount)return {key:t.id+':start',reason:'task_start',signature,summary:'开始自主执行攻击任务'};
  if(r?.phase==='acquiring'&&(t.lastDecision?.operation??t.lastOperation)==='radar_lock')return null;
  if((t.lastDecision?.operation??t.lastOperation)==='maneuver'&&r?.mode==='off'&&elapsed>=.5)return {key:t.id+':search-sensors',reason:'search_sensors',signature,summary:'搜索航段已建立，判断搜索传感器操作'};
  // Validated contexts already carry the flight task. For live units, mirror
  // commandContext: a heading hold (including 0 degrees) is not an orbit even
  // when it has no waypoints. Otherwise only the client keeps requesting work.
  const orbit=unit.task!=null?unit.task==='orbit':Array.isArray(unit.waypoints)&&!unit.waypoints.length&&!unit.headingRoute&&unit.headingTarget==null&&!unit.formation;
  if(orbit&&!t.searchLegEstablished&&elapsed>=.5)return {key:t.id+':search-leg',reason:'search_flight',signature,summary:'盘旋会使前方搜索方向持续变化，判断搜索飞行方案'};
  if(signature!==t.lastSignature&&elapsed>=.5)return {key:`${t.id}:state:${t.decisionCount}`,reason:'state_changed',signature,summary:'观测或武器状态变化，判断下一步攻击操作'};
  if(elapsed>=3&&searchAssessment(unit,t,time).mustChangeSearch)return {key:`${t.id}:sector:${t.decisionCount}`,reason:'search_sector_review',signature,summary:'当前扇区持续无回波，判断新的搜索航段'};
  const inFlight=t.firedMissileIds.some(id=>t.flightResults[id]?.alive!==false);
  if(elapsed>=(inFlight?10:w?.ready?4:15))return {key:`${t.id}:review:${t.decisionCount}`,reason:'review',signature,summary:inFlight?'复核在空导弹与雷达支持':'复核攻击机会'};
  return null;
}
export function attackObservation(world,unit){
  const task=attackTaskContext(unit),contacts=attackContacts(unit,world.time),allowed=allowedAttackModels(unit,task),nonfriendly=contacts.filter(c=>c.classification!=='friendly');
  const id=task.engagedTargetId??task.targetId??(nonfriendly.length===1?nonfriendly[0].id:null),target=contacts.find(c=>c.id===id);
  return {task,ownship:{id:unit.id,callsign:unit.callsign,position:[...unit.position],velocity:[...unit.velocity],speedMps:unit.speed,grounded:!!unit.surface?.grounded},
    radar:radarContext(unit,world.time),weapons:weaponsContext(unit,world.time),contacts,
    missileChoices:allowed.map(id=>{const m=MISSILE_MODELS.get(id);return {id,name:m.familyName,kind:m.kind,count:unit.weapons.inventory[id],warmupSec:m.seeker.warmupSec,workSec:m.seeker.workSec,maxTravelM:m.simulationLimits.maxTravelM,armingSec:m.proximityFuse.armingDelaySec,needsContinuousRadar:m.kind==='semi_active_radar',hasDatalink:!!m.guidance.datalink};}),
    launchOptions:target?allowed.map(modelId=>{const a=launchAssessment(world,unit,modelId,target.id),d=target.position.map((v,i)=>v-unit.position[i]),rangeM=Math.hypot(...d),closingMps=d.reduce((s,v,i)=>s+v*(unit.velocity[i]-target.velocity[i]),0)/Math.max(1,rangeM);return {modelId,targetId:target.id,ready:a.ready,reason:a.reason,rangeM,closingMps,
      engagement:engagementPermission(unit,target,{authorization:'attack'}),shotQuality:estimateShotQuality(unit,target,MISSILE_MODELS.get(modelId),world.time,world.terrain)};}):[],
    flights:captureOwnMissileFlights(world,unit,task.firedMissileIds)};
}
export const ATTACK_DECISION_SCHEMA={type:'object',additionalProperties:false,required:['operation','mode','modelId','targetId','quantity','headingDeg','altitudeM','speedMps','message'],properties:{
  operation:{enum:['radar_mode','radar_lock','radar_unlock','select','engage','launch','maneuver','wait','abort']},mode:{enum:[null,'pd','pulse','off']},modelId:{type:['string','null']},targetId:{type:['string','null']},quantity:{type:['integer','null'],minimum:1,maximum:4},
  headingDeg:{type:['number','null'],minimum:0,maximum:360},altitudeM:{type:['number','null'],minimum:500,maximum:15000},speedMps:{type:['number','null'],minimum:400/3.6,maximum:2400/3.6},message:{type:'string',maxLength:120}}};
export function validateAttackDecision(d,unit,time){
  if(directOwnsFlight(unit))throw Error('玩家直接机动正在执行，攻击判断等待复位');
  const t=unit.attackTask;if(!t?.active)throw Error('当前没有攻击授权任务');
  const search=searchAssessment(unit,t,time);
  if(d?.operation==='wait'&&search.mustChangeSearch)throw Error('当前扇区已持续搜索无回波，请选择新的搜索航段，不能无限等待');
  if(!d||Object.keys(d).length!==9||!Object.keys(ATTACK_DECISION_SCHEMA.properties).every(k=>Object.hasOwn(d,k))||!ATTACK_DECISION_SCHEMA.properties.operation.enum.includes(d.operation)||typeof d.message!=='string'||!d.message.trim()||d.message.length>120)throw Error('攻击判断格式无效');
  const allowed={radar_mode:['mode'],radar_lock:['targetId'],radar_unlock:[],select:['modelId','targetId'],engage:['modelId','targetId','quantity'],launch:['modelId','targetId','quantity'],maneuver:['targetId','headingDeg','altitudeM','speedMps'],wait:[],abort:[]}[d.operation];
  if(['mode','modelId','targetId','quantity','headingDeg','altitudeM','speedMps'].some(k=>!allowed.includes(k)&&d[k]!==null))throw Error('攻击动作与参数不匹配');
  if(/已(?:经)?命中|目标已(?:被)?摧毁|已经摧毁|击落成功/.test(d.message))throw Error('命中只能由真实导弹碰撞结果确认');
  const premature={radar_lock:/已(?:经)?(?:稳定)?锁定|锁定成功|lock(?:ed|[- ]on) successfully/i,select:/已(?:经)?选(?:择|定)|已(?:经)?装订|已(?:经)?锁定/,launch:/已(?:经)?发射|发射成功|missile (?:away|launched)/i,maneuver:/已(?:经)?(?:到达|转至|完成转向)/};
  if(premature[d.operation]?.test(d.message))throw Error('本次操作尚未执行，message只能描述拟操作，不能提前声称完成');
  if(d.operation==='radar_mode'&&!['pd','pulse','off'].includes(d.mode))throw Error('雷达模式无效');
  if(d.operation==='radar_mode'&&d.mode===unit.radar?.mode)throw Error('该雷达模式已经启用，继续扫描用wait；不要重复重置扫描');
  if(d.operation==='radar_lock'&&unit.radar?.phase==='locked'&&unit.radar.targetId===d.targetId)throw Error('已经稳定锁定该目标，不要重复截获；应判断选弹、准备或发射机会');
  if(d.operation==='wait'&&unit.radar?.canIlluminate&&/雷达(?:支持|照射|锁定)?(?:已)?解除|(?:解除|关闭)(?:本机)?雷达/.test(d.message))throw Error('等待动作不会解除雷达支持，不能虚报已解除');
  if(['radar_lock','select','engage','launch'].includes(d.operation)||d.operation==='maneuver'&&d.targetId!==null){
    const c=observedTarget(unit,time,d.targetId);if(!c)throw Error('只能使用本机刚刚发现的目标航迹');
    if(c.classification==='friendly'||c.id===unit.id)throw Error('禁止攻击已识别友机');
    if((t.targetId&&c.id!==t.targetId)||(t.engagedTargetId&&c.id!==t.engagedTargetId))throw Error('不能擅自更换攻击目标');
    const named=attackContacts(unit,time).find(c=>[c.id,c.callsign].some(s=>clean(s)===clean(t.targetRef)));if(named&&named.id!==c.id)throw Error('必须选择玩家点名的目标');
  }
  if(['select','engage','launch'].includes(d.operation)&&!allowedAttackModels(unit,t).includes(d.modelId))throw Error('所选导弹不在本机可用挂载或任务允许型号中');
  if(d.operation==='engage'){
    if(!Number.isInteger(d.quantity)||d.quantity<1||t.firedMissileIds.length+d.quantity>t.shotLimit||d.quantity>(unit.weapons.inventory[d.modelId]??0))throw Error('持续接战数量超出本次剩余额度或库存');
    const p=engagementPermission(unit,observedTarget(unit,time,d.targetId),{authorization:'attack'});if(!p.allowed)throw Error(p.reason);
    if(t.firedMissileIds.some(id=>t.flightResults[id]?.alive!==false))throw Error('已有本任务导弹在空，先维持必要支持');
  }
  if(d.operation==='select'&&t.selectedModelId===d.modelId&&unit.weapons?.targetId===d.targetId)throw Error('本任务已选同一导弹和目标，不要重复选弹；用engage持续准备和等待实时发射条件');
  if(d.operation==='launch'){
    if(['split','rotate'].includes(unit.tacticalGuidance?.offense)&&unit.tacticalGuidance?.group?.role==='supporting')throw Error('当前承担双机支援职责，交战角色交接前不能自行发射');
    const permission=engagementPermission(unit,observedTarget(unit,time,d.targetId),{authorization:'attack'});if(!permission.allowed)throw Error(permission.reason);
    if(t.selectedModelId!==d.modelId)throw Error('本次攻击任务尚未由飞行员明确选择该导弹，请先选弹准备');
    if(!unit.weapons.ready||unit.weapons.selectedModelId!==d.modelId||unit.weapons.targetId!==d.targetId)throw Error('导引头或当前发射条件尚未就绪，不能发射');
    if(!Number.isInteger(d.quantity)||d.quantity<1||d.quantity>4||t.firedMissileIds.length+d.quantity>t.shotLimit)throw Error('超出本次攻击任务的剩余发射额度');
    if(t.firedMissileIds.some(id=>t.flightResults[id]?.alive!==false))throw Error('已有本任务导弹在空，请先观察结果并维持必要支持');
  }
  if(d.operation==='maneuver'){
    if(search.mustChangeSearch&&Math.abs((d.headingDeg-search.currentHeadingDeg+540)%360-180)<20)throw Error('重复当前航向不能扩展搜索范围，请选择新搜索航段');
    if(!Number.isFinite(d.headingDeg)||d.headingDeg<0||d.headingDeg>360||!Number.isFinite(d.altitudeM)||d.altitudeM<500||d.altitudeM>15000||!Number.isFinite(d.speedMps)||d.speedMps<400/3.6||d.speedMps>2400/3.6)throw Error('攻击飞行方案超出支持范围');
    const envelope=unit.navigationEnvelope??(unit.profile?navigationEnvelope(unit):null);
    if(envelope&&(d.altitudeM>envelope.ceilingM||d.speedMps<envelope.safeLevelSpeedMps))throw Error('攻击机动超出本机当前升限或安全平飞速度包线，请依据navigationEnvelope修正');
    for(const k of ['headingDeg','altitudeM','speedMps'])if(t[k]!==null&&Math.abs(t[k]-d[k])>.01)throw Error('攻击机动不得改变玩家明确的飞行约束');
  }
  return d;
}
export function applyAttackDecision(world,unit,d,taskId,decisionCount,{maneuverDraft=null}={}){
  const t=unit.attackTask;if(!t?.active||t.id!==taskId||t.decisionCount!==decisionCount)throw Error('攻击任务或阶段已变化，旧操作作废');
  if(d?.operation==='radar_lock'&&unit.radar?.phase==='locked'&&unit.radar.targetId===d.targetId)d={...d,operation:'wait',targetId:null,message:'目标已建立稳定跟踪，保持锁定并继续判断武器准备'};
  validateAttackDecision(d,unit,world.time);
  if(!['engage','wait','launch'].includes(d.operation)&&t.engagement&&t.engagement.launchedAt===null)t.engagement=null;
  if(['radar_mode','radar_lock','radar_unlock'].includes(d.operation)){
    const order={operation:d.operation.slice(6),mode:d.mode,targetId:d.targetId};validateRadarOrder(world,unit,order);applyRadarOrder(world,unit,order,{autonomous:true});t.status=d.operation==='radar_lock'?'engaging':'searching';
  }else if(d.operation==='engage'){
    selectAttackWeapon(world,unit,d.modelId,d.targetId);
    t.engagement={modelId:d.modelId,targetId:d.targetId,quantity:d.quantity,issuedAt:world.time,expiresAt:world.time+45,phase:'preparing',lastReason:null,nextCheckAt:world.time,firstReadyAt:null,launchedAt:null};t.status='engaging';
  }else if(d.operation==='select'){
    selectAttackWeapon(world,unit,d.modelId,d.targetId);t.status='preparing';
  }else if(d.operation==='launch'){
    const order={operation:'launch',modelId:d.modelId,targetId:d.targetId,quantity:d.quantity};validateWeaponOrder(world,unit,order);applyWeaponOrder(world,unit,order,{autonomous:true});t.firedMissileIds.push(...unit.weapons.lastLaunch.missileIds);t.status='supporting';
    for(const id of unit.weapons.lastLaunch.missileIds)t.flightResults[id]={alive:true,phase:'launched',hitTargetId:null};
  }else if(d.operation==='maneuver'){
    if(unit.formation)throw Error('攻击飞行当前仍受编队职责约束，请先明确脱离编队');
    world.attackManeuver(unit.id,d.message,d,maneuverDraft);
    if(d.targetId===null)noteSearchManeuver(t,d.headingDeg,world.time);
    t.searchLegEstablished=true;
  }else if(d.operation==='abort'){t.engagement=null;t.active=false;t.status='aborted';}
  else if(d.operation==='wait')noteSearchWait(t);
  if(d.targetId&&!t.engagedTargetId)t.engagedTargetId=d.targetId;
  t.decisionCount++;t.lastDecisionAt=world.time;t.lastError=null;t.lastDecision={...d,time:world.time};t.pending=false;t.lastSignature=attackTaskEvent({...unit,attackTask:{...t,lastDecisionAt:-100}},world.time)?.signature??null;
  const result=d.operation==='engage'?'持续接战意图已装订，已前置选弹；按实测火控和授权条件执行':d.operation==='launch'?`${MISSILE_MODELS.get(d.modelId).familyName} 实际发射 ${d.quantity} 枚`:d.operation==='select'?`已选择${MISSILE_MODELS.get(d.modelId).familyName}并装订目标`:d.operation==='radar_lock'?'已请求截获，稳定锁定以雷达实测为准':d.operation==='radar_mode'?`雷达模式已设为${d.mode.toUpperCase()}，探测结果以实际回波为准`:d.operation==='radar_unlock'?'雷达锁定已解除':d.operation==='maneuver'?'攻击飞行方案已装订，等待实际机动':d.operation==='wait'?'保持当前状态，继续观察':d.operation==='abort'?'攻击任务已中止':'操作已执行';
  log(world,unit,d.operation,result,{decisionCount:t.decisionCount,operation:d.operation});world.revision++;return t.lastDecision;
}
export function attackMissionTaskFor(order,context){
  const p=order.parameters,allowed=['targetId','targetRef','weapon','quantity','altitudeM','speedMps','headingDeg'];
  if(Object.entries(p).some(([k,v])=>v!==null&&v!==false&&!allowed.includes(k)&&!(k==='mode'&&['auto','auto_tactics','automatic'].includes(v))))throw Error('本次攻击任务包含尚未支持的额外约束，请保留明确目标、武器或飞行要求');
  return order.unitIds.map(unitId=>{const unit=context.units.find(u=>u.id===unitId);const attackOrder={targetId:p.targetId,targetRef:p.targetRef,weaponRef:p.weapon,shotLimit:p.quantity??2,altitudeM:p.altitudeM,speedMps:p.speedMps,headingDeg:p.headingDeg};validateAttackOrder(attackOrder);
    if(!unit?.weapons||!allowedAttackModels(unit,attackOrder).length)throw Error('受令机未挂载可用或符合任务要求的导弹');
    const friendly=context.units.find(u=>u.id===p.targetId||p.targetRef&&[u.id,u.callsign,...(u.aliases??[])].some(s=>clean(s)===clean(p.targetRef)));if(friendly&&(friendly.team??'blue')===(unit.team??'blue'))throw Error('指定对象是友机，不能接受攻击任务');return {unitId,action:'attack_task',attackOrder};});
}
