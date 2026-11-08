import {AIRPORT_STATIONS} from './airport-atc.js';
import {getUnitSystem,unitLabels,radioAltitude} from './units.js';
export function clearanceMessage(clearance,unit,airport,{readback=false,system=getUnitSystem()}={}){
  const c=clearance,p=c.parameters,station=AIRPORT_STATIONS[c.station]??AIRPORT_STATIONS.tower,labels=unitLabels(system),name=unit.callsign;
  const altitude=Number.isFinite(p.initialAltitudeM)?radioAltitude(p.initialAltitudeM,system):null;
  let zh,en;
  if(c.type==='taxi'){
    const ways=[];for(let i=1;i<(p.route?.length??0);i++){const e=airport.edges.find(e=>e.a===p.route[i-1]&&e.b===p.route[i]||e.b===p.route[i-1]&&e.a===p.route[i]);if(e&&ways.at(-1)!==e.name)ways.push(e.name);}
    const stand=p.limit?.startsWith('G'),limit=stand?`机位${p.limit}`:`跑道${p.runway}外等待`,limitEn=stand?`STAND ${p.limit}`:`HOLD SHORT OF RUNWAY ${p.runway}`;
    zh=`${ways.length?'经'+ways.map(w=>'滑行道'+w).join('、')+'滑行，':''}${stand?'至':''}${limit}`;
    en=`TAXI${stand?' TO '+limitEn:''}${ways.length?' VIA '+ways.map(w=>'TAXIWAY '+w).join(', '):''}${stand?'':'. '+limitEn}`;
  }else if(c.type==='line_up'){zh=`跑道${p.runway}，进入跑道，对正等待`;en=`RUNWAY ${p.runway}, LINE UP AND WAIT`;}
  else if(c.type==='takeoff'){zh=`跑道${p.runway}，可以起飞${altitude!==null?'，起始爬升高度'+altitude+labels.altitudeSpoken:''}${p.departureProcedure?'，按'+p.departureProcedure+'离场':''}`;en=`RUNWAY ${p.runway}, CLEARED FOR TAKEOFF${altitude!==null?', INITIAL ALTITUDE '+altitude+' '+labels.altitudeEnglish:''}${p.departureProcedure?', DEPARTURE '+p.departureProcedure:''}`;}
  else if(c.type==='approach'){zh=`许可${p.approachType?.toUpperCase()??'ILS'}进近，跑道${p.runway}${altitude!==null?'，起始高度'+altitude+labels.altitudeSpoken:''}，等待单独着陆许可`;en=`CLEARED ${p.approachType?.toUpperCase()??'ILS'} APPROACH RUNWAY ${p.runway}${altitude!==null?', INITIAL ALTITUDE '+altitude+' '+labels.altitudeEnglish:''}. EXPECT SEPARATE LANDING CLEARANCE`;}
  else if(c.type==='land'){zh=`跑道${p.runway}，可以着陆`;en=`RUNWAY ${p.runway}, CLEARED TO LAND`;}
  else if(c.type==='contact'){const next=AIRPORT_STATIONS[p.station];zh=`联系${airport.id}${next?.zh??p.station}，频率${p.frequencyMHz}`;en=`CONTACT ${airport.id} ${next?.en??p.station} ON ${p.frequencyMHz}`;}
  else if(c.type==='vector'){const h=radioAltitude(p.altitudeM,system);zh=`飞航向${String(Math.round(p.headingDeg)).padStart(3,'0')}，保持高度${h}${labels.altitudeSpoken}，速度${Math.round(p.speedMps*1.94384)}节`;en=`FLY HEADING ${String(Math.round(p.headingDeg)).padStart(3,'0')}, MAINTAIN ${h} ${labels.altitudeEnglish}, SPEED ${Math.round(p.speedMps*1.94384)} KNOTS`;}
  else if(c.type==='cross'){zh=`许可穿越跑道${p.runway}，经滑行道${p.taxiway}`;en=`CROSS RUNWAY ${p.runway} VIA TAXIWAY ${p.taxiway}`;}
  else if(c.type==='go_around'){zh='复飞，按公布复飞程序爬升';en='GO AROUND, FLY PUBLISHED MISSED APPROACH';}
  else{zh='保持原位，等待进一步许可';en='HOLD POSITION, AWAIT FURTHER CLEARANCE';}
  if(!readback&&p.qnhHpa){zh+=`，修正海压${p.qnhHpa}${p.atisCode?'，本场通播'+p.atisCode:''}`;en+=`, QNH ${p.qnhHpa}${p.atisCode?', INFORMATION '+p.atisCode:''}`;}
  const texts=readback?{zh:`${airport.id}${station.zh}，${zh}，${name}。`,en:`${airport.id} ${station.en}, ${en}. ${name}.`}:
    {zh:`${name}，${airport.id}${station.zh}。${c.reasonZh?c.reasonZh+'。':''}${zh}。`,en:`${name}, ${airport.id} ${station.en}. ${c.reasonEn?c.reasonEn+'. ':''}${en}.`};
  return {speaker:readback?'pilot':'controller',unitId:unit.id,label:readback?`飞行员 · ${name}`:`${station.zh} · ${airport.id}`,text:texts.zh,texts,station:c.station,clearanceId:c.id,readback};
}
