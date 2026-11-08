import {throughWaypoints} from '../sim/route-continuity.js';

// 只用于拖动反馈，不据此执行飞行；完整气动和地形校核仍在Worker中进行。
export function estimateRoute(unit,route){
  return throughWaypoints(unit,route,null,{spacing:650,maxSamples:48})?.flatMap((leg,i)=>i?leg.slice(1):leg)??[[...unit.position],...route];
}

// 首次立即计算，持续拖动时限频而不延后；同一手势最多一个在途请求和一个最新草稿。
export class RoutePreview{
  constructor({planner,channel,getUnit,onResult,interval=140,now=()=>performance.now(),schedule=(run,delay)=>setTimeout(run,delay),unschedule=id=>clearTimeout(id)}){
    Object.assign(this,{planner,channel,getUnit,onResult,interval,now,schedule,unschedule});this.version=0;this.nextAt=0;this.closed=false;this.busy=false;this.pending=false;this.key=null;
  }
  update(route){
    if(this.closed)return;
    const key=JSON.stringify(route);if(this.key===key)return;
    this.key=key;this.route=route.map(p=>p.slice(0,3));this.version++;this.pending=true;this.pump();
  }
  refresh(){if(!this.closed&&this.route){this.pending=true;this.pump();}}
  pump(){
    if(this.closed||this.busy||!this.pending||this.timer!=null)return;
    const delay=Math.max(0,this.nextAt-this.now());
    if(delay){this.timer=this.schedule(()=>{this.timer=null;this.pump();},delay);return;}
    const version=this.version,route=this.route;this.pending=false;this.busy=true;this.nextAt=this.now()+this.interval;
    Promise.resolve(this.planner.request(this.channel,this.getUnit(),route)).then(result=>{
      if(!this.closed&&version===this.version&&result)this.onResult(result);
    }).catch(error=>{if(!this.closed&&version===this.version)this.onResult({valid:false,reason:error.message});})
      .finally(()=>{this.busy=false;this.pump();});
  }
  clear(){this.version++;this.key=null;this.pending=false;this.unschedule(this.timer);this.timer=null;this.planner.cancel(this.channel);}
  stop(){this.clear();this.closed=true;}
}
