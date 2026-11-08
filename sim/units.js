// Physics and persisted coordinates stay in SI. Only input/output use this shared policy.
export const UNIT_SYSTEMS=Object.freeze(['metric','imperial']);
let selectedUnits='metric';
export const normalizeUnits=value=>value==='imperial'?'imperial':'metric';
export const getUnitSystem=()=>selectedUnits;
export function setUnitSystem(value){selectedUnits=normalizeUnits(value);return selectedUnits;}
export function unitLabels(system=selectedUnits){return normalizeUnits(system)==='imperial'?
  {speed:'kt',altitude:'ft',distance:'NM',speedSpoken:'节',altitudeSpoken:'英尺',distanceSpoken:'海里',speedEnglish:'KNOTS',altitudeEnglish:'FEET',distanceEnglish:'NAUTICAL MILES'}:
  {speed:'km/h',altitude:'m',distance:'km',speedSpoken:'公里每小时',altitudeSpoken:'米',distanceSpoken:'公里',speedEnglish:'KILOMETERS PER HOUR',altitudeEnglish:'METERS',distanceEnglish:'KILOMETERS'};}
export const speedValue=(mps,system=selectedUnits)=>mps*(normalizeUnits(system)==='imperial'?3600/1852:3.6);
export const speedMps=(value,system=selectedUnits)=>value/(normalizeUnits(system)==='imperial'?3600/1852:3.6);
export const altitudeValue=(meters,system=selectedUnits)=>normalizeUnits(system)==='imperial'?meters/.3048:meters;
export const altitudeMeters=(value,system=selectedUnits)=>normalizeUnits(system)==='imperial'?value*.3048:value;
export const distanceValue=(meters,system=selectedUnits)=>meters/(normalizeUnits(system)==='imperial'?1852:1000);
export const distanceMeters=(value,system=selectedUnits)=>value*(normalizeUnits(system)==='imperial'?1852:1000);
export const rounded=(value,digits=0)=>Number(value.toFixed(digits));
// Radio precision is separate from SI physics and from editable numeric controls.
export const radioAltitude=(meters,system=selectedUnits)=>Math.round(altitudeValue(meters,system)/10)*10;
export const radioSpeed=(mps,system=selectedUnits)=>Math.round(speedValue(mps,system));
export const radioDistance=(meters,system=selectedUnits)=>rounded(distanceValue(meters,system),2);
function text(value,label,{digits=0,group=false}={}){const number=rounded(value,digits);return (group?number.toLocaleString('en-US',{maximumFractionDigits:digits}):String(number))+' '+label;}
export function formatSpeed(mps,{system=selectedUnits,...options}={}){return text(speedValue(mps,system),unitLabels(system).speed,options);}
export function formatAltitude(meters,{system=selectedUnits,...options}={}){return text(altitudeValue(meters,system),unitLabels(system).altitude,options);}
export function formatDistance(meters,{system=selectedUnits,digits=1,...options}={}){return text(distanceValue(meters,system),unitLabels(system).distance,{digits,...options});}
export const formatMach=(mach,digits=2)=>'M '+Number(mach).toFixed(digits);
export function unitPolicy(system=selectedUnits){const labels=unitLabels(system);return {system:normalizeUnits(system),speed:labels.speed,altitude:labels.altitude,distance:labels.distance,mach:'M（无量纲，公英制通用）'};}
export function modelUnitInstruction(system='metric'){
  const labels=unitLabels(system);
  const conversion=normalizeUnits(system)==='imperial'?'当前裸高度乘0.3048写入altitudeM，裸速度乘1852/3600写入speedMps，裸距离乘1852写入distanceM/rangeM。例如裸高度20000→6096米，裸速度300→154.333333米/秒，裸距离10→18520米。':'当前裸高度原值写入altitudeM，裸速度除3.6写入speedMps，裸距离乘1000写入distanceM/rangeM。';
  return `当前context.unitSystem=${normalizeUnits(system)}。游戏统一显示单位：速度${labels.speedSpoken}，高度${labels.altitudeSpoken}，距离${labels.distanceSpoken}。玩家省略单位时必须使用这套单位，明确说出的单位优先。${conversion}马赫数M是无量纲比值，不随公英制换算。API字段仍使用altitudeM米、speedMps米/秒、distanceM米，输入输出必须准确换算。`;
}
