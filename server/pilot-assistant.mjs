import {receivedCommanderMessage,normalizedCommanderTranscript,decodedCommanderParameters,bindCommanderNumbers,verifyCommanderHeading,verifyCommanderNumbers,verifyCommanderAirportInstruction} from '../sim/commander-message.js';
import {LocalAiRuntime} from './local-ai-runtime.mjs';
import {ApiError,validateContext} from './qwen.mjs';
import {pilotEvent,TACTICAL_INTENTS} from '../sim/pilot-watch.js';
import {parseRadarContext} from '../sim/radar.js';
import {radarMissionTaskFor} from '../sim/radar-task.js';
import {attackMissionTaskFor} from '../sim/attack-task.js';
import {ATTACK_TASK_RULES,verifyAttackTaskInterpretation} from './attack-rules.mjs';
import {parseWeaponsContext} from '../sim/weapons.js';
import {pilotReading,readPilotFile} from './pilot-handbook.mjs';
import {aviationReading,appendAviationReading} from './aviation-terms.mjs';
import {commandById,missingCapabilities} from '../sim/military-commands.js';
import {validatePlan} from '../sim/orders.js';
import {validateMilitaryInterpretation,normalizeMilitaryInterpretation,groundCooperation,compileMilitaryInterpretation,militarySchemaFor,PILOT_SYSTEM} from './military-planner.mjs';
import {inspectCommandResult,validateResultReadbacks,RESULT_VERDICTS} from '../sim/pilot-result.js';
import {unitPolicy} from '../sim/units.js';
import {ATC_INTENTS,atcTaskFor} from '../sim/atc-command.js';
import {englishResultReadback} from '../sim/result-language.js';
import {validateExecutionObservation,validatePilotAdjustment} from '../sim/pilot-execution.js';
import {navigationSchema,navigationOutput,AI_NAVIGATION_RULES} from './navigation-planning.mjs';

const receivedCommand=input=>{try{return receivedCommanderMessage(input);}catch(error){throw new ApiError(400,error.message);}};

const decisions=['continue_autopilot','request_data','notify_commander'];
const schema={type:'object',additionalProperties:false,required:['decision','message','missingData'],properties:{
  decision:{type:'string',enum:decisions},message:{type:'string',maxLength:180},missingData:{type:'array',maxItems:6,items:{type:'string',maxLength:80}}}};

export class PilotAssistant{
  constructor(root,options={}){
    this.model=options.model??'Qwen3.5-2B-Q4_K_M';this.provider=options.provider??'local';
    this.factory=options.runtimeFactory??(()=>new LocalAiRuntime(root,{gpuLayers:options.gpuLayers??99}));
    this.runtime=null;this.status='sleeping';this.queue=Promise.resolve();this.pending=0;this.calls=0;this.wakes=0;this.last=null;this.peakDedicatedMiB=0;this.closed=false;
    this.cache=new Map();
    this.resultChecks=0;this.lastResultCheck=null;
  }
  health(){return {enabled:true,commandPlanning:true,status:this.status,model:this.model,provider:this.provider,mode:'planning_events_and_results',pid:this.runtime?.health().pid??null,
    memory:{dedicatedMiB:this.runtime?.health().memory?.dedicatedMiB??0,peakDedicatedMiB:this.peakDedicatedMiB,budgetMiB:this.provider==='local'?1900:0},
    pending:this.pending,modelCalls:this.calls,wakeCount:this.wakes,lastAssessment:this.last,resultChecks:this.resultChecks,lastResultCheck:this.lastResultCheck};}
  async planCommand(input,{signal}={}){
    const commanderMessage=receivedCommand(input),instruction=commanderMessage.text;
    const context=validateContext(input?.context);
    if(typeof input.requestId!=='string'||!/^[-\w]{1,80}$/.test(input.requestId)||typeof instruction!=='string'||!instruction.trim()||instruction.length>4000)throw new ApiError(400,'飞行员任务规划请求无效');
    if(this.closed)throw new ApiError(503,'飞行员服务已停止');if(this.pending>=4)throw new ApiError(429,'飞行员正在处理其他任务');this.pending++;
    const operation=this.queue.catch(()=>{}).then(async()=>{
      signal?.throwIfAborted();this.runtime=this.factory();const runtime=this.runtime;this.status='planning_command';this.wakes++;
      const cancel=()=>void runtime.stop();signal?.addEventListener('abort',cancel,{once:true});
      try{
        await runtime.start();signal?.throwIfAborted();
        const reading=pilotReading(instruction,{compact:this.provider==='local'});
        const messages=[{role:'system',content:PILOT_SYSTEM+'\n你现在承担飞行员规划角色。本次只处理指挥员或塔台已经播报的commanderMessage.text；它是你的接令依据，不读取玩家输入，也不按未播报的候选参数补回原始指令。normalizedTranscript只把同一段指挥通话中的逐位数字规范化，不是另一条指令。除非命令明显离谱、对象不存在或缺少不可推断的关键目标，否则接收任务，自行安排常规推力、速度、爬升与航路细节；不能要求玩家画中间航点。当前已接入减推力起飞（takeoff+mode=reduced_thrust），随后由你从实际物理候选选择油门/加力与离场航路，即使通用发动机管理power尚未全部接入也可使用这项专门能力。不得把reduced_thrust丢掉或声称已经起飞；玩家没有限制推力时，你可自主选择标准或减推力方案，并用mode表达你的规划选择，不把它声称为玩家明确要求。保留原话所有目标、条件和约束，不增加原话没有的新任务。不能凭空实现武器、传感器等未接入执行器，仍完整表达意图让程序报告真实能力。玩家要求报告状态是report_status+request。输出同一军事意图协议JSON。\n'+reading.text},{role:'user',content:JSON.stringify({commanderMessage,normalizedTranscript:normalizedCommanderTranscript(commanderMessage),decodedFlightParameters:decodedCommanderParameters(commanderMessage),context})}];
        messages[0].content+='\n所有特定要求都先由你理解和判断，不限于减推力。你可以自主选择合理速度、高度、推力方案、既有动作的组合与航路安排；用已有参数/动作完整表达已理解的要求，不要把能通过规划完成的要求当作新功能拒绝。已通过参数/动作表达的要求不重复放进constraints导致误报不支持；未能落实的硬性要求必须保留，不能静默丢掉。确实听不懂时status=needs_clarification或unknown、orders=[]，summary必须点名哪一项未理解并说明本次不执行什么；不能只泛泛回答“无法解析”。无法执行的说明使用航空通联措辞“指令不明、无法执行、请重发、请求重新指示”，不用“听不懂”等聊天措辞。不要把任何不熟悉的词机械替换为默认起飞/巡航。';
        messages[0].content+='\n指挥员播报中的近似数值就是本次接令数值。decodedFlightParameters是程序从同一段通话解码并换算为SI的明确参数，应直接复制到对应字段，不要重新换算或另行取整。按通话规划，不恢复玩家原始换算值。未在通话提及的细节可以结合实况合理规划，不能把玩家未播报的约束或意图补进来。';
        messages[0].content+='\n界面不再提供高度和速度滑块。空中巡航、待命和独立导航中，未指定的高度与速度由你依据任务、当前飞行状态、地形余量和飞机能力自主选取，并写入已有任务的altitudeM/speedMps；不要求玩家补填这些常规飞行参数，也不把context中的旧目标当成玩家硬性命令。明确保持当前高度/速度时应保持；明确指定数值必须遵守。已有三维航路各点高度、编队相对位置及机场进近限制属于原任务约束，不得为了自主选择而拉平航路或改写许可。';
        let response,interpretation,pilotNavigationPlans=[],latencyPredictionSec=0;
        if(context.decisionTiming)messages[0].content+=AI_NAVIGATION_RULES;
        messages[0].content+='\n'+ATTACK_TASK_RULES;
        messages[0].content+='\n“攻击前方目标”“攻击搜索发现的目标”等已给出任务目标描述，足以接收attack：targetRef保留描述，targetId可为null，由攻击执行阶段先搜索发现。当前没有目标编号、回波或导弹尚未准备都是执行状态，不是指令不明，不得因此要求玩家先锁定或给出编号。只有明确友机、真正矛盾或没有可用武器等实质问题才拒绝；不能沿用旧参考文件中“攻击必须已有目标编号”的限制。';
        messages[0].content+='\nattack已经接入持续自主执行链。玩家只说攻击任务时，只输出attack并保留明确的目标targetId/targetRef、武器weapon、数量quantity或飞行数值，未明确的字段保持null。不要展开成radar_mode、lock_target、select_weapon、launch_weapon或自行编造发射命令。搜索、跟踪、选择型号、导引头准备、攻击机动和何时发射由后续攻击飞行员逐步自主判断。不能因为尚未锁定或玩家没有选择导弹而让玩家补设置。';
        messages[0].content+='\nsearch/track_target是持续传感器任务，targetId/targetRef可为null。全部受令机为雷达v2时，可保留指令明确的headingDeg搜索方向、altitudeM搜索中心高度和rangeM搜索距离；这些是扫描要求，不是飞机航路。未指定参数不补填，speedMps等飞行要求另列已有飞行任务，append=false。含v1受令机的批次只填目标；不能把v2扫描参数套到v1，可按能力拆分受令机并保留要求或报告无法执行。开机/波形/截获由后续雷达飞行员判断。';
        for(let attempt=0;attempt<2;attempt++){
          response=await runtime.complete('pilot',messages,navigationSchema(bindCommanderNumbers(militarySchemaFor(context),commanderMessage),context),{maxTokens:6000,signal});this.calls++;signal?.throwIfAborted();
          try{
            const navigation=navigationOutput(response.value,context);
            interpretation=groundCooperation(validateMilitaryInterpretation(normalizeMilitaryInterpretation(navigation.interpretation,{instruction:instruction}),context),context,instruction);
            verifyAttackTaskInterpretation(interpretation,instruction,context);
            if(attempt===0&&/攻击|\battack\b/i.test(instruction)&&interpretation.status==='needs_clarification'&&!/友机|禁止|未挂载|没有可用.*(?:武器|导弹)|弹量不足/.test(interpretation.summary))throw Error('攻击任务可以先搜索：请把指挥员给出的目标描述保留为targetRef并接收attack，未知目标编号不是拒绝任务的理由。重新判断，不要求玩家先锁定或选弹。');
            verifyCommanderHeading(interpretation,commanderMessage);
            verifyCommanderNumbers(interpretation,commanderMessage);
            verifyCommanderAirportInstruction(interpretation,commanderMessage);
            if(attempt===0&&interpretation.status==='understood')for(const order of interpretation.orders)if(ATC_INTENTS.includes(order.intent))atcTaskFor(order,context);
            if(attempt===0)for(const order of interpretation.orders??[])if(order.intent==='attack'){
              try{attackMissionTaskFor(order,context);}catch(error){throw Error('请修正攻击任务表达并保留原指令：'+error.message+'。不能要求玩家手工搜索、锁定、选弹或设置发射时机。');}
            }
            if(attempt===0)for(const order of interpretation.orders??[])if(['search','track_target'].includes(order.intent)){
              try{radarMissionTaskFor(order,context);}catch(error){throw Error('请修正雷达任务表达，按受令机雷达版本处理：'+error.message+'；搜索方向/中心高度不等于飞行要求，保留原命令约束，不静默删参数。');}
            }
            if(interpretation.status==='understood'&&/(如果.+(?:则|就|立即|，|,)|当.+时|遭到.+时|\bif\b.+\bthen\b)/i.test(instruction)&&!interpretation.orders.some(o=>o.timing==='on_condition'))throw Error('指挥员通话中的触发条件必须保留');
            pilotNavigationPlans=navigation.validate(compileMilitaryInterpretation(interpretation,context).plan);latencyPredictionSec=navigation.latencyPredictionSec??0;
            break;
          }catch(error){if(attempt)throw error;messages.push({role:'assistant',content:JSON.stringify(response.value)},{role:'user',content:'规划未通过协议核对：'+error.message+'。unitIds只能使用'+context.units.map(u=>u.id).join('、')+'。保留原始目标和条件，只修正结构和引用，重新输出完整JSON。'});}
        }
        if(interpretation.status!=='understood')interpretation.summary=`无法执行“${instruction.slice(0,100)}”。指令不明，${interpretation.summary}`.slice(0,600);
        const pilotRequirements=[];
        for(const order of interpretation.orders)if(order.intent==='takeoff'&&['reduced_thrust','derated','flex','dry','military_power','full_thrust','afterburner'].includes(order.parameters.mode)&&order.parameters.constraints){pilotRequirements.push({unitIds:order.unitIds,requirements:order.parameters.constraints});order.parameters.constraints=null;}
        const {plan,execution}=compileMilitaryInterpretation(interpretation,context);
        return {requestId:input.requestId,revision:context.revision,simTimeSec:context.simTimeSec,interpretation,plan,execution,pilotRequirements,pilotNavigationPlans,latencyPredictionSec,receivedFrom:'commander',commanderMessageId:commanderMessage.id,plannedBy:this.model,timing:response.timing,knowledgeUsed:reading.files};
      }catch(error){if(error.name==='AbortError'||error instanceof ApiError)throw error;throw new ApiError(502,error.message);}
      finally{signal?.removeEventListener('abort',cancel);await runtime.stop();if(this.runtime===runtime)this.runtime=null;this.status='sleeping';}
    });
    this.queue=operation;try{return await operation;}finally{this.pending--;}
  }
  async planDeparture(input,{signal}={}){
    const commanderMessage=receivedCommand(input),instruction=commanderMessage.text;
    const context=validateContext(input?.context),unit=context.units.find(u=>u.id===input.unitId),options=input.options;
    if(!unit||!unit.grounded||typeof input.requestId!=='string'||!/^[-\w]{1,80}$/.test(input.requestId)||typeof instruction!=='string'||instruction.length>4000||!Array.isArray(options)||options.length>20)throw new ApiError(400,'飞行员起飞规划请求无效');
    for(const o of options)if(!o||typeof o.id!=='string'||o.id.length>80||!Number.isFinite(o.throttle)||o.throttle<.6||o.throttle>1||!Number.isFinite(o.afterburner)||o.afterburner<0||o.afterburner>1||!Number.isFinite(o.groundRollM)||o.groundRollM<=0||!Number.isFinite(o.climbSpeedMps)||o.climbSpeedMps<80||o.climbSpeedMps>300||!Number.isFinite(o.altitudeM)||o.altitudeM<300||o.altitudeM>15000||!Array.isArray(o.points)||o.points.length!==2||o.points.some(p=>!Array.isArray(p)||p.length!==3||!p.every(Number.isFinite)))throw new ApiError(400,'起飞方案候选无效');
    if(this.closed)throw new ApiError(503,'飞行员服务已停止');if(this.pending>=4)throw new ApiError(429,'飞行员正在处理其他任务');this.pending++;
    const operation=this.queue.catch(()=>{}).then(async()=>{
      signal?.throwIfAborted();this.runtime=this.factory();const runtime=this.runtime;this.status='planning_departure';this.wakes++;
      const cancel=()=>void runtime.stop();signal?.addEventListener('abort',cancel,{once:true});
      try{
        await runtime.start();signal?.throwIfAborted();
        const customPlan={type:['object','null'],additionalProperties:false,required:['throttle','afterburner','climbSpeedMps','altitudeM','distanceM'],properties:{throttle:{type:'number',minimum:0,maximum:1},afterburner:{type:'number',minimum:0,maximum:1},climbSpeedMps:{type:'number',minimum:80,maximum:300},altitudeM:{type:'number',minimum:300,maximum:15000},distanceM:{type:'number',minimum:3000,maximum:60000}}};
        const schema={type:'object',additionalProperties:false,required:['decision','customPlan','message'],properties:{decision:{type:'string',enum:['execute','unable']},customPlan,message:{type:'string',maxLength:180}}};
        const reading=aviationReading(instruction+' 起飞',{compact:this.provider==='local'});
        const {value,timing}=await runtime.complete('pilot',[{role:'system',content:'你是游戏飞行员，负责把所有指挥要求变成实际推力与离场航路方案。候选由同一飞行物理生成，已检查跑道滑跑距离、升力/推力余量与路线目标点地形，候选只提供参考，不是可选项白名单。执行时必须自由提出customPlan，自行确定油门、加力、爬升速度、初始离场高度和路线长度，交程序验证后执行。原话明确给出的油门、速度、高度和距离数值必须精确保留，只对未指定细节自主决定。候选不是参数白名单；例如原话85%不能改成80%或90%，候选不包含原值就必须customPlan给出原值，不能为了选候选擅自四舍五入。优先满足原命令，减推力可用80%或90%等符合本机仿真的推力，没有“必须75%以下”的固定标准。减推力时优先关闭加力，用较长航路温和爬升。初始离场高度不等于最终巡航高度；未指定高度时可采用候选的初始离场高度，不继承飞机尚未执行的旧巡航目标。不得凭现实认证标准臆断游戏里可飞的方案无效。必须给原话明确的数值量身规划，不能只因参考方案没有这个数值就unable。没有合适方案或确实未理解要求才unable（customPlan=null），message点名本次不执行什么。message使用“拟采用”，不可声称已经起飞或达到目标。'+'\n'+reading.text},{role:'user',content:JSON.stringify({commanderMessage,ownship:{id:unit.id,callsign:unit.callsign,position:unit.position,speedMps:unit.speedMps,grounded:unit.grounded},plannedOrder:input.order??null,options})}],schema,{maxTokens:500,signal});this.calls++;signal?.throwIfAborted();
        if(!value||!['execute','unable'].includes(value.decision)||typeof value.message!=='string'||value.message.length>180||value.decision==='execute'&&!options.some(o=>o.id===value.optionId)&&!value.customPlan||value.decision==='unable'&&(value.optionId!=null||value.customPlan!=null))throw Error('飞行员起飞规划未通过校验');
        return {requestId:input.requestId,revision:context.revision,simTimeSec:context.simTimeSec,unitId:unit.id,...value,receivedFrom:'commander',commanderMessageId:commanderMessage.id,plannedBy:this.model,timing,knowledgeUsed:reading.files};
      }catch(error){if(error.name==='AbortError'||error instanceof ApiError)throw error;throw new ApiError(502,error.message);}
      finally{signal?.removeEventListener('abort',cancel);await runtime.stop();if(this.runtime===runtime)this.runtime=null;this.status='sleeping';}
    });
    this.queue=operation;try{return await operation;}finally{this.pending--;}
  }
  validate(input){
    if(!input||typeof input.requestId!=='string'||!/^[-\w]{1,80}$/.test(input.requestId))throw new ApiError(400,'飞行员判断请求无效');
    const context=validateContext(input.context),o=input.observation,unit=context.units.find(u=>u.id===o?.unitId);
    if(!unit||!o||typeof o!=='object'||!Array.isArray(o.contacts)||o.contacts.length>16||
      (o.blockedSince!==null&&(!Number.isFinite(o.blockedSince)||o.blockedSince<0||o.blockedSince>context.simTimeSec))||
      (o.blockedReason!==null&&(typeof o.blockedReason!=='string'||o.blockedReason.length>400)))throw new ApiError(400,'飞行员观测数据无效');
    const finiteVec=v=>v===null||Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);
    for(const c of o.contacts)if(!c||typeof c.id!=='string'||c.id.length>64||typeof c.source!=='string'||!c.source||c.source.length>80||
      !['friendly','hostile','unknown'].includes(c.classification)||!Number.isFinite(c.observedAt)||c.observedAt<0||c.observedAt>context.simTimeSec||
      typeof c.threat!=='boolean'||typeof c.missileWarning!=='boolean'||!finiteVec(c.position)||!finiteVec(c.velocity))throw new ApiError(400,'目标观测无效');
    let mission=null;
    if(o.mission!==null){
      const m=o.mission;if(!m||typeof m.id!=='string'||m.id.length>100||!TACTICAL_INTENTS.includes(m.intent)||
        !['now','after_previous','on_condition'].includes(m.timing)||!(m.condition===null||typeof m.condition==='string'&&m.condition.length<=300)||
        !m.parameters||typeof m.parameters!=='object'||Array.isArray(m.parameters)||JSON.stringify(m.parameters).length>3000)throw new ApiError(400,'战术任务无效');
      mission={id:m.id,intent:m.intent,timing:m.timing,condition:m.condition,parameters:m.parameters};
    }
    let execution;try{execution=validateExecutionObservation(o.execution,context.simTimeSec);}catch(error){throw new ApiError(400,error.message);}
    const observation={unitId:unit.id,blockedSince:o.blockedSince,blockedReason:o.blockedReason,mission,contacts:o.contacts,execution};
    // Recompute admission on the server; a claimed event cannot force a routine flight to load the model.
    const event=pilotEvent({...unit,pilotExecution:execution,pilotMission:mission,pilotContacts:o.contacts,navigationBlocked:o.blockedReason},context.simTimeSec,o.blockedSince);
    return {context,observation,event};
  }
  async assess(input,{signal}={}){
    const {context,observation,event}=this.validate(input);
    const reply=(assessment,modelInvoked,extra={})=>({requestId:input.requestId,revision:context.revision,simTimeSec:context.simTimeSec,assessment,modelInvoked,...extra});
    if(!event)return reply({decision:'continue_autopilot',message:'程序飞行正常，无需启动模型',missingData:[]},false);
    const cacheKey=event.key+':'+context.revision;
    if(this.cache.has(cacheKey))return reply(this.cache.get(cacheKey),false,{cached:true});
    if(this.closed)throw new ApiError(503,'飞行员判断服务已停止');
    if(this.pending>=4)throw new ApiError(429,'飞行员正在判断其他事件');
    this.pending++;
    const operation=this.queue.catch(()=>{}).then(async()=>{
      if(signal?.aborted)throw new DOMException('请求已取消','AbortError');
      if(this.closed)throw new ApiError(503,'飞行员判断服务已停止');
      if(this.cache.has(cacheKey))return reply(this.cache.get(cacheKey),false,{cached:true});
      this.runtime=this.factory();const runtime=this.runtime;this.status='loading';this.wakes++;
      const cancel=()=>void runtime.stop();signal?.addEventListener('abort',cancel,{once:true});
      try{
        await runtime.start();if(signal?.aborted)throw new DOMException('请求已取消','AbortError');
        if(runtime.health().status!=='ready')throw Error(runtime.health().error||'本地模型加载失败');
        this.status='assessing';const unit=context.units.find(u=>u.id===observation.unitId),reading=pilotReading(observation.mission?.intent||(event.reason==='new_threat'?'威胁防御':event.reason),{compact:this.provider==='local',intents:observation.mission?[observation.mission.intent]:[]});
        const missionCommand=commandById(observation.mission?.intent),unavailable=missionCommand?missingCapabilities(missionCommand):[];
        const formationUnavailable=unavailable.length>0&&missionCommand?.requires.includes('formation');
        if(formationUnavailable){const file=readPilotFile('formation_compact');reading.files=[{id:file.id,file:file.file,title:file.title}];reading.text=file.text;}
        else{const intervention=readPilotFile('intervention');reading.text+='\n'+intervention.text;reading.files.push({id:intervention.id,file:intervention.file,title:intervention.title});}
        if(!reading.files.some(f=>f.id==='aviation_terms'))Object.assign(reading,appendAviationReading(reading,observation.mission?.intent??event.reason,{compact:this.provider==='local'}));
        const eventSchema=structuredClone(schema);
        const autonomous=event.reason==='execution_deviation';
        if(autonomous){
          eventSchema.properties.decision.enum.push('adjust_plan');eventSchema.required.push('adjustment');
          eventSchema.properties.adjustment={type:['object','null'],additionalProperties:false,required:['throttle','afterburner','speedMps','via','recovery'],properties:{
            throttle:{type:'number',minimum:0,maximum:1},afterburner:{type:'number',minimum:0,maximum:1},speedMps:{type:'number',minimum:60,maximum:600},
            recovery:{type:['object','null'],additionalProperties:false,required:['flightPathDeg','bankDeg','unloadG'],properties:{flightPathDeg:{type:'number',minimum:-20,maximum:0},bankDeg:{type:'number',minimum:-20,maximum:20},unloadG:{type:'number',minimum:.2,maximum:.8}}},
            via:{type:'array',maxItems:6,items:{type:'array',minItems:3,maxItems:3,items:{type:'number'}}}}};
        }
        // Capability availability is a program fact, not a tactical choice for the model.
        if(formationUnavailable){eventSchema.properties.decision.enum=['notify_commander'];eventSchema.properties.missingData.maxItems=0;}
        const data={source:'当前游戏观测快照',simTimeSec:context.simTimeSec,revision:context.revision,event,displayUnits:unitPolicy(context.unitSystem),
          ownship:{id:unit.id,positionM:unit.position,headingDeg:unit.headingDeg,speedMps:unit.speedMps,telemetry:unit.telemetry??null},
          friendlyUnits:context.units.map(u=>({id:u.id,callsign:u.callsign})),
          mission:observation.mission,execution:observation.execution,missionSupport:{available:unavailable.length===0,missingCapabilities:unavailable},contacts:observation.contacts,blockedReason:observation.blockedReason,capabilities:context.capabilities};
        const system=formationUnavailable?'你是单机飞行员。新任务需要尚未接入的编队/协同执行器。只解释mission这一项，再报告当前无法执行；不复述教材示例，不添加攻击任务。decision=notify_commander，message简短中文说明任务与缺失执行器，missingData=[]。missingCapabilities表示缺少程序能力，不是缺少目标数据；不能声称已组成编队，不能把友机当敌机，不虚构已执行机动。':
          '你是单机飞行员的事件判断员。程序正在自动飞行，只判断这次事件是否需要额外处理。普通转弯、爬升、能量保护、失速改出继续交给程序。没有必要介入就continue_autopilot；缺少目标/威胁数据就request_data并列missingData；任务需要未实现的能力或现有航路长期不可行就notify_commander。禁止修改航点或虚构已执行机动。JSON只有decision、message、missingData，message简短中文。';
        const executionSystem='你是正在执行原任务的飞行员，具有自主调整推力、速度和中间航路的权限。根据execution实际速度、垂直速度、推力需求/可用推力和剩余目标判断原方案，不要等待玩家重新下令。持续能量不足应调整油门/加力上限、温和爬升速度或增加爬升航程；航路阻断或进展停滞应重新规划中间点。可行时decision=adjust_plan并给adjustment，否则continue_autopilot、request_data或notify_commander且adjustment=null。throttle与afterburner为0到1的推力上限，speedMps为本段暂用真空速；原任务高度、目的地、条件、明确推力上限和禁止加力限制不得删除。via为ENU米坐标的0至6个中间点，程序自动接回全部remainingGoals，不要重复末目标。保持heading的最终航向、编队掩护护航的长僚机职责；编队不能提出独立via。起飞低空阶段via=[]，先调整能量，机场进近许可不由你更改。根据availableThrustN与requiredThrustN规划；减推力任务优先延长航路且不用加力。lastError是上一方案拒绝原因，必须据此修正。message使用航空通联措辞描述拟调整的原因和方案，不声称已经完成或已到目标；JSON字段decision,message,missingData,adjustment。';
        const energyGuidance='\n执行重规划时：message最多100字，简短通联。JSON参数才是实际可执行方案，不得在message声称修改原任务高度。levelFlightThrustN是当前平飞阻力，climbReserveThrustN是温和爬升所需推力余量；新推力必须足以支持所选速度下的平飞/爬升，不是把旧油门略增一点。军推militaryThrustN和最大maximumThrustN表示全可用能力，availableThrustN只是旧方案限推后的值，不表示发动机故障。未给明确油门数值时可明显提高油门；减推力优先不用加力且低于maximumThrustFraction规定的最大湿推比例。只有明确禁止加力或干推/军推模式才是硬性禁令，不能把自己原先选择的不用加力当成玩家永久限制。';
        const recoveryGuidance='\n严重低速或失速改出是需要你立即判断的事件。不能一律让程序继续或只重复已经100%的油门。根据实际空速、航迹倾角、坡度和当前推力，自由组合推力/加力、卸载、减小坡度、适度下降换取速度。adjustment.recovery为加速阶段的连续控制参数：flightPathDeg为目标航迹倾角（-20到0度，负值为下降，不改任务终点海拔），bankDeg为目标坡度（-20到20度），unloadG为卸载阶段载荷上限（0.2到0.8G）。speedMps须高于safeSpeedMps并留余量。严重低速时via=[]，暂不追航点，恢复后程序接回原目的地；正常重规划recovery=null。参数交同一物理内核试飞，不能恢复的方案会被拒绝并通过lastError反馈，再选择其他参数。不得瞬移或直接补速度，不得突破明确推力限制。';
        const messages=[{role:'system',content:(autonomous?executionSystem:system)+'\n'+reading.text+(autonomous?energyGuidance+recoveryGuidance:'')},{role:'user',content:JSON.stringify(data)}];
        let value,timing;
        for(let attempt=0;attempt<2;attempt++){
          ({value,timing}=await runtime.complete('pilot',messages,eventSchema,{maxTokens:autonomous?1000:350,signal}));this.calls++;
          if(signal?.aborted)throw new DOMException('请求已取消','AbortError');
          try{
            if(!value||!eventSchema.properties.decision.enum.includes(value.decision)||typeof value.message!=='string'||!value.message.trim()||value.message.length>180||!Array.isArray(value.missingData)||value.missingData.length>(formationUnavailable?0:6)||value.missingData.some(v=>typeof v!=='string'||v.length>80))throw Error('decision、简短message或missingData不符合协议');
            if(value.decision==='adjust_plan')validatePilotAdjustment(value.adjustment);
            else if(autonomous&&value.adjustment!==null)throw Error('未执行调整时adjustment必须为null');
            break;
          }catch(error){if(attempt)throw Error('飞行员判断格式无效：'+error.message);messages.push({role:'assistant',content:JSON.stringify(value)},{role:'user',content:`修正协议后重发完整JSON：${error.message}。decision只能为${eventSchema.properties.decision.enum.join('、')}，message不超过100字；有控制方案则adjust_plan及完整adjustment，其余adjustment=null。`});}
        }
        this.last={unitId:unit.id,event:event.reason,...value};
        this.cache.set(cacheKey,value);if(this.cache.size>128)this.cache.delete(this.cache.keys().next().value);
        return reply(value,true,{event:event.reason,timing,knowledgeUsed:reading.files});
      }catch(error){if(error.name==='AbortError'||error instanceof ApiError)throw error;throw new ApiError(502,error.message);}
      finally{
        signal?.removeEventListener('abort',cancel);this.peakDedicatedMiB=Math.max(this.peakDedicatedMiB,runtime.health().memory?.peakDedicatedMiB??0);
        this.status='unloading';await runtime.stop();if(this.runtime===runtime)this.runtime=null;this.status='sleeping';
      }
    });
    this.queue=operation;try{return await operation;}finally{this.pending--;}
  }
  async checkResult(input,{signal}={}){
    if(!input||typeof input.requestId!=='string'||!/^[-\w]{1,80}$/.test(input.requestId))throw new ApiError(400,'执行结果检查请求无效');
    const context=validateContext(input.context),result=input.result,plan=input.plan;
    try{validatePlan(plan,context.units.map(u=>({...u,alive:true})));if(input.interpretation)validateMilitaryInterpretation(input.interpretation,context);}
    catch(error){throw new ApiError(400,error.message);}
    const finite=Number.isFinite,vec=value=>Array.isArray(value)&&value.length===3&&value.every(finite);
    if(!result||!['applied','blocked','informational'].includes(result.outcome)||
      !(result.reason===null||typeof result.reason==='string'&&result.reason.length<=600)||
      !(result.clockRunning===null||typeof result.clockRunning==='boolean')||!Array.isArray(result.units)||result.units.length!==context.units.length)throw new ApiError(400,'执行结果快照无效');
    const seen=new Set();
    for(const u of result.units){
      try{if(u?.radar)parseRadarContext(u.radar,context.simTimeSec);}catch{throw new ApiError(400,'雷达执行结果无效');}
      try{if(u?.weapons)parseWeaponsContext(u.weapons,context.simTimeSec);}catch{throw new ApiError(400,'武器执行结果无效');}
      if(!u||seen.has(u.unitId)||!context.units.some(c=>c.id===u.unitId)||!finite(u.holdAltitudeM)||!finite(u.targetSpeedMps)||
        !(u.headingRoute===null||u.headingRoute&&finite(u.headingRoute.headingDeg)&&finite(u.headingRoute.targetAltitudeM))||
        !Array.isArray(u.waypoints)||u.waypoints.length>32||!u.waypoints.every(vec)||!Array.isArray(u.orbit)||u.orbit.length!==2||!u.orbit.every(finite)||
        !(u.navigationBlocked===null||typeof u.navigationBlocked==='string'&&u.navigationBlocked.length<=600))throw new ApiError(400,'飞机执行状态无效');
      seen.add(u.unitId);
    }
    const facts=inspectCommandResult(context,plan,input.interpretation,result);
    const commanderMessage=input.commanderMessage?receivedCommand(input):null;
    if(commanderMessage)for(const fact of facts)fact.modelFacts.commanderMessage=commanderMessage;
    if(!facts.length||facts.some(f=>!f.requiredReadback||f.requiredReadback.length>240))throw new ApiError(400,'需要检查的指令过长或没有对象，请分条下令');
    const cacheKey='result:'+JSON.stringify({id:input.requestId,revision:context.revision,time:context.simTimeSec,unitSystem:context.unitSystem,commanderMessage,plan,result});
    const reply=(checks,modelInvoked,extra={})=>({requestId:input.requestId,revision:context.revision,simTimeSec:context.simTimeSec,checks,modelInvoked,checkedBy:this.model,...extra});
    if(this.cache.has(cacheKey))return reply(this.cache.get(cacheKey),false,{cached:true});
    if(this.closed)throw new ApiError(503,'飞行员检查服务已停止');
    if(this.pending>=4)throw new ApiError(429,'飞行员正在检查其他结果');this.pending++;
    const operation=this.queue.catch(()=>{}).then(async()=>{
      if(signal?.aborted)throw new DOMException('检查已取消','AbortError');
      if(this.closed)throw new ApiError(503,'飞行员检查服务已停止');
      if(this.cache.has(cacheKey))return reply(this.cache.get(cacheKey),false,{cached:true});
      this.runtime=this.factory();const runtime=this.runtime;this.status='loading';this.wakes++;
      const cancel=()=>void runtime.stop();signal?.addEventListener('abort',cancel,{once:true});
      try{
        await runtime.start();if(signal?.aborted)throw new DOMException('检查已取消','AbortError');
        if(runtime.health().status!=='ready')throw Error(runtime.health().error||'本地模型加载失败');
        this.status='checking_result';const guide=readPilotFile('result'),reading=appendAviationReading({text:guide.text,files:[{id:guide.id,file:guide.file,title:guide.title}]},[plan.summary,input.interpretation?.summary,...plan.tasks.map(t=>t.action)].filter(Boolean).join(' '),{compact:this.provider==='local'});
        const answer={checks:[]},timings=[];
        // A small model checks one bound aircraft at a time; all aircraft still share this process.
        for(const fact of facts){
          // Bind the readback to this command in the output grammar, leaving the result judgment to the model.
          const resultSchema={type:'object',additionalProperties:false,required:['instructionReadback','verdict','resultText'],properties:{
            instructionReadback:{type:'string',enum:[fact.requiredReadback]},verdict:{type:'string',enum:RESULT_VERDICTS},resultText:{type:'string',maxLength:160}}};
          const messages=[{role:'system',content:'你是飞行员，检查程序提供的执行结果，再复述给指挥官。commanderMessage是实际收到的指挥通话，不读取或猜测玩家原始输入；以接令后规划并装订的任务及程序事实核对结果。播报高度按已给的十米/十英尺精度、速度按整数，不补回换算小数。输出三个字段：instructionReadback原样复述instruction；verdict填检查结论；resultText用一句中文报告结果。verdict：当前参数达到目标=reached；已装订但还没达到=executing；不能执行=blocked；装订不一致=mismatch；状态通报=reported。resultText使用上述对应中文状态；补充数值只能来自installation和observed，注意单位。\n'+reading.text},
            {role:'user',content:JSON.stringify(fact.modelFacts)}];
          messages[0].content+='\n结论使用明确状态词：executing必须写“正在执行，尚未达到目标”；reached写“已达到目标”；blocked写“无法执行”；mismatch写“装订不一致”；reported写“状态已核实”。只复述这一条任务，不追加教材示例。';
          if(plan.tasks.some(t=>['assign_role','cover','escort'].includes(t.action)))messages[0].content+='\n本次是双机分工/保护任务，resultText只写一句结论，不重复呼号、角色、队形或数值。角色设置成功不等于僚机已飞到保护位。';
          if(fact.modelFacts.observed?.grounded)messages[0].content+='\n本机仍在地面。按真实机位、跑道位置和许可状态交流，resultText只写简短结论；不加高度、空速或马赫数，不编造发动机启动、检查合格或起飞许可。';
          if(plan.tasks.some(t=>['airport','atc'].includes(t.action)))messages[0].content+='\n机场任务的resultText只写中文执行结论，不重复模式标识或双语标签，不得输出reduced_thrust、TAKEOFF等内部代码。推力/航路方案已在instruction中按玩家语言表达。塔台排序、改跑道、许可指示的reported仅表示已记录并核实，不表示飞机已完成动作；阶段许可仍须由实际管制播报和飞行员复诵后生效，不能提前说已获起飞/着陆许可。';
          if(fact.modelFacts.clockRunning===false)messages[0].content+='\n本次模拟已暂停。若目标已装订但尚未达到，verdict仍用executing表示任务已接收，resultText必须明确“已装订，模拟暂停，等待继续”，不能说正在飞行、转向、爬升或正在执行。不得自行恢复时钟。';
          for(let attempt=0;attempt<2;attempt++){
            const response=await runtime.complete('pilot',messages,resultSchema,{maxTokens:350,signal});this.calls++;timings.push(response.timing);
            if(signal?.aborted)throw new DOMException('检查已取消','AbortError');
            const value=response.value,check={unitId:fact.unitId,verdict:value?.verdict,readbackText:fact.requiredReadback+'，'+value?.resultText};
            try{if(value?.instructionReadback!==fact.requiredReadback||typeof value?.resultText!=='string'||value.resultText.length>160)throw Error('复述必须原样保留instruction，resultText只写本次结果');validateResultReadbacks({checks:[check]},[fact]);check.readbackTexts={zh:check.readbackText,en:englishResultReadback(fact,plan,context,input.interpretation)};answer.checks.push(check);break;}
            catch(error){if(attempt)throw error;const state=fact.expectedVerdict==='executing'&&fact.modelFacts.clockRunning===false?'已装订，模拟暂停，等待继续':({executing:'正在执行，尚未达到目标',reached:'已达到目标',blocked:'无法执行',mismatch:'装订不一致',reported:'状态已核实'})[fact.expectedVerdict];messages.push({role:'assistant',content:JSON.stringify(response.value)},{role:'user',content:`复述未通过核对：${error.message}。重新检查数据，保留instruction原文：${fact.requiredReadback}。本次结论必须表达“${state}”。不得声称未达到的目标已经完成。`});}
          }
        }
        const timing={role:'pilot',inferenceMs:timings.reduce((sum,item)=>sum+(item?.inferenceMs??0),0),perCall:timings};
        this.resultChecks++;this.lastResultCheck={requestId:input.requestId,revision:context.revision,simTimeSec:context.simTimeSec,checks:answer.checks};
        this.cache.set(cacheKey,answer.checks);if(this.cache.size>128)this.cache.delete(this.cache.keys().next().value);
        return reply(answer.checks,true,{timing,knowledgeUsed:reading.files});
      }catch(error){if(error.name==='AbortError'||error instanceof ApiError)throw error;throw new ApiError(502,error.message);}
      finally{signal?.removeEventListener('abort',cancel);this.peakDedicatedMiB=Math.max(this.peakDedicatedMiB,runtime.health().memory?.peakDedicatedMiB??0);
        this.status='unloading';await runtime.stop();if(this.runtime===runtime)this.runtime=null;this.status='sleeping';}
    });
    this.queue=operation;try{return await operation;}finally{this.pending--;}
  }
  async stop(){this.closed=true;await this.runtime?.stop();this.runtime=null;this.status='sleeping';}
}
