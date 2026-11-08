import {controlAuthority,beginHandoff,acknowledgeHandoff,handoffMessages} from '../sim/control-authority.js';
export async function transmitHandoff(world,unit,radio,{signal,isCurrent=()=>true}={}){
  const c=controlAuthority(world,unit),sequence=beginHandoff(world,unit);if(sequence===null)return;
  const messages=handoffMessages(world,unit);
  for(let i=c.progress;i<messages.length;i++){
    if(signal?.aborted||!isCurrent()||!unit.alive)throw new DOMException('交接已中止','AbortError');
    radio.phase('control-handoff',`交接 ${i+1} / 4 · ${messages[i].label}`);
    await radio.transmit(messages[i],{signal});
    if(signal?.aborted||!isCurrent()||!unit.alive)throw new DOMException('交接已中止','AbortError');
    acknowledgeHandoff(world,unit,sequence,i);
  }
}
export class ControlHandoffRadio{
  constructor({getWorld,radio,isBusy,allowAutomatic=()=>true}){Object.assign(this,{getWorld,radio,isBusy,allowAutomatic});this.active=false;this.job=null;this.manual=new Set();}
  request(id){const w=this.getWorld(),u=w.units.find(u=>u.id===id);if(!u||controlAuthority(w,u).phase==='owned')return;this.manual.add(id);this.pump();}
  reset(){this.job?.controller.abort();this.manual.clear();}
  pump(){
    const world=this.getWorld();if(this.job&&(this.job.world!==world||!this.job.unit.alive))this.job.controller.abort();
    if(this.active||this.isBusy())return;
    const unit=world.units.find(u=>{const c=controlAuthority(world,u);return u.alive&&c.phase!=='owned'&&(c.phase==='transferring'||this.manual.has(u.id)||c.mode==='auto'&&this.allowAutomatic(u));});
    if(!unit)return;this.manual.delete(unit.id);const controller=new AbortController(),job={world,unit,controller};this.active=true;this.job=job;
    void transmitHandoff(world,unit,this.radio,{signal:controller.signal,isCurrent:()=>this.getWorld()===world}).catch(()=>{}).finally(()=>{if(this.job===job){this.active=false;this.job=null;}});
  }
}
