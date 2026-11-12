import {validateContext,ApiError} from './qwen.mjs';
import {ATC_ACTIONS,validateAtcDecisions} from '../sim/atc-decisions.js';
import {aviationReading} from './aviation-terms.mjs';
function verifyTrafficFacts(decisions,snapshot){
  for(const d of decisions){
    const u=snapshot.traffic.find(u=>u.unitId===d.unitId),r=snapshot.runways.find(r=>r.designator===u?.runway),refs=text=>[...new Set(text.match(/\b\d{2}[LRC]\b/g)??[])].sort().join(',');
    if(refs(d.reasonZh)!==refs(d.reasonEn))throw Error('中英文建议提及的跑道编号不一致；两种语言必须陈述相同事实。');
    if(d.action==='change_taxi'&&d.taxiways.some(name=>!snapshot.taxiways.includes(name)))throw Error('taxiways必须使用实际滑行道名称，不能写等待点或内部节点。');
    if(r&&(snapshot.closed.includes(r.stripId)||snapshot.closed.includes(r.designator))&&d.action!=='continue'&&(!/关闭/.test(d.reasonZh)||!/CLOSED/i.test(d.reasonEn)))throw Error(`当前跑道${r.designator}已关闭，建议须在中英文明确说明关闭事实，不得声称正在使用或仅缺起飞许可。`);
  }
}
export function createTowerAssistant(client){
  return async(input,{signal}={})=>{
    if(typeof input?.requestId!=='string'||!/^[-\w]{1,80}$/.test(input.requestId))throw new ApiError(400,'塔台评估请求无效');
    const context=validateContext(input.context),snapshot=context.airportTraffic;
    if(!snapshot)throw new ApiError(400,'缺少机场全场态势');
    const unitIds=snapshot.traffic.map(u=>u.unitId);if(!unitIds.length)return {requestId:input.requestId,revision:context.revision,simTimeSec:context.simTimeSec,decisions:[],modelInvoked:false};
    const schema={type:'object',additionalProperties:false,required:['decisions'],properties:{decisions:{type:'array',maxItems:8,items:{type:'object',additionalProperties:false,
      required:['unitId','action','runway','taxiways','headingDeg','altitudeM','speedMps','priority','approachType','reasonZh','reasonEn'],properties:{
        unitId:{type:'string',enum:unitIds},action:{type:'string',enum:ATC_ACTIONS},runway:{type:['string','null'],enum:[null,...snapshot.runways.map(r=>r.designator)]},taxiways:{type:'array',maxItems:12,items:{type:'string',enum:snapshot.taxiways}},
        headingDeg:{type:['number','null'],minimum:0,maximum:360},altitudeM:{type:['number','null'],minimum:150,maximum:15000},speedMps:{type:['number','null'],minimum:70,maximum:400},
        priority:{type:'integer',minimum:0,maximum:100},approachType:{type:['string','null'],enum:[null,'visual','ils','rnav','overhead']},reasonZh:{type:'string',maxLength:180},reasonEn:{type:'string',maxLength:500}}}}}};
    const reading=aviationReading('塔台 地面滑行 跑道外等待 起飞 着陆 进近 复飞 管制许可 QNH ATIS',{compact:false});
    const messages=[{role:'system',content:'你是BAY虚构机场的管制参谋，玩家才是管制员。根据真实交通、意图、气象、跑道占用、许可和队列提出建议，只有玩家下达后才会执行。可建议排序、等待、改滑行路线、改跑道、雷达引导、进近类型及复飞，不替玩家授权。正常安全执行时continue，不重复制造建议。不能声称飞机已到等待点或已获许可，必须核对groundNode与phase。priority建议调整优先级，应急优先，不能降低紧急机优先级。地面冲突建议hold_ground或change_taxi（taxiways只能是路网实际滑行道名，不能写等待点H09L），不得逆向穿越交通。短五边保护、占用、尾流及性能由执行器核验，不可绕过。进近许可不等于着陆许可。vector只用于未进入最后进近的空中飞机，给完整headingDeg/altitudeM/speedMps，45秒后回原程序，不低于程序最低高度。支持ILS/RNAV/visual/overhead。lastModelError是上次校验失败原因，须修正。reasonZh/reasonEn为简洁航空通联，说明原因和拟执行安排，不能声称已完成。英文不夹中文，单位SI，只输出JSON。\n'+reading.text},
      {role:'user',content:JSON.stringify({source:'当前机场实际运行快照',criticalFacts:{closedRunways:snapshot.runways.filter(r=>snapshot.closed.includes(r.stripId)||snapshot.closed.includes(r.designator)).map(r=>r.designator),aircraft:snapshot.traffic.map(u=>({unitId:u.unitId,actualGroundNode:u.groundNode,phase:u.phase,assignedRunway:u.runway})),adviceOnly:true},airport:snapshot})}];
    let value,timing;
    for(let attempt=0;attempt<2;attempt++){
      ({value,timing}=await client.completePilot(messages,schema,{maxTokens:1800,signal}));
      try{validateAtcDecisions(value?.decisions,unitIds);verifyTrafficFacts(value.decisions,snapshot);break;}catch(error){if(attempt)throw new ApiError(502,error.message);messages.push({role:'assistant',content:JSON.stringify(value)},{role:'user',content:'协议核对失败：'+error.message+'。保留真实交通与任务，修正后重发完整JSON。'});}
    }
    return {requestId:input.requestId,revision:context.revision,simTimeSec:context.simTimeSec,decisions:value.decisions,modelInvoked:true,timing};
  };
}
