import {airportRadioProcedure} from '../sim/airport-radio-procedure.js';
import {clearanceMessage} from '../sim/atc-radio.js';
// Airport events are history, not a queue of commands that remain valid forever.
export function airportEventIsCurrent(world,event,unit,{checkAge=true}={}){
  if(!unit||!event||typeof event.text!=='string')return false;
  if(world.airportOps?.traffic.state.communicationFailures.includes(unit.id))return false;
  if(event.clearanceId){const c=world.airportOps?.airport.atc?.clearances.find(c=>c.id===event.clearanceId);return unit.alive!==false&&!!c&&['issued','delivered'].includes(c.status);}
  if(event.kind==='atc_notice')return unit.alive!==false&&world.time-event.time<120;
  if(unit.alive===false&&!event.text.startsWith('着陆碰撞：'))return false;
  if(checkAge&&(!Number.isFinite(event.time)||event.time>world.time+.05||world.time-event.time>30))return false;
  const s=unit.surface,text=event.text,grounded=s?.grounded===true;
  const stand=text.match(/^([A-Z]\d+)机位就绪，等待指令$/)?.[1]??text.match(/^已到达([A-Z]\d+)，刹车停车$/)?.[1];
  if(stand)return grounded&&s.phase==='parked'&&s.node===stand;
  const phaseRules=[
    [/^滑行许可：|^放宽模式：/,true,['taxi']],
    [/^进入跑道许可 /,true,['lineup_taxi','lined_up']],
    [/^起飞许可 /,true,['lined_up','takeoff_roll']],
    [/^着陆许可 /,false,['approach','final']],
    [/^已到\d{2}[LRC]?等待点|^保持跑道外等待$/,true,['holding']],
    [/^\d{2}[LRC]?已对正/,true,['lined_up']],
    [/中断起飞/,true,['rejected']],
    [/^接地，/,true,['rollout','exit']],
    [/^正在脱离跑道|^已越过跑道等待线/,true,['exit','taxi','waiting_gate','parked']],
    [/^抬轮离地，/,false,['climb']],
    [/^\d{2}[LRC]?进近，|^着陆许可请求已记录/,false,['approach']],
    [/^复飞：/,false,['missed','climb']]
  ];
  const rule=phaseRules.find(([pattern])=>pattern.test(text));
  if(rule&&(grounded!==rule[1]||!rule[2].includes(s?.phase)))return false;
  const runway=text.match(/^(?:进入跑道许可 |起飞许可 |着陆许可 |已到)?(\d{2}[LRC]?)/)?.[1];
  if(runway&&s?.runway&&s.runway!==runway)return false;
  if(typeof event.grounded==='boolean'&&grounded!==event.grounded)return false;
  if(!rule&&event.phase&&s?.phase!==event.phase)return false;
  return true;
}
export class AirportRadio{
  constructor({getWorld,radio,isBusy}){this.getWorld=getWorld;this.radio=radio;this.isBusy=isBusy;this.world=null;this.cursor=0;this.active=false;this.pending=null;}
  pump(){
    const world=this.getWorld();if(this.world!==world){this.pending?.controller.abort();this.world=world;this.cursor=world.airportRadioStartId??0;if(world.airportOps?.airport.atc)world.airportOps.airport.atc.radioRequired=true;}
    if(this.pending){const p=this.pending;if(!airportEventIsCurrent(world,p.event,world.units.find(u=>u.id===p.event.unitId),{checkAge:false}))p.controller.abort();}
    if(this.active||this.isBusy())return;
    for(const event of world.airportOps?.airport.events??[]){
      if(event.id<=this.cursor)continue;this.cursor=event.id;
      const unit=world.units.find(u=>u.id===event.unitId);if(!airportEventIsCurrent(world,event,unit))continue;
      const message=airportRadioProcedure(event,unit,world.airportOps.airport),controller=new AbortController(),job={event,controller};this.pending=job;this.active=true;
      void (async()=>{
        await this.radio.transmit({...message,unitId:event.unitId,text:message.texts.zh,simTime:event.time,airportEventId:event.id},{signal:controller.signal});
        if(event.clearanceId&&!controller.signal.aborted){
          const atc=world.airportOps.traffic,c=atc.state.clearances.find(c=>c.id===event.clearanceId);if(!c||!atc.delivered(c.id,world))return;
          const readback=structuredClone(c.parameters);await this.radio.transmit({...clearanceMessage(c,unit,world.airportOps.airport,{readback:true}),simTime:world.time},{signal:controller.signal});
          if(!controller.signal.aborted)atc.acknowledge(c.id,readback,world);
        }
      })().catch(()=>{}).finally(()=>{if(this.pending===job){this.pending=null;this.active=false;}});
      break;
    }
  }
}
