// Airport events have their own phraseology in both languages. UI translation
// must not turn internal taxi graph nodes (H09L/R09L/APRON) into spoken callsigns.
import {clearanceMessage} from './atc-radio.js';
import {AIRPORT_STATIONS} from './airport-atc.js';
import {pilotStageMessage} from './pilot-stage-request.js';
export function airportRadioProcedure(event,unit,airport){
  if(event.kind==='pilot_request')return pilotStageMessage(event,unit,airport);
  if(event.clearanceId){const c=airport.atc?.clearances.find(c=>c.id===event.clearanceId);if(c)return clearanceMessage(c,unit,airport);}
  if(event.texts){const station=AIRPORT_STATIONS[event.station]??AIRPORT_STATIONS.tower;return {speaker:event.speaker??'controller',label:station.zh+' · '+airport.id,station:event.station,
    texts:{zh:`${unit.callsign}，${airport.id}${station.zh}。${event.texts.zh}。`,en:`${unit.callsign}, ${airport.id} ${station.en}. ${event.texts.en}.`}};}
  const text=event.text,name=unit?.callsign??event.unitId;
  const recipient=unit?.controlAuthority?.owner==='tower'?`${airport?.id??'BAY'}塔台`:'指挥台',recipientEn=unit?.controlAuthority?.owner==='tower'?`${airport?.id??'BAY'} TOWER`:'CONTROL';
  let zh=text,en=null,tower=false,m;
  if((m=text.match(/^(进入跑道许可|起飞许可|着陆许可)\s+(\d{2}[LRC]?)$/))){
    tower=true;
    const action={进入跑道许可:['进入跑道，等待','LINE UP AND WAIT'],起飞许可:['可以起飞','CLEARED FOR TAKEOFF'],着陆许可:['可以着陆','CLEARED TO LAND']}[m[1]];
    zh=`跑道${m[2]}，${action[0]}`;en=`RUNWAY ${m[2]}, ${action[1]}`;
  }else if(text.startsWith('滑行许可：')){
    tower=true;
    const path=text.slice(5).split('，')[0].split(/\s*→\s*/),ways=[];
    if(event.taxiOrigin&&path[0]!==event.taxiOrigin)path.unshift(event.taxiOrigin);
    for(let i=1;i<path.length;i++){
      const edge=airport?.edges?.find(e=>e.a===path[i-1]&&e.b===path[i]||e.b===path[i-1]&&e.a===path[i]);
      if(edge&&ways.at(-1)!==edge.name)ways.push(edge.name);
    }
    const runway=path.map(p=>p.match(/^[HR](\d{2}[LRC]?)$/)?.[1]).find(Boolean)??unit?.surface?.runway;
    zh=`${ways.length?'经'+ways.map(w=>'滑行道'+w).join('、')+'滑行，':''}${runway?'跑道'+runway+'外等待':'跑道外等待'}`;
    en=`${ways.length?'TAXI VIA '+ways.map(w=>'TAXIWAY '+w).join(', ')+'. ':''}HOLD SHORT${runway?' OF RUNWAY '+runway:''}`;
  }else if((m=text.match(/^([A-Z]\d+)机位就绪，等待指令$/))){zh=`机位${m[1]}，准备就绪，等待指令`;en=`STAND ${m[1]}, READY, STANDING BY`;}
  else if((m=text.match(/^已到(\d{2}[LRC]?)等待点，跑道外等待$/))){zh=`已到跑道${m[1]}等待点，跑道外等待`;en=`HOLDING SHORT OF RUNWAY ${m[1]}`;}
  else if((m=text.match(/^(\d{2}[LRC]?)已对正，等待起飞许可$/))){zh=`跑道${m[1]}已对正，等待起飞许可`;en=`LINED UP RUNWAY ${m[1]}, AWAITING TAKEOFF CLEARANCE`;}
  else if((m=text.match(/^已到达([A-Z]\d+)，刹车停车$/))){zh=`已到机位${m[1]}，刹车停车`;en=`AT STAND ${m[1]}, PARKING BRAKE SET`;}
  else if((m=text.match(/^请求(\d{2}[LRC]?)进近许可$/))){zh=`请求跑道${m[1]}进近许可`;en=`REQUEST APPROACH CLEARANCE RUNWAY ${m[1]}`;}
  else if((m=text.match(/^(\d{2}[LRC]?)进近，(请求着陆许可|到决断点等待着陆许可)$/))){zh=`跑道${m[1]}进近，${m[2]}`;en=`APPROACHING RUNWAY ${m[1]}, ${m[2]==='请求着陆许可'?'REQUEST LANDING CLEARANCE':'AWAITING LANDING CLEARANCE AT DECISION POINT'}`;}
  else if(text.startsWith('复飞：')){zh=text.replace('复飞：','复飞，');en='GOING AROUND, APPROACH DISCONTINUED';}
  else en={
    '着陆许可请求已记录，保持原进近':'LANDING CLEARANCE REQUESTED, CONTINUING APPROACH',
    '中断起飞，保持跑道刹车':'REJECTING TAKEOFF, BRAKING ON RUNWAY',
    '保持跑道外等待':'HOLDING SHORT OF RUNWAY',
    '放宽模式：原滑行道无法使用，已改走可达路线':'UNABLE ORIGINAL TAXI ROUTE, USING ALTERNATE TAXI ROUTE',
    '着陆碰撞：姿态/速度超限':'LANDING COLLISION, AIRCRAFT DISABLED',
    '接地，减速脱离跑道':'TOUCHDOWN, DECELERATING TO VACATE RUNWAY',
    '跑道侵入，中断起飞':'RUNWAY INCURSION, REJECTING TAKEOFF',
    '抬轮离地，爬升':'AIRBORNE, CLIMBING',
    '未达抬轮速度，中断起飞':'UNABLE ROTATION SPEED, REJECTING TAKEOFF',
    '正在脱离跑道，保持地面许可':'VACATING RUNWAY, MAINTAINING GROUND CLEARANCE',
    '已越过跑道等待线，跑道释放':'RUNWAY VACATED'
  }[text]??null;
  return {speaker:tower?'controller':'pilot',texts:{zh:tower?`${name}，塔台。${zh}。`:`${recipient}，${zh}，${name}。`,
    ...(en?{en:tower?`${name}, TOWER. ${en}.`:`${recipientEn}, ${en}. ${name}.`}:{})}};
}
