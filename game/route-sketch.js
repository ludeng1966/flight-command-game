export const pointDistance=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));
// 保留接入点之前仍待飞的旧航点；后半程由新笔画替换。
export function continueSketchRoute(unit,points,{prefix=[],join=null}={}){
  const route=prefix.filter(w=>unit.waypoints.includes(w));
  for(const point of [...(join?[join]:[]),...points.slice(1)])if(!route.length||pointDistance(route.at(-1),point)>20)route.push(point.slice(0,3));
  return route;
}
export function simplifySketch(points,tolerance=400){
  if(points.length<3)return points.map(p=>p.slice(0,3));
  const a=points[0],b=points.at(-1),d=b.map((v,i)=>v-a[i]),length=d.reduce((s,v)=>s+v*v,0);let far=0,index=0;
  for(let i=1;i<points.length-1;i++){const t=Math.max(0,Math.min(1,points[i].reduce((s,v,k)=>s+(v-a[k])*d[k],0)/Math.max(1,length))),distance=Math.hypot(...points[i].map((v,k)=>v-a[k]-d[k]*t));if(distance>far){far=distance;index=i;}}
  return far>tolerance?[...simplifySketch(points.slice(0,index+1),tolerance).slice(0,-1),...simplifySketch(points.slice(index),tolerance)]:[a.slice(0,3),b.slice(0,3)];
}
export function snapSketchPoint(point,{anchor,previous,targets=[],project,screen,tolerance=12}){
  const distance=p=>{const s=project(p);return s.visible?Math.hypot(s.x-screen.x,s.y-screen.y):Infinity;};
  const target=targets.map((p,index)=>({point:p,index,distance:distance(p)})).sort((a,b)=>a.distance-b.distance)[0];
  if(target?.distance<tolerance)return {point:target.point.slice(0,3),kind:'point',index:target.index};
  if(!anchor)return {point,kind:null};
  const candidates=[];
  if(previous){const d=anchor.map((v,i)=>v-previous[i]),length=d.reduce((s,v)=>s+v*v,0),t=point.reduce((s,v,i)=>s+(v-anchor[i])*d[i],0)/Math.max(1,length);if(t>0)candidates.push(anchor.map((v,i)=>v+d[i]*t));}
  const dx=point[0]-anchor[0],dy=point[1]-anchor[1],angle=Math.round(Math.atan2(dy,dx)/(Math.PI/4))*Math.PI/4,r=dx*Math.cos(angle)+dy*Math.sin(angle);
  if(Math.hypot(dx,dy)>200)candidates.push([anchor[0]+r*Math.cos(angle),anchor[1]+r*Math.sin(angle),point[2]]);
  const line=candidates.map(p=>({point:p,distance:distance(p)})).sort((a,b)=>a.distance-b.distance)[0];
  return line?.distance<tolerance*.7?{...line,kind:'line'}:{point,kind:null};
}
