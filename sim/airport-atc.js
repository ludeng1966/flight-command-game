import {atisInformation,runwayWeatherLimits} from './airport-weather.js';
import {runwayProcedure} from './airport-procedures.js';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const active=c=>['issued','delivered','active'].includes(c.status);
const types=new Set(['taxi','line_up','takeoff','approach','land','cross','hold','go_around','contact','vector']);
export const AIRPORT_STATIONS=Object.freeze({ground:{zh:'地面',en:'GROUND',frequencyMHz:121.7},tower:{zh:'塔台',en:'TOWER',frequencyMHz:118.1},departure:{zh:'离场',en:'DEPARTURE',frequencyMHz:124.2},approach:{zh:'进近',en:'APPROACH',frequencyMHz:119.4}});
export function initializeAtc(airport){
  airport.atc??={sequence:0,requestSequence:0,revision:0,requests:[],clearances:[],lastUse:{},decisions:[],radioRequired:false,communicationFailures:[],events:[]};
  airport.frequencies??=structuredClone(AIRPORT_STATIONS);return airport.atc;
}
export function wakeCategory(unit){return unit.profile.mass>=136000?'heavy':unit.profile.mass>=30000?'large':'small_jet';}
export function separationSeconds(previous,unit,operation){
  if(!previous)return 0;
  const category=wakeCategory(unit);
  if(previous.category==='heavy'&&category!=='heavy')return operation==='arrival'?120:120;
  if(previous.category==='large'&&category==='small_jet')return operation==='arrival'?90:75;
  if(operation==='arrival')return 45;
  return previous.operation==='arrival'?20:30;
}
export function arrivalEta(unit,runway){
  if(unit.surface?.grounded||!['approach','final'].includes(unit.surface?.phase))return Infinity;
  const start=runway.direction===1?runway.x0:runway.x1,d=(start-unit.position[0])*runway.direction;
  if(d< -500||d>35000||Math.abs(unit.position[1]-runway.y)>10000)return Infinity;
  if(unit.surface.phase==='final')return Math.max(0,d)/Math.max(40,(unit.groundVelocity??unit.velocity)[0]*runway.direction);
  const points=unit.waypoints??[],length=points.reduce((sum,p,i)=>sum+Math.hypot(p[0]-(i?points[i-1][0]:unit.position[0]),p[1]-(i?points[i-1][1]:unit.position[1])),0);
  return (length+Math.max(0,(start-(points.at(-1)?.[0]??unit.position[0]))*runway.direction))/Math.max(70,unit.speed);
}
export class AirportTrafficController{
  constructor(ops){Object.defineProperty(this,'ops',{value:ops,enumerable:false});initializeAtc(ops.airport);this.nextThink=0;}
  get state(){return initializeAtc(this.ops.airport);}
  resume(world){
    for(const c of this.state.clearances)if(['issued','delivered'].includes(c.status)){
      c.status='issued';c.deliveredAt=null;this.ops.airport.events.push({id:++this.ops.eventSequence,unitId:c.unitId,time:world.time,text:'恢复待确认许可',kind:'clearance',clearanceId:c.id,station:c.station});
    }
  }
  request(unit,kind,world,details={}){
    for(const old of this.state.requests)if(old.unitId===unit.id&&old.status!=='completed')old.status='superseded';
    const r={id:`request-${++this.state.requestSequence}`,unitId:unit.id,kind,requestedAt:world.time,runway:unit.surface.runway,
      status:'pending',priority:unit.fuel?.status==='emergency'?100:0,reason:null,expectedAt:world.time,...details};
    this.state.requests.push(r);this.state.requests=this.state.requests.slice(-64);unit.surface.atcRequestId=r.id;this.state.revision++;return r;
  }
  notice(unit,world,zh,en,station='tower'){
    const event={id:++this.ops.eventSequence,unitId:unit.id,time:world.time,text:zh,texts:{zh,en},speaker:'controller',station,kind:'atc_notice'};
    this.ops.airport.events.push(event);if(this.ops.airport.events.length>96)this.ops.airport.events.shift();unit.surface.message=zh;return event;
  }
  issue(unit,type,parameters,world,{reasonZh='',reasonEn='',station=type==='taxi'?'ground':type==='approach'?'approach':'tower'}={}){
    if(!types.has(type))throw Error('未知管制许可');
    const existing=this.current(unit,type);if(existing&&same(existing.parameters,parameters))return existing;
    if(existing)this.cancel(existing,world,'许可已修订','CLEARANCE AMENDED');
    const c={id:`clearance-${++this.state.sequence}`,unitId:unit.id,type,parameters:structuredClone(parameters),status:'issued',station,
      issuedAt:world.time,deliveredAt:null,acknowledgedAt:null,expiresAt:null,validForSec:type==='takeoff'?90:type==='line_up'?180:type==='land'?240:1200,
      reasonZh,reasonEn,readback:null};
    this.state.clearances.push(c);this.state.clearances=this.state.clearances.filter(v=>active(v)||world.time-v.issuedAt<900).slice(-128);
    unit.surface.clearances??={};unit.surface.clearances[type]=c.id;this.state.revision++;
    const label=({taxi:'滑行许可',line_up:'进入跑道许可',takeoff:'起飞许可',approach:'进近许可',land:'着陆许可',cross:'穿越跑道许可',hold:'保持等待',go_around:'复飞指令',contact:'移交频率',vector:'雷达引导'})[type];
    const event={id:++this.ops.eventSequence,unitId:unit.id,time:world.time,text:`${label} ${parameters.runway??''}`.trim(),kind:'clearance',clearanceId:c.id,station};
    this.ops.airport.events.push(event);if(this.ops.airport.events.length>96)this.ops.airport.events.shift();return c;
  }
  current(unit,type){const id=unit.surface?.clearances?.[type];return this.state.clearances.find(c=>c.id===id&&active(c));}
  permitted(unit,type){return this.current(unit,type)?.status==='active';}
  delivered(id,world){const c=this.state.clearances.find(c=>c.id===id);if(!c||c.status!=='issued')return false;c.status='delivered';c.deliveredAt=world.time;return true;}
  acknowledge(id,readback,world){
    const c=this.state.clearances.find(c=>c.id===id),unit=world.units.find(u=>u.id===c?.unitId);
    if(!c||!unit?.alive||!['issued','delivered'].includes(c.status))return false;
    if(!same(c.parameters,readback)){
      c.readbackErrors=(c.readbackErrors??0)+1;this.notice(unit,world,'复诵不符，请确认跑道及许可范围','NEGATIVE, READ BACK RUNWAY AND CLEARANCE LIMITS. SAY AGAIN.',c.station);return false;
    }
    if(['line_up','takeoff','land'].includes(c.type)){
      const runway=this.ops.runway(c.parameters.runway,true),weather=runwayWeatherLimits(this.ops.airport.weather,runway,unit.profile);
      if(!weather.valid||this.ops.airport.closed.includes(runway.designator)||this.ops.airport.closed.includes(runway.stripId)){
        this.cancel(c,world,weather.reason??'跑道关闭','RUNWAY UNAVAILABLE');return false;
      }
      if(['line_up','takeoff'].includes(c.type)&&this.arrivalBlocks(runway,world.units,unit.id,world.time)){
        this.cancel(c,world,'进近交通，保持跑道外或原位等待','ARRIVING TRAFFIC, HOLD SHORT OR HOLD POSITION');return false;
      }
    }
    c.status='active';c.readback=structuredClone(readback);c.acknowledgedAt=world.time;c.expiresAt=world.time+c.validForSec;this.state.revision++;
    if(c.type==='contact'){unit.surface.station=c.parameters.station;if(unit.controlAuthority){unit.controlAuthority.station=c.parameters.station;unit.controlAuthority.frequencyMHz=c.parameters.frequencyMHz;}c.status='completed';}
    if(c.type==='vector')unit.surface.towerHold={...c.parameters,until:world.time+45,vector:true};
    unit.qnhHpa=c.parameters.qnhHpa??unit.qnhHpa;unit.atisCode=c.parameters.atisCode??unit.atisCode;return true;
  }
  complete(unit,type,world){const c=this.current(unit,type);if(c){c.status='completed';c.completedAt=world.time;this.state.revision++;}}
  cancel(c,world,zh,en){if(!active(c))return;c.status='cancelled';c.cancelledAt=world.time;this.state.revision++;
    const u=world.units.find(u=>u.id===c.unitId);if(u)this.notice(u,world,`取消${({taxi:'原滑行许可',line_up:'进入跑道许可',takeoff:'起飞许可',land:'着陆许可',approach:'原进近许可'})[c.type]??'原许可'}，${zh}`,`CANCEL ${c.type.toUpperCase().replaceAll('_',' ')} CLEARANCE. ${en}.`,c.station);
  }
  cancelUnit(unit,world,zh='任务已更新',en='TASK REVISED'){for(const c of this.state.clearances)if(c.unitId===unit.id&&active(c))this.cancel(c,world,zh,en);}
  arrivalBlocks(r,units,owner,time=this.ops.airport.clock??0){
    const own=units.find(u=>u.id===owner),ownEta=own?arrivalEta(own,r):Infinity;
    if(own?.surface?.phase==='takeoff_roll')return false;
    const window=own?.surface?.phase==='lined_up'?50:75;
    return units.some(u=>u.id!==owner&&u.alive&&this.ops.airport.runways.find(v=>v.designator===u.surface?.runway)?.stripId===r.stripId&&
      arrivalEta(u,r)<Math.min(window,ownEta));
  }
  runwayAvailable(r,u,world,operation){
    if(this.ops.occupied(r,world.units,u.id))return false;
    const performance=this.ops.performance(u,r,operation);if(!performance.valid){u.surface.performanceReason=performance.reason;return false;}u.surface.performanceReason=null;
    const previous=this.state.lastUse[r.stripId];if(previous&&world.time-previous.at<separationSeconds(previous,u,operation))return false;
    return true;
  }
  recordRelease(id,stripId,time){
    const u=this.ops.world?.units.find(u=>u.id===id);if(!u){this.state.lastUse[stripId]={at:time,unitId:id,category:'small_jet',operation:'departure'};return;}
    this.state.lastUse[stripId]={at:time,unitId:id,category:wakeCategory(u),operation:u.surface?.grounded?'arrival':'departure'};this.state.revision++;
  }
  tick(world){
    this.ops.world=world;const a=this.ops.airport,s=this.state;
    if(world.time<this.nextThink)return;this.nextThink=world.time+.25;
    for(const u of world.units){const surface=u.surface,p=surface?.departureProcedure,r=a.runways.find(r=>r.designator===surface?.runway);
      if(!u.alive||surface?.phase!=='climb'||!p||!r)continue;
      if((u.position[0]-(r.direction===1?r.x1:r.x0))*r.direction>=p.transferDistanceM&&u.position[2]>=a.elevation+p.transferHeightM&&surface.station!=='departure')
        this.issue(u,'contact',{station:'departure',frequencyMHz:AIRPORT_STATIONS.departure.frequencyMHz},world,{station:'tower'});
    }
    for(const c of s.clearances.filter(active)){
      const u=world.units.find(u=>u.id===c.unitId);if(!u?.alive){c.status='cancelled';continue;}
      if(c.type==='vector'&&c.status==='active'&&world.time>=u.surface.towerHold?.until){u.surface.towerHold=null;this.complete(u,'vector',world);}
      if(c.expiresAt!==null&&world.time>c.expiresAt){this.cancel(c,world,'许可有效期结束，等待重新许可','CLEARANCE EXPIRED, STANDBY');continue;}
      if(!s.radioRequired&&!s.communicationFailures.includes(u.id)&&['issued','delivered'].includes(c.status)){
        if(world.time-c.issuedAt>=1)this.delivered(c.id,world);
        if(world.time-c.issuedAt>=2)this.acknowledge(c.id,c.parameters,world);
      }
    }
    for(const q of [...s.requests])if(q.status==='missed'){
      const u=world.units.find(u=>u.id===q.unitId);if(!u?.alive||u.surface?.phase!=='missed'){q.status='cancelled';continue;}
      if(!u.waypoints.length&&world.time-q.requestedAt>30){
        const current=this.ops.airport.runways.find(r=>r.designator===u.surface.runway);
        if(current&&(a.closed.includes(current.stripId)||a.closed.includes(current.designator)||!runwayWeatherLimits(a.weather,current,u.profile).valid)){this.ops.resolveRunwayUnavailable(u,world,'原跑道不可用');continue;}
        try{this.ops.apply(u,{intent:'land',runway:u.surface.runway,airportId:a.id,mode:u.surface.approachType??'ils',taxiways:[],gate:u.surface.arrivalGate??null,altitudeM:null},world);}
        catch(error){q.reason=error.message;if(world.time-(q.retryAt??0)>30){q.retryAt=world.time;this.notice(u,world,'保持复飞等待，正在重新安排进近','MAINTAIN MISSED APPROACH HOLD, EXPECT RESEQUENCING.','approach');}}
      }
    }
    const requests=s.requests.filter(q=>['pending','waiting','cleared'].includes(q.status)).map(q=>{
      const u=world.units.find(u=>u.id===q.unitId),r=a.runways.find(r=>r.designator===u?.surface?.runway);
      q.priority=u?.fuel?.status==='emergency'||u?.surface?.emergency?100:q.priority;
      q.etaSec=q.kind==='arrival'&&u&&r?arrivalEta(u,r):null;return {q,u,r};
    }).filter(v=>v.u?.alive&&v.r).sort((x,y)=>y.q.priority-x.q.priority||
      (x.q.kind==='arrival'&&y.q.kind==='arrival'?x.q.etaSec-y.q.etaSec:0)||x.q.requestedAt-y.q.requestedAt||x.q.id.localeCompare(y.q.id));
    requests.forEach(({q,u,r},index)=>{
      q.sequence=index+1;q.expectedAt=world.time+(q.kind==='arrival'?q.etaSec:Math.max(0,index*35));
      const surface=u.surface,weather=runwayWeatherLimits(a.weather,r,u.profile),atis=atisInformation(a,world.time),base={runway:r.designator,qnhHpa:a.weather.qnhHpa,atisCode:atis.code};
      if(surface.sectionWaiting){q.status='waiting';q.reason='双机分开起降，二号保持间隔';return;}
      if(surface.atcHoldUntil>world.time){q.status='waiting';q.reason='塔台指示保持等待';return;}
      if(surface.towerHold?.vector&&world.time>=surface.towerHold.until)surface.towerHold=null;
      if(s.communicationFailures.includes(u.id)){q.status='waiting';q.reason='通信中断，保持最后有效许可';return;}
      if(a.closed.includes(r.stripId)||a.closed.includes(r.designator)||!weather.valid){q.status='waiting';q.reason=weather.reason??'跑道关闭';this.ops.resolveRunwayUnavailable?.(u,world,q.reason);return;}
      if(q.kind==='departure'){
        if(['climb','airborne'].includes(surface.phase)){q.status='completed';return;}
        if(surface.phase==='holding'&&(surface.lineUp||surface.depart)){
          if(surface.station!=='tower'){
            this.issue(u,'contact',{station:'tower',frequencyMHz:AIRPORT_STATIONS.tower.frequencyMHz},world,{station:'ground'});q.reason='联系塔台，复诵频率后等待进入跑道许可';return;
          }
          if(this.runwayAvailable(r,u,world,'departure')){
            this.ops.leases[r.stripId]=u.id;this.issue(u,'line_up',base,world);q.status='cleared';q.reason=null;
          }else{q.status='waiting';q.reason=u.surface.performanceReason??(this.arrivalBlocks(r,world.units,u.id,world.time)?'进近交通优先，保持跑道外等待':'跑道占用或间隔尚未满足');}
        }
        if(surface.phase==='lined_up'&&surface.depart){
          if(this.runwayAvailable(r,u,world,'departure')){this.issue(u,'takeoff',{...base,initialAltitudeM:surface.climbAltitude,departureProcedure:runwayProcedure(a,r).sid.id},world);q.status='cleared';}
          else{q.status='waiting';q.reason='等待进近交通或跑道间隔';}
        }
      }else if(q.kind==='arrival'){
        if(surface.grounded){q.status='completed';return;}
        if(surface.phase==='approach'&&!this.current(u,'approach'))this.issue(u,'approach',{...base,procedure:surface.procedure?.id??`${a.id}-${r.designator}`,approachType:surface.approachType??'ils',initialAltitudeM:surface.procedure?.points?.[0]?.[2]??a.elevation+1200},world,{station:'approach'});
        if(q.etaSec<120&&surface.station!=='tower'){this.issue(u,'contact',{station:'tower',frequencyMHz:AIRPORT_STATIONS.tower.frequencyMHz},world,{station:'approach'});q.reason='转交塔台获取着陆许可';return;}
        const earlier=requests.some(v=>v.q!==q&&v.q.kind==='arrival'&&v.r.stripId===r.stripId&&(v.q.priority>q.priority||v.q.priority===q.priority&&v.q.etaSec<q.etaSec));
        if(!earlier&&q.etaSec<180&&this.runwayAvailable(r,u,world,'arrival')){
          this.ops.leases[r.stripId]=u.id;this.issue(u,'land',base,world);q.status='cleared';q.reason=null;
        }else{q.status='waiting';q.reason=u.surface.performanceReason??(earlier?'按到达次序保持进近间隔':'继续进近，等待跑道可用');}
      }
      if(q.reason&&world.time-(q.lastReportAt??-Infinity)>=25){q.lastReportAt=world.time;this.notice(u,world,`${q.reason}，本场排序${q.sequence}`,`STANDBY, TRAFFIC SEQUENCE ${q.sequence}. ${q.kind==='arrival'?'CONTINUE APPROACH, EXPECT LANDING CLEARANCE':'HOLD POSITION, EXPECT DEPARTURE CLEARANCE'}.`);}
    });
  }
  snapshot(world){
    const a=this.ops.airport,s=this.state;
    return {airportId:a.id,revision:s.revision,time:world.time,atis:atisInformation(a,world.time),frequencies:a.frequencies,closed:[...a.closed],
      taxiways:[...new Set(a.edges.map(e=>e.name))],groundNetwork:{nodes:structuredClone(a.nodes),edges:structuredClone(a.edges)},
      runways:a.runways.map(r=>({designator:r.designator,stripId:r.stripId,headingDeg:r.headingDeg,lengthM:r.length,widthM:r.width,
        ownerId:this.ops.leases[r.stripId]??null,lastUse:s.lastUse[r.stripId]??null,procedure:runwayProcedure(a,r)})),
      traffic:world.units.filter(u=>u.alive&&u.surface?.runway).map(u=>({unitId:u.id,callsign:u.callsign,position:[...u.position],groundVelocity:u.groundVelocity??u.velocity,
        speedMps:u.speed,phase:u.surface.phase,runway:u.surface.runway,groundNode:u.surface.node??null,route:[...(u.surface.route??[])],
        etaSec:Number.isFinite(arrivalEta(u,a.runways.find(r=>r.designator===u.surface.runway)))?arrivalEta(u,a.runways.find(r=>r.designator===u.surface.runway)):null,
        emergency:u.surface.emergency===true,fuelStatus:u.fuel?.status??'normal',fuelKg:u.fuel?.massKg??null,massKg:u.profile.mass,storesMassKg:u.storesMassKg??0,performance:this.ops.performance(u,a.runways.find(r=>r.designator===u.surface.runway),u.surface.grounded?'departure':'arrival'),receiver:u.navReceiver??null,station:u.surface.station??(u.surface.grounded?'ground':'approach'),lastModelError:u.surface.lastATCError??null})),
      queue:s.requests.filter(q=>['pending','waiting','cleared'].includes(q.status)).map(q=>structuredClone(q)),clearances:s.clearances.filter(active).map(c=>structuredClone(c))};
  }
}
