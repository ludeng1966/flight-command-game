import {ControlHandoffRadio} from './control-handoff.js';
import {formatAltitude,formatSpeed,formatDistance,getUnitSystem} from '../sim/units.js';
import {commandContext} from '../sim/orders.js';
import {planningModeLabel} from '../sim/command-planning.js';
import {runCommandSession} from './command-session.js';
import {DecisionLatency,sameDecisionClock} from '../sim/decision-timing.js';
import {createRadioConsole} from './radio-console.js';
import {AirportRadio} from './airport-radio.js';
import {RadarRadio} from './radar-radio.js';
import {RwrRadio} from './rwr-radio.js';
import {ManualRouteRadio} from './manual-route-radio.js';
import {WavRecorder} from './recorder.js';
import {COMMAND_CATALOG,COMMAND_GROUPS,missingCapabilities} from '../sim/military-commands.js';
import {captureCommandResult,inspectCommandResult,validateResultReadbacks} from '../sim/pilot-result.js';
import {FORMATIONS,COOPERATION_MODES,FORMATION_ROLES,doctrineLabel} from '../sim/formation-doctrine.js';
import {DEFAULT_PILOT_MODEL,pilotModelInfo} from '../sim/pilot-models.js';
import {airportModeLabel} from '../sim/airport-language.js';
import {needsDeparturePlan,departureOptions,evaluateDeparturePlan} from '../sim/departure-plan.js';
import {setPilotInstruction} from '../sim/pilot-execution.js';
import {PilotExecutionRadio} from './pilot-execution-radio.js';

export function initVoiceCommands({getState,onApplied,onSimulation,onPilotPreview=()=>{},onPilotModelChanged=()=>{},onCommandCommitted=()=>{},radio:providedRadio,pause,prepareCommand,forecastCommand,allowAutomaticHandoff=()=>true}){
  const decisionLatency=new DecisionLatency();
  const clock=()=>({playing:getState().playing===true,rate:getState().rate??1});
  const $=s=>document.querySelector(s),text=$('#command-text'),mic=$('#command-mic'),send=$('#command-send'),cancel=$('#command-cancel');
  const status=$('#command-status'),badge=$('#command-connection'),history=$('#command-history');
  const radio=providedRadio||createRadioConsole({getWorld:()=>getState().world});
  const rwrRadio=new RwrRadio({getWorld:()=>getState().world,radio,isBusy:()=>handoffRadio.active||busy||recording||starting||airportRadio.active||manualRadio.active||radarRadio.active||executionRadio.active});
  const executionRadio=new PilotExecutionRadio({getWorld:()=>getState().world,radio,isBusy:()=>handoffRadio.active||busy||recording||starting||rwrRadio.active||airportRadio.active||manualRadio.active||radarRadio.active});
  const radarRadio=new RadarRadio({getWorld:()=>getState().world,radio,isBusy:()=>handoffRadio.active||busy||recording||starting||rwrRadio.active||airportRadio.active||manualRadio.active||executionRadio.active});
  const airportRadio=new AirportRadio({getWorld:()=>getState().world,radio,isBusy:()=>handoffRadio.active||busy||recording||starting||rwrRadio.active||!!manualRadio.active||radarRadio.active||executionRadio.active});
  const manualRadio=new ManualRouteRadio({getState:()=>({...getState(),radioStyle:$('#command-style')?.value||'pla'}),radio,isBusy:()=>handoffRadio.active||busy||recording||starting||rwrRadio.active||airportRadio.active||radarRadio.active||executionRadio.active});
  const handoffRadio=new ControlHandoffRadio({getWorld:()=>getState().world,radio,allowAutomatic:allowAutomaticHandoff,isBusy:()=>busy||recording||starting||airportRadio.active||manualRadio.active||rwrRadio.active||executionRadio.active||radarRadio.active});let handoffWasBusy=false;
  const updateUnitHint=()=>{text.placeholder=getUnitSystem()==='imperial'?'让 Alpha 向西飞，高度两万英尺，速度三百节':'让 Alpha 向西飞，高度八千米，速度六百公里每小时';};
  let lastUnderstanding=null;
  const modelSelect=$('#pilot-model'),download=$('#pilot-model-download');
  let pilotModel=DEFAULT_PILOT_MODEL;
  try{const saved=globalThis.localStorage?.getItem('flight-pilot-model');if(pilotModelInfo(saved))pilotModel=saved;}catch{}
  if(modelSelect)modelSelect.value=pilotModel;
  const pilotAvailable=()=>!!pilotModelInfo(pilotModel)?.available;
  const pilotLabel=()=>pilotModelInfo(pilotModel)?.label||'AI';
  let health=null,busy=false,recording=false,starting=false,recorder=null,abort=null,serial=0,timer=null,recordRef=null,committed=false,healthTimer=null,closed=false;
  let progressListener=null;
  const say=(message,error=false)=>{status.textContent=message;status.dataset.error=String(error);status.dataset.pending='false';progressListener?.(message,error);};
  function showUnderstanding(interpretation,execution){
    lastUnderstanding={interpretation,execution};
    const section=$('#command-understanding'),list=$('#command-intents');if(!section||!list)return;
    list.replaceChildren();section.hidden=!interpretation?.orders?.length;
    for(const o of interpretation?.orders||[]){
      const entry=COMMAND_CATALOG.find(c=>c.id===o.intent),state=execution?.orderStates?.find(s=>s.id===o.id),item=document.createElement('li');
      const call=o.unitIds.map(id=>getState().world.units.find(u=>u.id===id)?.callsign||id).join('、')||'指挥台';
      const when=o.timing==='after_previous'?'前项完成后':o.timing==='on_condition'?`条件：${o.condition}`:'现在';
      const role={directive:'指令',request:'请求',report:'通报',clearance:'许可'}[o.speechAct];
      const p=o.parameters,details=[];
      const planning=execution?.planning?.find(p=>p.orderId===o.id);if(planning)details.push(planning.message);
      if(p.runway)details.push('跑道'+p.runway);if(p.airportRef)details.push(p.airportRef);if(p.holdPoint)details.push('等待点'+p.holdPoint);
      const target=p.targetId?getState().world.units.find(u=>u.id===p.targetId)?.callsign:p.targetRef;
      if(target)details.push('对象'+target);if(p.headingDeg!==null)details.push('航向'+p.headingDeg+'°');
      if(p.altitudeM!==null)details.push('高度'+formatAltitude(p.altitudeM));if(p.speedMps!==null)details.push('真空速'+formatSpeed(p.speedMps));
      if(p.distanceM!==null)details.push('距离'+formatDistance(p.distanceM));
      if(p.bearingDeg!==null)details.push((p.mode==='bullseye'?'靶眼方位':'目标方位')+p.bearingDeg+'°');
      if(p.formation)details.push(doctrineLabel(FORMATIONS,p.formation));if(p.side)details.push(({left:'左侧',right:'右侧'})[p.side]||p.side);
      if(p.rangeM!==null)details.push('间隔/距离'+formatDistance(p.rangeM,{digits:2}));if(p.role)details.push(doctrineLabel(FORMATION_ROLES,p.role));
      if(p.weapon)details.push(p.weapon);if(p.quantity!==null)details.push('数量'+p.quantity);
      if(p.mode)details.push(airportModeLabel(p.mode,o.intent)??planningModeLabel(p.mode)??doctrineLabel(COOPERATION_MODES,p.mode));if(p.constraints)details.push(p.constraints);
      item.textContent=`${call} · ${role} · ${entry?.label||o.intent} · ${when}${details.length?' · '+details.join(' · '):''}${state?.status==='capability_unavailable'?' · 待接入':''}`;
      list.append(item);
    }
    for(const note of execution?.adjustments??[]){const item=document.createElement('li');item.textContent='放宽模式 · '+note;list.append(item);}
  }
  function buildHandbook(){
    const catalog=$('#command-catalog');if(!catalog)return;catalog.replaceChildren();
    for(const [group,label]of Object.entries(COMMAND_GROUPS)){
      const block=document.createElement('details'),title=document.createElement('summary');title.textContent=label;block.append(title);
      for(const c of COMMAND_CATALOG.filter(c=>c.group===group&&!['radar_mode','lock_target','select_weapon','launch_weapon'].includes(c.id))){
        const row=document.createElement('button');row.type='button';row.className='command-example';
        const executable=!missingCapabilities(c).length&&c.id!=='report_event';
        row.textContent=`${c.label} · ${executable?'可执行':c.id==='report_event'?'仅通报':'待接入'}\n${c.example}`;
        row.onclick=()=>{if(busy||recording||starting)return;text.value=c.example;text.focus();sync();};block.append(row);
      }
      catalog.append(block);
    }
  }
  const sync=()=>{
    mic.disabled=handoffRadio.active||busy||starting||!health?.voiceReady||!pilotAvailable();send.disabled=handoffRadio.active||busy||recording||starting||!health?.commandReady||!pilotAvailable()||!text.value.trim();
    if(download)download.hidden=pilotModel!=='2b';
    text.disabled=busy||recording||starting;cancel.disabled=!busy&&!recording&&!starting;
    mic.textContent=starting?'正在打开麦克风…':recording?'结束录音':'开始录音';
    mic.setAttribute('aria-pressed',String(recording));mic.dataset.recording=String(recording);
    cancel.textContent=committed&&busy?'停止通话':'取消';
  };
  const reference=()=>{const s=getState();return {...s,pilotModel,pilotLabel:pilotLabel(),revision:s.world.revision,mapPoint:s.mapPoint?[...s.mapPoint]:null,radioStyle:$('#command-style')?.value||'pla'};};
  const assertCurrent=ref=>{
    if(ref.world!==getState().world||ref.world.revision!==ref.revision)throw Error('期间已有新操作或战场重置，本次指令已作废，请重新下令');
  };
  async function post(url,body,contentType,signal){
    let response;
    try{response=await fetch(url,{method:'POST',headers:{'Content-Type':contentType},body,signal});}
    catch(e){if(signal.aborted)throw e;throw Error('无法连接指挥服务，请检查启动程序和网络');}
    let data;try{data=await response.json();}catch{throw Error('指挥服务未启动，请使用 start_game.cmd 启动游戏');}
    if(!response.ok)throw Error(data.error||'请求失败');return data;
  }
  function log(summary){
    const row=document.createElement('li');row.textContent=`T+${Math.floor(getState().world.time)}s · ${summary}`;
    history.prepend(row);while(history.children.length>4)history.lastElementChild.remove();
  }
  async function interpret(instruction,ref,token,signal,source='radio'){
    assertCurrent(ref);const context=commandContext(ref.world,ref.selectedId,ref.mapPoint,ref.radioStyle),requestId=crypto.randomUUID();
    say(health?.provider==='local'?'本地指挥官正在理解口令…':'正在理解军事口令…');showUnderstanding(null,null);
    const commanderStarted=performance.now(),reply=await post('/api/tactical/interpret',JSON.stringify({requestId,instruction,context}),'application/json',signal);
    if(!decisionLatency.samples.length)decisionLatency.record((performance.now()-commanderStarted)/1000);
    if(token!==serial||signal.aborted)return;
    assertCurrent(ref);
    if(reply.requestId!==requestId||reply.revision!==context.revision||reply.simTimeSec!==context.simTimeSec)throw Error('指令响应不匹配，请重新下令');
    if(ref.world.time-context.simTimeSec>120)throw Error('战场已推进较久，本次计划已过期，请重新下令');
    showUnderstanding(reply.interpretation,reply.execution);
    // 相对转向最终是绝对航向；若分析期间已明显转向则重新解释。
    for(const task of reply.plan?.tasks||[]){
      if(task.action!=='fly_heading')continue;
      const before=context.units.find(u=>u.id===task.unitId),now=ref.world.units.find(u=>u.id===task.unitId);
      if(!before||!now)continue;
      const angle=Math.atan2(now.velocity[0],now.velocity[1])*180/Math.PI-before.headingDeg;
      if(Math.abs(Math.atan2(Math.sin(angle*Math.PI/180),Math.cos(angle*Math.PI/180)))>Math.PI/6)throw Error('分析期间飞机航向变化较大，请重新下达转向指令');
    }
    say(health?.pilotAssistant?.enabled?`指挥台正在下令，程序执行后由 ${ref.pilotLabel} 检查并复述…`:'指挥台正在下令，等待飞行员复诵与规划…');
    const result=await runCommandSession({world:ref.world,reply,pilotLabel:ref.pilotLabel,expectedRevision:ref.revision,selectedUnitId:ref.selectedId,style:ref.radioStyle,radio,signal,pause,preparePlan:prepareCommand,enforceAuthority:true,
      planPilotCommand:health?.pilotAssistant?.commandPlanning?async({commanderMessage})=>{
        assertCurrent(ref);say(ref.pilotLabel+' 飞行员正在处理收到的指挥通话…');
        for(let attempt=0;attempt<3;attempt++){
          const sampledClock=clock(),snapshot=commandContext(ref.world,ref.selectedId,ref.mapPoint,ref.radioStyle);
          if(forecastCommand)snapshot.decisionTiming=await forecastCommand(ref.world,decisionLatency.timing(sampledClock),signal);
          if(!sameDecisionClock(sampledClock,clock()))continue;
          const started=performance.now(),planned=await post('/api/tactical/pilot/plan',JSON.stringify({requestId,pilotModel:ref.pilotModel,commanderMessage,context:snapshot}),'application/json',signal);
          decisionLatency.record((performance.now()-started)/1000);
          if(token!==serial||signal.aborted)throw new DOMException('通联已取消','AbortError');assertCurrent(ref);
          if(planned.requestId!==requestId||planned.revision!==snapshot.revision||planned.simTimeSec!==snapshot.simTimeSec||planned.commanderMessageId!==commanderMessage.id)throw Error('飞行员接令响应不匹配');
          if(!sameDecisionClock(sampledClock,clock())){say('时钟状态已改变，飞行员正在按当前机位重新规划…');continue;}
          showUnderstanding(planned.interpretation,planned.execution);return planned;
        }
        throw Error('规划期间连续切换时钟，请保持当前状态后重新下令');
      }:null,
      reviewPilot:async({commanderMessage})=>{
        for(const task of reply.plan.tasks.filter(t=>t.action==='airport'&&needsDeparturePlan(t.airportOrder))){
          assertCurrent(ref);const unit=ref.world.units.find(u=>u.id===task.unitId),options=departureOptions(ref.world,unit,task.airportOrder);
          say(`${ref.pilotLabel} 正在选择推力与离场航路…`);
          const currentContext=commandContext(ref.world,ref.selectedId,ref.mapPoint,ref.radioStyle);
          const planned=await post('/api/tactical/pilot/plan-departure',JSON.stringify({requestId,pilotModel:ref.pilotModel,commanderMessage,unitId:unit.id,context:currentContext,order:task.airportOrder,options}),'application/json',signal);
          assertCurrent(ref);if(planned.requestId!==requestId||planned.revision!==currentContext.revision||planned.simTimeSec!==currentContext.simTimeSec||planned.unitId!==unit.id)throw Error('飞行员起飞方案已经过期');
          if(planned.decision!=='execute')throw Error(planned.message||'飞行员未找到可行离场方案');
          const selected=planned.customPlan?evaluateDeparturePlan(ref.world,unit,task.airportOrder,planned.customPlan):options.find(o=>o.id===planned.optionId);if(!selected)throw Error('飞行员方案未通过实际推力、跑道或航路校验，本次不执行');
          (reply.pilotProcedures??={})[unit.id]=selected;reply.pilotPlanning=planned;
        }
      },
      checkPilotResult:health?.pilotAssistant?.enabled?async({outcome,result,reason,revision,commanderMessage})=>{
        const current=()=>{if(ref.world!==getState().world||ref.world.revision!==revision)throw Error('期间已有新操作，旧结果检查已作废');};current();
        for(let attempt=0;attempt<3;attempt++){
        say(committed?`程序已开始执行，${ref.pilotLabel} 正在检查结果…`:`${ref.pilotLabel} 正在检查程序返回的结果…`);
        const snapshot=commandContext(ref.world,ref.selectedId,ref.mapPoint,ref.radioStyle),clock=getState().playing;
        const receipt=captureCommandResult(ref.world,{outcome,reason:reason??null,clockRunning:typeof clock==='boolean'?clock:result?.simulation?result.simulation==='resume':null});
        const controller=new AbortController(),guard=setInterval(()=>{try{current();}catch{controller.abort();}},250);
        let reviewed;
        try{reviewed=await post('/api/tactical/pilot/result',JSON.stringify({requestId,pilotModel:ref.pilotModel,commanderMessage,context:snapshot,plan:reply.plan,interpretation:reply.interpretation,result:receipt}),'application/json',AbortSignal.any([signal,controller.signal]));}
        finally{clearInterval(guard);}
        current();if(ref.world.time-snapshot.simTimeSec>120)throw Error('结果采样已经过期，请重新报告状态');
        if(clock!==getState().playing)continue;
        const expectedModel=health?.pilotModels?.find(m=>m.id===ref.pilotModel)?.model||pilotModelInfo(ref.pilotModel).model;
        if(reviewed.requestId!==requestId||reviewed.revision!==snapshot.revision||reviewed.simTimeSec!==snapshot.simTimeSec||reviewed.checkedBy!==expectedModel)throw Error(`${ref.pilotLabel} 检查结果不匹配`);
        validateResultReadbacks(reviewed,inspectCommandResult(snapshot,reply.plan,reply.interpretation,receipt));reply.resultReview=reviewed;
        for(const item of reviewed.checks){const unit=ref.world.units.find(u=>u.id===item.unitId);if(unit)unit.lastPilotResult={requestId,revision,...item};}
        return reviewed;
        }
        throw Error('检查期间连续切换暂停状态，请重新报告当前状态');
      }:null,
      assertCurrent:()=>assertCurrent(ref),assertWorldCurrent:()=>{if(ref.world!==getState().world)throw Error('战场已经重置，旧结果作废');},onPreview:onPilotPreview,onSimulation,
      onCommitted:()=>{committed=true;for(const task of reply.plan.tasks)if(task.unitId&&!['report_status','atc','radar','sensor_task','attack_task','weapon','assign_role'].includes(task.action))setPilotInstruction(ref.world.units.find(u=>u.id===task.unitId),reply.commanderMessage.text);onApplied();onCommandCommitted({reply,source});sync();}});
    if(token!==serial)return;
    ref.world.recordMilitaryOrder?.(requestId,reply.interpretation,reply.execution);
    if(result.committed){
      say(`${result.verifiedByModel?ref.pilotLabel+' 已检查':result.status==='reported'?'已报告':'已执行'}：${result.summary}`);log(result.summary);
    }else{
      const recognized=['capability_unavailable','informational'].includes(reply.execution?.status);
      say(result.summary,!recognized);status.dataset.pending=String(recognized);log(result.summary);
    }
    return {...result,reply};
  }
  async function operation(run,{rethrow=false,onStatus=null}={}){
    manualRadio.interrupt();
    radio.cancel();
    progressListener=onStatus;
    const token=++serial;busy=true;committed=false;const controller=new AbortController();abort=controller;const signal=controller.signal;
    const timeout=setTimeout(()=>controller.abort(),120000);sync();
    try{return await run(token,signal);}catch(e){if(token===serial){
      const message=committed?(e.pilotResultCheckFailure&&!signal.aborted?'程序继续执行已装订任务；飞行员结果检查未完成：'+e.message:'通话已结束，飞机继续执行已装订任务'):signal.aborted?'通联超时或已取消，本次任务未装订':e.message;
      radio.phase(committed?'executing':'cancelled',message);say(message,!committed);
    }if(rethrow){e.commandCommitted=committed;throw e;}}
    finally{clearTimeout(timeout);if(progressListener===onStatus)progressListener=null;if(token===serial){busy=false;abort=null;sync();}}
  }
  // The tutorial and free-command window share this AI / pilot / execution path.
  async function issue(instruction,{source='training',onStatus=null}={}){
    if(!health)await checkConnection();
    if(handoffRadio.active||busy||recording||starting)throw Error('另一条通联正在进行，请等飞行员复述后再下令。');
    if(!health?.commandReady)throw Error('AI 指挥服务尚未就绪，请检查连接后重试；本次未下令。');
    if(!pilotAvailable())throw Error('2B 模型下载暂未提供，请选择 Flash。');
    instruction=instruction.trim();if(!instruction)throw Error('请先说出你的命令。');
    const ref=reference();return operation((token,signal)=>interpret(instruction,ref,token,signal,source),{rethrow:true,onStatus});
  }
  async function submit(){
    if(handoffRadio.active||busy||recording||starting||!health?.commandReady||!pilotAvailable())return;
    const instruction=text.value.trim();if(!instruction)return;
    const ref=reference();await operation((token,signal)=>interpret(instruction,ref,token,signal));
  }
  async function finishRecording(){
    if(!recording)return;recording=false;clearTimeout(timer);timer=null;
    const active=recorder,ref=recordRef;recorder=null;
    await operation(async(token,signal)=>{
      say('正在转写语音…');const wav=await active.stop();
      if(token!==serial)return;
      const data=await post('/api/voice/transcribe',wav,'audio/wav',signal);
      if(token!==serial)return;
      text.value=data.text;assertCurrent(ref);
      if($('#command-auto').checked&&health.commandReady)await interpret(data.text,ref,token,signal);
      else say('转写完成，可编辑文字后点击“下达指令”');
    });
    $('#command-level').style.setProperty('--level','0%');
  }
  async function startRecording(){
    if(busy||starting||recording||!health?.voiceReady||!pilotAvailable())return;
    manualRadio.interrupt();
    radio.cancel();
    recordRef=reference();const token=++serial;starting=true;sync();say('请允许访问麦克风');
    const active=new WavRecorder(level=>$('#command-level').style.setProperty('--level',`${Math.round(level*100)}%`));recorder=active;
    try{
      await active.start();if(token!==serial){active.cancel();return;}
      starting=false;recording=true;say('正在收音，说完后结束录音 · 最长 20 秒');sync();
      timer=setTimeout(()=>void finishRecording(),20000);
    }catch(e){
      if(token!==serial)return;starting=false;recorder=null;
      say(e.name==='NotAllowedError'?'麦克风权限未开启，请允许后重试，也可输入文字':e.name==='NotFoundError'?'没有找到麦克风，可直接输入文字':e.message,true);sync();
    }
  }
  function cancelCurrent(message,{keepManual=false}={}){
    if(keepManual)manualRadio.interrupt();else manualRadio.clear();
    const hadCommitted=committed;message??=hadCommitted?'通话已停止，飞机继续执行已装订任务':'已取消，本次任务未装订';
    serial++;clearTimeout(timer);timer=null;abort?.abort();abort=null;recorder?.cancel();recorder=null;
    radio.cancel();getState().world.pilotPreview=null;radio.phase(hadCommitted?'executing':'cancelled',message);
    starting=false;recording=false;busy=false;$('#command-level').style.setProperty('--level','0%');say(message);sync();
  }
  async function checkConnection(){
    clearTimeout(healthTimer);badge.textContent='检查连接…';
    try{
      const r=await fetch('/api/health',{signal:AbortSignal.timeout(3000)});const data=await r.json();
      if(!r.ok||data.service!=='tactical-voice')throw Error();const connectionChanged=!health||health.commandReady!==data.commandReady||health.ai?.status!==data.ai?.status;health=data;
      radio.configure?.(data.tts);
      const local=data.provider==='local',ai=data.ai;
      const model=document.querySelector('.command-model');if(model)model.textContent=local?'QWEN3.5 · 2B · 本地共享':data.commandModel;
      badge.textContent=local?(data.commandReady?'本地模型 · 就绪':ai?.status==='loading'?'本地模型 · 加载中':'本地模型 · 未就绪'):data.commandReady?'QWEN · 已配置':'等待配置密钥';
      const resource=document.querySelector('#command-ai-resource');
      if(resource){resource.hidden=!local;const used=ai?.memory?.dedicatedMiB,peak=ai?.memory?.peakDedicatedMiB;
        const timings=ai?.roleTimings,latency=timings?.commander!=null?` · 指挥 ${(timings.commander/1000).toFixed(1)}s${timings.pilot!=null?` / 复诵 ${(timings.pilot/1000).toFixed(1)}s`:''}`:'';
        resource.textContent=Number.isFinite(used)?`共享模型 · AI 显存 ${Math.round(used)} MiB · 峰值 ${Math.round(peak)} MiB${latency}`:'指挥官与飞行员共用模型 · 正在测量显存';}
      if(resource&&data.pilotAssistant?.enabled){
        const pilot=data.pilotAssistant,labels={sleeping:'待命，程序飞行',loading:'准备判断',planning_command:'正在规划任务',planning_departure:'正在选择推力与离场航路',assessing:'正在判断事件',checking_result:'正在检查指令结果',unloading:'结束检查'};
        resource.hidden=false;resource.textContent=pilotModel==='2b'?'2B 飞行员 · 下载暂未提供':`Flash 飞行员 · ${labels[pilot.status]||pilot.status} · 云端模型 · 已判断 ${pilot.modelCalls} 次`;
      }
      if(connectionChanged&&!busy&&!recording&&!starting)say(!pilotAvailable()?'2B 模型下载暂未提供，请选择 Flash':local?(data.commandReady?'本地指挥官与 Flash 飞行员，可输入文字或语音下令':ai?.error||'正在自动加载本地指挥官模型，飞行控制可正常使用'):data.commandReady?'可语音下令，也可直接输入文字':'打开设置 → API 接入，填写自己的 Qwen API Key 并应用即可；也可使用本机 .env 配置',local?ai?.status==='error':!data.commandReady);
      if((local&&ai?.status!=='error'||data.pilotAssistant?.enabled)&&!closed)healthTimer=setTimeout(()=>void checkConnection(),2000);
    }catch{badge.textContent='连接暂不可用 · 正在重试';if(!busy&&!recording&&!starting&&!health)say('请使用 start_game.cmd 启动带语音 API 的游戏服务',true);if(!closed)healthTimer=setTimeout(()=>void checkConnection(),2000);}
    sync();
  }
  mic.onclick=()=>recording?void finishRecording():void startRecording();send.onclick=()=>void submit();
  if(modelSelect)modelSelect.onchange=()=>{
    pilotModel=pilotModelInfo(modelSelect.value)?modelSelect.value:DEFAULT_PILOT_MODEL;
    modelSelect.value=pilotModel;
    try{globalThis.localStorage?.setItem('flight-pilot-model',pilotModel);}catch{}
    cancelCurrent(pilotAvailable()?`已选择 ${pilotLabel()} 飞行员`:'2B 模型下载暂未提供，请选择 Flash');
    onPilotModelChanged(pilotModel);void checkConnection();
  };
  cancel.onclick=()=>cancelCurrent();badge.onclick=()=>void checkConnection();text.oninput=sync;
  text.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();void submit();}});
  let keyHeld=false;
  document.addEventListener('keydown',e=>{
    if(e.code!=='KeyV'||e.repeat||e.ctrlKey||e.metaKey||e.altKey||e.target?.matches('input,textarea,select,[contenteditable="true"]'))return;
    if(busy||starting||recording)return;e.preventDefault();keyHeld=true;void startRecording();
  });
  document.addEventListener('keyup',e=>{
    if(e.code!=='KeyV'||!keyHeld)return;keyHeld=false;e.preventDefault();
    if(starting)cancelCurrent('收音尚未开始，请按住 V 稍久，或使用录音按钮');else void finishRecording();
  });
  window.addEventListener('blur',()=>{keyHeld=false;if(starting||recording)cancelCurrent('窗口失去焦点，录音已取消');});
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&(starting||recording))cancelCurrent('页面已隐藏，录音已取消');});
  window.addEventListener('pagehide',()=>{closed=true;clearTimeout(healthTimer);cancelCurrent();});
  buildHandbook();updateUnitHint();sync();void checkConnection();
  return {issue,get busy(){return handoffRadio.active||busy||recording||starting;},get playerCommandPending(){return recording||starting||busy&&!committed;},reportPilotExecution:report=>executionRadio.enqueue(report),requestHandoff:id=>handoffRadio.request(id),pumpAirportRadio:()=>{rwrRadio.pump();manualRadio.pump();executionRadio.pump();handoffRadio.pump();airportRadio.pump();radarRadio.pump();if(handoffWasBusy!==handoffRadio.active){handoffWasBusy=handoffRadio.active;sync();}},routeChanged(id,change){if(busy||recording||starting)cancelCurrent('手动航路已接管，旧通联已停止',{keepManual:true});manualRadio.enqueue(id,change);},unitsChanged(){if(busy||recording||starting)cancelCurrent('单位已切换，请按新单位重新下令');updateUnitHint();if(lastUnderstanding)showUnderstanding(lastUnderstanding.interpretation,lastUnderstanding.execution);},cancel:cancelCurrent,get pilotModel(){return pilotModel;},get pilotAssistantEnabled(){return pilotAvailable()&&health?.pilotReady!==false&&!!health?.pilotAssistant?.enabled&&!busy&&!recording&&!starting;},reset(){handoffRadio.reset();cancelCurrent('战场已重置，请重新下令');showUnderstanding(null,null);lastUnderstanding=null;executionRadio.queue.length=0;radio.clear();}};
}
