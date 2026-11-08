import {validateContext,ApiError} from './qwen.mjs';
export const RWR_DECISION_SCHEMA={type:'object',additionalProperties:false,required:['maneuver','side','message'],properties:{maneuver:{enum:['notch','extend']},side:{enum:['auto','left','right']},message:{type:'string',maxLength:120}}};
export function validateRwrDecision(d){
  if(typeof d?.message==='string'&&/立即|立刻|马上/.test(d.message))throw Error('自动处置仍须等待玩家指令，建议只能用于等待结束后，不使用立即执行措辞');
  if(!d||Object.keys(d).length!==3||!['notch','extend'].includes(d.maneuver)||!['auto','left','right'].includes(d.side)||typeof d.message!=='string'||!d.message.trim()||d.message.length>120||/已(?:经)?(?:规避|脱离|躲过|击败)|剩余\d|\d+\s*(?:秒命中|公里|千米)|箔条|热焰弹|干扰机/.test(d.message))throw Error('告警判断不能声称已经避开导弹、虚构距离/命中时间或提出未接入动作');return d;
}
export function createRwrPilot(client){
  const cache=new Map();
  return async(input,{signal}={})=>{
    if(!input||typeof input.requestId!=='string'||!/^[-\w]{1,80}$/.test(input.requestId))throw new ApiError(400,'RWR判断请求无效');
    const context=validateContext(input.context),u=context.units.find(u=>u.id===input.unitId),d=u?.rwrDefense,e=d?.episode;
    if(!u?.rwr?.available||!e||input.episodeKey!==e.key||input.controlSequence!==d.controlSequence)throw new ApiError(409,'告警或玩家指令已变化');
    const reply=(decision,modelInvoked)=>({requestId:input.requestId,revision:context.revision,simTimeSec:context.simTimeSec,unitId:u.id,episodeKey:e.key,controlSequence:d.controlSequence,decision,modelInvoked});
    if(d.mode!=='auto'||e.playerOverride||d.suspended||e.reviewed||!u.rwr.contacts.some(c=>c.id===e.contactId&&c.epoch===e.epoch&&c.ageSec<2.5))return reply(null,false);
    const key=JSON.stringify([u.id,e.key,e.firstSeen,e.bearingDeg,d.controlSequence,context.revision,u.headingDeg,u.position[2]]);if(cache.has(key))return reply(cache.get(key),false);
    const messages=[{role:'system',content:'你是游戏飞行员，判断已接收到的雷达告警，提出等待结束后的自卫建议。只读ownship、rwr和defense中的实际观测。RWR只给近似方位、信号等级和时间，没有距离、高度、精确位置、敌我身份或剩余命中时间；不能编造。search是搜索照射，track是被跟踪，launch是识别出的照射/主动导引头信号，不能认定所有告警都是射向本机的导弹。被动红外弹没有RWR发射告警。notch是相对辐射源横切，extend是背向拉开；这两项不保证成功，受真实飞控、地形和能量限制。选择一种建议和左右方向；一般持续雷达威胁可优先notch，结合当前状态判断，不虚构其他动作。玩家指令和只报告模式优先；程序控制等待时间，不能要求立即抢夺玩家控制，不增加开火、箔条或热焰弹。message以“拟”或“建议”说明依据，最多120字，不说已避开、已脱离或已消灭威胁。输出完整JSON。'},
      {role:'user',content:JSON.stringify({ownship:{callsign:u.callsign,headingDeg:u.headingDeg,speedMps:u.speedMps,altitudeM:u.position[2],maxG:u.maxG},rwr:u.rwr,defense:d})}];
    messages[0].content+='\n本游戏横切只尝试在对方PD雷达有地面杂波时进入径向速度门，不会减弱辐射功率或信号强度，不保证离开雷达波束，RWR仍可能继续收到照射。没有证据时只能说尝试横切，不肯定对方是PD或必然进入速度门。';
    let decision;for(let attempt=0;attempt<2;attempt++){
      const result=await client.completePilot(messages,RWR_DECISION_SCHEMA,{maxTokens:400,signal});decision=result.value;
      try{validateRwrDecision(decision);break;}catch(error){if(attempt)throw new ApiError(502,error.message);messages.push({role:'assistant',content:JSON.stringify(decision)},{role:'user',content:'请修正：'+error.message});}
    }
    cache.set(key,decision);if(cache.size>128)cache.delete(cache.keys().next().value);return reply(decision,true);
  };
}
