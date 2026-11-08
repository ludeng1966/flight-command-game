import {commandContext} from '../sim/orders.js';
import {applyAtcDecision} from '../sim/atc-decisions.js';
export class TowerSupervisor{
  constructor({getWorld,enabled=()=>true,fetchImpl=fetch,now=()=>performance.now(),onStatus=()=>{}}){Object.assign(this,{getWorld,enabled,fetchImpl,now,onStatus});this.nextAt=0;this.active=null;this.world=null;this.signature=null;}
  reset(){this.active?.abort();this.active=null;this.signature=null;this.nextAt=0;}
  tick(){
    const world=this.getWorld();if(world!==this.world){this.reset();this.world=world;}
    if(!this.enabled()){this.active?.abort();return;}
    const at=this.now();if(this.active||at<this.nextAt||!world?.airportOps)return;
    const context=commandContext(world,world.units[0].id),snapshot=context.airportTraffic;if(!snapshot.queue.length)return;
    const signature=JSON.stringify([snapshot.atis.sequence,snapshot.closed,snapshot.queue.map(q=>[q.id,q.status,q.reason]),snapshot.traffic.map(t=>[t.unitId,t.phase,t.lastModelError,t.emergency,t.fuelStatus])]);
    if(signature===this.signature)return;
    this.signature=signature;this.nextAt=at+10000;const controller=new AbortController();this.active=controller;
    const requestId=crypto.randomUUID(),requests=new Map(snapshot.queue.map(q=>[q.unitId,q.id]));
    void(async()=>{try{
      const response=await this.fetchImpl('/api/atc/assess',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId,context}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(45000)])}),result=await response.json();
      if(controller.signal.aborted||this.getWorld()!==world||world.revision!==context.revision)return;
      if(!response.ok)throw Error(result.error??'塔台判断暂不可用');
      if(result.requestId!==requestId||result.revision!==context.revision||result.simTimeSec!==context.simTimeSec)throw Error('塔台评估已过期');
      for(const d of result.decisions){
        try{applyAtcDecision(world,d,{requestId:requests.get(d.unitId)});const u=world.units.find(u=>u.id===d.unitId);if(u?.surface)u.surface.lastATCError=null;}
        catch(error){const u=world.units.find(u=>u.id===d.unitId);if(u?.surface)u.surface.lastATCError=error.message;this.onStatus({error:error.message});}
      }
    }catch(error){if(!controller.signal.aborted){this.signature=null;this.nextAt=this.now()+30000;this.onStatus({error:error.message});}}
    finally{if(this.active===controller)this.active=null;}})();
  }
}
