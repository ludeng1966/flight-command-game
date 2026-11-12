import {decisionReading} from './pilot-decision-reading.mjs';
import {ApiError,validateContext} from './qwen.mjs';
import {teamGuidanceContext} from '../sim/tactical-guidance.js';
import {createHash} from 'node:crypto';
import {MISSILE_MODELS} from '../sim/missiles.js';
import {estimateShotQuality} from '../sim/shot-quality.js';
import {parseOwnMissileFlights,assessOwnMissile} from '../sim/missile-assessment.js';
import {compactRadar} from './tactical-awareness.mjs';
import {engagementPermission} from '../sim/weapons.js';
import {searchAssessment} from '../sim/search-assessment.js';
import {attackTaskEvent,attackContacts,allowedAttackModels,validateAttackDecision,ATTACK_DECISION_SCHEMA} from '../sim/attack-task.js';

export function normalizeAttackProposal(raw){
  const allowed={radar_mode:['mode'],radar_lock:['targetId'],radar_unlock:[],select:['modelId','targetId'],engage:['modelId','targetId','quantity'],launch:['modelId','targetId','quantity'],maneuver:['targetId','headingDeg','altitudeM','speedMps'],wait:[],abort:[]}[raw?.operation];
  if(!allowed||typeof raw.message!=='string'||raw.message.length>120)return {decision:raw,normalizations:[]};
  const decision={...raw},normalizations=[];
  for(const key of ['mode','modelId','targetId','quantity','headingDeg','altitudeM','speedMps'])if(Object.hasOwn(decision,key)&&!allowed.includes(key)&&decision[key]!==null){decision[key]=null;normalizations.push('忽略当前动作未使用的字段：'+key);}
  const intention={radar_mode:'拟设置雷达搜索模式',radar_lock:'拟请求截获指定航迹',radar_unlock:'拟解除雷达锁定',select:'拟选择导弹并装订指定目标',engage:'拟装订持续接战意图，实时条件成立时执行',launch:'拟按当前条件发射指定数量导弹',maneuver:'拟装订攻击飞行方案',wait:'拟保持当前状态继续观察',abort:'拟中止当前攻击任务'}[raw.operation];
  decision.message=intention;normalizations.push('模型原话作为未验证判断单独保留；操作通话由动作生成');
  return {decision,normalizations};
}
export function createAttackPilot(client){
  const cache=new Map();
  return async(input,{signal}={})=>{
    if(!input||typeof input.requestId!=='string'||!/^[-\w]{1,80}$/.test(input.requestId))throw new ApiError(400,'攻击判断请求无效');
    const context=validateContext(input.context),unit=context.units.find(u=>u.id===input.unitId),task=unit?.attackTask;
    if(!task?.active||task.id!==input.taskId)throw new ApiError(409,'攻击任务已变化');
    const event=attackTaskEvent(unit,context.simTimeSec),reply=(decision,modelInvoked,details={})=>({requestId:input.requestId,revision:context.revision,simTimeSec:context.simTimeSec,taskId:task.id,decisionCount:task.decisionCount,event,decision,modelInvoked,...details});
    if(!event)return reply(null,false);
    const contacts=attackContacts(unit,context.simTimeSec),models=allowedAttackModels(unit,task),observation=input.observation;
    if(!observation||!Array.isArray(observation.launchOptions)||observation.launchOptions.length>64||!Array.isArray(observation.flights)||observation.flights.length>4)throw new ApiError(400,'攻击观测无效');
    const launchOptions=observation.launchOptions.map(o=>{if(!o||!models.includes(o.modelId)||!contacts.some(c=>c.id===o.targetId)||typeof o.ready!=='boolean'||typeof o.reason!=='string'||o.reason.length>160||!Number.isFinite(o.rangeM)||o.rangeM<0||!Number.isFinite(o.closingMps)||Math.abs(o.closingMps)>4000)throw new ApiError(400,'发射机会观测无效');const contact=contacts.find(c=>c.id===o.targetId);return {modelId:o.modelId,targetId:o.targetId,ready:o.ready,reason:o.reason,rangeM:o.rangeM,closingMps:o.closingMps,
      engagement:engagementPermission(unit,contact,{authorization:'attack'}),shotQuality:estimateShotQuality(unit,contact,MISSILE_MODELS.get(o.modelId),context.simTimeSec,null,o.shotQuality?.terrainClear===false?false:null)};});
    let flights;
    try{flights=parseOwnMissileFlights(observation.flights,{maxCount:4});if(flights.some(m=>!task.firedMissileIds.includes(m.id)||m.ownerId!==null&&m.ownerId!==unit.id))throw Error('导弹不属于本机任务');}
    catch{throw new ApiError(400,'在空导弹观测无效');}
    const targetId=task.engagedTargetId??task.targetId;
    const schema=structuredClone(ATTACK_DECISION_SCHEMA);schema.properties.modelId.enum=[null,...models];schema.properties.targetId.enum=[null,...contacts.filter(c=>!targetId||c.id===targetId).map(c=>c.id)];
    if(unit.radar?.phase==='locked'&&(!task.engagedTargetId||unit.radar.targetId===task.engagedTargetId))schema.properties.operation.enum=schema.properties.operation.enum.filter(op=>op!=='radar_lock');
    if(unit.rwrDefense?.active)schema.properties.operation.enum=schema.properties.operation.enum.filter(op=>op!=='maneuver');
    if(!contacts.some(c=>c.classification!=='friendly'))schema.properties.operation.enum=schema.properties.operation.enum.filter(op=>!['radar_lock','select','engage','launch'].includes(op));
    // Match the executor's current release gate, so the model does not waste a
    // response on a launch that is mechanically impossible in this snapshot.
    if(!task.selectedModelId||!launchOptions.some(o=>o.ready&&o.engagement.allowed&&o.modelId===task.selectedModelId))schema.properties.operation.enum=schema.properties.operation.enum.filter(op=>op!=='launch');
    if(task.selectedModelId&&unit.weapons?.targetId===task.engagedTargetId)schema.properties.operation.enum=schema.properties.operation.enum.filter(op=>op!=='select');
    schema.properties.mode.enum=schema.properties.mode.enum.filter(mode=>mode===null||mode!==unit.radar?.mode);
    const payload={tacticalGuidance:unit.tacticalGuidance,teamMembers:teamGuidanceContext(context,unit),event,mission:task,ownship:{id:unit.id,callsign:unit.callsign,position:unit.position,headingDeg:unit.headingDeg,speedMps:unit.speedMps,grounded:unit.grounded,formation:unit.formation,flightTask:unit.task,navigationEnvelope:unit.navigationEnvelope,telemetry:unit.telemetry},
      searchAssessment:searchAssessment(unit,task,context.simTimeSec),rwr:unit.rwr,defense:unit.rwrDefense,defenseAssessment:unit.defenseAssessment,radar:compactRadar(unit.radar),datalink:unit.datalink,weapons:unit.weapons,contacts,launchOptions,flights,
      engagementCandidates:contacts.filter(c=>c.classification!=='friendly').map(c=>{const east=c.position[0]-unit.position[0],north=c.position[1]-unit.position[1],bearingDeg=(Math.atan2(east,north)*180/Math.PI+360)%360;return {targetId:c.id,bearingDeg,offNoseDeg:((bearingDeg-unit.headingDeg+540)%360)-180,observedAt:c.observedAt,ageSec:context.simTimeSec-c.observedAt,rangeM:Math.hypot(...c.position.map((v,i)=>v-unit.position[i])),meaning:'bearingDeg是从本机指向观测点的方向，目标velocity方向不是接敌航向；engage由本地程序持续对正'};}),
      tacticalAwareness:unit.tacticalAwareness,ownMissileAssessment:(unit.missileTelemetry.length?unit.missileTelemetry:flights).map(assessOwnMissile),incomingMissileAssessment:unit.incomingMissileAssessment,
      missileChoices:models.map(id=>{const m=MISSILE_MODELS.get(id);return {id,name:m.familyName,kind:m.kind,count:unit.weapons.inventory[id],warmupSec:m.seeker.warmupSec,maxTravelM:m.simulationLimits.maxTravelM,armingSec:m.proximityFuse.armingDelaySec,needsContinuousRadar:m.kind==='semi_active_radar',hasDatalink:!!m.guidance.datalink};})};
    payload.executionRequirements={persistentEngageAvailable:true,decisionLatencySec:Number.isFinite(observation.decisionLatencySec)?Math.max(0,Math.min(60,observation.decisionLatencySec)):3,engageMeaning:"一次选择目标/弹种/数量并授予45秒条件执行；程序准备、对正、跟踪，在实时授权和火控成立时发射；不等待下一次模型调用",selectionRequired:task.selectedModelId===null,defenseOwnsFlight:!!unit.rwrDefense?.active,observedTargetIds:contacts.filter(c=>c.classification!=='friendly').map(c=>c.id)};
    const key=createHash('sha256').update(JSON.stringify([context.revision,context.simTimeSec,payload,schema])).digest('hex');if(cache.has(key)){const cached=cache.get(key);return reply(cached.decision,false,cached.details);}
    const reading=decisionReading('attack',unit,{search:!contacts.some(c=>c.classification!=='friendly')||payload.searchAssessment.mustChangeSearch});
    const messages=[{role:'system',content:reading.text},{role:'user',content:JSON.stringify(payload)}];let decision,details;
    for(let attempt=0;attempt<2;attempt++){
      const result=await client.completePilot(messages,schema,{maxTokens:700,signal}),normalized=normalizeAttackProposal(result.value);decision=normalized.decision;details={knowledgeUsed:reading.files,promptVersion:reading.version,promptChars:reading.chars,originalModelDecision:result.value,normalizations:normalized.normalizations};
      try{if(!schema.properties.operation.enum.includes(decision.operation))throw Error('当前观测或控制权不允许此动作');validateAttackDecision(decision,unit,context.simTimeSec);if(decision.operation==='launch'&&!launchOptions.some(o=>o.ready&&o.modelId===decision.modelId&&o.targetId===decision.targetId))throw Error('当前实际发射机会尚未成立');break;}
      catch(error){if(attempt)throw new ApiError(502,'攻击判断未通过校验：'+error.message);messages.push({role:'assistant',content:JSON.stringify(decision)},{role:'user',content:'请按真实状态修正，只重发完整JSON：'+error.message});}
    }
    cache.set(key,{decision,details});if(cache.size>128)cache.delete(cache.keys().next().value);return reply(decision,true,details);
  };
}
