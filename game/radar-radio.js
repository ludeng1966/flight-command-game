import {commandUnits} from '../sim/battle-observation.js';
import {confirmedAttackHit} from '../sim/task-feedback.js';
const terminal=new Set(['attack_hit','attack_aborted','attack_abort','attack_exhausted','attack_cancelled']);
const priority=e=>terminal.has(e.type)?6:e.type==='lost'?5:e.type==='attack_launch'?4:e.type==='locked'?3:e.type==='attack_miss'?2:1;
const ttl=e=>terminal.has(e.type)?45:e.type==='attack_launch'||e.type==='attack_miss'?25:12;
const group=e=>['locked','lost','acquiring','search','off'].includes(e.type)?'radar-state':terminal.has(e.type)?'attack-terminal':e.type?.startsWith('attack_')&&!['attack_launch','attack_miss'].includes(e.type)?'attack-progress':e.type;
function current(world,unit,e){
  if(!unit||!Number.isFinite(e.time)||world.time<e.time||world.time-e.time>ttl(e))return false;
  const r=unit.radar,t=unit.attackTask;
  if(e.type?.startsWith('attack_')){
    if(!t?.events?.some(a=>'attack_'+a.type===e.type&&a.time===e.time&&a.text===e.text))return false;
    if(e.type==='attack_hit'&&!confirmedAttackHit(t))return false;
    if(!terminal.has(e.type)&&!['attack_launch','attack_miss'].includes(e.type)&&!t.active)return false;
  }
  if(e.type==='locked'&&(r?.phase!=='locked'||r.lastLockSequence!==e.sequence))return false;
  if(e.type==='lost'&&(r?.phase==='locked'||r.lastLostSequence!==e.sequence))return false;
  if(e.type==='acquiring'&&r?.phase!=='acquiring'||e.type==='search'&&r?.phase!=='search'||e.type==='off'&&r?.mode!=='off')return false;
  return true;
}
export class RadarRadio{
  constructor({getWorld,radio,isBusy}){this.getWorld=getWorld;this.radio=radio;this.isBusy=isBusy;this.world=getWorld();this.cursor=new Map(this.world.units.map(u=>[u.id,u.radar?.sequence??0]));this.queue=[];this.active=false;}
  pump(){
    const world=this.getWorld();if(world!==this.world){this.world=world;this.cursor=new Map(world.units.map(u=>[u.id,u.radar?.sequence??0]));this.queue=[];}
    if(this.active||this.isBusy())return;
    for(const unit of commandUnits(world)){
      const events=(unit.radar?.events??[]).filter(e=>e.sequence>(this.cursor.get(unit.id)??0));
      if(events.length)this.cursor.set(unit.id,events.at(-1).sequence);
      for(const entry of events){
        // State changes supersede old claims; terminal results supersede old progress.
        this.queue=this.queue.filter(q=>q.unitId!==unit.id||group(q.entry)!==group(entry)&&!(terminal.has(entry.type)&&q.entry.type?.startsWith('attack_')));
        if(current(world,unit,entry))this.queue.push({unitId:unit.id,entry});
      }
    }
    this.queue=this.queue.filter(q=>current(world,world.units.find(u=>u.id===q.unitId),q.entry)).sort((a,b)=>priority(b.entry)-priority(a.entry)||b.entry.time-a.entry.time).slice(0,32);
    const next=this.queue.shift();if(!next)return;const {entry,unitId}=next;this.active=true;
    Promise.resolve().then(()=>{
      const unit=world.units.find(u=>u.id===unitId);
      if(this.getWorld()!==world||!current(world,unit,entry))return;
      return this.radio.transmit({speaker:'pilot',unitId,text:`指挥台，${unit.callsign}。${entry.text.replace(/[。.!]+$/,'')}。`,language:'zh-CN',simTime:entry.time,radarEventId:entry.sequence,
        eventSource:entry.type?.startsWith('attack_')?'attack':'radar',observedAt:entry.time});
    }).catch(()=>{}).finally(()=>{this.active=false;});
  }
}
