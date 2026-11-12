import {decisionReading} from './pilot-decision-reading.mjs';
import {teamGuidanceContext} from '../sim/tactical-guidance.js';
import {validateContext,ApiError} from './qwen.mjs';
import {compactRadar} from './tactical-awareness.mjs';
import {defenseReviewEvent} from '../sim/rwr-defense.js';
import {assessDefenseOptions} from '../sim/defense-assessment.js';
export const RWR_DECISION_SCHEMA={type:'object',additionalProperties:false,required:['maneuver','side','message'],properties:{maneuver:{enum:['notch','extend','maintain']},side:{enum:['auto','left','right']},message:{type:'string',maxLength:120}}};
export function validateRwrDecision(d){
  if(!d||Object.keys(d).length!==3||!['notch','extend','maintain'].includes(d.maneuver)||!['auto','left','right'].includes(d.side)||typeof d.message!=='string'||!d.message.trim()||d.message.length>120||/已(?:经)?(?:规避|脱离|躲过|击败)|剩余\d|\d+\s*(?:秒命中|公里|千米)|箔条|热焰弹|干扰(?:机|弹)|chaff|flare|jammer/i.test(d.message))throw Error('告警判断不能声称已经避开导弹、虚构距离/命中时间或提出未接入动作');return d;
}
export function createRwrPilot(client){
  const cache=new Map();
  return async(input,{signal}={})=>{
    if(!input||typeof input.requestId!=='string'||!/^[-\w]{1,80}$/.test(input.requestId))throw new ApiError(400,'RWR判断请求无效');
    const context=validateContext(input.context),u=context.units.find(u=>u.id===input.unitId),d=u?.rwrDefense,e=d?.episode;
    if(!u?.rwr?.available||!e||input.episodeKey!==e.key||input.controlSequence!==d.controlSequence)throw new ApiError(409,'告警或玩家指令已变化');
    const reply=(decision,modelInvoked)=>({requestId:input.requestId,revision:context.revision,simTimeSec:context.simTimeSec,unitId:u.id,episodeKey:e.key,controlSequence:d.controlSequence,decision,modelInvoked});
    if(!defenseReviewEvent(u,context.simTimeSec))return reply(null,false);
    const key=JSON.stringify([u.id,e.key,e.firstSeen,e.bearingDeg,d.controlSequence,context.revision,u.headingDeg,u.position[2],e.reviewedAt??null,defenseReviewEvent(u,context.simTimeSec),d.active]);if(cache.has(key))return reply(cache.get(key),false);
    const reading=decisionReading('defense',u);
    const messages=[{role:'system',content:reading.text},
      {role:'user',content:JSON.stringify({teamMembers:teamGuidanceContext(context,u),tacticalGuidance:u.tacticalGuidance,ownship:{callsign:u.callsign,headingDeg:u.headingDeg,speedMps:u.speedMps,altitudeM:u.position[2],maxG:u.maxG,navigationEnvelope:u.navigationEnvelope,telemetry:u.telemetry},rwr:u.rwr,radar:compactRadar(u.radar),defense:d,defenseAssessment:assessDefenseOptions(u,context.simTimeSec),tacticalAwareness:u.tacticalAwareness,ownMissileAssessment:u.ownMissileAssessment,incomingMissileAssessment:u.incomingMissileAssessment})}];
    let decision;for(let attempt=0;attempt<2;attempt++){
      const result=await client.completePilot(messages,RWR_DECISION_SCHEMA,{maxTokens:400,signal});decision=result.value;
      try{validateRwrDecision(decision);if(decision.maneuver==='maintain'&&!d.active)throw Error('尚未执行规避，不能保持不存在的动作');break;}catch(error){if(attempt)throw new ApiError(502,error.message);messages.push({role:'assistant',content:JSON.stringify(decision)},{role:'user',content:'请修正：'+error.message});}
    }
    cache.set(key,decision);if(cache.size>128)cache.delete(cache.keys().next().value);return reply(decision,true);
  };
}
