import {commandUnits} from '../sim/battle-observation.js';
import {pilotContext as commandContext} from '../sim/orders.js';
import {defenseReviewEvent,defenseReviewSignature,applyDefenseRecommendation} from '../sim/rwr-defense.js';
import {rwrEvent} from '../sim/rwr.js';
import {capturePlayerOrderScope,isPlayerOrderScopeCurrent} from '../sim/command-scope.js';
// Advisory inference is event driven; the bounded local self-defence clock never waits for it.
export class RwrPilot{
  constructor({getWorld,enabled=()=>true,isPlaying=()=>true,getPilotModel=()=>'flash',fetchImpl=fetch,now=()=>performance.now(),maxConcurrent=Infinity}){Object.assign(this,{getWorld,enabled,isPlaying,getPilotModel,fetchImpl,now});if(maxConcurrent!==Infinity&&(!Number.isSafeInteger(maxConcurrent)||maxConcurrent<1))throw Error('告警模型并发预算必须是正整数或Infinity');this.maxConcurrent=maxConcurrent;this.jobs=new Map();this.nextCheck=0;}
  get active(){return this.jobs.values().next().value??null;}
  cancel(job){job.controller.abort();if(job.unit.rwrDefense.controlSequence===job.sequence&&job.unit.rwrDefense.episode?.key===job.key)job.unit.rwrDefense.episode.reviewed=false;this.jobs.delete(job.unit.id);}
  reset(){for(const job of this.jobs.values())this.cancel(job);this.nextCheck=0;}
  stop(){this.closed=true;this.reset();}
  tick(){
    if(this.closed)return;const world=this.getWorld(),at=this.now();
    if(!world||!this.enabled()||!this.isPlaying()){this.reset();return;}
    for(const job of this.jobs.values())if(job.world!==world||job.unit.alive===false||!isPlayerOrderScopeCurrent(world,job.scope,[job.unit.id])||job.unit.rwrDefense.controlSequence!==job.sequence||job.unit.rwrDefense.episode?.key!==job.key)this.cancel(job);
    if(this.jobs.size>=this.maxConcurrent||at<this.nextCheck)return;this.nextCheck=at+100;
    for(const unit of commandUnits(world)){const d=unit.rwrDefense,e=d?.episode;
      if(this.jobs.has(unit.id)||!unit.alive||!defenseReviewEvent(unit,world.time))continue;
      const requestId=crypto.randomUUID(),controller=new AbortController(),pilotModel=this.getPilotModel(),job={world,unit,key:e.key,sequence:d.controlSequence,scope:capturePlayerOrderScope(world),controller};this.jobs.set(unit.id,job);
      const context=commandContext(world,unit.id);

      void(async()=>{
        try{
          const response=await this.fetchImpl.call(globalThis,'/api/tactical/pilot/rwr',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId,pilotModel,unitId:unit.id,episodeKey:e.key,controlSequence:job.sequence,context}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});
          const result=await response.json();
          if(controller.signal.aborted||this.getWorld()!==world||!this.enabled()||!this.isPlaying()||unit.alive===false||!isPlayerOrderScopeCurrent(world,job.scope,[unit.id])||this.getPilotModel()!==pilotModel||d.controlSequence!==job.sequence||d.episode!==e||e.playerOverride||world.time-e.lastSeen>2.5||d.mode!=='auto')return;
          if(!response.ok)throw Error(result.error||'RWR判断服务不可用');
          if(result.requestId!==requestId||result.episodeKey!==e.key||result.controlSequence!==job.sequence||result.revision!==context.revision||result.simTimeSec!==context.simTimeSec)throw Error('RWR判断已过期');
          const decision=result.decision;if(!decision)return;
          if(!['notch','extend','maintain'].includes(decision.maneuver)||!['auto','left','right'].includes(decision.side)||typeof decision.message!=='string'||decision.message.length>120)throw Error('RWR建议格式无效');
          d.modelReview={...decision,episodeKey:e.key,time:world.time};
          applyDefenseRecommendation(unit,decision);e.reviewed=true;e.reviewedAt=world.time;e.reviewSignature=defenseReviewSignature(unit,world.time);
          // Report the validated choice and the actual control policy. Model prose cannot
          // redefine the wait deadline or claim a manoeuvre has already defeated a missile.
          const choice=decision.maneuver==='maintain'?'保持当前规避':`${decision.side==='left'?'向左':decision.side==='right'?'向右':''}${decision.maneuver==='notch'?'横切规避':'背向脱离'}`;
          rwrEvent(unit,world.time,'judgment',d.active?`飞行员判断后已装订${choice}，正在执行，效果尚未确认`:`飞行员建议${choice}；按即时自卫策略执行，明确冲突指令优先`,{level:e.level,bearingDeg:e.bearingDeg});
        }catch(error){if(!controller.signal.aborted&&this.getWorld()===world&&unit.alive!==false&&isPlayerOrderScopeCurrent(world,job.scope,[unit.id])&&d.episode===e&&!e.playerOverride){d.modelError=error.message.slice(0,200);e.reviewRetryAt=world.time+5;/* Local rule continues; never stall flight on inference. */}}
        finally{if(this.jobs.get(unit.id)===job)this.jobs.delete(unit.id);}
      })();if(this.jobs.size>=this.maxConcurrent)break;
    }
  }
}
