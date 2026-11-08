import {commandContext} from '../sim/orders.js';
import {defenseHeading} from '../sim/rwr-defense.js';
import {rwrEvent} from '../sim/rwr.js';
// Advisory inference is event driven; the bounded local self-defence clock never waits for it.
export class RwrPilot{
  constructor({getWorld,enabled=()=>true,isPlaying=()=>true,getPilotModel=()=>'flash',fetchImpl=fetch,now=()=>performance.now()}){Object.assign(this,{getWorld,enabled,isPlaying,getPilotModel,fetchImpl,now});this.active=null;this.nextCheck=0;}
  reset(){const job=this.active;job?.controller.abort();if(job&&job.unit.rwrDefense.controlSequence===job.sequence&&job.unit.rwrDefense.episode?.key===job.key)job.unit.rwrDefense.episode.reviewed=false;this.active=null;this.nextCheck=0;}
  stop(){this.closed=true;this.reset();}
  tick(){
    if(this.closed)return;const world=this.getWorld(),at=this.now();
    if(!world||!this.enabled()||!this.isPlaying()||world.playerCommandPending){this.reset();return;}
    if(this.active&&(this.active.world!==world||this.active.unit.rwrDefense.controlSequence!==this.active.sequence||this.active.unit.rwrDefense.episode?.key!==this.active.key))this.reset();
    if(this.active||at<this.nextCheck)return;this.nextCheck=at+1000;
    for(const unit of world.units){const d=unit.rwrDefense,e=d?.episode;
      if(!unit.alive||!d||d.mode!=='auto'||!e||e.reviewed||e.playerOverride||world.time-e.lastSeen>2.5)continue;
      const requestId=crypto.randomUUID(),controller=new AbortController(),pilotModel=this.getPilotModel(),job={world,unit,key:e.key,sequence:d.controlSequence,controller};this.active=job;
      const context=commandContext(world,unit.id);
      e.reviewed=true;
      void(async()=>{
        try{
          const response=await this.fetchImpl.call(globalThis,'/api/tactical/pilot/rwr',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId,pilotModel,unitId:unit.id,episodeKey:e.key,controlSequence:job.sequence,context}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});
          const result=await response.json();
          if(controller.signal.aborted||this.getWorld()!==world||this.getPilotModel()!==pilotModel||world.playerCommandPending||d.controlSequence!==job.sequence||d.episode!==e||e.playerOverride||world.time-e.lastSeen>2.5||d.mode!=='auto')return;
          if(!response.ok)throw Error(result.error||'RWR判断服务不可用');
          if(result.requestId!==requestId||result.episodeKey!==e.key||result.controlSequence!==job.sequence||result.revision!==context.revision||result.simTimeSec!==context.simTimeSec)throw Error('RWR判断已过期');
          const decision=result.decision;if(!decision)return;
          if(!['notch','extend'].includes(decision.maneuver)||!['auto','left','right'].includes(decision.side)||typeof decision.message!=='string'||decision.message.length>120)throw Error('RWR建议格式无效');
          d.modelReview={...decision,episodeKey:e.key,time:world.time};
          if(d.active&&!d.active.manual){Object.assign(d.active,{maneuver:decision.maneuver,side:decision.side,headingDeg:defenseHeading(unit,e.bearingDeg,decision.maneuver,decision.side),decidedBy:'pilot_model'});}
          // Report the validated choice and the actual control policy. Model prose cannot
          // redefine the wait deadline or claim a manoeuvre has already defeated a missile.
          const choice=`${decision.side==='left'?'向左':decision.side==='right'?'向右':''}${decision.maneuver==='notch'?'横切规避':'背向脱离'}`;
          rwrEvent(unit,world.time,'judgment',d.active?`飞行员判断后已装订${choice}，正在执行，效果尚未确认`:`飞行员建议${choice}；继续等待玩家指令，等待结束后按设置执行`,{level:e.level,bearingDeg:e.bearingDeg});
        }catch(error){if(!controller.signal.aborted&&d.episode===e&&!e.playerOverride){d.modelError=error.message.slice(0,200);/* Local rule continues; never stall flight on inference. */}}
        finally{if(this.active===job)this.active=null;}
      })();break;
    }
  }
}
