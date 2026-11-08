import {ApiError,validateContext} from './qwen.mjs';
import {MISSILE_MODELS} from '../sim/missiles.js';
import {attackTaskEvent,attackContacts,allowedAttackModels,validateAttackDecision,ATTACK_DECISION_SCHEMA} from '../sim/attack-task.js';

const SYSTEM=`你是游戏电脑飞行员，玩家只下达攻击任务，你自主完成搜索、跟踪、选弹、准备、发射时机与必要攻击飞行。
只能使用本机雷达/光学已观测contacts和当前武器状态，不知道其他目标的隐藏真值。已识别友机禁止攻击；点名的targetId/targetRef不得偷换。没有目标回波先自主搜索，不要求玩家设置雷达模式或手工锁定。
每次只决定一步。operation可为radar_mode（mode=pd/pulse/off），radar_lock（targetId为有效航迹），radar_unlock，select（modelId及targetId，选择并准备该目标），launch（当前已选择且准备好的modelId、targetId、quantity），maneuver（targetId及headingDeg、altitudeM、speedMps），wait或abort。其他不使用的字段必须null。
任务是攻击授权，不是立即扣扳机。结合missileChoices的引导方式、距离、闭合率、截获状态、剩余弹量与launchOptions，自己选择型号和发射时机。雷达弹先稳定跟踪；红外弹可根据本机光学航迹准备导引头。需要准备时先select，然后等待真实ready。maxTravelM是模型航程限制，不是必达射程或保证命中的距离。launchOptions.ready只表示程序当前允许发射，你仍可wait或改善几何后再打。俯视地面背景时pulse受杂波影响，PD可以过滤杂波但有速度门；依据真实观测和lastError选择，不能因pulse锁定失败不断重试同一操作。
发射数量不超过任务shotLimit剩余额度；未指定时默认每次任务最多两枚，你可以只发一枚。已有本任务导弹在空时先维持支持、观察结果，不重复连发；半主动弹需持续雷达支持，主动弹尚未自主寻的时也应保持必要支持。发射不等于命中，只有真实命中反馈才能称完成；miss/expired/impact/spent不是命中，可按剩余额度和当前航迹决定补射。
maneuver可建立搜索航段，也可根据实际观测改善攻击几何。处于orbit且尚未建立搜索航段时，优先maneuver(targetId=null)建立沿mission.searchHeadingDeg的直线搜索航段，自主安排适当高度速度，避免雷达随盘旋转向而漏掉任务开始时的前方；这是搜索飞行，不代表已发现目标。已有对正航路不重复改航。searchLegEstablished=true且雷达off时应接着选择搜索模式，search_sensors事件不是要求再次maneuver。追踪已发现目标的maneuver才填写其targetId；未发现前不能猜目标位置。尊重玩家明确飞行约束和编队职责，程序验证地形与气动，不可瞬移或直接补速度。即使默认挂载恰好合适，本任务也必须先select明确选择型号与目标，才允许launch。
message最多120字，是玩家能看到听到的通话，只说明本次operation的判断与拟操作。maneuver不切换雷达，radar_lock不选弹，wait不解除雷达，不能把另一个动作说成本次已执行。不能提前宣称已发射、已锁定或已命中，真实结果另有通报。lastError是上次拒绝原因，必须修正后再试。只有无弹、任务无法继续或目标确实无法识别时abort，并说明原因；不要把正常的等待准备当成失败。`;
export function createAttackPilot(client){
  const cache=new Map();
  return async(input,{signal}={})=>{
    if(!input||typeof input.requestId!=='string'||!/^[-\w]{1,80}$/.test(input.requestId))throw new ApiError(400,'攻击判断请求无效');
    const context=validateContext(input.context),unit=context.units.find(u=>u.id===input.unitId),task=unit?.attackTask;
    if(!task?.active||task.id!==input.taskId)throw new ApiError(409,'攻击任务已变化');
    const event=attackTaskEvent(unit,context.simTimeSec),reply=(decision,modelInvoked)=>({requestId:input.requestId,revision:context.revision,simTimeSec:context.simTimeSec,taskId:task.id,decisionCount:task.decisionCount,event,decision,modelInvoked});
    if(!event)return reply(null,false);
    const contacts=attackContacts(unit,context.simTimeSec),models=allowedAttackModels(unit,task),observation=input.observation;
    if(!observation||!Array.isArray(observation.launchOptions)||observation.launchOptions.length>64||!Array.isArray(observation.flights)||observation.flights.length>4)throw new ApiError(400,'攻击观测无效');
    const launchOptions=observation.launchOptions.map(o=>{if(!o||!models.includes(o.modelId)||!contacts.some(c=>c.id===o.targetId)||typeof o.ready!=='boolean'||typeof o.reason!=='string'||o.reason.length>160||!Number.isFinite(o.rangeM)||o.rangeM<0||!Number.isFinite(o.closingMps)||Math.abs(o.closingMps)>4000)throw new ApiError(400,'发射机会观测无效');return {modelId:o.modelId,targetId:o.targetId,ready:o.ready,reason:o.reason,rangeM:o.rangeM,closingMps:o.closingMps};});
    const flights=observation.flights.map(m=>{if(!m||!task.firedMissileIds.includes(m.id)||!MISSILE_MODELS.has(m.modelId)||typeof m.alive!=='boolean'||typeof m.phase!=='string'||m.phase.length>40||!Number.isFinite(m.ageSec)||m.ageSec<0||!Number.isFinite(m.speedMps)||m.speedMps<0||typeof m.active!=='boolean'||typeof m.needsRadarSupport!=='boolean')throw new ApiError(400,'在空导弹观测无效');return {id:m.id,modelId:m.modelId,targetId:m.targetId,alive:m.alive,phase:m.phase,ageSec:m.ageSec,speedMps:m.speedMps,active:m.active,needsRadarSupport:m.needsRadarSupport};});
    const key=JSON.stringify([unit.id,task.id,task.decisionCount,task.retryCount,context.revision,event.signature]);if(cache.has(key))return reply(cache.get(key),false);
    const schema=structuredClone(ATTACK_DECISION_SCHEMA);schema.properties.modelId.enum=[null,...models];schema.properties.targetId.enum=[null,...contacts.map(c=>c.id)];
    if(unit.radar?.phase==='locked'&&(!task.engagedTargetId||unit.radar.targetId===task.engagedTargetId))schema.properties.operation.enum=schema.properties.operation.enum.filter(op=>op!=='radar_lock');
    schema.properties.mode.enum=schema.properties.mode.enum.filter(mode=>mode===null||mode!==unit.radar?.mode);
    const payload={event,mission:task,ownship:{id:unit.id,callsign:unit.callsign,position:unit.position,headingDeg:unit.headingDeg,speedMps:unit.speedMps,grounded:unit.grounded,formation:unit.formation,flightTask:unit.task},
      radar:unit.radar,weapons:unit.weapons,contacts,launchOptions,flights,missileChoices:models.map(id=>{const m=MISSILE_MODELS.get(id);return {id,name:m.familyName,kind:m.kind,count:unit.weapons.inventory[id],warmupSec:m.seeker.warmupSec,maxTravelM:m.simulationLimits.maxTravelM,armingSec:m.proximityFuse.armingDelaySec,needsContinuousRadar:m.kind==='semi_active_radar',hasDatalink:!!m.guidance.datalink};})};
    const messages=[{role:'system',content:SYSTEM},{role:'user',content:JSON.stringify(payload)}];let decision;
    for(let attempt=0;attempt<2;attempt++){
      const result=await client.completePilot(messages,schema,{maxTokens:700,signal});decision=result.value;
      try{validateAttackDecision(decision,unit,context.simTimeSec);if(decision.operation==='launch'&&!launchOptions.some(o=>o.ready&&o.modelId===decision.modelId&&o.targetId===decision.targetId))throw Error('当前实际发射机会尚未成立');break;}
      catch(error){if(attempt)throw new ApiError(502,'攻击判断未通过校验：'+error.message);messages.push({role:'assistant',content:JSON.stringify(decision)},{role:'user',content:'请按真实状态修正，只重发完整JSON：'+error.message});}
    }
    cache.set(key,decision);if(cache.size>128)cache.delete(cache.keys().next().value);return reply(decision,true);
  };
}
