import {radioAltitude,radioSpeed,radioDistance} from './units.js';
import {commandById} from './military-commands.js';
import {FORMATION_ACTIONS,PROTECTION_MODES} from './formation.js';
import {FORMATIONS,doctrineLabel} from './formation-doctrine.js';
import {unitLabels,altitudeValue,speedValue,distanceValue,unitPolicy} from './units.js';
import {airportCommandLabel,airportModeLabel,airportModeSupported} from './airport-language.js';
import {needsDeparturePlan,departurePlanReadback} from './departure-plan.js';
import {radarContext} from './radar.js';
import {radarTaskContext} from './radar-task.js';
import {attackTaskContext} from './attack-task.js';
import {groundStatusReport} from './ground-radio.js';

const number=value=>String(Math.round(value*100)/100);
const near=(a,b,tolerance=.01)=>typeof a==='number'&&Number.isFinite(a)&&Math.abs(a-b)<=tolerance;
const angle=(a,b)=>Math.abs(((a-b+540)%360)-180);
export const RESULT_VERDICTS=['executing','reached','blocked','mismatch','reported'];

export function captureCommandResult(world,{outcome='applied',reason=null,clockRunning=null}={}){
  return {outcome,reason,clockRunning,units:world.units.map(u=>({unitId:u.id,holdAltitudeM:u.holdAltitude,targetSpeedMps:u.targetSpeed,
    headingRoute:u.headingRoute?{headingDeg:u.headingRoute.headingDeg,targetAltitudeM:u.headingRoute.targetAltitudeM,continuous:u.headingRoute.continuous}:null,
    flightRole:u.flightRole?{...u.flightRole}:null,
    formation:u.formation?{leaderId:u.formation.leaderId,shape:u.formation.shape,side:u.formation.side,rangeM:u.formation.rangeM,intent:u.formation.intent,status:u.formation.status}:null,
    surface:u.surface?{phase:u.surface.phase,runway:u.surface.runway??null,depart:!!u.surface.depart,lineUp:!!u.surface.lineUp,landCleared:!!u.surface.landCleared,destination:u.surface.destination??null}:null,
    radar:radarContext(u,world.time),radarTask:radarTaskContext(u),attackTask:attackTaskContext(u),weapons:weaponsContext(u,world.time),rwrDefense:defenseContext(u),gearDown:!!u.gearDown,flaps:u.flaps??null,departurePowerPlan:u.departurePowerPlan?structuredClone(u.departurePowerPlan):null,
    waypoints:u.waypoints.slice(0,32).map(w=>w.slice(0,3)),orbit:[...u.orbit],navigationBlocked:u.navigationBlocked||null}))};
}
function instruction(task,system,units){
  if(task.action==='attack_task'){const o=task.attackOrder,labels=unitLabels(system);return '执行攻击任务，'+(o.targetRef??o.targetId??'搜索并识别任务目标')+'，'+(o.weaponRef?'使用'+o.weaponRef:'自主选择导弹')+'，本次最多'+o.shotLimit+'枚'+(o.altitudeM!==null?'，高度'+radioAltitude(o.altitudeM,system)+labels.altitudeSpoken:'')+(o.speedMps!==null?'，真空速'+radioSpeed(o.speedMps,system)+labels.speedSpoken:'');}
  if(task.action==='defense')return defensePhrase(task.defenseOrder);
  if(task.action==='sensor_task')return (task.sensorTask.goal==='search'?'搜索前方空域':'持续跟踪目标')+'，由飞行员自主操作雷达';
  if(task.action==='weapon')return weaponPhrase(task.weaponOrder);
  const parts=[],labels=unitLabels(system);
  if(task.action==='radar'){const o=task.radarOrder;parts.push(o.operation==='lock'?'开始截获目标'+o.targetId:o.operation==='unlock'?'解除锁定，恢复搜索':o.mode==='off'?'关闭雷达':`切换${o.mode==='pd'?'PD':'SRC'}雷达搜索`);}
  if(task.action==='assign_role')parts.push(`担任${task.role==='lead'?'长机':'僚机'}，搭档${units.find(u=>u.id===task.targetId)?.callsign??task.targetId}`);
  if(FORMATION_ACTIONS.includes(task.action))parts.push(`${PROTECTION_MODES[task.action]?.label??'跟随'}${units.find(u=>u.id===task.targetId)?.callsign??task.targetId}，${doctrineLabel(FORMATIONS,task.formation)}${task.formation==='trail'?'':`，${task.side==='left'?'左侧':'右侧'}`}，间隔${number(distanceValue(task.rangeM,system))}${labels.distanceSpoken}`);
  if(task.action==='airport'){
    const o=task.airportOrder;parts.push(airportCommandLabel(o.intent)??o.intent);
    if(o.runway)parts.push('跑道'+o.runway);
    if(o.gate)parts.push('机位'+o.gate);
    if(o.taxiways?.length)parts.push('经'+o.taxiways.join('、'));
    if(Number.isFinite(o.altitudeM))parts.push('高度'+number(radioAltitude(o.altitudeM,system))+labels.altitudeSpoken);
    const mode=airportModeLabel(o.mode,o.intent);if(mode)parts.push(mode);
  }
  if(task.action==='fly_heading')parts.push('航向'+number(task.headingDeg%360)+'度');
  if(task.action==='fly_to')parts.push(task.append?'追加指定航点':'飞往指定航点');
  if(['orbit','clear_waypoints'].includes(task.action))parts.push(task.action==='orbit'?'盘旋待命':'清除航路并待命');
  if(task.action==='report_status')parts.push('报告本机状态');
  if(Number.isFinite(task.altitudeM))parts.push('高度'+number(radioAltitude(task.altitudeM,system))+labels.altitudeSpoken);
  if(Number.isFinite(task.speedMps))parts.push('真空速'+number(radioSpeed(task.speedMps,system))+labels.speedSpoken);
  if(Number.isFinite(task.distanceM))parts.push('前出'+number(distanceValue(task.distanceM,system))+labels.distanceSpoken);
  return parts.join('，');
}
// Compare issued targets with installed tasks and measured state. This never changes the World.
export function inspectCommandResult(context,plan,interpretation,result){
  const system=context.unitSystem??'metric',labels=unitLabels(system);
  const ids=[...new Set([...plan.tasks.map(t=>t.unitId),...(result.outcome==='applied'?[]:(interpretation?.orders??[]).flatMap(o=>o.unitIds))].filter(id=>id!==null))];
  if(plan.tasks.some(t=>t.unitId===null))ids.push(null);
  return ids.map(unitId=>{
    const unit=context.units.find(u=>u.id===unitId),state=result.units.find(u=>u.unitId===unitId),tasks=plan.tasks.filter(t=>t.unitId===unitId);
    const orders=(interpretation?.orders??[]).filter(o=>o.unitIds.includes(unitId));
    const installation=[],goals=[],details=[];
    let requiredReadback=tasks.map(t=>instruction(t,system,context.units)).filter(Boolean).join('；')||orders.map(o=>commandById(o.intent)?.label.split(' / ')[0]||o.intent).join('；');
    let verdict;
    if(result.outcome==='blocked')verdict='blocked';
    else if(result.outcome==='informational')verdict='reported';
    else if(unitId===null){
      const action=tasks.at(-1)?.action;requiredReadback=action==='pause'?'暂停模拟':'继续模拟';
      const matched=result.clockRunning===(action==='resume');installation.push({field:'模拟时钟',matched});verdict=matched?'reported':'mismatch';
    }else if(unit?.alive===false&&tasks.some(t=>t.action!=='report_status'))verdict='blocked';
    else{
      for(const t of tasks){
        if(t.action==='defense'){const d=state.rwrDefense,o=t.defenseOrder,matched=o.mode==='execute'?d?.active?.manual&&d.active.maneuver===o.maneuver&&(o.headingDeg===null||near(d.active.headingDeg,o.headingDeg)):d?.mode===o.mode;installation.push({field:'RWR防御策略与规避装订',expected:o,actual:d,matched:!!matched});goals.push(false);continue;}
        if(t.action==='weapon'){
          const o=t.weaponOrder,w=state.weapons,l=w?.lastLaunch;
          const matched=o.operation==='select'?w?.selectedModelId===o.modelId:o.operation==='designate'?w?.targetId===o.targetId:o.operation==='launch'?l?.modelId===o.modelId&&l?.targetId===o.targetId&&l?.quantity===o.quantity&&l?.time>=context.simTimeSec-60:w?.roe===o.operation;
          installation.push({field:o.operation==='launch'?'实际发射记录（不等于命中）':'武器设置',expected:o,actual:o.operation==='launch'?l:w,matched:!!matched});goals.push(!!matched);continue;
        }
        if(t.action==='report_status')continue;
        if(t.action==='attack_task'){const s=state.attackTask,o=t.attackOrder,matched=s?.active===true&&['targetId','targetRef','weaponRef','shotLimit','altitudeM','speedMps','headingDeg'].every(k=>s[k]===o[k]);installation.push({field:'攻击任务授权',expected:o,actual:s??null,matched});continue;}
        if(t.action==='sensor_task'){const s=state.radarTask,matched=s?.active===true&&s.goal===t.sensorTask.goal&&s.targetId===t.sensorTask.targetId&&s.targetRef===t.sensorTask.targetRef;installation.push({field:'雷达任务',expected:t.sensorTask,actual:s?{...s,phase:state.radar?.phase}:null,matched});continue;}
        if(t.action==='radar'){const o=t.radarOrder,r=state.radar,matched=o.operation==='mode'?r?.mode===o.mode:o.operation==='lock'?r?.targetId===o.targetId:r?.targetId===null;installation.push({field:'雷达设置',expected:o,actual:r?{mode:r.mode,phase:r.phase,targetId:r.targetId}:null,matched});continue;}
        if(t.action==='assign_role'){const matched=state.flightRole?.role===t.role&&state.flightRole?.partnerId===t.targetId;installation.push({field:'长僚机角色',expected:{role:t.role,partnerId:t.targetId},actual:state.flightRole??null,matched});goals.push(matched);}
        if(t.action==='airport'){
          const o=t.airportOrder,s=state.surface,phase=s?.phase;
          const supported={taxi:['taxi','holding','parked'],hold_short:['taxi','holding'],line_up:['holding','lineup_taxi','lined_up'],takeoff:['taxi','holding','lineup_taxi','lined_up','takeoff_roll','climb'],abort_takeoff:['rejected','exit','parked'],approach:['approach','final'],land:['approach','final','rollout','exit','parked'],go_around:['missed','climb']};
          const matched=o.intent==='gear'?state.gearDown===(o.mode!=='up'):o.intent==='flaps'?state.flaps===(o.mode??'landing'):
            airportModeSupported(o)&&(!needsDeparturePlan(o)||state.departurePowerPlan?.mode===o.mode)&&!!s&&supported[o.intent]?.includes(phase)&&(!o.runway||s.runway===o.runway)&&(o.intent!=='land'||s.landCleared||['rollout','exit','parked'].includes(phase))&&(o.intent!=='takeoff'||s.depart||phase==='climb')&&(o.intent!=='line_up'||s.lineUp||phase==='lined_up');
          if(needsDeparturePlan(o))installation.push({field:'飞行员推力与离场航路',expected:o.mode,actual:state.departurePowerPlan,matched:!!state.departurePowerPlan&&state.departurePowerPlan.mode===o.mode});
          installation.push({field:'机场任务',expected:o,actual:s??null,matched:!!matched});
          goals.push(['gear','flaps'].includes(o.intent)||o.intent==='taxi'&&['holding','parked'].includes(phase)||o.intent==='hold_short'&&phase==='holding'||o.intent==='line_up'&&phase==='lined_up'||o.intent==='takeoff'&&phase==='climb'||o.intent==='land'&&['rollout','exit','parked'].includes(phase));
        }
        if(FORMATION_ACTIONS.includes(t.action)){
          const f=state.formation,matched=!!f&&f.leaderId===t.targetId&&f.shape===t.formation&&f.side===t.side&&near(f.rangeM,t.rangeM)&&(!PROTECTION_MODES[t.action]||f.intent===t.action);
          installation.push({field:'双机编队任务',expected:{leaderId:t.targetId,shape:t.formation,side:t.side,rangeM:t.rangeM},actual:f??null,matched});goals.push(matched&&f.status==='holding');
        }
        if(Number.isFinite(t.speedMps)){installation.push({field:'目标真空速',unit:labels.speedSpoken,expected:Number(number(radioSpeed(t.speedMps,system))),actual:Number(number(radioSpeed(state.targetSpeedMps,system))),matched:near(state.targetSpeedMps,t.speedMps)});goals.push(near(unit.speedMps,t.speedMps,5/3.6));}
        if(Number.isFinite(t.altitudeM)&&t.action!=='fly_to'){installation.push({field:'目标高度',unit:labels.altitudeSpoken,expected:Number(number(radioAltitude(t.altitudeM,system))),actual:Number(number(radioAltitude(state.holdAltitudeM,system))),matched:near(state.holdAltitudeM,t.altitudeM)});goals.push(near(unit.position[2],t.altitudeM,50));}
        if(t.action==='fly_heading'){
          const matched=state.headingRoute!==null&&angle(state.headingRoute.headingDeg,t.headingDeg)<.01;
          installation.push({field:'目标航向',unit:'度',expected:t.headingDeg,actual:state.headingRoute?.headingDeg??null,matched});goals.push(angle(unit.headingDeg,t.headingDeg)<=3);
          if(Number.isFinite(t.distanceM)){installation.push({field:'定长航段',matched:state.headingRoute?.continuous===false});goals.push(state.waypoints.length===0);}
        }
        if(t.action==='fly_to'){
          const point=[t.eastM,t.northM,t.altitudeM??unit.targetAltitudeM],arrived=Math.hypot(...unit.position.map((v,i)=>v-point[i]))<=250;
          installation.push({field:'指定航点',expected:point,matched:state.waypoints.some(w=>Math.hypot(...w.map((v,i)=>v-point[i]))<1)||arrived});goals.push(arrived);
        }
        if(['orbit','clear_waypoints'].includes(t.action)){
          installation.push({field:'盘旋待命任务',matched:state.waypoints.length===0&&state.headingRoute===null});goals.push(false);
        }
      }
      if(tasks.every(t=>t.action==='report_status')){
        verdict='reported';requiredReadback=groundStatusReport(unit)??`航向${number(Math.round(unit.headingDeg))}度，高度${number(radioAltitude(unit.position[2],system))}${labels.altitudeSpoken}，真空速${number(radioSpeed(unit.speedMps,system))}${labels.speedSpoken}`;
      }else if(installation.some(item=>!item.matched))verdict='mismatch';
      else if(tasks.every(t=>t.action==='defense'&&t.defenseOrder.mode!=='execute'))verdict='reported';
      else if(tasks.every(t=>t.action==='weapon')){verdict='reported';if(tasks.some(t=>t.weaponOrder.operation==='launch'))requiredReadback+='，已发射，尚未确认命中';}
      else if(tasks.every(t=>t.action==='radar'))verdict=tasks.some(t=>t.radarOrder.operation==='lock')&&state.radar?.phase!=='locked'?'executing':'reported';
      else if(tasks.every(t=>t.action==='sensor_task'))verdict='executing';
      else if(tasks.every(t=>t.action==='attack_task'))verdict='executing';
      else if(state.navigationBlocked)verdict='blocked';
      else verdict=goals.length&&goals.every(Boolean)?'reached':'executing';
    }
    if(tasks.some(t=>t.action==='airport'&&needsDeparturePlan(t.airportOrder))&&state?.departurePowerPlan)requiredReadback+='，'+departurePlanReadback(state.departurePowerPlan,system);
    details.push(result.reason||'');if(state?.navigationBlocked)details.push(state.navigationBlocked);
    return {unitId,requiredReadback,expectedVerdict:verdict,departurePlan:state?.departurePowerPlan??null,modelFacts:{unitId,callsign:unit?.callsign??'指挥台',instruction:requiredReadback,
      comparisonSummary:{executing:'目标设置与命令一致；当前飞行状态尚未全部达到目标，正在执行。',reached:'当前飞行参数已达到本次指令要求；达到参数目标后仍可继续飞行，不要求航点队列清空。',
        blocked:'程序无法执行这条指令。',mismatch:'程序实际装订的设置与指挥命令不一致。只对比installation里的expected和actual说明设置差异；当前飞机还没转向或爬升到位不代表装订错误。',reported:'这是一份已经核实的状态或通报。'}[verdict],
      claimedOutcome:result.outcome,units:unitPolicy(system),installation,goalReached:goals.length?goals.every(Boolean):null,
      tolerances:{headingDeg:3,altitudeM:50,speedKph:5},
      observed:unit&&verdict!=='mismatch'?(groundStatusReport(unit)?{alive:unit.alive,grounded:true,phase:unit.surfacePhase,groundNode:unit.groundNode,groundRunway:unit.groundRunway,groundStatus:groundStatusReport(unit)}:{alive:unit.alive,headingDeg:Number(number(unit.headingDeg)),altitude:Number(number(radioAltitude(unit.position[2],system))),altitudeUnit:labels.altitudeSpoken,speed:Number(number(radioSpeed(unit.speedMps,system))),speedUnit:labels.speedSpoken}):null,
      reason:details.filter(Boolean).join('；')}};
  });
}

export function validateResultReadbacks(value,facts){
  if(!value||!Array.isArray(value.checks)||value.checks.length!==facts.length)throw Error('2B遗漏了需要检查的飞机');
  for(let i=0;i<facts.length;i++){
    const check=value.checks[i],fact=facts[i];
    if(fact.modelFacts.installation.some(item=>item.field==='实际发射记录（不等于命中）')&&/(?:已(?:经)?|成功)(?:命中|击毁)|命中目标|目标被击毁|\b(?:target destroyed|confirmed kill)\b/i.test(check.readbackText??''))throw Error('发射记录不能作为命中或击毁证据');
    const radarSetting=fact.modelFacts.installation.find(item=>['雷达设置','雷达任务'].includes(item.field));
    if(radarSetting&&radarSetting.actual?.phase!=='locked'&&/(已(?:经)?锁定|锁定成功|锁定完成)/.test(check.readbackText??''))throw Error('雷达尚未建立稳定锁定，不能报告锁定成功');
    if(check.unitId!==fact.unitId||check.verdict!==fact.expectedVerdict)throw Error('2B报告与实际执行结果不一致');
    if(fact.modelFacts.observed?.grounded&&fact.expectedVerdict==='reported'&&/(高度|空速|马赫|\b(?:altitude|airspeed|mach)\b)/i.test(check.readbackText??''))throw Error('地面准备通联应报告位置与许可状态，不附加飞行高度或空速');
    const normalized=text=>text.replace(/\s/g,'').replace(/,/g,'，').replace(/公里\/小时|千米\/小时/g,'公里每小时');
    if(typeof check.readbackText!=='string'||!check.readbackText.trim()||check.readbackText.length>300||!normalized(check.readbackText).includes(normalized(fact.requiredReadback)))throw Error('2B复述遗漏或改变了关键参数');
    const allowedNumbers=new Set(((fact.requiredReadback+' '+fact.modelFacts.callsign+' '+JSON.stringify({installation:fact.modelFacts.installation,observed:fact.modelFacts.observed,reason:check.verdict==='blocked'?fact.modelFacts.reason:null})).match(/\d+(?:\.\d+)?/g)??[]));
    for(const numeric of check.readbackText.match(/\d+(?:\.\d+)?/g)??[])if(!allowedNumbers.has(numeric))throw Error('复述添加了指令没有要求的数值，请只复述instruction和结果状态');
    if(check.verdict!=='reached'&&/(已(?:经)?(?:到达|达到)|已(?:经)?完成(?:任务|目标|飞行)|目标已(?:完成|达成)|\b(?:TARGET REACHED|MISSION COMPLETE)\b)/i.test(check.readbackText))throw Error('任务尚未完成，不能报告已经达到目标');
    if(check.verdict==='executing'&&!/(执行中|正在(?:执行|转向|爬升|下降|飞行))/.test(check.readbackText))throw Error('2B需要说明任务仍在执行中');
    if(check.verdict==='reached'&&!/(已(?:经)?(?:达到|到达)|目标已达成)/.test(check.readbackText))throw Error('2B需要说明采样数据已经达到目标');
    if(check.verdict==='blocked'&&!/(无法|不能执行|未执行)/.test(check.readbackText))throw Error('2B需要说明任务无法执行');
    if(check.verdict==='mismatch'&&!/((装订|设置).*(不一致|未通过|不匹配)|(不一致|不匹配).*装订|未装订)/.test(check.readbackText))throw Error('2B需要明确报告装订或设置不一致，不能仅因当前飞机尚未到达目标而报告错误');
  }
  return value;
}
import {weaponPhrase,weaponsContext} from './weapons.js';
import {defensePhrase,defenseContext} from './rwr-defense.js';
