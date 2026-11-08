import {getUnitSystem} from '../sim/units.js';
export function plannerUnit(unit,includePath=false){
  const keys=['id','profileId','profile','position','velocity','bank','cl','speed','loadFactor','throttle','afterburner','targetSpeed','targetAltitude','holdAltitude','orbit','flightState','recoveryTime','recoveryCause','control','energy','guidance','navCursor','departurePowerPlan','pilotPowerPlan','stalled','gearDown','flaps','speedBrake'];
  const snapshot=Object.fromEntries(keys.map(k=>[k,unit[k]]));
  snapshot.wind=unit.wind;snapshot.groundVelocity=unit.groundVelocity;
  if(unit.pilotExecution?.constraints)snapshot.pilotExecution={constraints:structuredClone(unit.pilotExecution.constraints)};
  snapshot.gateCaptured=!!unit.gateEntered&&unit.gateEntered===unit.waypoints[0];snapshot.gatePosition=snapshot.gateCaptured?unit.waypoints[0].slice(0,3):null;
  if(includePath){snapshot.navLegs=unit.navLegs;snapshot.waypoints=unit.waypoints;}
  return structuredClone(snapshot);
}

export class PlannerClient{
  constructor(terrain){
    this.terrain=terrain;this.queue=new Map();this.serial=0;this.lanes=[this.createLane(false),null];this.worker=this.lanes[0].worker;
  }
  createLane(commit){
    const lane={commit,active:null,worker:new Worker(new URL('../sim/planner-worker.js',import.meta.url),{type:'module'})};
    const buffer=this.terrain.heights.slice().buffer;lane.worker.postMessage({type:'init',meta:this.terrain.meta,buffer},[buffer]);
    lane.worker.onmessage=event=>{const job=lane.active;if(!job||event.data.id!==job.id)return;lane.active=null;job.resolve(event.data.result);this.pump();};
    lane.worker.onerror=()=>{const result={valid:false,reason:'后台航路计算不可用，请刷新页面',points:[],warnings:[]};lane.active?.resolve(result);lane.active=null;for(const job of this.queue.values())job.resolve(result);this.queue.clear();this.failed=true;};
    return lane;
  }
  cancel(channel){const job=this.queue.get(channel);if(job){this.queue.delete(channel);job.resolve(null);}}
  request(channel,unit,route,type='plan'){
    if(this.failed)return Promise.resolve({valid:false,reason:'后台航路计算不可用',points:[],warnings:[]});
    const old=this.queue.get(channel);if(old)old.resolve(null);
    const running=this.lanes[1];
    if(running?.active?.channel===channel){
      running.active.resolve(null);running.active=null;running.worker.terminate?.();this.lanes[1]=this.createLane(true);
    }
    return new Promise(resolve=>{this.queue.set(channel,{id:++this.serial,channel,type,unit,route:route.map(p=>p.slice(0,3)),resolve});this.pump();});
  }
  pump(){
    if(!this.queue.size)return;
    const isCommit=job=>job.channel==='commit'||job.channel.startsWith('commit:');
    if(!this.lanes[1]&&[...this.queue.values()].some(isCommit))this.lanes[1]=this.createLane(true);
    const priority=channel=>channel.startsWith('nav:')?0:channel==='live'?2:1;
    for(const lane of this.lanes){
      if(!lane||lane.active)continue;
      const job=[...this.queue.values()].filter(job=>isCommit(job)===lane.commit).sort((a,b)=>priority(a.channel)-priority(b.channel))[0];if(!job)continue;
      this.queue.delete(job.channel);lane.active=job;const {resolve,...payload}=job;
      // 排队期间飞机继续飞行，真正发出任务时才读取状态。
      payload.unit=plannerUnit(job.unit,true);
      if(job.channel!=='live'&&!job.channel.startsWith('nav:')){payload.unit.pilotPowerPlan=null;payload.unit.departurePowerPlan=null;}
      payload.unitSystem=getUnitSystem();lane.worker.postMessage(payload);
    }
  }
}
