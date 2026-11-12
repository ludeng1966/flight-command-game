import {applyRadarOrder,validateRadarOrder,recordRadarEvent,createRadar} from './radar.js';
import {setScanPolicy,SCAN_POLICY_SCHEMA} from './radar-v2.js';
import {navigationEnvelope} from './energy.js';
import {trackUsable} from './radar-quality.js';
import {createSearchState,updateSearchState,parseSearchState,searchAssessment,noteSearchManeuver,noteSearchWait} from './search-assessment.js';
export const RADAR_TASK_GOALS=Object.freeze(['search','track_target']);
const canonical=s=>String(s??'').replace(/[\s_-]/g,'').toUpperCase();
const finite=Number.isFinite;
export function validateRadarTask(value){
  if(!value||Object.keys(value).some(k=>!['goal','targetId','targetRef','scanPolicy'].includes(k))||!['goal','targetId','targetRef'].every(k=>Object.hasOwn(value,k))||!RADAR_TASK_GOALS.includes(value.goal)||
    !(value.targetId===null||typeof value.targetId==='string'&&value.targetId.length>0&&value.targetId.length<=64)||
    !(value.targetRef===null||typeof value.targetRef==='string'&&value.targetRef.length>0&&value.targetRef.length<=160))throw Error('雷达任务格式无效');
  if(value.scanPolicy)setScanPolicy({radar:createRadar('f16',{sensorModelVersion:2})},value.scanPolicy);return value;
}
export function installRadarTask(world,unit,value){
  validateRadarTask(value);if(!unit?.alive||!unit.radar?.available)throw Error('该机没有可用的搜索雷达');
  if(value.scanPolicy)setScanPolicy(unit,value.scanPolicy);
  if(unit.attackTask?.active){unit.attackTask.active=false;unit.attackTask.status='cancelled';unit.attackTask.pending=false;}
  const generation=(unit.radarTaskGeneration??0)+1;unit.radarTaskGeneration=generation;
  unit.radarTask={...value,id:`${unit.id}-sensor-${generation}`,active:true,issuedAt:world.time,decisionCount:0,retryCount:0,
    lastDecisionAt:null,lastSignature:null,reviewedLossEpoch:0,lastError:null,lastDecision:null,pending:false,
    allowSearchManeuver:true,searchState:createSearchState(world.time)};
  recordRadarEvent(unit.radar,world.time,`${value.goal==='search'?'前方空域搜索':'目标持续跟踪'}任务已接收，飞行员自主操作雷达`,'task');
  if(unit.radar.sensorModelVersion===2&&unit.radar.mode==='off')applyRadarOrder(world,unit,{operation:'mode',mode:'pd',targetId:null},{autonomous:true});
}
export function radarTaskContext(unit){
  const t=unit.radarTask;if(!t?.active)return null;
  return {id:t.id,goal:t.goal,targetId:t.targetId,targetRef:t.targetRef,active:true,issuedAt:t.issuedAt,decisionCount:t.decisionCount,
    retryCount:t.retryCount,lastDecisionAt:t.lastDecisionAt,lastSignature:t.lastSignature,reviewedLossEpoch:t.reviewedLossEpoch,lastError:t.lastError,
    ...(t.scanPolicy?{scanPolicy:structuredClone(t.scanPolicy)}:{}),allowSearchManeuver:t.allowSearchManeuver!==false,searchState:t.searchState?structuredClone(t.searchState):null};
}
export function parseRadarTaskContext(t,time){
  if(t==null)return null;
  validateRadarTask({goal:t.goal,targetId:t.targetId,targetRef:t.targetRef,...(t.scanPolicy?{scanPolicy:t.scanPolicy}:{})});
  if(typeof t.id!=='string'||!t.id||t.id.length>100||t.active!==true||!finite(t.issuedAt)||t.issuedAt<0||t.issuedAt>time+.001||
    !['decisionCount','retryCount','reviewedLossEpoch'].every(k=>Number.isSafeInteger(t[k])&&t[k]>=0)||
    !(t.lastDecisionAt===null||finite(t.lastDecisionAt)&&t.lastDecisionAt>=0&&t.lastDecisionAt<=time+.001)||
    !(t.lastSignature===null||typeof t.lastSignature==='string'&&t.lastSignature.length<=3000)||
    !(t.lastError===null||typeof t.lastError==='string'&&t.lastError.length<=300))throw Error('雷达任务状态无效');
  return {id:t.id,goal:t.goal,targetId:t.targetId,targetRef:t.targetRef,active:true,issuedAt:t.issuedAt,decisionCount:t.decisionCount,retryCount:t.retryCount,
    lastDecisionAt:t.lastDecisionAt,lastSignature:t.lastSignature,reviewedLossEpoch:t.reviewedLossEpoch,lastError:t.lastError,
    ...(t.scanPolicy?{scanPolicy:structuredClone(t.scanPolicy)}:{}),allowSearchManeuver:t.allowSearchManeuver!==false,searchState:parseSearchState(t.searchState,time)};
}
export function monitorRadarTasks(world){for(const unit of world.units)if(unit.alive&&unit.radarTask?.active)updateSearchState(unit,unit.radarTask,world.time);}
export function radarContactSignature(radar,time){return JSON.stringify((radar?.contacts??[]).filter(c=>trackUsable(c,time)).map(c=>[c.id,c.classification]).sort((a,b)=>a[0].localeCompare(b[0])));}
export function radarTaskEvent(unit,time){
  const t=unit.radarTask,r=unit.radar;if(!t?.active||unit.alive===false||unit.grounded===true||unit.surface?.grounded||!r?.available)return null;
  const base=`${t.id}:${t.retryCount}`;
  if(t.lastError){if(time-(t.lastDecisionAt??t.issuedAt)<3)return null;return {key:base+':retry',reason:'retry',summary:'上次雷达操作未通过，重新判断'};}
  if(t.decisionCount===0)return {key:base+':start',reason:'task_start',summary:'飞行员正在选择雷达搜索方案'};
  if(r.phase==='locked'&&(!t.targetId||t.targetId===r.targetId))return null;
  const epoch=r.lastLockSequence??r.events?.findLast(e=>e.type==='locked')?.sequence??0;
  if(epoch>t.reviewedLossEpoch&&(r.phase==='coasting'||r.lastReason&&r.phase==='search'))return {key:`${t.id}:loss:${epoch}`,reason:'signal_lost',lossEpoch:epoch,summary:'雷达丢波，飞行员正在重新判断'};
  if(r.phase==='acquiring')return null;
  const signature=radarContactSignature(r,time);
  if(signature!==t.lastSignature)return {key:base+':contacts:'+signature,reason:'contacts_changed',summary:'航迹变化，飞行员正在选择跟踪对象'};
  if(t.allowSearchManeuver!==false&&searchAssessment(unit,t,time).mustChangeSearch&&time-(t.lastDecisionAt??t.issuedAt)>=3)
    return {key:base+':sector:'+t.decisionCount,reason:'search_sector_review',summary:'当前空域持续未发现目标，复核下一搜索航段'};
  if(time-(t.lastDecisionAt??t.issuedAt)>=20)return {key:base+':review:'+t.decisionCount,reason:'search_review',summary:'飞行员正在复核搜索方式'};
  return null;
}
export const RADAR_DECISION_SCHEMA={type:'object',additionalProperties:false,required:['operation','mode','targetId','headingDeg','altitudeM','speedMps','message'],properties:{
  operation:{enum:['mode','lock','unlock','hold','maneuver','scan']},mode:{enum:[null,'pd','pulse','off']},targetId:{type:['string','null']},
  headingDeg:{type:['number','null'],minimum:0,maximum:360},altitudeM:{type:['number','null'],minimum:500,maximum:15000},speedMps:{type:['number','null'],minimum:400/3.6,maximum:2400/3.6},message:{type:'string',maxLength:120}}};
RADAR_DECISION_SCHEMA.properties.scanPolicy={anyOf:[{type:'null'},SCAN_POLICY_SCHEMA]};
RADAR_DECISION_SCHEMA.required.push('scanPolicy');
export function validateRadarDecision(value,unit,time){
  const legacy=value&&value.operation!=='maneuver'&&Object.keys(value).length===4;
  if(!value||Object.keys(value).some(k=>!Object.hasOwn(RADAR_DECISION_SCHEMA.properties,k))||(!legacy&&(![7,8].includes(Object.keys(value).length)||!Object.keys(RADAR_DECISION_SCHEMA.properties).filter(k=>k!=='scanPolicy').every(k=>Object.hasOwn(value,k))))||!['operation','mode','targetId','message'].every(k=>Object.hasOwn(value,k))||
    !RADAR_DECISION_SCHEMA.properties.operation.enum.includes(value.operation)||typeof value.message!=='string'||!value.message.trim()||value.message.length>120)throw Error('飞行员雷达判断格式无效');
  if(value.operation!=='maneuver'&&!legacy&&['headingDeg','altitudeM','speedMps'].some(k=>value[k]!==null))throw Error('雷达操作不能同时改变航向、高度或速度');
  if(value.operation==='hold'&&searchAssessment(unit,unit.radarTask,time).mustChangeSearch)throw Error('当前扇区已持续搜索无回波，请选择新的搜索航段');
  if(value.operation==='mode'){if(!['pd','pulse','off'].includes(value.mode)||value.targetId!==null)throw Error('雷达工作模式参数无效');}
  else if(value.mode!==null||(['unlock','hold','maneuver','scan'].includes(value.operation)?value.targetId!==null:typeof value.targetId!=='string'))throw Error('雷达跟踪参数无效');
  if(value.operation==='scan'){if(!value.scanPolicy)throw Error('缺少扫描策略');setScanPolicy({radar:unit.radar.config?structuredClone(unit.radar):createRadar('f16',{sensorModelVersion:2})},value.scanPolicy);}
  else if(value.scanPolicy!=null)throw Error('当前动作不接受扫描策略');
  if(value.operation==='maneuver'){
    if(!finite(value.headingDeg)||value.headingDeg<0||value.headingDeg>360||!finite(value.altitudeM)||value.altitudeM<500||value.altitudeM>15000||!finite(value.speedMps)||value.speedMps<400/3.6||value.speedMps>2400/3.6)throw Error('搜索飞行方案超出支持范围');
    if(unit.radarTask?.allowSearchManeuver===false||unit.rwrDefense?.active||unit.formation)throw Error('玩家飞行约束、编队或自卫正在接管，不能改变搜索航向');
    const envelope=unit.navigationEnvelope??(unit.profile?navigationEnvelope(unit):null);
    if(envelope&&(value.altitudeM>envelope.ceilingM||value.speedMps<envelope.safeLevelSpeedMps))throw Error('搜索机动超出本机当前升限或安全平飞速度包线');
    const assessment=searchAssessment(unit,unit.radarTask,time);
    if(assessment.mustChangeSearch&&Math.abs(((value.headingDeg-(unit.headingDeg??Math.atan2(unit.velocity[0],unit.velocity[1])*180/Math.PI)+540)%360)-180)<20)throw Error('当前扇区已持续搜索，重复当前航向不能扩展搜索范围');
  }
  if(/已(?:经)?锁定|锁定成功|锁定完成/.test(value.message)&&!(value.operation==='hold'&&unit.radar?.phase==='locked'))throw Error('尚未建立真实锁定，不能报告锁定成功');
  if(value.operation==='lock'){
    const r=unit.radar,t=unit.radarTask,contact=r?.contacts.find(c=>c.id===value.targetId&&trackUsable(c,time));
    if(r.sensorModelVersion===2&&t?.goal==='search')throw Error('普通搜索任务需要维持覆盖；请保持搜索或调整扫描策略，不转单目标跟踪');
    if(!contact||r.mode==='off')throw Error('只能截获本机刚刚探测的有效航迹');
    if(t?.targetId&&t.targetId!==contact.id)throw Error('不能擅自更换指挥员指定的跟踪目标');
    const named=r.contacts.find(c=>[c.id,c.callsign].some(s=>canonical(s)===canonical(t?.targetRef)));
    if(named&&named.id!==contact.id)throw Error('必须跟踪指挥员点名的航迹');
    if(contact.classification==='friendly'&&t?.targetId!==contact.id&&![contact.id,contact.callsign].some(s=>canonical(s)===canonical(t?.targetRef)))throw Error('未指定友机跟踪任务，不能自主锁定已识别友机');
  }
  return value;
}
export function applyRadarDecision(world,unit,decision,expectedTaskId,event,{maneuverDraft=null}={}){
  const t=unit.radarTask;if(!t?.active||t.id!==expectedTaskId)throw Error('雷达任务已变化，旧操作作废');
  validateRadarDecision(decision,unit,world.time);
  const order={operation:decision.operation,mode:decision.mode,targetId:decision.targetId};
  if(decision.operation==='scan'){
    setScanPolicy(unit,decision.scanPolicy);unit.radar.controlSequence=(unit.radar.controlSequence??0)+1;
    recordRadarEvent(unit.radar,world.time,'三维扫描策略已装订，覆盖以实际波束为准','pilot_decision');
  }else if(decision.operation==='maneuver'){
    world.attackManeuver(unit.id,'搜索飞行方案',decision,maneuverDraft);noteSearchManeuver(t,decision.headingDeg,world.time);
    recordRadarEvent(unit.radar,world.time,`搜索航向 ${Math.round(decision.headingDeg)}° 已装订，等待实际转向与扫描`,'pilot_decision');
  }else if(decision.operation!=='hold'){validateRadarOrder(world,unit,order);applyRadarOrder(world,unit,order,{autonomous:true});
    unit.radar.events.at(-1).text=decision.message+'。'+unit.radar.events.at(-1).text;
  }else {noteSearchWait(t);recordRadarEvent(unit.radar,world.time,decision.message,'pilot_decision');}
  t.decisionCount++;t.lastDecisionAt=world.time;t.lastSignature=radarContactSignature(unit.radar,world.time);t.lastError=null;t.pending=false;
  if(event?.reason==='signal_lost')t.reviewedLossEpoch=event.lossEpoch;
  t.lastDecision={...decision,time:world.time};world.revision++;
  return t.lastDecision;
}
export function radarMissionTaskFor(order,context){
  const p=order.parameters;
  if(context.units.filter(u=>order.unitIds.includes(u.id)).every(u=>u.radar?.sensorModelVersion===2)){
    if(Object.entries(p).some(([k,v])=>v!==null&&v!==false&&!['targetId','targetRef','headingDeg','altitudeM','rangeM','mode'].includes(k)))throw Error('搜索任务支持方向、中心高度和搜索距离，其他飞行要求请单独下达');
    return order.unitIds.map(unitId=>{const u=context.units.find(u=>u.id===unitId);if(!u?.radar?.available)throw Error('受令机没有可用的搜索雷达');
      const scanPolicy={...u.radar.scanPolicy};if(p.headingDeg!=null){scanPolicy.frame='world';scanPolicy.azCenterDeg=p.headingDeg;}if(p.altitudeM!=null)scanPolicy.altitudeBandM=[Math.max(0,p.altitudeM-3000),p.altitudeM+3000];if(p.rangeM!=null)scanPolicy.rangeBandM=[scanPolicy.rangeBandM[0],p.rangeM];
      return {unitId,action:'sensor_task',sensorTask:{goal:order.intent,targetId:p.targetId,targetRef:p.targetRef,scanPolicy}};});
  }
  if(Object.entries(p).some(([k,v])=>v!==null&&v!==false&&!['targetId','targetRef'].includes(k)&&!(k==='mode'&&['auto','auto_tactics','automatic'].includes(v))))throw Error('当前支持机头前方空域搜索与持续跟踪；指定航向、高度或空间区域请保留为单独飞行任务');
  return order.unitIds.map(unitId=>{if(!context.units.find(u=>u.id===unitId)?.radar?.available)throw Error('受令机没有可用的搜索雷达');return {unitId,action:'sensor_task',sensorTask:{goal:order.intent,targetId:p.targetId,targetRef:p.targetRef}};});
}
