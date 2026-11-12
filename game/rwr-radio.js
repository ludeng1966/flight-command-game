import {commandUnits} from '../sim/battle-observation.js';
import {bearingClock,RWR_LABELS,RWR_LEVELS} from '../sim/rwr.js';
export class RwrRadio{
  constructor({getWorld,radio,isBusy}){Object.assign(this,{getWorld,radio,isBusy});this.cursor=new Map();this.active=false;this.world=getWorld();}
  pump(){
    const world=this.getWorld();if(world!==this.world){this.world=world;this.cursor.clear();}
    if(this.active)return;
    const priority={evading:6,player_control:5,policy:5,assessment:4,escalated:4,judgment:3,detected:2,resume:1,lost:0};
    const isUrgent=e=>['detected','assessment','escalated','evading'].includes(e.type)&&RWR_LEVELS[e.level]>=2,busy=this.isBusy();
    for(const unit of commandUnits(world)){const events=(unit.rwr?.events??[]).filter(e=>e.sequence>(this.cursor.get(unit.id)??0));if(!events.length)continue;
      const valid=events.filter(e=>world.time>=e.time&&world.time-e.time<=12&&(!['assessment','evading','judgment','player_control','resume','policy'].includes(e.type)||e.controlSequence===unit.rwrDefense?.controlSequence));
      // Select among calls that can actually interrupt the channel. A newer
      // policy/readback must not hide an urgent detection while the radio is busy.
      let entry=valid.filter(e=>!busy||isUrgent(e)).sort((a,b)=>(priority[b.type]??0)-(priority[a.type]??0)||b.sequence-a.sequence)[0];
      if(!entry&&!valid.length){const current=unit.rwr.contacts.filter(c=>world.time-c.observedAt<.35).sort((a,b)=>RWR_LEVELS[b.level]-RWR_LEVELS[a.level])[0];if(current)entry={type:'detected',level:current.level,bearingDeg:current.bearingDeg,text:`当前仍收到${RWR_LABELS[current.level]}，请关注告警面板`};}if(!entry)continue;
      const urgent=isUrgent(entry);
      if(busy&&!urgent)continue;
      // Leave newer events pending when an older urgent event wins selection.
      const previousCursor=this.cursor.get(unit.id)??0;this.cursor.set(unit.id,entry.sequence??events.at(-1).sequence);
      const clock=Number.isFinite(entry.bearingDeg)?bearingClock(unit,entry.bearingDeg):null;
      this.active=true;const text=`指挥台，${unit.callsign}，${clock?`约${clock}点钟方向，`:''}${entry.text}。`;
      const texts={zh:text,en:`CONTROL, ${unit.callsign}. ${entry.type==='evading'?'NO NEW ORDERS RECEIVED. STARTING DEFENSIVE MANOEUVRE.':entry.type==='player_control'?'FOLLOWING YOUR NEW ORDER.':entry.type==='resume'?'RESUMING PREVIOUS TASK. THREAT DEFEAT NOT CONFIRMED.':`RADAR WARNING${clock?', APPROXIMATELY '+clock+' O CLOCK':''}. ${entry.level==='launch'?'POSSIBLE RADAR MISSILE SIGNAL.':entry.level==='track'?'TRACKING SIGNAL.':'RADIATION STATUS UPDATE.'}`}`};
      const sequence=unit.rwrDefense?.controlSequence;
      void this.radio.transmit({speaker:'pilot',unitId:unit.id,language:'zh-CN',text,texts,priority:urgent?100:10,simTime:entry.time??world.time,expiresAt:(entry.time??world.time)+12},{isCurrent:()=>this.getWorld()===world&&unit.alive!==false&&sequence===unit.rwrDefense?.controlSequence&&(!urgent||unit.rwr.contacts.some(c=>world.time-c.observedAt<.35&&RWR_LEVELS[c.level]>=2))}).catch(error=>{
        if(error.name==='AbortError'&&this.getWorld()===world&&sequence===unit.rwrDefense?.controlSequence&&unit.rwr.contacts.some(c=>world.time-c.observedAt<.35&&RWR_LEVELS[c.level]>=2))this.cursor.set(unit.id,previousCursor);
      }).finally(()=>{this.active=false;});break;
    }
  }
}
