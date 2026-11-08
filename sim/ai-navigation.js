const vector=p=>Array.isArray(p)&&p.length===3&&p.every(Number.isFinite);
const near=(a,b,tolerance=5)=>Math.hypot(...a.map((v,i)=>v-b[i]))<=tolerance;
export function forecastOrigin(context,unitId,seconds){
  return context.decisionTiming?.forecasts?.find(f=>f.outputSec===seconds)?.units.find(u=>u.id===unitId)?.position??context.units.find(u=>u.id===unitId)?.position;
}
// Check the AI's actual coordinates, including every commanded destination, before any installation.
export function validateAiNavigation(navigationPlans,plan,context,latencyPredictionSec){
  const timing=context.decisionTiming;
  if(!Number.isFinite(latencyPredictionSec)||timing&&!timing.horizonsSec.includes(latencyPredictionSec)||!timing&&(latencyPredictionSec<0||latencyPredictionSec>60))throw Error('输出延时必须选择本次预测时刻；暂停时只能为0');
  if(!Array.isArray(navigationPlans)||navigationPlans.length>32)throw Error('飞行员航点格式无效');
  const required=new Set(plan.status==='accepted'?plan.tasks.filter(t=>['fly_to','fly_heading'].includes(t.action)).map(t=>t.unitId):[]),seen=new Set();
  const result=[];
  for(const route of navigationPlans){
    if(!route||Object.keys(route).some(k=>!['unitId','waypoints'].includes(k))||!required.has(route.unitId)||seen.has(route.unitId)||!Array.isArray(route.waypoints)||!route.waypoints.length||route.waypoints.length>12)throw Error('只为收到导航任务的本机规划一条航路');
    seen.add(route.unitId);const unit=context.units.find(u=>u.id===route.unitId),tasks=plan.tasks.filter(t=>t.unitId===route.unitId&&['fly_to','fly_heading'].includes(t.action)),origin=forecastOrigin(context,unit.id,latencyPredictionSec);
    for(const p of route.waypoints)if(!vector(p)||Math.abs(p[0])>200000||Math.abs(p[1])>200000||p[2]<500||p[2]>Math.min(15000,unit.navigationEnvelope?.ceilingM??15000))throw Error('AI航点超出地图、高度或本机升限');
    let cursor=-1;
    for(const task of tasks){
      if(task.action==='fly_to'){
        const target=[task.eastM,task.northM,task.altitudeM??unit.targetAltitudeM],index=route.waypoints.findIndex((p,i)=>i>cursor&&near(p,target));
        if(index<0)throw Error('AI航路必须按顺序保留指挥员指定的每个目标坐标和高度');cursor=index;
      }
    }
    const last=tasks.at(-1);
    if(last.action==='fly_to'&&cursor!==route.waypoints.length-1)throw Error('最后一个AI航点必须是命令的目的地');
    if(last.action==='fly_heading'){
      if(tasks.length!==1)throw Error('同机航向与其他导航请分次下达');
      const span=last.distanceM??20000,angle=last.headingDeg*Math.PI/180,target=[origin[0]+Math.sin(angle)*span,origin[1]+Math.cos(angle)*span,last.altitudeM??unit.targetAltitudeM];
      if(!near(route.waypoints.at(-1),target,10))throw Error('航向航路终点必须按预测机位、指定航向与距离计算，当前选定输出时刻的正确终点为'+JSON.stringify(target.map(n=>Math.round(n*100)/100))+'；保留中间点规划并修正终点。未给距离前视20000米');
    }
    result.push({unitId:unit.id,waypoints:route.waypoints.map(p=>[...p]),referencePosition:[...origin],relative:last.action==='fly_heading',latencyPredictionSec});
  }
  if([...required].some(id=>!seen.has(id)))throw Error('飞行员必须给每架导航受令机输出实际三维航点，不要求玩家规划');
  return result;
}
