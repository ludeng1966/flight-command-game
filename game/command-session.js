import {preparePilotPlan,commitPilotPlan} from '../sim/orders.js';
import {createCommandExchange,pilotUnable,verifyReadback,unitRadioName} from '../sim/radio-procedure.js';
import {ROUTINE_INTENTS} from '../sim/pilot-watch.js';
import {needsDeparturePlan} from '../sim/departure-plan.js';
import {createCommanderTransmission,captureCommanderMessage,captureAcceptedCommanderMessage} from '../sim/commander-message.js';
import {towerTask,createTowerTransmission} from '../sim/control-radio.js';
import {controlAuthority,requestHandoff} from '../sim/control-authority.js';
import {transmitHandoff} from './control-handoff.js';
import {validateAtcAssignment} from '../sim/atc-command.js';
import {AIRPORT_STATIONS} from '../sim/airport-atc.js';

const abortError=()=>new DOMException('通联已取消','AbortError');
export function radioPause(ms,signal){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(abortError());return;}
    const done=()=>{signal?.removeEventListener('abort',cancel);resolve();};
    const timer=setTimeout(done,ms),cancel=()=>{clearTimeout(timer);reject(abortError());};
    signal?.addEventListener('abort',cancel,{once:true});
  });
}

// Routine orders are handled by the computer pilot without model review.
// Event-driven judgment runs independently and never stalls continuous flight.
export async function runCommandSession({world,reply,expectedRevision,selectedUnitId=null,style='pla',radio,signal,onPreview=()=>{},onCommitted=()=>{},onSimulation=()=>{},pause=radioPause,assertCurrent=()=>{},assertWorldCurrent=()=>{},reviewPilot=null,checkPilotResult=null,planPilotCommand=null,preparePlan=preparePilotPlan,pilotLabel='AI',enforceAuthority=false,responsive=false,speechSignal=null,onSpeechError=()=>{},executionGuard=null}){
  let {plan,interpretation,execution}=reply;const language=style==='nato'?'en-US':'zh-CN';
  const throughTower=plan.status==='accepted'&&towerTask(reply,world),airport=world.airportOps?.airport.id??'BAY';
  const detachedSpeech=responsive&&!throughTower;
  const speechError=error=>{try{void Promise.resolve(onSpeechError(error)).catch(()=>{});}catch{/* Reporting must not reject an installed command. */}};
  let towerStation='tower';
  const transmit=(message,options)=>{
    if(throughTower&&message.speaker==='pilot'){
      const address=(text,en=false)=>{if(!text)return text;const station=AIRPORT_STATIONS[towerStation]??AIRPORT_STATIONS.tower,target=en?`${airport} ${station.en}`:`${airport}${station.zh}`;if(text.startsWith(target))return text;return target+(en?', ':'，')+text.replace(en?/^CONTROL[., ]*/:/^指挥台[，,。]*/,'');};
      message={...message,text:address(message.text,message.language==='en-US'),...(message.texts?{texts:{zh:address(message.texts.zh),en:address(message.texts.en,true)}}:{})};
    }
    message={...message,commandId:reply.requestId,unitIds:[...new Set(plan.tasks.map(t=>t.unitId).filter(Boolean))]};
    if(!detachedSpeech)return radio.transmit(message,options);
    // Cancellation of sound never cancels the command's planning/commit signal.
    const speechOptions={...options,signal:speechSignal};
    try{
      if(radio.publish){const handle=radio.publish(message,speechOptions);void handle.completion.catch(speechError);return Promise.resolve(handle.record);}
      // Small adapters/tests can retain transmit-only consoles.
      void Promise.resolve().then(()=>radio.transmit(message,speechOptions)).catch(speechError);
      return Promise.resolve({...message,id:reply.requestId,delivery:'queued',reception:'accepted'});
    }catch(error){speechError(error);return Promise.resolve({...message,id:reply.requestId,delivery:'unavailable',reception:'accepted'});}
  };
  const check=()=>{if(signal?.aborted)throw abortError();if(executionGuard){executionGuard.assertCurrent();expectedRevision=executionGuard.rebase?.()??world.revision;}else{assertCurrent();if(world.revision!==expectedRevision)throw Error('收到新指令，本次通联作废');}};
  const send=(speaker,text,unitId=null)=>transmit({speaker,text,unitId,language},{signal});
  async function checkedReadback(outcome,result,reason=null){
    if(!checkPilotResult)return null;
    const revision=world.revision;
    const current=()=>{if(signal?.aborted)throw abortError();assertWorldCurrent();if(executionGuard)executionGuard.assertCurrent();else if(world.revision!==revision)throw Error('检查期间收到新操作，旧结果不再复述');};
    try{
      current();radio.phase('pilot-result-check','核对实际装订与执行状态');
      const reviewed=await checkPilotResult({outcome,result,reason,revision,commanderMessage:reply.commanderMessage});current();
      if(!reviewed?.checks?.length)throw Error(`${pilotLabel} 未返回执行结果`);
      for(const item of reviewed.checks){
        current();const unit=world.units.find(u=>u.id===item.unitId),name=unit?unitRadioName(unit,world.units.indexOf(unit),style):'指挥台';
        radio.phase('pilot-result-readback',reviewed.checkedBy==='flight-computer'?'程序已核实 · 飞行员复述':`${pilotLabel} 飞行员 · 检查后复述`);
        const englishName=unit?unitRadioName(unit,world.units.indexOf(unit),'nato'):'CONTROL',speakerUnit=unit??world.units.find(u=>u.id===selectedUnitId)??world.units[0],speakerIndex=world.units.indexOf(speakerUnit);
        const blocked=item.verdict==='blocked',zhReason=(item.readbackTexts?.zh??item.readbackText).replace(/[，,\s]*(?:当前)?无法执行[。.]?$/,''),enReason=(item.readbackTexts?.en??item.readbackText).replace(/[.\s]*Unable to execute\.[\s]*$/i,'');
        const texts=blocked?{zh:pilotUnable(speakerUnit,speakerIndex,zhReason,'pla'),en:pilotUnable(speakerUnit,speakerIndex,enReason,'nato')}:item.readbackTexts?{zh:`${unit?unitRadioName(unit,world.units.indexOf(unit),style):'指挥台'}，${item.readbackTexts.zh}`,en:`${englishName}. ${item.readbackTexts.en}`}:undefined;
        const pilotText=blocked?pilotUnable(speakerUnit,speakerIndex,zhReason,style):`${name}，${item.readbackText}`;
        await transmit({speaker:'pilot',unitId:item.unitId,text:pilotText,texts,language:'zh-CN',checkedByModel:reviewed.checkedBy!=='flight-computer',model:reviewed.checkedBy,simTime:reviewed.simTimeSec},{signal,isCurrent:()=>{try{current();return reviewed.isCurrent?.()!==false;}catch{return false;}}});
      }
      return {reviewed,verifiedByModel:reviewed.checkedBy!=='flight-computer',summary:reviewed.checks.map(item=>item.readbackText).join('；')};
    }catch(error){error.pilotResultCheckFailure=true;throw error;}
  }
  check();
  if(enforceAuthority&&plan.status==='accepted')for(const id of new Set(plan.tasks.map(t=>t.unitId).filter(Boolean))){
    const u=world.units.find(u=>u.id===id),c=controlAuthority(world,u),tasks=plan.tasks.filter(t=>t.unitId===id);
    if(throughTower&&tasks.some(t=>['airport','atc'].includes(t.action))){
      for(const t of tasks.filter(t=>t.action==='atc'))validateAtcAssignment(world,u,t.atcOrder);
      for(const t of tasks.filter(t=>t.action==='airport'))world.airportOps?.validate(u,t.airportOrder,world.executionMode);
      if(c.owner==='commander'){if(c.mode==='manual')throw Error('严苛模式需要手动交接：先点击“返场联系塔台”，等待塔台确认接管');requestHandoff(world,u,'tower');await transmitHandoff(world,u,radio,{signal});check();}
    }else if(!throughTower&&c.owner==='tower'&&tasks.some(t=>!['report_status','pause','resume'].includes(t.action))){
      if(c.mode==='auto'&&c.target==='commander'){await transmitHandoff(world,u,radio,{signal});check();}
      else throw Error(c.phase==='ready'?'仍由塔台管制，请先点击“请求交接”，完成空中指挥接管':'塔台负责初始离场；完成离场交接后再下达空中任务');
    }
  }
  const transmission=throughTower?createTowerTransmission(reply,world,style,world.unitSystem):createCommanderTransmission(reply,world.units,style,world.unitSystem);
  towerStation=transmission.controllerRole??'tower';
  radio.phase(throughTower?'tower-command':'commander',throughTower?'指挥官AI已核对 · 以塔台身份发令':'空中指挥 · 正在播报命令');
  const record=await transmit(transmission,{signal});check();
  reply.commanderMessage=(detachedSpeech?captureAcceptedCommanderMessage:captureCommanderMessage)(transmission,record,reply.requestId,world.unitSystem);
  // The structured commander plan is already validated. Only navigation tasks
  // require the pilot's explicit 3D waypoint output (see validateAiNavigation).
  const requiresPilotPlan=!responsive||plan.status==='accepted'&&plan.tasks.some(t=>['fly_to','fly_heading'].includes(t.action));
  if(planPilotCommand&&requiresPilotPlan){
    radio.phase('pilot-model',`${pilotLabel} 飞行员 · 正在处理收到的指挥通话`);
    const planned=await planPilotCommand({commanderMessage:reply.commanderMessage});check();
    reply.commanderInterpretation=interpretation;
    Object.assign(reply,{interpretation:planned.interpretation,execution:planned.execution,plan:planned.plan,pilotCommandPlanning:planned});
    ({plan,interpretation,execution}=reply);
  }
  if(plan.status!=='accepted'){
    if(!['capability_unavailable','informational'].includes(execution?.status)){
      const unit=world.units.find(u=>u.id===selectedUnitId)??world.units[0],index=world.units.indexOf(unit);
      const text=pilotUnable(unit,index,plan.summary,style,{clarification:true});
      radio.phase('clarification','飞行员 · 无法执行，请重发指令');await transmit({speaker:'pilot',unitId:unit.id,text,texts:{zh:pilotUnable(unit,index,plan.summary,'pla',{clarification:true}),en:pilotUnable(unit,index,plan.summary,'nato',{clarification:true})},language},{signal});return {summary:text,status:'clarification',committed:false};
    }
    if(execution.status==='informational'){
      const checked=await checkedReadback('informational',null,plan.summary);radio.phase('reported','通报已记录');
      return {summary:checked?.summary??plan.summary,status:'informational',committed:false,verifiedByModel:checked?.verifiedByModel??false};
    }
    if(checkPilotResult){
      const checked=await checkedReadback('blocked',null,plan.summary);radio.phase('unable','程序已核实 · 当前无法执行');
      return {summary:checked.summary,status:'unable',committed:false,verifiedByModel:checked.verifiedByModel};
    }
    const ids=[...new Set((interpretation?.orders||[]).flatMap(o=>o.unitIds))];
    for(const id of ids){
      const u=world.units.find(u=>u.id===id);if(!u)continue;
      radio.phase('unable',`${u.callsign} · 报告无法执行`);
      const missing=execution.missingCapabilities?.map(c=>c.label).join('、');
      await send('pilot',pilotUnable(u,world.units.indexOf(u),missing?`尚未具备${missing}`:'当前无法完成要求的任务',style),u.id);check();
    }
    return {summary:plan.summary,status:'unable',committed:false};
  }
  const exchange=createCommandExchange(plan,world.units,style,world.unitSystem);
  const needsJudgment=(interpretation?.orders??[]).some(order=>!ROUTINE_INTENTS.includes(order.intent))||plan.tasks.some(t=>t.action==='airport'&&needsDeparturePlan(t.airportOrder));
  if(reviewPilot&&needsJudgment){
    radio.phase('pilot-model','飞行员 · 正在核对任务');
    try{await reviewPilot({commanderMessage:reply.commanderMessage});check();}catch(error){
      if(signal?.aborted||!checkPilotResult)throw error;
      const checked=await checkedReadback('blocked',null,error.message);radio.phase('unable','飞行员规划后报告无法执行');
      return {summary:checked.summary,status:'unable',committed:false,verifiedByModel:checked.verifiedByModel};
    }
  }
  if(plan.tasks.every(t=>t.action==='report_status')){
    const result=commitPilotPlan(preparePilotPlan(world,plan,expectedRevision,{radioStyle:style}));onCommitted(result,null);
    if(checkPilotResult){if(detachedSpeech){void checkedReadback('applied',result).catch(speechError);return {summary:result.summary,status:'reported',committed:true,verifiedByModel:false,resultReviewPending:true};}const checked=await checkedReadback('applied',result);radio.phase('reported','已核实并报告状态');return {summary:checked.summary,status:'reported',committed:true,verifiedByModel:checked.verifiedByModel};}
    radio.phase('reported','电脑飞行员报告当前状态');await transmit({speaker:'pilot',unitId:plan.tasks[0].unitId,text:result.summary,language:'zh-CN'},{signal});
    return {summary:result.summary,status:'reported',committed:true};
  }
  for(const pilot of checkPilotResult?[]:exchange.pilots){
    const commands=plan.tasks.filter(t=>t.unitId===pilot.unitId);verifyReadback(commands,pilot.tasks);
    radio.phase('readback',`${pilot.callsign} · 复诵关键参数`);await send('pilot',pilot.readbackText,pilot.unitId);check();
  }
  radio.phase('planning',checkPilotResult?'飞行员已拟定航点 · 校验可飞性与装订结果':'复诵核对通过 · 后台规划航路');if(!responsive)await pause(40,signal);check();
  let draft;
  try{
    const prepare=()=>preparePlan(world,plan,expectedRevision,{radioStyle:style,pilotProcedures:reply.pilotProcedures,aiRoutes:reply.pilotCommandPlanning?.pilotNavigationPlans??[],scoped:responsive},signal);
    draft=await prepare();check();
    for(const preview of draft.previews){
      if(responsive){world.pilotPreview={...preview,requestId:reply.requestId,count:preview.points.length};onPreview(world.pilotPreview);check();continue;}
      for(let count=1;count<=preview.points.length;count++){
        check();world.pilotPreview={...preview,requestId:reply.requestId,count};onPreview(world.pilotPreview);
        radio.phase('plotting',`${world.units.find(u=>u.id===preview.unitId).callsign} · 飞行员拟设航点 ${count}/${preview.points.length}`);
        await pause(320,signal);
      }
    }
    check();
    // Preview/model latency never freezes flight. Revalidate/recompute from live state before installation.
    let result;
    for(let attempt=0;attempt<3;attempt++){
      if(draft.backgroundPrepared&&world.time-draft.sampledAt>.5){draft=await prepare();check();}
      check();if(executionGuard)draft.expectedRevision=expectedRevision;
      try{result=commitPilotPlan(draft);break;}catch(error){if(error.code!=='FLIGHT_STATE_CHANGED'||attempt===2)throw error;draft=await prepare();check();}
    }
    world.pilotPreview=null;
    if(result.simulation)onSimulation(result.simulation==='resume');
    onCommitted(result,draft);
    if(checkPilotResult){
      if(detachedSpeech){void checkedReadback('applied',result).catch(speechError);radio.phase('executing','任务已装订 · 飞行员执行中');return {summary:result.summary,status:'executing',committed:true,verifiedByModel:false,resultReviewPending:true};}
      const checked=await checkedReadback('applied',result);radio.phase('executing','已核实并复述 · 程序继续飞行');
      return {summary:checked.summary,status:'executing',committed:true,verifiedByModel:checked.verifiedByModel};
    }
    radio.phase('executing','航路已装订 · 电脑飞行员执行中');
    for(const pilot of exchange.pilots){
      const u=world.units.find(u=>u.id===pilot.unitId),onlyReport=pilot.tasks.every(t=>t.action==='report_status');
      const count=u.waypoints.length,name=unitRadioName(u,world.units.indexOf(u),style);
      const text=onlyReport?result.summary:style==='nato'?`${name}. ${count?`${count} WAYPOINTS SET. `:''}EXECUTING.`:`${name}，${count?`航路已装订，共${count}个航点，`:''}正在执行。`;
      await send('pilot',text,pilot.unitId);
    }
    return {summary:result.summary,status:'executing',committed:true};
  }catch(error){
    world.pilotPreview=null;
    if(draft?.committed)throw error;
    if(signal?.aborted)throw error;
    if(checkPilotResult&&!error.pilotResultCheckFailure){
      await checkedReadback('blocked',null,error.message);radio.phase('unable','程序已核实 · 当前无法执行');
      error.pilotResultReviewed=true;throw error;
    }
    radio.phase('unable','飞行员 · 无法按当前指令执行');
    for(const pilot of exchange.pilots){
      const u=world.units.find(u=>u.id===pilot.unitId);
      await send('pilot',pilotUnable(u,world.units.indexOf(u),error.message,style),u.id);
    }
    throw error;
  }finally{world.pilotPreview=null;}
}
