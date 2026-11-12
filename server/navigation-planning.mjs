import {validateAiNavigation} from '../sim/ai-navigation.js';
export const AI_NAVIGATION_RULES=`
你负责输出真实航点。根JSON增加latencyPredictionSec和navigationPlans；其他意图字段不变。navigationPlans每项{unitId,waypoints:[[东米,北米,海拔米],...]}，最多12点。只有fly_to、fly_heading及编译成这两种任务的巡航需要航点，其他任务给[]。
context.decisionTiming提供本次时钟、最近实测输出秒数和若干预测时刻。运行时先选择你预计完成输出所需的horizonsSec之一填latencyPredictionSec，使用对应forecasts中的本机预测机位规划。预测为近似值，执行前程序还会检查最新机位。暂停时latencyPredictionSec必须0，使用当前机位，完全不估计耗时、不做位移补偿。
航点由你选择和输出，不要求玩家绘制。fly_to必须按顺序经过指挥员指定的每个坐标和高度，最后一点是目的地；中间可自主设置转弯、爬升点。fly_heading终点=预测机位+[sin(航向)*距离,cos(航向)*距离]，高度为指定高度；未给距离使用20000米前视，持续航向由程序后续延伸。不要混用经纬度。为避免回追旧机位，不把当前或预测机位本身作为第一个航点。
本机navigationEnvelope的structuralMaxG、configurationMaxG、availableG、sustainableG和minimumTurnRadiusM来自飞机型号、实际质量、速度、高度、构型和能量。按这些数据选择转弯空间，不能假定所有机型统一2.6G或3G。可选择更平缓的机动，但不能自行设置一个全局过载上限。航点只是拟定，程序验证地形和可飞性后才装订；不得宣称已到达。`;
export function navigationSchema(schema,context){
  if(!context.decisionTiming)return schema;
  return {...schema,required:[...schema.required,'latencyPredictionSec','navigationPlans'],properties:{...schema.properties,
    latencyPredictionSec:{type:'number',enum:context.decisionTiming.horizonsSec},
    navigationPlans:{type:'array',maxItems:32,items:{type:'object',additionalProperties:false,required:['unitId','waypoints'],properties:{unitId:{type:'string',enum:context.units.map(u=>u.id)},waypoints:{type:'array',minItems:1,maxItems:12,items:{type:'array',minItems:3,maxItems:3,items:{type:'number'}}}}}}}};
}
export function navigationOutput(value,context){
  if(!context.decisionTiming&&!Object.hasOwn(value??{},'navigationPlans'))return {interpretation:value,validate:()=>[]};
  const {navigationPlans,latencyPredictionSec,...interpretation}=value;
  return {interpretation,latencyPredictionSec,validate:plan=>{
    if(plan.status!=='accepted'&&navigationPlans?.length)throw Error('当前意图未编译为可执行导航：'+plan.summary+'。请修正意图参数；fly_heading的eastM/northM必须null，坐标只放navigationPlans。确实无法执行时navigationPlans=[]。');
    return validateAiNavigation(navigationPlans,plan,context,latencyPredictionSec);
  }};
}
export function parseDecisionTiming(timing,units){
  if(timing===undefined)return undefined;
  const finite=Number.isFinite,vector=p=>Array.isArray(p)&&p.length===3&&p.every(finite);
  if(!timing||typeof timing.playing!=='boolean'||![1,2,4,8].includes(timing.rate)||!finite(timing.estimatedOutputSec)||timing.estimatedOutputSec<0||timing.estimatedOutputSec>60||
    !Array.isArray(timing.recentOutputSec)||timing.recentOutputSec.length>8||timing.recentOutputSec.some(n=>!finite(n)||n<0||n>60)||
    !Array.isArray(timing.horizonsSec)||!timing.horizonsSec.length||timing.horizonsSec.length>3||timing.horizonsSec.some(n=>!finite(n)||n<0||n>60)||
    !timing.playing&&(timing.estimatedOutputSec!==0||timing.horizonsSec.length!==1||timing.horizonsSec[0]!==0)||
    !Array.isArray(timing.forecasts)||timing.forecasts.length!==timing.horizonsSec.length)throw Error('输出延时预测无效');
  const forecasts=timing.forecasts.map((f,i)=>{
    if(f.outputSec!==timing.horizonsSec[i]||!finite(f.simTimeSec)||!Array.isArray(f.units)||f.units.length!==units.length||new Set(f.units.map(u=>u.id)).size!==units.length||f.units.some(u=>!units.some(v=>v.id===u.id)||!vector(u.position)||!vector(u.velocity)||typeof u.alive!=='boolean'))throw Error('预测机位无效');
    return {outputSec:f.outputSec,simTimeSec:f.simTimeSec,units:f.units.map(u=>({id:u.id,position:u.position,velocity:u.velocity,alive:u.alive,navigationEnvelope:u.navigationEnvelope}))};
  });
  return {playing:timing.playing,rate:timing.rate,estimatedOutputSec:timing.estimatedOutputSec,recentOutputSec:timing.recentOutputSec,horizonsSec:timing.horizonsSec,forecasts};
}
