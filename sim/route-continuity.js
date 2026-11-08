import {clamp,stepFlight} from './flight.js';

const distance=(a,b)=>Math.hypot(...b.map((v,k)=>v-a[k]));

// 平面夹持三次样条：起点沿实际速度方向，所有内部航点位置/切线/曲率连续。
function derivatives(points,steps,axis,initial){
  const n=points.length,lower=new Float64Array(n),diag=new Float64Array(n),upper=new Float64Array(n),rhs=new Float64Array(n);
  diag[0]=1;rhs[0]=initial;
  for(let i=1;i<n-1;i++){
    const before=steps[i-1],after=steps[i];lower[i]=after;diag[i]=2*(before+after);upper[i]=before;
    rhs[i]=3*(after*(points[i][axis]-points[i-1][axis])/before+before*(points[i+1][axis]-points[i][axis])/after);
  }
  lower[n-1]=1;diag[n-1]=2;rhs[n-1]=3*(points[n-1][axis]-points[n-2][axis])/steps[n-2];
  for(let i=1;i<n;i++){const factor=lower[i]/diag[i-1];diag[i]-=factor*upper[i-1];rhs[i]-=factor*rhs[i-1];}
  const result=new Float64Array(n);result[n-1]=rhs[n-1]/diag[n-1];
  for(let i=n-2;i>=0;i--)result[i]=(rhs[i]-upper[i]*result[i+1])/diag[i];
  return result;
}

function altitudeSlopes(points,steps,initial){
  const n=points.length,slopes=new Float64Array(n),secants=steps.map((h,i)=>(points[i+1][2]-points[i][2])/h);
  slopes[0]=initial;slopes[n-1]=0;
  for(let i=1;i<n-1;i++){
    const a=secants[i-1],b=secants[i];if(a*b<=0)continue;
    const w1=2*steps[i]+steps[i-1],w2=steps[i]+2*steps[i-1];slopes[i]=(w1+w2)/(w1/a+w2/b);
  }
  // 保持高度单调；连续爬升不在每个航点归零，真实峰顶/谷底才逐渐改平。
  for(let i=0;i<steps.length;i++){
    const slope=secants[i];if(Math.abs(slope)<1e-8){slopes[i]=slopes[i+1]=0;continue;}
    if(slopes[i]*slope<0)slopes[i]=0;if(slopes[i+1]*slope<0)slopes[i+1]=0;
    const scale=Math.hypot(slopes[i]/slope,slopes[i+1]/slope);if(scale>3){slopes[i]*=3/scale;slopes[i+1]*=3/scale;}
  }
  return slopes;
}

export function throughWaypoints(unit,goals,terrain,{spacing=150,maxSamples=512}={}){
  if(!goals.length)return [];
  const points=[[...unit.position],...goals.map(p=>p.slice(0,3))],steps=points.slice(1).map((p,i)=>Math.max(50,distance(points[i],p)));
  const speed=Math.max(1,Math.hypot(...unit.velocity));
  const tangents=[derivatives(points,steps,0,unit.velocity[0]/speed),derivatives(points,steps,1,unit.velocity[1]/speed),altitudeSlopes(points,steps,unit.velocity[2]/speed)];
  const legs=[];
  for(let i=0;i<steps.length;i++){
    const count=Math.min(maxSamples,Math.max(6,Math.ceil(steps[i]/spacing))),leg=[];
    for(let j=0;j<=count;j++){
      const t=j/count,t2=t*t,t3=t2*t,h=steps[i];
      const p=[0,1,2].map(k=>(2*t3-3*t2+1)*points[i][k]+(t3-2*t2+t)*h*tangents[k][i]+(-2*t3+3*t2)*points[i+1][k]+(t3-t2)*h*tangents[k][i+1]);
      if(!p.every(Number.isFinite)||terrain?.checkPoint&&!terrain.checkPoint(p,100).valid)return null;
      if(j&&terrain?.checkSegment&&!terrain.checkSegment(leg[j-1],p,100).valid)return null;
      leg.push(p);
    }
    leg[0]=[...points[i]];leg[leg.length-1]=[...points[i+1]];legs.push(leg);
  }
  return legs;
}

// 修改后段时保留尚未受影响的前段；修改近处时先接一小段真实运动，给滚转和推力留出响应时间。
export function rejoinWaypoints(unit,goals,terrain){
  if(!goals.length||!unit.navLegs?.length||!unit.waypoints?.length)return null;
  let unchanged=0;
  while(unchanged<goals.length&&unchanged<unit.waypoints.length&&distance(goals[unchanged],unit.waypoints[unchanged])<.01)unchanged++;
  const keep=Math.min(Math.max(0,unchanged-1),unit.navLegs.length-1);
  if(keep){
    const prefix=unit.navLegs.slice(0,keep).map((leg,i)=>leg.slice(i?0:unit.navCursor??0).map(p=>[...p]));
    const end=prefix.at(-1).at(-1),next=unit.navLegs[keep],after=next?.find(p=>distance(p,end)>1);
    if(!after)return null;
    const direction=after.map((v,k)=>v-end[k]),length=Math.hypot(...direction),speed=Math.hypot(...unit.velocity);
    const tail=throughWaypoints({...unit,position:end,velocity:direction.map(v=>v/length*speed)},goals.slice(keep),terrain);
    return tail?[...prefix,...tail]:null;
  }
  const entry=[[...unit.position]],copy={...unit,position:[...unit.position],velocity:[...unit.velocity],control:{...unit.control}};
  const duration=Math.min(1.8,distance(unit.position,goals[0])/Math.max(1,Math.hypot(...unit.velocity)*4));
  const count=Math.max(1,Math.ceil(duration*60));
  for(let i=0;i<count;i++){
    const before=copy.position;stepFlight(copy,duration/count);
    if(copy.stalled||terrain?.checkSegment&&!terrain.checkSegment(before,copy.position,100).valid)return null;
    if(i%10===0||i===count-1)entry.push([...copy.position]);
  }
  const tail=throughWaypoints(copy,goals,terrain);if(!tail)return null;
  tail[0]=[...entry,...tail[0].slice(1)];return tail;
}

export function gateDirection(unit){
  const leg=unit.navLegs?.[0],next=unit.navLegs?.[1],goal=unit.waypoints[0];
  const after=next?.find(p=>distance(p,goal)>1),before=leg?.findLast(p=>distance(p,goal)>1);
  const direction=after?after.map((v,k)=>v-goal[k]):before?goal.map((v,k)=>v-before[k]):goal.map((v,k)=>v-(unit.previousWaypoint?.[k]??unit.position[k]));
  const length=Math.hypot(...direction);if(length<1e-6)return unit.velocity;
  return direction.map(v=>v/length);
}

export function futureWindow(unit,index,t){
  const current=unit.navLegs[0],point=current[index].map((v,k)=>v+(current[index+1][k]-v)*t);
  const nodes=[point,...current.slice(index+1)];let gateDistance=0;
  for(let i=1;i<nodes.length;i++)gateDistance+=distance(nodes[i-1],nodes[i]);
  for(const leg of unit.navLegs.slice(1,3))nodes.push(...leg.slice(1));
  return {nodes,gateDistance};
}

export function curvatureAt(a,b,c){
  const ab=[b[0]-a[0],b[1]-a[1]],bc=[c[0]-b[0],c[1]-b[1]],la=Math.hypot(...ab),lb=Math.hypot(...bc);
  if(la<1||lb<1)return 0;
  return Math.acos(clamp((ab[0]*bc[0]+ab[1]*bc[1])/(la*lb),-1,1))/Math.max(1,(la+lb)/2);
}
