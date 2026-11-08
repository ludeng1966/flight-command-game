import {validateContext,ApiError} from './qwen.mjs';
import {ATC_ACTIONS,validateAtcDecisions} from '../sim/atc-decisions.js';
import {aviationReading} from './aviation-terms.mjs';
export function createTowerAssistant(client){
  return async(input,{signal}={})=>{
    if(typeof input?.requestId!=='string'||!/^[-\w]{1,80}$/.test(input.requestId))throw new ApiError(400,'塔台评估请求无效');
    const context=validateContext(input.context),snapshot=context.airportTraffic;
    if(!snapshot)throw new ApiError(400,'缺少机场全场态势');
    const unitIds=snapshot.traffic.map(u=>u.unitId);if(!unitIds.length)return {requestId:input.requestId,revision:context.revision,simTimeSec:context.simTimeSec,decisions:[],modelInvoked:false};
    const schema={type:'object',additionalProperties:false,required:['decisions'],properties:{decisions:{type:'array',maxItems:8,items:{type:'object',additionalProperties:false,
      required:['unitId','action','runway','taxiways','headingDeg','altitudeM','speedMps','priority','approachType','reasonZh','reasonEn'],properties:{
        unitId:{type:'string',enum:unitIds},action:{type:'string',enum:ATC_ACTIONS},runway:{type:['string','null'],enum:[null,...snapshot.runways.map(r=>r.designator)]},taxiways:{type:'array',maxItems:12,items:{type:'string'}},
        headingDeg:{type:['number','null'],minimum:0,maximum:360},altitudeM:{type:['number','null'],minimum:150,maximum:15000},speedMps:{type:['number','null'],minimum:70,maximum:400},
        priority:{type:'integer',minimum:0,maximum:100},approachType:{type:['string','null'],enum:[null,'visual','ils','rnav','overhead']},reasonZh:{type:'string',maxLength:180},reasonEn:{type:'string',maxLength:500}}}}}};
    const reading=aviationReading('塔台 地面滑行 跑道外等待 起飞 着陆 进近 复飞 管制许可 QNH ATIS',{compact:false});
    const messages=[{role:'system',content:'你是BAY虚构机场的全场管制员，负责根据真实交通、意图、气象、跑道占用、许可和队列主动安排安全高效运行。可以自主决定排序、等待、改滑行路线、改跑道、雷达引导、进近类型及复飞，不必每次等玩家重新下令。正常正在安全执行时continue，不重复制造新指令。priority调整队列优先级，应急/燃油紧急优先；不能降低紧急机优先级。地面冲突用hold_ground或change_taxi（taxiways为实际滑行道名），不能让飞机逆向穿过迎面交通。短五边保护、跑道占用、尾流及飞机性能由执行器强制核验，不可绕过。进近许可不等于着陆许可，后者由实际可用状态单独签发。vector只用于尚未进入最后进近的空中飞机，给完整headingDeg/altitudeM/speedMps，45秒后回原程序；不得把程序最低高度以下当作等待高度。可按可见度/云底/侧风改进近程序或跑道，ILS/RNAV/visual/overhead已接入。lastModelError是上一决定校验失败原因，须据此修正。reasonZh与reasonEn均使用简洁航空通联，说明原因和拟执行安排，不声称已经完成。英文不得夹中文；单位SI。只输出JSON。\n'+reading.text},
      {role:'user',content:JSON.stringify({source:'当前机场实际运行快照',airport:snapshot})}];
    let value,timing;
    for(let attempt=0;attempt<2;attempt++){
      ({value,timing}=await client.completePilot(messages,schema,{maxTokens:1800,signal}));
      try{validateAtcDecisions(value?.decisions,unitIds);break;}catch(error){if(attempt)throw new ApiError(502,error.message);messages.push({role:'assistant',content:JSON.stringify(value)},{role:'user',content:'协议核对失败：'+error.message+'。保留真实交通与任务，修正后重发完整JSON。'});}
    }
    return {requestId:input.requestId,revision:context.revision,simTimeSec:context.simTimeSec,decisions:value.decisions,modelInvoked:true,timing};
  };
}
