import {validateContext,ApiError} from './qwen.mjs';
import {attackContacts} from '../sim/attack-task.js';
import {TACTICAL_AWARENESS_RULES,compactTacticalUnit} from './tactical-awareness.mjs';
export function createDuelCommander(client){return async(input,{signal}={})=>{
 const context=validateContext(input?.context),own=context.units.filter(u=>u.alive),contacts=[...new Map(own.flatMap(u=>attackContacts(u,context.simTimeSec)).filter(c=>c.classification!=='friendly').map(c=>[c.id,c])).values()];
 if(own.length>2||!own.length)throw new ApiError(400,'2v2指挥需要一至两架存活友机');
 const orderSchema={type:'object',additionalProperties:false,required:['unitId','targetId','posture'],properties:{unitId:{enum:own.map(u=>u.id)},targetId:{enum:[null,...contacts.map(c=>c.id)]},posture:{enum:['attack','defend','search']}}};
 const schema={type:'object',additionalProperties:false,required:['orders','reason'],properties:{reason:{type:'string',maxLength:160},orders:{type:'array',maxItems:2,minItems:1,items:orderSchema}}};
 const result=await client.completePilot([{role:'system',content:'你是实时2v2空战红方指挥官。只基于友机状态和己方contacts给两架飞机分工。未知对手坐标与损伤；不要猜测。无接触先search，有观测可attack并明确targetId；可分头对敌或集中兵力。defend提出标准横切规避指令，要求本机存在有效RWR告警；程序仍会校验；有效威胁由本机即时自卫处理，明确冲突飞行指令优先，不等待本次指挥判断。search与defend的targetId必须null。全部分工经过与玩家相同的任务校验和装订，不代表已执行。既有导弹支持任务应保持，不反复重置相同任务。不宣称命中。输出JSON，orders至少一条。reason只用一句简短中文说明分工理由，建议60字以内，最多160字，不复述完整态势。'+ '\n'+TACTICAL_AWARENESS_RULES},{role:'user',content:JSON.stringify({time:context.simTimeSec,own:own.map(compactTacticalUnit),contacts})}],schema,{maxTokens:500,signal});
 const raw=result.value;
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!['orders','reason'].includes(key))||
   !Array.isArray(raw.orders)||raw.orders.length<1||raw.orders.length>2||typeof raw.reason!=='string')throw new ApiError(502,'指挥输出格式错误');
 const seen=new Set();
 for(const o of raw.orders){
   if(!o||typeof o!=='object'||Array.isArray(o)||Object.keys(o).some(key=>!['unitId','targetId','posture'].includes(key))||
     !own.some(u=>u.id===o.unitId)||seen.has(o.unitId)||!['attack','defend','search'].includes(o.posture)||
     o.targetId!==null&&!contacts.some(c=>c.id===o.targetId)||o.posture==='attack'&&o.targetId===null||o.posture!=='attack'&&o.targetId!==null)throw new ApiError(502,'指挥命令不符合当前观测');
   seen.add(o.unitId);
 }
 // Presentation text cannot invalidate otherwise legal tactical orders. Keep
 // their validation strict, and only normalize/shorten the explanatory string.
 // Avoid leaving a dangling UTF-16 high surrogate at the truncation boundary.
 const reason=raw.reason.replace(/\s+/g,' ').trim().slice(0,160).replace(/[\uD800-\uDBFF]$/,'');
 const d={orders:raw.orders.map(({unitId,targetId,posture})=>({unitId,targetId,posture})),reason};
 return {requestId:input.requestId,simTimeSec:context.simTimeSec,revision:context.revision,decision:d,modelInvoked:true};
};}
