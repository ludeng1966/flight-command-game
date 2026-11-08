import {ApiError,validateContext} from './qwen.mjs';
import {radarTaskEvent,validateRadarDecision,RADAR_DECISION_SCHEMA} from '../sim/radar-task.js';

const SYSTEM=`你是游戏飞机的飞行员，负责按mission自主操作雷达，玩家只下达搜索或持续跟踪任务。
只依据ownship、mission和本机radar.contacts判断；未显示的目标不可见，不得读取或猜测其他飞机真实位置。未知回波不是敌机，不授权开火。
operation=mode时mode选pd/pulse/off、targetId=null；lock时mode=null且targetId只能选本机新鲜航迹；unlock/hold时mode和targetId均为null。每次只操作一步，物理扫描、截获和掉锁由程序继续执行。
任务开始应自主选择搜索方式。PD有地面杂波速度门，SRC脉冲模式易受下视地面杂波遮蔽；结合最后实际回波、目标观测高度及lastReason判断，不机械反复切换。发现符合任务的航迹后可自主截获；搜索任务允许截获不明回波以持续观察。不得自主锁定已识别友机，除非mission明确指定跟踪该友机。不明目标不得自称敌机。
锁定稳定就hold；丢波时根据实际状态选择保持短时外推、解除后重新搜索或适合的模式。超出距离/角度/地形遮挡时，不能声称切模式会穿透地形。尚未探测到指定目标则继续搜索，不编造航迹或向玩家索要扫描模式。mode=off只能表示基于任务判断暂不主动发射，不能把雷达关闭说成任务完成。
message是玩家能看见、听见的飞行员通话，最多120字，简短说明当前判断与拟操作，不写JSON字段名。lock只说准备/开始截获，不能说已经锁定。真实锁定和掉锁会由物理状态另行通报。lastError是上次操作拒绝原因，必须据此调整。输出完整JSON。`;
export function createRadarPilot(client){
  const cache=new Map();
  return async(input,{signal}={})=>{
    if(!input||typeof input.requestId!=='string'||!/^[-\w]{1,80}$/.test(input.requestId))throw new ApiError(400,'雷达判断请求无效');
    const context=validateContext(input.context),unit=context.units.find(u=>u.id===input.unitId);
    if(!unit||!unit.radarTask||input.taskId!==unit.radarTask.id)throw new ApiError(409,'雷达任务已变化');
    const event=radarTaskEvent(unit,context.simTimeSec);
    const reply=(decision,modelInvoked)=>({requestId:input.requestId,revision:context.revision,simTimeSec:context.simTimeSec,taskId:unit.radarTask.id,
      controlSequence:unit.radar.controlSequence,event,decision,modelInvoked});
    if(!event)return reply(null,false);
    const key=JSON.stringify([unit.id,unit.radarTask.id,event.key,unit.radarTask.decisionCount,context.revision,unit.radar.phase,unit.radar.lastReason,unit.radar.contacts.map(c=>[c.id,c.observedAt])]);
    if(cache.has(key))return reply(cache.get(key),false);
    const schema=structuredClone(RADAR_DECISION_SCHEMA);schema.properties.targetId.enum=[null,...unit.radar.contacts.filter(c=>context.simTimeSec-c.observedAt<=2.25).map(c=>c.id)];
    const messages=[{role:'system',content:SYSTEM},{role:'user',content:JSON.stringify({event,mission:unit.radarTask,
      ownship:{callsign:unit.callsign,position:unit.position,headingDeg:unit.headingDeg,speedMps:unit.speedMps,grounded:unit.grounded},radar:unit.radar})}];
    let decision;
    for(let attempt=0;attempt<2;attempt++){
      const result=await client.completePilot(messages,schema,{maxTokens:500,signal});decision=result.value;
      try{validateRadarDecision(decision,unit,context.simTimeSec);break;}
      catch(error){if(attempt)throw new ApiError(502,'雷达判断未通过校验：'+error.message);messages.push({role:'assistant',content:JSON.stringify(decision)},{role:'user',content:'请修正方案后输出完整JSON：'+error.message});}
    }
    cache.set(key,decision);if(cache.size>128)cache.delete(cache.keys().next().value);return reply(decision,true);
  };
}
