import {decisionReading} from './pilot-decision-reading.mjs';
import {teamGuidanceContext} from '../sim/tactical-guidance.js';
import {trackUsable} from '../sim/radar-quality.js';
import {ApiError,validateContext} from './qwen.mjs';
import {radarTaskEvent,validateRadarDecision,RADAR_DECISION_SCHEMA} from '../sim/radar-task.js';
import {searchAssessment} from '../sim/search-assessment.js';
import {compactRadar} from './tactical-awareness.mjs';

export function normalizeRadarProposal(raw){
  const allowed={mode:['mode'],lock:['targetId'],unlock:[],hold:[],maneuver:['headingDeg','altitudeM','speedMps'],scan:['scanPolicy']}[raw?.operation];
  if(!allowed||typeof raw.message!=='string'||raw.message.length>120)return {decision:raw,normalizations:[]};
  const decision={...raw},normalizations=[];
  for(const key of ['mode','targetId','headingDeg','altitudeM','speedMps','scanPolicy'])if(Object.hasOwn(decision,key)&&!allowed.includes(key)&&decision[key]!==null){decision[key]=null;normalizations.push('忽略当前动作未使用的字段：'+key);}
  decision.message={mode:'拟设置雷达工作模式',lock:'拟请求截获指定航迹',unlock:'拟解除单目标跟踪并恢复搜索',hold:'拟保持当前搜索或跟踪并继续观察',maneuver:'拟装订搜索飞行方案',scan:'拟调整三维搜索策略，覆盖以实际波束为准'}[raw.operation];
  normalizations.push('模型原始判断单独保存，操作通话不提前宣称成功');return {decision,normalizations};
}

export function createRadarPilot(client){
  const cache=new Map();
  return async(input,{signal}={})=>{
    if(!input||typeof input.requestId!=='string'||!/^[-\w]{1,80}$/.test(input.requestId))throw new ApiError(400,'雷达判断请求无效');
    const context=validateContext(input.context),unit=context.units.find(u=>u.id===input.unitId);
    if(!unit||!unit.radarTask||input.taskId!==unit.radarTask.id)throw new ApiError(409,'雷达任务已变化');
    const event=radarTaskEvent(unit,context.simTimeSec);
    const reply=(decision,modelInvoked,details={})=>({requestId:input.requestId,revision:context.revision,simTimeSec:context.simTimeSec,taskId:unit.radarTask.id,
      controlSequence:unit.radar.controlSequence,event,decision,modelInvoked,...details});
    if(!event)return reply(null,false);
    const key=JSON.stringify([unit.id,unit.radarTask.id,event.key,unit.radarTask.decisionCount,context.revision,unit.radar.phase,unit.radar.lastReason,unit.radar.contacts.map(c=>[c.id,c.observedAt]),unit.datalink]);
    if(cache.has(key)){const cached=cache.get(key);return reply(cached.decision,false,cached.details);}
    const search=searchAssessment(unit,unit.radarTask,context.simTimeSec),schema=structuredClone(RADAR_DECISION_SCHEMA);
    if(unit.radar.sensorModelVersion!==2){schema.properties.operation.enum=schema.properties.operation.enum.filter(op=>op!=='scan');delete schema.properties.scanPolicy;schema.required=schema.required.filter(k=>k!=='scanPolicy');}
    schema.properties.targetId.enum=[null,...unit.radar.contacts.filter(c=>trackUsable(c,context.simTimeSec)&&(!unit.radarTask.targetId||c.id===unit.radarTask.targetId)).map(c=>c.id)];
    if(unit.radar.sensorModelVersion===2&&unit.radarTask.goal==='search')schema.properties.operation.enum=schema.properties.operation.enum.filter(op=>op!=='lock');
    if(unit.radarTask.allowSearchManeuver===false||unit.rwrDefense?.active||unit.formation)schema.properties.operation.enum=schema.properties.operation.enum.filter(op=>op!=='maneuver');
    const reading=decisionReading('radar',unit,{search:true});
    const messages=[{role:'system',content:reading.text},{role:'user',content:JSON.stringify({teamMembers:teamGuidanceContext(context,unit),tacticalGuidance:unit.tacticalGuidance,event,mission:unit.radarTask,searchAssessment:search,
      ownship:{callsign:unit.callsign,position:unit.position,headingDeg:unit.headingDeg,speedMps:unit.speedMps,grounded:unit.grounded,navigationEnvelope:unit.navigationEnvelope,flightTask:unit.task,formation:unit.formation},
      radar:compactRadar(unit.radar),datalink:unit.datalink,defense:unit.rwrDefense,defenseAssessment:unit.defenseAssessment,tacticalAwareness:unit.tacticalAwareness,ownMissileAssessment:unit.ownMissileAssessment})}];
    let decision,details;
    for(let attempt=0;attempt<2;attempt++){
      const result=await client.completePilot(messages,schema,{maxTokens:500,signal}),normalized=normalizeRadarProposal(result.value);decision=normalized.decision;details={originalModelDecision:result.value,normalizations:normalized.normalizations};
      try{if(!schema.properties.operation.enum.includes(decision.operation))throw Error('当前控制权不允许此动作');validateRadarDecision(decision,unit,context.simTimeSec);break;}
      catch(error){if(attempt)throw new ApiError(502,'雷达判断未通过校验：'+error.message);messages.push({role:'assistant',content:JSON.stringify(decision)},{role:'user',content:'请修正方案后输出完整JSON：'+error.message});}
    }
    cache.set(key,{decision,details});if(cache.size>128)cache.delete(cache.keys().next().value);return reply(decision,true,details);
  };
}
