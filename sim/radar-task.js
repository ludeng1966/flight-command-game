import {applyRadarOrder,validateRadarOrder,recordRadarEvent} from './radar.js';
export const RADAR_TASK_GOALS=Object.freeze(['search','track_target']);
const canonical=s=>String(s??'').replace(/[\s_-]/g,'').toUpperCase();
const finite=Number.isFinite;
export function validateRadarTask(value){
  if(!value||Object.keys(value).length!==3||!['goal','targetId','targetRef'].every(k=>Object.hasOwn(value,k))||!RADAR_TASK_GOALS.includes(value.goal)||
    !(value.targetId===null||typeof value.targetId==='string'&&value.targetId.length>0&&value.targetId.length<=64)||
    !(value.targetRef===null||typeof value.targetRef==='string'&&value.targetRef.length>0&&value.targetRef.length<=160))throw Error('雷达任务格式无效');return value;
}
export function installRadarTask(world,unit,value){
  validateRadarTask(value);if(!unit?.alive||!unit.radar?.available)throw Error('该机没有可用的搜索雷达');
  if(unit.attackTask?.active){unit.attackTask.active=false;unit.attackTask.status='cancelled';unit.attackTask.pending=false;}
  const generation=(unit.radarTaskGeneration??0)+1;unit.radarTaskGeneration=generation;
  unit.radarTask={...value,id:`${unit.id}-sensor-${generation}`,active:true,issuedAt:world.time,decisionCount:0,retryCount:0,
    lastDecisionAt:null,lastSignature:null,reviewedLossEpoch:0,lastError:null,lastDecision:null,pending:false};
  recordRadarEvent(unit.radar,world.time,`${value.goal==='search'?'前方空域搜索':'目标持续跟踪'}任务已接收，飞行员自主操作雷达`,'task');
}
export function radarTaskContext(unit){
  const t=unit.radarTask;if(!t?.active)return null;
  return {id:t.id,goal:t.goal,targetId:t.targetId,targetRef:t.targetRef,active:true,issuedAt:t.issuedAt,decisionCount:t.decisionCount,
    retryCount:t.retryCount,lastDecisionAt:t.lastDecisionAt,lastSignature:t.lastSignature,reviewedLossEpoch:t.reviewedLossEpoch,lastError:t.lastError};
}
export function parseRadarTaskContext(t,time){
  if(t==null)return null;
  validateRadarTask({goal:t.goal,targetId:t.targetId,targetRef:t.targetRef});
  if(typeof t.id!=='string'||!t.id||t.id.length>100||t.active!==true||!finite(t.issuedAt)||t.issuedAt<0||t.issuedAt>time+.001||
    !['decisionCount','retryCount','reviewedLossEpoch'].every(k=>Number.isSafeInteger(t[k])&&t[k]>=0)||
    !(t.lastDecisionAt===null||finite(t.lastDecisionAt)&&t.lastDecisionAt>=0&&t.lastDecisionAt<=time+.001)||
    !(t.lastSignature===null||typeof t.lastSignature==='string'&&t.lastSignature.length<=3000)||
    !(t.lastError===null||typeof t.lastError==='string'&&t.lastError.length<=300))throw Error('雷达任务状态无效');
  return {id:t.id,goal:t.goal,targetId:t.targetId,targetRef:t.targetRef,active:true,issuedAt:t.issuedAt,decisionCount:t.decisionCount,retryCount:t.retryCount,
    lastDecisionAt:t.lastDecisionAt,lastSignature:t.lastSignature,reviewedLossEpoch:t.reviewedLossEpoch,lastError:t.lastError};
}
export function radarContactSignature(radar,time){return JSON.stringify((radar?.contacts??[]).filter(c=>time-c.observedAt<=2.25).map(c=>[c.id,c.classification]).sort((a,b)=>a[0].localeCompare(b[0])));}
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
  if(time-(t.lastDecisionAt??t.issuedAt)>=20)return {key:base+':review:'+t.decisionCount,reason:'search_review',summary:'飞行员正在复核搜索方式'};
  return null;
}
export const RADAR_DECISION_SCHEMA={type:'object',additionalProperties:false,required:['operation','mode','targetId','message'],properties:{
  operation:{enum:['mode','lock','unlock','hold']},mode:{enum:[null,'pd','pulse','off']},targetId:{type:['string','null']},message:{type:'string',maxLength:120}}};
export function validateRadarDecision(value,unit,time){
  if(!value||Object.keys(value).length!==4||!Object.keys(RADAR_DECISION_SCHEMA.properties).every(k=>Object.hasOwn(value,k))||
    !['mode','lock','unlock','hold'].includes(value.operation)||typeof value.message!=='string'||!value.message.trim()||value.message.length>120)throw Error('飞行员雷达判断格式无效');
  if(value.operation==='mode'){if(!['pd','pulse','off'].includes(value.mode)||value.targetId!==null)throw Error('雷达工作模式参数无效');}
  else if(value.mode!==null||(['unlock','hold'].includes(value.operation)?value.targetId!==null:typeof value.targetId!=='string'))throw Error('雷达跟踪参数无效');
  if(/已(?:经)?锁定|锁定成功|锁定完成/.test(value.message)&&!(value.operation==='hold'&&unit.radar?.phase==='locked'))throw Error('尚未建立真实锁定，不能报告锁定成功');
  if(value.operation==='lock'){
    const r=unit.radar,t=unit.radarTask,contact=r?.contacts.find(c=>c.id===value.targetId&&time-c.observedAt<=2.25);
    if(!contact||r.mode==='off')throw Error('只能截获本机刚刚探测的有效航迹');
    if(t?.targetId&&t.targetId!==contact.id)throw Error('不能擅自更换指挥员指定的跟踪目标');
    const named=r.contacts.find(c=>[c.id,c.callsign].some(s=>canonical(s)===canonical(t?.targetRef)));
    if(named&&named.id!==contact.id)throw Error('必须跟踪指挥员点名的航迹');
    if(contact.classification==='friendly'&&t?.targetId!==contact.id&&![contact.id,contact.callsign].some(s=>canonical(s)===canonical(t?.targetRef)))throw Error('未指定友机跟踪任务，不能自主锁定已识别友机');
  }
  return value;
}
export function applyRadarDecision(world,unit,decision,expectedTaskId,event){
  const t=unit.radarTask;if(!t?.active||t.id!==expectedTaskId)throw Error('雷达任务已变化，旧操作作废');
  validateRadarDecision(decision,unit,world.time);
  const order={operation:decision.operation,mode:decision.mode,targetId:decision.targetId};
  if(decision.operation!=='hold'){validateRadarOrder(world,unit,order);applyRadarOrder(world,unit,order,{autonomous:true});
    unit.radar.events.at(-1).text=decision.message+'。'+unit.radar.events.at(-1).text;
  }else recordRadarEvent(unit.radar,world.time,decision.message,'pilot_decision');
  t.decisionCount++;t.lastDecisionAt=world.time;t.lastSignature=radarContactSignature(unit.radar,world.time);t.lastError=null;t.pending=false;
  if(event?.reason==='signal_lost')t.reviewedLossEpoch=event.lossEpoch;
  t.lastDecision={...decision,time:world.time};world.revision++;
  return t.lastDecision;
}
export function radarMissionTaskFor(order,context){
  const p=order.parameters;
  if(Object.entries(p).some(([k,v])=>v!==null&&v!==false&&!['targetId','targetRef'].includes(k)&&!(k==='mode'&&['auto','auto_tactics','automatic'].includes(v))))throw Error('当前支持机头前方空域搜索与持续跟踪；指定航向、高度或空间区域请保留为单独飞行任务');
  return order.unitIds.map(unitId=>{if(!context.units.find(u=>u.id===unitId)?.radar?.available)throw Error('受令机没有可用的搜索雷达');return {unitId,action:'sensor_task',sensorTask:{goal:order.intent,targetId:p.targetId,targetRef:p.targetRef}};});
}
