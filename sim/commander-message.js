import {createCommandExchange,formatIntentCommand} from './radio-procedure.js';
import {normalizeRadioInstruction} from './radio.js';
import {altitudeMeters,speedMps} from './units.js';

export function createCommanderTransmission(reply,units,style='pla',system='metric'){
  // Cruise compilation has fallback parameters for direct program execution.
  // Do not turn those defaults into spoken orders that bind the model's choices.
  const cruise=reply.interpretation?.orders?.length&&reply.interpretation.orders.every(o=>['cruise','attack'].includes(o.intent));
  const render=language=>{const names=style==='nato'?'nato':language;return cruise?formatIntentCommand(reply.interpretation,units,language,system,names):reply.plan?.status==='accepted'?createCommandExchange(reply.plan,units,language,system,names).commander.text:
    reply.interpretation?.orders?.length?formatIntentCommand(reply.interpretation,units,language,system,names):reply.plan?.summary??'指令未明确，请重发指令';};
  const texts={zh:render('pla'),en:render('nato')};
  return {speaker:'commander',unitId:null,label:'指挥台 · 玩家',text:texts[style==='nato'?'en':'zh'],texts,language:style==='nato'?'en-US':'zh-CN'};
}
export function captureCommanderMessage(source,record,requestId,system='metric'){
  return {id:record?.id??requestId??'commander',speaker:source.speaker==='controller'?'controller':'commander',text:record?.speechText??record?.text??source.text,
    language:record?.speechLanguage??record?.language??source.language,unitSystem:system};
}
// The validated command can be received as data before its optional audio plays.
// Freeze the semantic message so localization or TTS cannot rewrite its orders.
export function captureAcceptedCommanderMessage(source,record,requestId,system='metric'){
  return Object.freeze({id:record?.id??requestId??'commander',speaker:source.speaker==='controller'?'controller':'commander',text:source.text,
    language:source.language,unitSystem:system,receipt:'accepted',delivery:'queued'});
}
// Legacy API callers may supply instruction as a transcript. A supplied message always wins.
export function receivedCommanderMessage(input){
  const message=input?.commanderMessage??{id:input?.requestId??'commander',speaker:'commander',text:input?.instruction,language:'zh-CN'};
  if(!message||!['commander','controller'].includes(message.speaker)||typeof message.id!=='string'||!/^[-\w]{1,100}$/.test(message.id)||typeof message.text!=='string'||!message.text.trim()||message.text.length>4000||!['zh-CN','en-US'].includes(message.language)||message.receipt!==undefined&&message.receipt!=='accepted')throw Error('需要已接收的指挥员或塔台完整命令消息，不能以玩家输入代替');
  return {id:message.id,speaker:message.speaker,text:message.text,language:message.language,...(message.unitSystem?{unitSystem:message.unitSystem}:{}),...(message.receipt?{receipt:message.receipt}:{})};
}
export const normalizedCommanderTranscript=message=>normalizeRadioInstruction(message.text);
const zhDigits={'零':0,'〇':0,'洞':0,'幺':1,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'拐':7,'八':8,'九':9,'勾':9,'钩':9};
const enNumbers={ZERO:0,ONE:1,TWO:2,THREE:3,FOUR:4,FIVE:5,SIX:6,SEVEN:7,EIGHT:8,NINE:9,NINER:9,TEN:10,ELEVEN:11,TWELVE:12,THIRTEEN:13,FOURTEEN:14,FIFTEEN:15,SIXTEEN:16,SEVENTEEN:17,EIGHTEEN:18,NINETEEN:19,TWENTY:20,THIRTY:30,FORTY:40,FIFTY:50,SIXTY:60,SEVENTY:70,EIGHTY:80,NINETY:90};
export function parseRadioNumber(value){
  value=value.trim();if(/^[+-]?\d+(?:\.\d+)?$/.test(value))return Number(value);
  const negative=/^(负|MINUS\s+)/i.test(value);value=value.replace(/^(负|MINUS\s+)/i,'');
  const [whole,fraction]=value.toUpperCase().split(/点|\s+DECIMAL\s+/);let total=0,section=0,digit=0;
  if(/[\u3400-\u9fff]/.test(whole)){
    if(!/[十百千万]/.test(whole))total=Number([...whole].map(c=>zhDigits[c]??'X').join(''));
    else{for(const c of whole){if(Object.hasOwn(zhDigits,c)){digit=zhDigits[c];continue;}const scale=({十:10,百:100,千:1000,万:10000})[c];if(!scale)return NaN;if(scale===10000){total+=(section+digit)*scale;section=0;}else section+=(digit||1)*scale;digit=0;}total+=section+digit;}
  }else{
    for(const word of whole.split(/[ -]+/)){if(word==='AND')continue;if(Object.hasOwn(enNumbers,word))section+=enNumbers[word];else if(word==='HUNDRED')section=(section||1)*100;else if(word==='THOUSAND'){total+=section*1000;section=0;}else return NaN;}total+=section;
  }
  if(fraction){const digits=/[\u3400-\u9fff]/.test(fraction)?[...fraction].map(c=>zhDigits[c]??'X').join(''):fraction.split(/[ -]+/).map(w=>enNumbers[w]??'X').join('');if(!/^\d+$/.test(digits))return NaN;total+=Number('0.'+digits);}
  return negative?-total:total;
}
const enNumberPattern=Object.keys(enNumbers).concat(['HUNDRED','THOUSAND','AND','MINUS','DECIMAL']).join('|');
const numberPattern=`(?:[负+\\-〇零洞幺一二两三四五六七拐八九勾钩十百千万点\\d.]+|(?:${enNumberPattern})(?:[ -]+(?:${enNumberPattern}))*)`;
export function decodedCommanderParameters(message){
  const text=normalizedCommanderTranscript(message),out={};
  const unique=values=>{const v=[...new Set(values.filter(Number.isFinite).map(n=>Number(n.toFixed(8))))];return v.length===1?v[0]:null;};
  const headings=[...text.matchAll(/(?:航向|\bHEADING|\bCOURSE)\s*(\d{1,3})(?!\d)/gi)].map(m=>Number(m[1])%360);
  const altitudes=[...text.matchAll(new RegExp(`(?:爬升至|下降至|保持高度|保持|高度|CLIMB TO|DESCEND TO|ALTITUDE|MAINTAIN)\\s*(${numberPattern})\\s*(英尺|米|FEET|METERS|FT\\b)`, 'gi'))].map(m=>altitudeMeters(parseRadioNumber(m[1]),/英尺|FEET|FT/i.test(m[2])?'imperial':'metric'));
  const speeds=[...text.matchAll(new RegExp(`(${numberPattern})\\s*(公里每小时|公里/小时|千米每小时|节|KILOMETERS PER HOUR|KNOTS|KT\\b)`, 'gi'))].map(m=>speedMps(parseRadioNumber(m[1]),/节|KNOTS|KT/i.test(m[2])?'imperial':'metric'));
  const coordinate=axis=>[...text.matchAll(new RegExp(`(?:${axis})\\s*(${numberPattern})\\s*(海里|公里|千米|米|NAUTICAL MILES|KILOMETERS|METERS|NM\\b|KM\\b)`, 'gi'))].map(m=>parseRadioNumber(m[1])*(/海里|NAUTICAL MILES|NM/i.test(m[2])?1852:/公里|千米|KILOMETERS|KM/i.test(m[2])?1000:1));
  for(const [key,values]of Object.entries({headingDeg:headings,altitudeM:altitudes,speedMps:speeds,eastM:coordinate('东向|\\bEAST'),northM:coordinate('北向|\\bNORTH')})){const value=unique(values);if(value!==null)out[key]=value;}
  return out;
}
export function bindCommanderNumbers(schema,message){
  const decoded=decodedCommanderParameters(message),items=schema.properties.orders.items;
  for(const branch of items.anyOf??[items])for(const [key,value]of Object.entries(decoded)){const property=branch.properties.parameters.properties[key];if(property)property.enum=[null,value];}
  return schema;
}
export function verifyCommanderNumbers(interpretation,message,tolerances={}){
  if(interpretation.status!=='understood')return;
  const orders=interpretation.orders.filter(o=>['fly_heading','set_flight','fly_to','cruise','orbit','clear_waypoints'].includes(o.intent));if(!orders.length)return;
  const decoded=decodedCommanderParameters(message);
  for(const [key,value]of Object.entries(decoded)){const fields=orders.map(o=>o.parameters[key]).filter(Number.isFinite);if(!fields.length||fields.some(n=>Math.abs(n-value)>(tolerances[key]??.00001)))throw Error(`指挥员实际通话中的${key}换算为${value}，必须保留已解码的数值，不能另作取整或换成其他目标。`);}
}
export function verifyCommanderHeading(interpretation,message){
  if(interpretation.status!=='understood')return;
  const values=[...normalizedCommanderTranscript(message).matchAll(/(?:航向|\bHEADING|\bCOURSE)\s*(\d{1,3})(?!\d)/gi)].map(m=>Number(m[1])%360),unique=[...new Set(values)];
  // Only bind an unambiguous single heading; multiple distinct orders remain separate.
  if(unique.length!==1)return;
  const orders=interpretation.orders.filter(o=>o.intent==='fly_heading');
  if(orders.some(o=>!Number.isFinite(o.parameters.headingDeg)||Math.abs(((o.parameters.headingDeg-unique[0]+540)%360)-180)>.01))throw Error(`指挥员实际播报的航向是${String(unique[0]).padStart(3,'0')}度，必须保留这一方向，不能遗漏或改成其他航向。`);
}

// Check the explicit airport clearance actually spoken, without interpreting the
// player's free-form request or constructing an executable order from keywords.
export function verifyCommanderAirportInstruction(interpretation,message){
  if(interpretation.status!=='understood')return;
  const phaseNames={滑行:'taxi',进入跑道对正等待:'line_up',起飞:'takeoff',进近:'approach',着陆:'land',所有阶段:'all',TAXI:'taxi','LINE UP AND WAIT':'line_up',TAKEOFF:'takeoff',APPROACH:'approach',LANDING:'land','ALL PHASES':'all'},administrative=new Map();
  for(const match of message.text.matchAll(/(签发|取消)(滑行|进入跑道对正等待|起飞|进近|着陆|所有阶段)许可|(ISSUE|CANCEL) (TAXI|LINE UP AND WAIT|TAKEOFF|APPROACH|LANDING|ALL PHASES) CLEARANCE/gi)){
    const intent=match[1]==='签发'||match[3]?.toUpperCase()==='ISSUE'?'atc_clearance':'atc_cancel_clearance';if(!administrative.has(intent))administrative.set(intent,new Set());administrative.get(intent).add(phaseNames[match[2]??match[4].toUpperCase()]);
  }
  if(administrative.size)for(const o of interpretation.orders){
    if(['takeoff','land','approach','taxi','line_up','hold_short'].includes(o.intent))throw Error('本次实际通话是签发或取消已有任务的阶段许可，须保留为atc_clearance/atc_cancel_clearance，不得重建机场任务');
    if(administrative.has(o.intent)&&!administrative.get(o.intent).has(o.parameters.mode))throw Error('飞行员改变了实际播报的许可阶段，请按原许可复诵');
  }
  const text=message.text.toUpperCase(),rules=[
    ['abort_takeoff',/中断起飞|ABORT TAKEOFF|REJECT(?:ED)? TAKEOFF/],
    ['go_around',/复飞|GO AROUND/],['line_up',/进入跑道|对正等待|LINE UP/],
    ['takeoff',/起飞|TAKEOFF|TAKE OFF/],['approach',/进近|APPROACH/],
    ['land',/着陆|降落|CLEARED TO LAND|\bLAND\b/],
    ['taxi',/滑行|\bTAXI\b/],['hold_short',/跑道外等待|HOLD SHORT/]
  ];
  const allowed=new Set(rules.filter(([,re])=>re.test(text)).map(([intent])=>intent));
  if(allowed.has('abort_takeoff'))allowed.delete('takeoff');
  if(allowed.has('taxi')||allowed.has('hold_short')){allowed.add('taxi');allowed.add('hold_short');}
  if(allowed.has('land'))allowed.add('return_to_base');
  if(!allowed.size)return;
  const airportIntents=new Set(rules.map(([intent])=>intent).concat('return_to_base'));
  for(const order of interpretation.orders)if(airportIntents.has(order.intent)&&!allowed.has(order.intent))throw Error(`塔台实际通话只包含${[...allowed].join('/')}，不能改成${order.intent}或擅自追加后续许可；请重新理解已播报的机场指令。`);
}
