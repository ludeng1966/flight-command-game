import {getUnitSystem,unitLabels,radioAltitude,radioSpeed,radioDistance,rounded} from './units.js';
import {radioDigits} from './radio.js';
import {commandById} from './military-commands.js';
import {planningModeLabel} from './command-planning.js';
import {FORMATION_ACTIONS,PROTECTION_MODES} from './formation.js';
import {FORMATIONS,doctrineLabel} from './formation-doctrine.js';
import {airportCommandLabel,airportModeLabel} from './airport-language.js';
import {groundStatusReport} from './ground-radio.js';

const ZH='零一二三四五六七八九';
export function chineseNumber(value){
  const n=Math.round(value);
  if(n<0)return '负'+chineseNumber(-n);
  if(n<10)return ZH[n];
  for(const [scale,word]of [[10000,'万'],[1000,'千'],[100,'百'],[10,'十']]){
    if(n<scale)continue;const head=Math.floor(n/scale),rest=n%scale;
    return (scale===10&&head===1?'':chineseNumber(head))+word+(rest?(rest<scale/10?'零':'')+chineseNumber(rest):'');
  }
}
function englishNumber(value){
  if(value<0)return 'MINUS '+englishNumber(-value);
  const n=Math.round(value),ones=['ZERO','ONE','TWO','THREE','FOUR','FIVE','SIX','SEVEN','EIGHT','NINE','TEN','ELEVEN','TWELVE','THIRTEEN','FOURTEEN','FIFTEEN','SIXTEEN','SEVENTEEN','EIGHTEEN','NINETEEN'];
  if(n<20)return ones[n];
  if(n<100)return ['','','TWENTY','THIRTY','FORTY','FIFTY','SIXTY','SEVENTY','EIGHTY','NINETY'][Math.floor(n/10)]+(n%10?' '+ones[n%10]:'');
  const scale=n>=1000?1000:100;return englishNumber(Math.floor(n/scale))+(scale===1000?' THOUSAND':' HUNDRED')+(n%scale?' '+englishNumber(n%scale):'');
}
function spokenNumber(value,style){
  if(value<0)return (style==='nato'?'MINUS ':'负')+spokenNumber(-value,style);
  const [whole,fraction]=Number(value.toFixed(3)).toString().split('.');
  const base=style==='nato'?englishNumber(Number(whole)):chineseNumber(Number(whole));
  return base+(fraction?(style==='nato'?' DECIMAL ':'点')+radioDigits(fraction,style):'');
}
export function unitRadioName(unit,index=0,style='pla'){
  if(style!=='nato')return radioDigits(unit.radioNumber||String(101+index));
  return unit.callsign.replace(/\d+/g,d=>radioDigits(d,'nato'));
}
const keyFields=['unitId','action','altitudeM','speedMps','headingDeg','eastM','northM','distanceM','append','targetId','formation','side','rangeM','role'];
export function verifyReadback(command,readback){
  if(command.length!==readback.length||command.some((t,i)=>keyFields.some(k=>t[k]!==readback[i][k])||JSON.stringify(t.airportOrder)!==JSON.stringify(readback[i].airportOrder)))throw Error('复诵与指挥命令不一致，需要重新复诵');
  return true;
}
function taskPhrase(t,unit,style,system,units){
  if(t.action==='attack_task'){const en=style==='nato',o=t.attackOrder;return (en?'ATTACK TARGET':'执行攻击任务')+(o.targetRef?' '+o.targetRef:o.targetId?' '+o.targetId:'');}
  if(t.action==='defense')return defensePhrase(t.defenseOrder,style==='nato');
  if(t.action==='sensor_task'){const en=style==='nato',goal=t.sensorTask;return (en?(goal.goal==='search'?'SEARCH THE FORWARD AIRSPACE':'MAINTAIN TARGET TRACK'):(goal.goal==='search'?'搜索前方空域':'持续跟踪目标'))+(goal.targetRef?(en?', TARGET ':'，目标')+goal.targetRef:goal.targetId?(en?', TARGET ':'，目标')+goal.targetId:'');}
  if(t.action==='weapon')return weaponPhrase(t.weaponOrder,style==='nato');
  const en=style==='nato',parts=[],labels=unitLabels(system),alt=m=>radioAltitude(m,system),speed=m=>radioSpeed(m,system),distance=m=>radioDistance(m,system);
  if(t.action==='radar'){const o=t.radarOrder;return o.operation==='lock'?(en?`ACQUIRE RADAR TARGET ${o.targetId}`:`雷达截获目标${o.targetId}`):o.operation==='unlock'?(en?'UNLOCK RADAR TARGET':'解除雷达锁定'):o.mode==='off'?(en?'RADAR OFF':'关闭雷达'):(en?`RADAR ${o.mode.toUpperCase()} SEARCH`:`雷达切换${o.mode==='pd'?'PD脉冲多普勒':'SRC脉冲'}搜索`);}
  if(t.action==='assign_role')return en?`${t.role==='lead'?'FLIGHT LEAD':'WINGMAN'}`:`担任${t.role==='lead'?'长机':'僚机'}，搭档${units.find(u=>u.id===t.targetId)?.callsign??t.targetId}`;
  if(FORMATION_ACTIONS.includes(t.action)){
    const leader=units.find(u=>u.id===t.targetId),name=leader?unitRadioName(leader,units.indexOf(leader),style):t.targetId;
    const duty=PROTECTION_MODES[t.action];
    return en?`${t.action==='cover'?'COVER':t.action==='escort'?'ESCORT':'JOIN'} ${name}. ${t.formation.toUpperCase()}. ${t.formation==='trail'?'':t.side.toUpperCase()+'. '}SPACING ${spokenNumber(distance(t.rangeM),style)} ${labels.distanceEnglish}${duty?`. STEP UP ${spokenNumber(alt(duty.heightM),style)} ${labels.altitudeEnglish}`:''}`:
      `${duty?.label??'跟随长机'}${name}，${doctrineLabel(FORMATIONS,t.formation)}${t.formation==='trail'?'':`，${t.side==='left'?'左侧':'右侧'}`}，间隔${spokenNumber(distance(t.rangeM),style)}${labels.distanceSpoken}${duty?`，默认高差${spokenNumber(alt(duty.heightM),style)}${labels.altitudeSpoken}`:''}`;
  }
  if(t.action==='airport'){const o=t.airportOrder,mode=airportModeLabel(o.mode,o.intent,en?'en':'zh'),height=Number.isFinite(o.altitudeM)?(en?`, CLIMB TO ${spokenNumber(alt(o.altitudeM),style)} ${labels.altitudeEnglish}`:`，爬升至${spokenNumber(alt(o.altitudeM),style)}${labels.altitudeSpoken}`):'';return (en?`${airportCommandLabel(o.intent,'en')}, ${o.airportId?o.airportId+' AIRFIELD':'LOCAL AIRFIELD'}, RUNWAY ${o.runway??'AS ASSIGNED'}${o.taxiways.length?', VIA '+o.taxiways.join(', '):''}${o.gate?', TO STAND '+o.gate:''}${mode?', '+mode:''}`:`${airportCommandLabel(o.intent)}，${o.airportId?o.airportId+'机场':'本场'}，跑道${o.runway??'由地面调度选择'}${o.taxiways.length?'，经'+o.taxiways.join('、'):''}${o.gate?'，至机位'+o.gate:''}${mode?'，'+mode:''}`)+height;}
  if(t.action==='fly_heading')parts.push(en?`FLY HEADING ${radioDigits(String(Math.round(t.headingDeg)%360).padStart(3,'0'),'nato')}`:`航向${radioDigits(String(Math.round(t.headingDeg)%360).padStart(3,'0'))}`);
  if(t.action==='fly_to')parts.push(en?`${t.append?'APPEND WAYPOINT':'PROCEED TO COORDINATES'}, EAST ${spokenNumber(distance(t.eastM),style)} ${labels.distanceEnglish}, NORTH ${spokenNumber(distance(t.northM),style)} ${labels.distanceEnglish}`:`${t.append?'追加航点':'飞往坐标'}，东向${spokenNumber(distance(t.eastM),style)}${labels.distanceSpoken}，北向${spokenNumber(distance(t.northM),style)}${labels.distanceSpoken}`);
  if(t.action==='orbit'||t.action==='clear_waypoints')parts.push(en?'ORBIT AND HOLD POSITION':'盘旋待命');
  if(t.action==='report_status')parts.push(groundStatusReport(unit)?(en?'REPORT POSITION AND GROUND STATUS':'报告位置与地面准备情况'):(en?'REPORT HEADING, ALTITUDE AND SPEED':'报告航向、高度和速度'));
  if(Number.isFinite(t.altitudeM)){
    const verb=t.altitudeM>unit.position[2]+50?(en?'CLIMB TO':'爬升至'):t.altitudeM<unit.position[2]-50?(en?'DESCEND TO':'下降至'):(en?'MAINTAIN':'保持高度');
    parts.push(en?`${verb} ${spokenNumber(alt(t.altitudeM),style)} ${labels.altitudeEnglish}`:`${verb}${spokenNumber(alt(t.altitudeM),style)}${labels.altitudeSpoken}`);
  }
  if(Number.isFinite(t.speedMps))parts.push(en?`TRUE AIRSPEED ${spokenNumber(speed(t.speedMps),style)} ${labels.speedEnglish}`:`真空速${spokenNumber(speed(t.speedMps),style)}${labels.speedSpoken}`);
  if(Number.isFinite(t.distanceM))parts.push(en?`PROCEED ${spokenNumber(distance(t.distanceM),style)} ${labels.distanceEnglish}, THEN ORBIT`:`前出${spokenNumber(distance(t.distanceM),style)}${labels.distanceSpoken}，到达后盘旋`);
  return parts.join(en?'. ':'，');
}
export function createCommandExchange(plan,units,style='pla',system=getUnitSystem(),nameStyle=style){
  const en=style==='nato',pilots=[];
  for(const unit of units){
    const tasks=plan.tasks.filter(t=>t.unitId===unit.id);if(!tasks.length)continue;
    const name=unitRadioName(unit,units.indexOf(unit),nameStyle),phrase=tasks.map(t=>taskPhrase(t,unit,style,system,units)).join(en?'. ':'；');
    pilots.push({unitId:unit.id,callsign:unit.callsign,name,tasks:tasks.map(t=>({...t})),
      commanderText:en?`${name}, CONTROL. ${phrase}.`:`${name}，指挥台。${phrase}。`,
      readbackText:en?`${phrase}. ${name}.`:`${phrase}，${name}。`});
  }
  const globals=plan.tasks.filter(t=>t.unitId===null).map(t=>t.action==='pause'?(en?'PAUSE SIMULATION':'暂停模拟'):(en?'RESUME SIMULATION':'继续模拟'));
  return {commander:{speaker:'commander',label:'指挥台 · 玩家',unitId:null,language:en?'en-US':'zh-CN',
    text:pilots.map(p=>p.commanderText).concat(globals).join(en?' ':'\n')},pilots};
}
export function formatIntentCommand(interpretation,units,style='pla',system=getUnitSystem(),nameStyle=style){
  const texts=(interpretation?.orders||[]).map(o=>{
    const p=o.parameters,names=o.unitIds.map(id=>{const i=units.findIndex(u=>u.id===id);return unitRadioName(units[i],i,nameStyle);});
    const bits=[commandById(o.intent)?.label.split(' / ')[0]||'任务指令'];
    if(p.runway)bits.push('跑道'+p.runway);if(p.airportRef)bits.push('机场'+p.airportRef);if(p.holdPoint)bits.push('等待点或机位'+p.holdPoint);if(p.targetRef)bits.push('目标'+p.targetRef);if(p.targetId&&!p.targetRef)bits.push('目标'+(units.find(u=>u.id===p.targetId)?.callsign||p.targetId));
    if(Number.isFinite(p.headingDeg))bits.push('航向'+radioDigits(String(Math.round(p.headingDeg)%360).padStart(3,'0'),style));
    if(p.altitudeM!==null)bits.push('高度'+spokenNumber(radioAltitude(p.altitudeM,system),style)+unitLabels(system).altitudeSpoken);
    if(Number.isFinite(p.speedMps))bits.push('真空速'+spokenNumber(radioSpeed(p.speedMps,system),style)+unitLabels(system).speedSpoken);
    if(Number.isFinite(p.eastM)&&Number.isFinite(p.northM))bits.push('东向'+spokenNumber(radioDistance(p.eastM,system),style)+unitLabels(system).distanceSpoken+'，北向'+spokenNumber(radioDistance(p.northM,system),style)+unitLabels(system).distanceSpoken);
    if(Number.isFinite(p.distanceM))bits.push('前出'+spokenNumber(radioDistance(p.distanceM,system),style)+unitLabels(system).distanceSpoken);
    if(Number.isFinite(p.bearingDeg))bits.push('方位'+radioDigits(String(Math.round(p.bearingDeg)%360).padStart(3,'0'),style));
    if(Number.isFinite(p.rangeM))bits.push('距离/间隔'+spokenNumber(radioDistance(p.rangeM,system),style)+unitLabels(system).distanceSpoken);
    if(p.formation)bits.push(doctrineLabel(FORMATIONS,p.formation));if(p.role)bits.push(p.role==='lead'?'长机':p.role==='wingman'?'僚机':p.role);
    if(p.weapon)bits.push(p.weapon);if(p.side)bits.push(p.side==='left'?'左侧':p.side==='right'?'右侧':p.side);if(p.mode)bits.push(airportModeLabel(p.mode,o.intent)??planningModeLabel(p.mode)??p.mode);if(p.quantity!==null)bits.push('数量'+p.quantity);
    if(Number.isFinite(p.durationSec))bits.push('持续'+spokenNumber(p.durationSec,style)+'秒');if(p.constraints)bits.push('要求：'+p.constraints);
    if(p.append)bits.push('追加到现有航路末尾');
    const when=o.timing==='on_condition'?`当${o.condition}时，`:o.timing==='after_previous'?'完成前项任务后，':'';
    return `${names.join('、')||'指挥台'}，${o.speechAct==='report'?'通报':o.speechAct==='request'?'请求':'指挥台'}。${when}${bits.join('，')}。`;
  });
  return texts.join('\n');
}
export function pilotUnable(unit,index,reason,style='pla',{clarification=false}={}){
  const name=unitRadioName(unit,index,style);
  const detail=String(reason??'').trim().replace(/[。.!！]+$/,'');
  return style==='nato'?`CONTROL, UNABLE. ${detail.replace(/^无法执行/,'')}. ${clarification?'SAY AGAIN':'REQUEST FURTHER INSTRUCTIONS'}. MAINTAINING PREVIOUS TASK. ${name}.`:`指挥台，${detail.startsWith('无法执行')?'':'无法执行。'}${detail}。${clarification?'请重发指令':'请求新的指示'}，保持原任务，${name}。`;
}
import {weaponPhrase} from './weapons.js';
import {defensePhrase} from './rwr-defense.js';
