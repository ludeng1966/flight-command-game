import {clamp} from './flight.js';
export const DEFAULT_WEATHER=Object.freeze({windFromDeg:90,windSpeedMps:3,gustMps:3,visibilityM:20000,ceilingM:3000,qnhHpa:1013.25,temperatureC:15,runwayCondition:'dry',windShear:false});
export function airportWeather(value={}){
  const w={...DEFAULT_WEATHER,...value};
  for(const [key,min,max]of [['windFromDeg',0,360],['windSpeedMps',0,50],['gustMps',0,65],['visibilityM',50,100000],['ceilingM',0,15000],['qnhHpa',870,1085],['temperatureC',-60,60]])if(!Number.isFinite(w[key])||w[key]<min||w[key]>max)throw Error('机场气象参数无效：'+key);
  if(!['dry','wet','icy'].includes(w.runwayCondition)||typeof w.windShear!=='boolean')throw Error('跑道状况或风切变参数无效');
  w.windFromDeg%=360;w.gustMps=Math.max(w.windSpeedMps,w.gustMps);return w;
}
export function windComponents(weather,headingDeg){
  const angle=(weather.windFromDeg-headingDeg)*Math.PI/180;
  return {headwindMps:weather.windSpeedMps*Math.cos(angle),crosswindMps:weather.gustMps*Math.sin(angle)};
}
export function sampleWind(weather,time=0){
  if(!weather)return [0,0,0];
  const angle=weather.windFromDeg*Math.PI/180,speed=weather.windSpeedMps+(weather.gustMps-weather.windSpeedMps)*(.5+.5*Math.sin(time*.21));
  return [-Math.sin(angle)*speed,-Math.cos(angle)*speed,weather.windShear?Math.sin(time*.9)*1.8:0];
}
export function runwayWeatherLimits(weather,runway,profile={}){
  const c=windComponents(weather,runway.headingDeg),crossLimit=profile.airportCrosswindLimitMps??12,tailLimit=profile.airportTailwindLimitMps??5;
  const reason=weather.windShear?'报告低空风切变':Math.abs(c.crosswindMps)>crossLimit?'侧风超过本机运行限制':c.headwindMps<-tailLimit?'顺风超过本机运行限制':null;
  return {...c,crosswindLimitMps:crossLimit,tailwindLimitMps:tailLimit,valid:!reason,reason};
}
export const brakingDeceleration=weather=>weather?.runwayCondition==='icy'?1.1:weather?.runwayCondition==='wet'?2.2:3.5;
export function atisInformation(airport,time=0){
  const w=airport.weather??airportWeather(),sequence=airport.weatherSequence??0,code=String.fromCharCode(65+sequence%26);
  return {code,sequence,issuedAt:airport.weatherUpdatedAt??0,weather:{...w},runwayInUse:airport.runways.filter(r=>!airport.closed.includes(r.stripId)&&!airport.closed.includes(r.designator)).sort((a,b)=>windComponents(w,b.headingDeg).headwindMps-windComponents(w,a.headingDeg).headwindMps)[0]?.designator??null,airportId:airport.id,time};
}
export function updateWeather(airport,patch,time){
  airport.weather=airportWeather({...airport.weather,...patch});airport.wind={heading:airport.weather.windFromDeg,speedMps:airport.weather.windSpeedMps};
  airport.weatherSequence=(airport.weatherSequence??0)+1;airport.weatherUpdatedAt=time;return atisInformation(airport,time);
}
export function applyAtmosphere(unit,weather,time){
  if(!weather)return;
  unit.wind=unit.surface?.grounded?[0,0,0]:sampleWind(weather,time);
  unit.profile.densityScale=weather.qnhHpa/1013.25*288.15/(273.15+weather.temperatureC);
  unit.qnhHpa??=weather.qnhHpa;
  unit.indicatedAltitudeM=unit.position[2]+(unit.qnhHpa-weather.qnhHpa)*8.3;
  unit.visibilityM=weather.visibilityM;unit.ceilingM=weather.ceilingM;
}
