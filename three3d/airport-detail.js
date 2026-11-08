const smooth=(a,b,x)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};

// 按跑道在屏幕上占据的长度显示细节，避免窗口大小或斜视角造成距离阈值失真。
export function airportDetail(projectedLength){
  return {labels:smooth(230,340,projectedLength),markings:smooth(120,230,projectedLength)};
}

export function airportBounds(airport){
  if(!airport)return null;
  const half=airport.footprint??[2550,1400];
  return {minX:airport.center[0]-half[0],maxX:airport.center[0]+half[0],minY:airport.center[1]-half[1],maxY:airport.center[1]+half[1]};
}

// 裁去机场整平范围内的旧等高线，仅影响画线，不改动地形或碰撞数据。
export function outsideAirportSegment(x0,y0,x1,y1,bounds){
  if(!bounds)return [[x0,y0,x1,y1]];
  let enter=0,exit=1;const dx=x1-x0,dy=y1-y0;
  for(const [p,q] of [[-dx,x0-bounds.minX],[dx,bounds.maxX-x0],[-dy,y0-bounds.minY],[dy,bounds.maxY-y0]]){
    if(Math.abs(p)<1e-12){if(q<0)return [[x0,y0,x1,y1]];continue;}
    const t=q/p;if(p<0)enter=Math.max(enter,t);else exit=Math.min(exit,t);
    if(enter>exit)return [[x0,y0,x1,y1]];
  }
  const result=[];
  if(enter>0)result.push([x0,y0,x0+dx*enter,y0+dy*enter]);
  if(exit<1)result.push([x0+dx*exit,y0+dy*exit,x1,y1]);
  return result;
}
