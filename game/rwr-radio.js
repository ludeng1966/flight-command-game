import {bearingClock,RWR_LABELS,RWR_LEVELS} from '../sim/rwr.js';
export class RwrRadio{
  constructor({getWorld,radio,isBusy}){Object.assign(this,{getWorld,radio,isBusy});this.cursor=new Map();this.active=false;this.world=getWorld();}
  pump(){
    const world=this.getWorld();if(world!==this.world){this.world=world;this.cursor.clear();}
    if(this.active||this.isBusy())return;
    const priority={evading:6,player_control:5,policy:5,assessment:4,escalated:4,judgment:3,detected:2,resume:1,lost:0};
    for(const unit of world.units){const events=(unit.rwr?.events??[]).filter(e=>e.sequence>(this.cursor.get(unit.id)??0));if(!events.length)continue;
      this.cursor.set(unit.id,events.at(-1).sequence);
      let entry=events.filter(e=>world.time-e.time<=12&&(!['assessment','evading','judgment','player_control','resume','policy'].includes(e.type)||e.controlSequence===unit.rwrDefense?.controlSequence)).sort((a,b)=>(priority[b.type]??0)-(priority[a.type]??0)||b.sequence-a.sequence)[0];
      if(!entry){const current=unit.rwr.contacts.filter(c=>world.time-c.observedAt<.35).sort((a,b)=>RWR_LEVELS[b.level]-RWR_LEVELS[a.level])[0];if(current)entry={type:'detected',level:current.level,bearingDeg:current.bearingDeg,text:`当前仍收到${RWR_LABELS[current.level]}，请关注告警面板`};}if(!entry)continue;
      const clock=Number.isFinite(entry.bearingDeg)?bearingClock(unit,entry.bearingDeg):null;
      this.active=true;const text=`指挥台，${unit.callsign}，${clock?`约${clock}点钟方向，`:''}${entry.text}。`;
      const texts={zh:text,en:`CONTROL, ${unit.callsign}. ${entry.type==='evading'?'NO NEW ORDERS RECEIVED. STARTING DEFENSIVE MANOEUVRE.':entry.type==='player_control'?'FOLLOWING YOUR NEW ORDER.':entry.type==='resume'?'RESUMING PREVIOUS TASK. THREAT DEFEAT NOT CONFIRMED.':`RADAR WARNING${clock?', APPROXIMATELY '+clock+' O CLOCK':''}. ${entry.level==='launch'?'POSSIBLE RADAR MISSILE SIGNAL.':entry.level==='track'?'TRACKING SIGNAL.':'RADIATION STATUS UPDATE.'}`}`};
      void this.radio.transmit({speaker:'pilot',unitId:unit.id,language:'zh-CN',text,texts}).catch(()=>{}).finally(()=>{this.active=false;});break;
    }
  }
}
