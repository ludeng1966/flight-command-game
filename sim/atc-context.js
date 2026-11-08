import {airportWeather} from './airport-weather.js';
export function parseAirportTraffic(value,time,unitIds){
  if(value==null)return null;
  const finite=Number.isFinite,vec=p=>Array.isArray(p)&&p.length===3&&p.every(finite),ids=new Set(unitIds);
  if(typeof value!=='object'||JSON.stringify(value).length>55000||typeof value.airportId!=='string'||value.airportId.length>80||!Number.isSafeInteger(value.revision)||value.revision<0||
    !finite(value.time)||Math.abs(value.time-time)>.1||!value.atis||typeof value.atis.code!=='string'||!/^[A-Z]$/.test(value.atis.code)||
    !Array.isArray(value.closed)||value.closed.length>64||value.closed.some(s=>typeof s!=='string'||s.length>80)||!Array.isArray(value.runways)||value.runways.length>8||
    !Array.isArray(value.traffic)||value.traffic.length>64||!Array.isArray(value.queue)||value.queue.length>64||!Array.isArray(value.clearances)||value.clearances.length>128)throw Error('机场全场态势快照无效');
  airportWeather(value.atis.weather);
  for(const r of value.runways)if(!r||!/^\d{2}[LRC]?$/.test(r.designator)||typeof r.stripId!=='string'||!finite(r.headingDeg)||!finite(r.lengthM)||r.lengthM<300||r.lengthM>10000||!finite(r.widthM)||r.widthM<10||!(r.ownerId===null||ids.has(r.ownerId)))throw Error('跑道运行快照无效');
  for(const t of value.traffic)if(!t||!ids.has(t.unitId)||typeof t.callsign!=='string'||!vec(t.position)||!vec(t.groundVelocity)||!finite(t.speedMps)||!finite(t.massKg)||!(t.etaSec===null||finite(t.etaSec)&&t.etaSec>=0)||typeof t.phase!=='string'||typeof t.runway!=='string'||typeof t.emergency!=='boolean')throw Error('机场交通快照无效');
  for(const q of value.queue)if(!q||!ids.has(q.unitId)||typeof q.id!=='string'||!['arrival','departure'].includes(q.kind)||!finite(q.requestedAt)||q.requestedAt>time+.1||!finite(q.priority)||q.priority<0||q.priority>100)throw Error('进离场队列无效');
  for(const c of value.clearances)if(!c||!ids.has(c.unitId)||typeof c.id!=='string'||!['issued','delivered','active'].includes(c.status)||!c.parameters||typeof c.parameters!=='object'||!finite(c.issuedAt)||c.issuedAt>time+.1)throw Error('管制许可快照无效');
  return structuredClone(value);
}
