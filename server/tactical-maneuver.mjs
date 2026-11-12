import {ApiError,validateContext} from './qwen.mjs';
import {DIRECT_MANEUVERS,GUIDANCE_RULES,OFFENSE_POLICIES,DEFENSE_POLICIES} from '../sim/tactical-guidance.js';
const vector=p=>Array.isArray(p)&&p.length===3&&p.every(Number.isFinite)&&Math.abs(p[0])<=200000&&Math.abs(p[1])<=200000&&p[2]>=500&&p[2]<=15000;
export function validateManeuverProposal(p,{stage,resumePoint=null}={}){
  if(!p||!['execute','unable'].includes(p.status)||!Array.isArray(p.waypoints)||p.waypoints.length>8||!p.waypoints.every(vector)||!Number.isFinite(p.speedMps)||p.speedMps<400/3.6||p.speedMps>2400/3.6)throw Error('机动方案格式无效');
  for(const k of ['purposeZh','purposeEn','reasonZh','reasonEn','recoveryZh','recoveryEn'])if(typeof p[k]!=='string'||!p[k].trim()||p[k].length>300)throw Error('机动目的或复位说明缺失');
  if(p.status==='unable'&&p.waypoints.length||p.status==='execute'&&!p.waypoints.length)throw Error('机动状态与航路不一致');
  if(p.status==='execute'&&stage==='recover'&&resumePoint&&Math.hypot(...p.waypoints.at(-1).map((v,i)=>v-resumePoint[i]))>.5)throw Error('复位航路必须接回原任务下一目标点');
  return p;
}
export function createTacticalManeuver(client){return async(input,{signal}={})=>{
  const context=validateContext(input?.context),unit=context.units.find(u=>u.id===input.unitId);
  if(!unit||typeof input.requestId!=='string'||!/^[-\w]{1,100}$/.test(input.requestId)||!Object.hasOwn(DIRECT_MANEUVERS,input.maneuver)||!['execute','recover'].includes(input.stage)||input.resumePoint!=null&&!vector(input.resumePoint))throw new ApiError(400,'直接机动请求无效');
  const schema={type:'object',additionalProperties:false,required:['status','waypoints','speedMps','purposeZh','purposeEn','reasonZh','reasonEn','recoveryZh','recoveryEn'],properties:{status:{enum:['execute','unable']},waypoints:{type:'array',maxItems:8,items:{type:'array',minItems:3,maxItems:3,items:{type:'number'}}},speedMps:{type:'number',minimum:400/3.6,maximum:2400/3.6},...Object.fromEntries(['purposeZh','purposeEn','reasonZh','reasonEn','recoveryZh','recoveryEn'].map(k=>[k,{type:'string',maxLength:300}]))}};
  const guidance=unit.tacticalGuidance;
  const payload={stage:input.stage,maneuver:input.maneuver,maneuverIntent:DIRECT_MANEUVERS[input.maneuver],offense:OFFENSE_POLICIES[guidance.offense],defense:DEFENSE_POLICIES[guidance.defense],ownship:unit,teamMembers:context.units.filter(u=>guidance.group?.unitIds.includes(u.id)||unit.flightRole?.partnerId===u.id).map(u=>({id:u.id,callsign:u.callsign,position:u.position,headingDeg:u.headingDeg,speedMps:u.speedMps,guidance:u.tacticalGuidance,formation:u.formation,attackTask:u.attackTask,defense:u.rwrDefense})),resumePoint:input.resumePoint??null};
  const messages=[{role:'system',content:`你是本游戏飞行员。${GUIDANCE_RULES}
直接机动必须理解当前方针和原任务的目的，规划可执行三维航点与速度，解释原因及复位方案。execute阶段按指定左右方向/支援意图规划有限机动，不变成永久新任务；recover阶段按当前真实位置回接原任务，resumePoint有值时最后一点必须精确为它，可补中间点但不能更换任务目的地。无原航点时结合当前航向与原攻击任务规划稳定的恢复段，恢复后原任务继续。notch_left/right、extend的紧急动作由本地自卫执行器执行，你提供任务目的与恢复规划；crank_left/right需要本机当前有效目标观测且考虑武器支援，不得使用敌机隐藏位置。不能满足直接要求时unable，航点空，理由使用航空无法执行措辞。所有坐标仅为游戏米制，范围±200000、高度500至15000，还要遵守ownship.navigationEnvelope、地形与机场管制，程序校验后执行。waypoints最多8点；不得直接修改位置或放宽目标、武器、弹量授权。每项说明同时给简短中文与英文航空通话，说明拟做什么，不能声称机动已经完成。`},{role:'user',content:JSON.stringify(payload)}];
  const {value}=await client.completePilot(messages,schema,{maxTokens:1600,signal});
  try{validateManeuverProposal(value,input);}catch(error){throw new ApiError(502,error.message);}
  return {requestId:input.requestId,revision:context.revision,simTimeSec:context.simTimeSec,...value};
};}
