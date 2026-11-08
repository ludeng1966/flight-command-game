import {UNIT_SYSTEMS,normalizeUnits,modelUnitInstruction} from '../sim/units.js';
import {parseAirportTraffic} from '../sim/atc-context.js';
import {verifyCommanderNumbers} from '../sim/commander-message.js';
import {militarySchemaFor,MILITARY_SYSTEM,normalizeMilitaryInterpretation,validateMilitaryInterpretation,compileMilitaryInterpretation,groundCooperation} from './military-planner.mjs';
import {CAPABILITIES} from '../sim/military-commands.js';
import {parseRadarContext} from '../sim/radar.js';
import {parseRadarTaskContext} from '../sim/radar-task.js';
import {parseWeaponsContext} from '../sim/weapons.js';
import {parseRwrContext} from '../sim/rwr.js';
import {parseDefenseContext} from '../sim/rwr-defense.js';
import {parseAttackTaskContext} from '../sim/attack-task.js';
import {ATTACK_TASK_RULES,verifyAttackTaskInterpretation} from './attack-rules.mjs';
import {RADIO_STYLES,normalizeRadioInstruction} from '../sim/radio.js';
import {pilotReading} from './pilot-handbook.mjs';
import {parseDecisionTiming} from './navigation-planning.mjs';

export class ApiError extends Error {
  constructor(status,message){super(message);this.status=status;}
}

export function validateContext(c) {
  const finite=v=>typeof v==='number'&&Number.isFinite(v);
  if(!c||!finite(c.simTimeSec)||c.simTimeSec<0||!Number.isSafeInteger(c.revision)||c.revision<0||
    !Array.isArray(c.units)||!c.units.length||c.units.length>32)throw new ApiError(400,'战场上下文无效');
  const ids=new Set();
  if(c.bullseye!==undefined&&c.bullseye!==null&&(!c.bullseye||typeof c.bullseye.name!=='string'||!c.bullseye.name.trim()||c.bullseye.name.length>80||!Array.isArray(c.bullseye.position)||c.bullseye.position.length!==3||!c.bullseye.position.every(finite)))throw new ApiError(400,'靶眼基准无效');
  if(c.radioStyle!==undefined&&!RADIO_STYLES.includes(c.radioStyle))throw new ApiError(400,'通联风格无效');
  if(c.unitSystem!==undefined&&!UNIT_SYSTEMS.includes(c.unitSystem))throw new ApiError(400,'单位设置无效');
  const units=c.units.map((u,i)=>{
    if(!u||typeof u.id!=='string'||u.id.length>64||ids.has(u.id)||typeof u.callsign!=='string'||u.callsign.length>80||
      !Array.isArray(u.position)||u.position.length!==3||!u.position.every(finite)||typeof u.alive!=='boolean'||
      !['headingDeg','speedMps','targetAltitudeM','targetSpeedMps','maxG'].every(k=>finite(u[k]))||
      !Array.isArray(u.aliases)||u.aliases.length>24||u.aliases.some(a=>typeof a!=='string'||!a||a.length>80)||
      typeof u.radioNumber!=='string'||!/^\d{1,6}$/.test(u.radioNumber))throw new ApiError(400,'飞机状态无效');
    ids.add(u.id);
    let rwr,rwrDefense;try{rwr=parseRwrContext(u.rwr,c.simTimeSec);rwrDefense=parseDefenseContext(u.rwrDefense,c.simTimeSec);}catch{throw new ApiError(400,'告警与防御上下文无效');}
    let radar,radarTask;try{radar=parseRadarContext(u.radar,c.simTimeSec);radarTask=parseRadarTaskContext(u.radarTask,c.simTimeSec);}catch{throw new ApiError(400,'雷达航迹或任务上下文无效');}
    let weapons,attackTask;try{weapons=parseWeaponsContext(u.weapons,c.simTimeSec);attackTask=parseAttackTaskContext(u.attackTask,c.simTimeSec);}catch{throw new ApiError(400,'武器或攻击任务上下文无效');}
    return {id:u.id,callsign:u.callsign,number:i+1,aliases:u.aliases,radioNumber:u.radioNumber,position:u.position,headingDeg:u.headingDeg,
      speedMps:u.speedMps,targetAltitudeM:u.targetAltitudeM,targetSpeedMps:u.targetSpeedMps,maxG:u.maxG,
      ...(u.navigationEnvelope?{navigationEnvelope:parseNavigationEnvelope(u.navigationEnvelope)}:{}),
      ...(Array.isArray(u.velocity)&&u.velocity.length===3&&u.velocity.every(finite)?{velocity:u.velocity}:{}),
      alive:u.alive,task:['heading','waypoints','orbit','formation'].includes(u.task)?u.task:'unknown',
      controlAuthority:u.controlAuthority&&['tower','commander'].includes(u.controlAuthority.owner)?{owner:u.controlAuthority.owner,phase:['owned','ready','transferring'].includes(u.controlAuthority.phase)?u.controlAuthority.phase:'owned',target:['tower','commander'].includes(u.controlAuthority.target)?u.controlAuthority.target:null,mode:c.executionMode==='relaxed'?'auto':'manual'}:null,
      grounded:u.grounded===true,surfacePhase:typeof u.surfacePhase==='string'&&u.surfacePhase.length<40?u.surfacePhase:'airborne',
      groundNode:typeof u.groundNode==='string'&&/^[A-Z0-9_-]{1,24}$/.test(u.groundNode)?u.groundNode:null,
      groundRunway:typeof u.groundRunway==='string'&&/^\d{2}[LRC]?$/.test(u.groundRunway)?u.groundRunway:null,
      team:typeof u.team==='string'&&u.team.length<=40?u.team:'blue',radar,radarTask,weapons,attackTask,rwr,rwrDefense,
      flightRole:u.flightRole&&['lead','wingman'].includes(u.flightRole.role)&&c.units.some(v=>v.id===u.flightRole.partnerId)?{role:u.flightRole.role,partnerId:u.flightRole.partnerId}:null,
      formation:u.formation&&typeof u.formation.leaderId==='string'&&c.units.some(v=>v.id===u.formation.leaderId)&&
        typeof u.formation.shape==='string'&&['left','right'].includes(u.formation.side)&&finite(u.formation.rangeM)&&u.formation.rangeM>=400&&u.formation.rangeM<=5000?
        {leaderId:u.formation.leaderId,shape:u.formation.shape,side:u.formation.side,rangeM:u.formation.rangeM,intent:['join_formation','follow_unit','formation_change','cover','escort'].includes(u.formation.intent)?u.formation.intent:'join_formation',status:u.formation.status,slotErrorM:u.formation.slotErrorM}:null,
      ...(u.telemetry&&typeof u.telemetry==='object'&&Array.isArray(u.telemetry.waypoints)&&u.telemetry.waypoints.length<=32&&
        u.telemetry.waypoints.every(w=>Array.isArray(w)&&w.length===3&&w.every(finite))&&
        typeof u.telemetry.flightState==='string'&&u.telemetry.flightState.length<40&&finite(u.telemetry.loadFactor)&&
        (u.telemetry.groundClearanceM===null||finite(u.telemetry.groundClearanceM))?{telemetry:{waypoints:u.telemetry.waypoints,flightState:u.telemetry.flightState,
          loadFactor:u.telemetry.loadFactor,groundClearanceM:u.telemetry.groundClearanceM}}:{})};
  });
  if(!ids.has(c.selectedUnitId))throw new ApiError(400,'未选择有效飞机');
  if(c.mapPoint!==null&&(!Array.isArray(c.mapPoint)||c.mapPoint.length!==3||!c.mapPoint.every(finite)))throw new ApiError(400,'地图标记无效');
  if(c.executionMode!==undefined&&!['strict','relaxed'].includes(c.executionMode))throw new ApiError(400,'执行模式无效');
  const airports=Array.isArray(c.airports)?c.airports.filter(a=>a&&typeof a.id==='string'&&a.id.length<80&&typeof a.name==='string'&&a.name.length<80&&Array.isArray(a.runways)&&a.runways.length<=8&&a.runways.every(r=>typeof r==='string'&&/^\d{2}[LRC]?$/.test(r))).slice(0,8).map(a=>({id:a.id,name:a.name,runways:a.runways})):[];
  let airportTraffic;try{airportTraffic=parseAirportTraffic(c.airportTraffic,c.simTimeSec,units.map(u=>u.id));}catch(error){throw new ApiError(400,error.message);}
  let decisionTiming;try{decisionTiming=parseDecisionTiming(c.decisionTiming,units);}catch(error){throw new ApiError(400,error.message);}
  return {simTimeSec:c.simTimeSec,revision:c.revision,selectedUnitId:c.selectedUnitId,mapPoint:c.mapPoint,bullseye:c.bullseye?{name:c.bullseye.name,position:[...c.bullseye.position]}:null,radioStyle:c.radioStyle||'pla',unitSystem:normalizeUnits(c.unitSystem),executionMode:c.executionMode??'strict',capabilities:CAPABILITIES,airports,units,airportTraffic,...(decisionTiming?{decisionTiming}:{})};
}

function parseNavigationEnvelope(e){
  const keys=['structuralMaxG','configurationMaxG','availableG','sustainableG','ceilingM','safeLevelSpeedMps'];
  if(!e||keys.some(k=>!Number.isFinite(e[k])||e[k]<0)||e.minimumTurnRadiusM!==null&&(!Number.isFinite(e.minimumTurnRadiusM)||e.minimumTurnRadiusM<0))throw new ApiError(400,'本机机动包线无效');
  return Object.fromEntries([...keys,'minimumTurnRadiusM'].map(k=>[k,e[k]]));
}

export function createQwenClient(config,fetchImpl=fetch) {
  async function complete(body,audio=false,signal) {
    const key=audio?(config.asrKey||config.apiKey):config.apiKey;
    if(!key)throw new ApiError(503,'尚未配置百炼 API Key，请在设置 → API 接入中填写，或在本机 .env 中设置 DASHSCOPE_API_KEY 后重启服务');
    const base=audio?config.asrBaseUrl:config.baseUrl;
    try {
      const response=await fetchImpl(`${base.replace(/\/$/,'')}/chat/completions`,{
        method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
        body:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(config.timeoutMs)]):AbortSignal.timeout(config.timeoutMs),redirect:'error'
      });
      if(!response.ok){
        const message=response.status===401?'API Key 无效或与地域不匹配':response.status===403?'当前账号没有模型调用权限':
          response.status===429?'调用频率或额度受限，请稍后重试':response.status===404?'模型或接口地址不可用，请检查配置':
          response.status===400?'模型不接受当前请求，请检查模型、地域和接口兼容性':'上游服务暂时不可用';
        throw new ApiError(502,`百炼：${message}（HTTP ${response.status}）`);
      }
      const data=await response.json();
      const choice=data.choices?.[0];
      if(choice?.finish_reason==='length')throw new ApiError(502,'AI 输出被截断，请缩短指令');
      const text=choice?.message?.content;
      if(typeof text!=='string')throw new ApiError(502,'百炼返回了无效结果');
      return text;
    }catch(e){
      if(signal?.aborted)throw new DOMException('请求已取消','AbortError');
      if(e instanceof ApiError)throw e;
      throw new ApiError(e.name==='TimeoutError'?504:502,e.name==='TimeoutError'?'API 请求超时，请重试':'无法连接百炼接口，请检查网络和服务地址');
    }
  }
  return {
    async completePilot(messages,schema,{maxTokens=350,signal}={}){
      const started=performance.now();
      const text=await complete({model:config.pilotModel||'qwen3.7-flash',stream:false,enable_thinking:false,max_tokens:maxTokens,
        messages,response_format:{type:'json_schema',json_schema:{name:'pilot_assessment',strict:true,schema}}},false,signal);
      let value;try{value=JSON.parse(text);}catch{throw new ApiError(502,'飞行员返回了无效 JSON');}
      return {value,timing:{role:'pilot',inferenceMs:performance.now()-started}};
    },
    async interpret(input){
      if(!input||typeof input.requestId!=='string'||!/^[-\w]{1,80}$/.test(input.requestId)||
        typeof input.instruction!=='string'||!input.instruction.trim()||input.instruction.length>1000)throw new ApiError(400,'请输入 1–1000 字的指令');
      const context=validateContext(input.context);
      const reading=pilotReading(input.instruction);
      const request={model:config.commandModel,stream:false,enable_thinking:false,max_tokens:6000,
        messages:[{role:'system',content:MILITARY_SYSTEM+'\n'+modelUnitInstruction(context.unitSystem)+'\n\n以下是本项目参考文件，输出仍须遵守上面的军事意图协议。\n'+reading.text},{role:'user',content:JSON.stringify({instruction:normalizeRadioInstruction(input.instruction),originalInstruction:input.instruction,context})}],
        response_format:{type:'json_schema',json_schema:{name:'military_order',strict:true,schema:militarySchemaFor(context)}}};
      request.messages[0].content+='\n'+ATTACK_TASK_RULES;
      let text=await complete(request);
      let interpretation;
      for(let attempt=0;attempt<2;attempt++){
        try{
          interpretation=groundCooperation(validateMilitaryInterpretation(normalizeMilitaryInterpretation(JSON.parse(text),{instruction:input.instruction}),context),context,input.instruction);
          // A single explicit flight command must not inherit a different target
          // from the snapshot. Ask the model to repair it before broadcasting.
          if(interpretation.orders.length===1)verifyCommanderNumbers(interpretation,{text:input.instruction},{altitudeM:1,speedMps:.1,headingDeg:.01});
          verifyAttackTaskInterpretation(interpretation,input.instruction,context);
          // An understood relational task must retain its reference. Ask the model to repair
          // an omitted object before the compiler requests clarification from the player.
          if(interpretation.status==='understood')for(const o of interpretation.orders){
            if(o.intent==='fly_to'&&o.parameters.mode==='bullseye'&&context.bullseye&&(!Number.isFinite(o.parameters.bearingDeg)||!Number.isFinite(o.parameters.rangeM)))
              throw Error('靶眼坐标遗漏方位或距离：原话指定的靶眼方位必须填bearingDeg，原话指定的距离按明确单位或当前全局单位换算为米填rangeM；distanceM不是替代字段。只使用本次原话的数据，不引用教材示例。若原话确实缺少数据才返回needs_clarification，不能要求玩家重复已经给出的距离或规划航路。');
            if(['follow_unit','join_formation','cover','escort'].includes(o.intent)&&!o.parameters.targetId&&!o.parameters.targetRef)
              throw Error(`${o.intent}遗漏了参照或受保护对象：原话指明的友机必须写targetId（对应context.units.id），外部对象写targetRef；原话没有对象才返回needs_clarification。`);
          }
          const hasExplicitCondition=/(如果.+(?:则|就|立即|，|,)|遭到.+时|\bif\b.+\bthen\b)/i.test(input.instruction);
          if(hasExplicitCondition&&interpretation.status==='understood'&&!interpretation.orders.some(o=>o.timing==='on_condition'))throw Error('遗漏了原始命令的触发条件');
          break;
        }catch(error){
          if(attempt)throw new ApiError(502,'AI 返回的军事口令未通过校验，飞机未收到本次指令，请重新表述');
          text=await complete({...request,messages:[...request.messages,{role:'assistant',content:text},
            {role:'user',content:`上次输出未通过本地校验：${error.message}。请仅修正格式、单位引用和缺失的条件，完整保留原始任务与条件。非全局命令至少一个真实单位ID；pause/resume 的 unitIds=[]；每条 parameters 必须完整；on_condition 必须有非空 condition。不能通过删掉任务或改成其他战术来通过校验。重新输出完整JSON。`}]});
        }
      }
      const {plan,execution}=compileMilitaryInterpretation(interpretation,context);
      return {requestId:input.requestId,revision:context.revision,simTimeSec:context.simTimeSec,interpretation,execution,
        command:{authority:'player',speakerRole:'commander',planningOwner:'pilot',status:plan.status,tasks:plan.tasks},plan,knowledgeUsed:reading.files};
    },
    async transcribe(wav){
      // 前端固定编码 PCM16 单声道 WAV，避免浏览器容器/编码差异。
      if(wav.length<44||wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE'||
        wav.toString('ascii',12,16)!=='fmt '||wav.readUInt32LE(16)!==16||wav.readUInt16LE(20)!==1||
        wav.readUInt16LE(22)!==1||wav.readUInt16LE(34)!==16||wav.toString('ascii',36,40)!=='data')throw new ApiError(400,'录音格式无效，请重新录音');
      const rate=wav.readUInt32LE(24),size=wav.readUInt32LE(40);
      if(rate<8000||rate>96000||size!==wav.length-44||size%2||size/(rate*2)>30||size/(rate*2)<.25)throw new ApiError(400,'录音时长或采样率无效，请录制 0.3–20 秒指令');
      const text=(await complete({model:config.asrModel,stream:false,
        messages:[{role:'user',content:[{type:'input_audio',input_audio:{data:`data:audio/wav;base64,${wav.toString('base64')}`}}]}],
        asr_options:{enable_itn:true}},true)).trim();
      if(!text||text.length>1000)throw new ApiError(422,'未识别到有效指令，请靠近麦克风重试或输入文字');
      return {text};
    }
  };
}
