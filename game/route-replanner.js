const same=(a,b)=>a.every((v,k)=>Math.abs(v-b[k])<.01);

// 草稿保留航点身份，等待规划时经过的旧航点不会被重新塞回队列。
export function routeDraft(unit,points,base=unit.waypoints){
  return {points:points.map(point=>({point:point.slice(0,3),source:base.find(w=>same(point,w))??null})),revision:unit.routeRevision??0};
}
export function draftPoints(unit,draft){return draft.points.filter(p=>!p.source||unit.waypoints.includes(p.source)).map(p=>p.point.slice(0,3));}

export class RouteReplanner{
  constructor({getWorld,planner}){this.getWorld=getWorld;this.planner=planner;this.latest=new Map();}
  async apply(id,intent,{isCurrent=()=>true}={}){
    const world=this.getWorld(),unit=world.units.find(u=>u.id===id),revision=unit.routeRevision??0,token={};
    if(intent.revision!=null&&intent.revision!==revision)throw Error('航路已有新指令，取消旧草稿');
    this.latest.set(id,token);
    const current=()=>this.latest.get(id)===token&&world===this.getWorld()&&isCurrent();
    const route=()=>{
      if((unit.routeRevision??0)!==revision)throw Error('航路已有新指令，取消旧草稿');
      if(intent.kind==='move'){
        if(!unit.waypoints.includes(intent.reference))throw Error('该航点已通过，结束编辑');
        return unit.waypoints.map(w=>w===intent.reference||unit.routeLoop&&w.loopIndex===intent.reference.loopIndex?intent.point.slice(0,3):w.slice(0,3));
      }
      if(intent.kind==='append')return [...unit.waypoints.map(w=>w.slice(0,3)),intent.point.slice(0,3)];
      if(intent.kind==='command')return [intent.point.slice(0,3)];
      if(intent.draft.revision!==revision)throw Error('航路已有新指令，取消旧草稿');
      return draftPoints(unit,intent.draft);
    };
    for(let attempt=0;attempt<5;attempt++){
      if(!current())return null;
      const points=route(),plan=await this.planner.request('commit:'+id,unit,points);
      if(!current())return null;
      const latest=route();if(JSON.stringify(latest)!==JSON.stringify(points))continue;
      if(!plan)continue;if(!plan.valid)throw Error(plan.reason||'无法安全到达');
      try{
        let result;
        if(intent.kind==='move')result=world.moveWaypoint(id,unit.waypoints.indexOf(intent.reference),intent.point,plan);
        else if(intent.kind==='append')result=world.command(id,intent.point,true,plan);
        else if(intent.kind==='command')result=world.command(id,intent.point,false,plan);
        else result=world.replaceRoute(id,points,{prepared:plan});
        world.prediction={...result,unitId:id};return result;
      }catch(error){if(attempt===4||!error.message.includes('重新规划'))throw error;}
    }
    throw Error('飞机状态持续变化，请稍后再试');
  }
}
