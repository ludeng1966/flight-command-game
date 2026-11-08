import {radioAltitude,radioSpeed,radioDistance} from './units.js';
// 公开通联读法 + 场景自行分配的呼号。
import {FORMATION_ACTIONS,PROTECTION_MODES} from './formation.js';
import {FORMATIONS,doctrineLabel} from './formation-doctrine.js';
import {getUnitSystem,unitLabels,altitudeValue,speedValue,distanceValue,rounded} from './units.js';
import {selectedAircraftStatus} from './unit-status.js';
import {groundStatusReport} from './ground-radio.js';
import {atcOrderPhrase} from './atc-command.js';
export const RADIO_STYLES=['pla','nato'];
const ZH_DIGITS='洞幺两三四五六拐八勾';
const EN_DIGITS=['ZERO','ONE','TWO','THREE','FOUR','FIVE','SIX','SEVEN','EIGHT','NINER'];
const ZH_MAP={'洞':'0','零':'0','〇':'0','幺':'1','一':'1','两':'2','二':'2','三':'3','四':'4','五':'5','六':'6','拐':'7','七':'7','八':'8','捌':'8','勾':'9','钩':'9','九':'9'};
const EN_MAP={zero:'0',oh:'0',one:'1',two:'2',three:'3',tree:'3',four:'4',five:'5',fife:'5',six:'6',seven:'7',eight:'8',nine:'9',niner:'9'};
export const radioDigits=(number,style='pla')=>String(number).split('').map(c=>/\d/.test(c)?style==='nato'?EN_DIGITS[Number(c)]:ZH_DIGITS[Number(c)]:c).join(style==='nato'?' ':'');
export function normalizeRadioInstruction(input){
  // 仅处理航向字段里的逐位数字；保留“向右拐”“两百七十”等正常语义。
  let text=input.normalize('NFKC').replace(/(航向|方位|转至|转到)\s*([洞零〇幺一两二三四五六拐七八捌勾钩九\d\s]{3,})(?![十百千万])/g,(all,label,spoken)=>{
    const chars=spoken.replace(/\s/g,'');if(chars.length!==3)return all;
    return label+chars.split('').map(c=>ZH_MAP[c]??c).join('');
  });
  text=text.replace(/\b(heading|course|bearing)\s+((?:(?:zero|oh|one|two|three|tree|four|five|fife|six|seven|eight|nine|niner)[ -]+){2}(?:zero|oh|one|two|three|tree|four|five|fife|six|seven|eight|nine|niner))\b/gi,
    (_,label,spoken)=>`${label} ${spoken.toLowerCase().split(/[ -]+/).map(w=>EN_MAP[w]).join('')}`);
  return text;
}
export function callsignAliases(unit,index){
  const radioNumber=unit.radioNumber||String(101+index),stem=unit.callsign?.match(/^[A-Z]+/i)?.[0]||'';
  const variants={ALPHA:['Alpha','Alfa','阿尔法'],BRAVO:['Bravo','布拉沃'],CHARLIE:['Charlie','查理']};
  return [...new Set([unit.callsign,...(unit.aliases||[]),...(variants[stem.toUpperCase()]||[]),
    radioNumber,radioDigits(radioNumber),`${index+1}号机`].filter(Boolean))];
}
export function radioReadback(plan,units,style='pla',system=getUnitSystem()){
  const labels=unitLabels(system),alt=m=>radioAltitude(m,system),speed=m=>radioSpeed(m,system),distance=m=>rounded(distanceValue(m,system),2);
  if(plan.status!=='accepted')return plan.summary;
  return plan.tasks.map(t=>{
    if(t.action==='pause')return '指挥台，收到。模拟暂停。';
    if(t.action==='resume')return '指挥台，收到。继续模拟。';
    const index=units.findIndex(u=>u.id===t.unitId),u=units[index],number=u.radioNumber||String(101+index);
    const call=style==='pla'?radioDigits(number):u.callsign;
    const ack=style==='nato'?'ROGER':'收到';
    if(t.action==='atc')return `${call}，${ack}。${atcOrderPhrase(t.atcOrder,units,style==='nato')}。`;
    if(t.action==='attack_task')return `${call}，${ack}。攻击任务已接收，由我完成搜索、锁定、选弹和发射判断。`;
    if(t.action==='defense')return `${call}，${ack}。${defensePhrase(t.defenseOrder,style==='nato')}，${t.defenseOrder.mode==='execute'?'开始执行，不保证已脱离威胁':'策略已设置'}。`;
    if(t.action==='sensor_task')return `${call}，${ack}。${t.sensorTask.goal==='search'?'前方空域搜索':'目标持续跟踪'}任务已接收，由我自主操作雷达。`;
    if(t.action==='weapon')return `${call}，${ack}。${weaponPhrase(t.weaponOrder,style==='nato')}，${t.weaponOrder.operation==='launch'?'已发射，尚未确认命中':'设置已应用'}。`;
    if(t.action==='radar')return `${call}，${ack}。${t.radarOrder.operation==='lock'?'开始截获目标，等待稳定锁定':t.radarOrder.operation==='unlock'?'解除锁定，恢复雷达搜索':t.radarOrder.mode==='off'?'雷达关闭，保持电磁静默':`雷达切换${t.radarOrder.mode==='pd'?'PD 脉冲多普勒':'SRC 脉冲'}搜索`}。`;
    if(t.action==='airport')return `${call}，${ack}。机场任务已接收，${u.surface?.message??'等待程序调度'}。`;
    const details=[];
    if(t.action==='assign_role')return `${call}，${ack}。担任${t.role==='lead'?'长机':'僚机'}，搭档${units.find(v=>v.id===t.targetId)?.callsign??t.targetId}。`;
    if(FORMATION_ACTIONS.includes(t.action))details.push(`${PROTECTION_MODES[t.action]?.label??(t.action==='follow_unit'?'跟随':'加入')}${units.find(v=>v.id===t.targetId)?.callsign??t.targetId}，${doctrineLabel(FORMATIONS,t.formation)}，${t.side==='left'?'左侧':'右侧'}，间隔${distance(t.rangeM)}${labels.distanceSpoken}，正在集合`);
    if(t.action==='report_status'){
      if(u.alive===false)return `${call}，报告。已坠毁，位置高度${alt(u.position[2])}${labels.altitudeSpoken}，当前速度为零。`;
      const ground=groundStatusReport(u);if(ground)return `${call}，${ground}。`;
      const heading=String(Math.round((Math.atan2(u.velocity[0],u.velocity[1])*180/Math.PI+360)%360)%360).padStart(3,'0');
      return `${call}，报告。航向${heading}，高度${alt(u.position[2])}${labels.altitudeSpoken}，真空速${speed(u.speed)}${system==='imperial'?labels.speedSpoken:'公里/小时'}，${selectedAircraftStatus(u).phase}。`;
    }
    if(t.action==='fly_heading'){
      const heading=String(Math.round(t.headingDeg)%360).padStart(3,'0');
      details.push(style==='nato'?`HEADING ${radioDigits(heading,'nato')}（${heading}°）`:`航向${radioDigits(heading)}（${heading}°）`);
      details.push(t.distanceM==null?'已建立航路，沿航向持续延伸':`沿航路前出${distance(t.distanceM)}${labels.distanceSpoken}，到达后盘旋`);
    }
    if(t.action==='fly_to')details.push(t.append?'追加航点':'按指定航点飞行');
    if(t.action==='orbit'||t.action==='clear_waypoints')details.push('盘旋待命');
    if(Number.isFinite(t.altitudeM))details.push(`高度${alt(t.altitudeM)}${labels.altitudeSpoken}`);
    if(Number.isFinite(t.speedMps))details.push(`真空速${speed(t.speedMps)}${system==='imperial'?labels.speedSpoken:'公里/小时'}`);
    return `${call}，${ack}。${details.join('，')}。`;
  }).join('\n');
}
import {weaponPhrase} from './weapons.js';
import {defensePhrase} from './rwr-defense.js';
