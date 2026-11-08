export function chooseWindowPlacement(rect,bounds,obstacles=[]){
  const margin=8,top=100,maxX=Math.max(margin,bounds.width-rect.width-margin),maxY=Math.max(margin,bounds.height-rect.height-72);
  const candidates=[rect,...[78,maxX,(bounds.width-rect.width)/2].flatMap(x=>[top,maxY].map(y=>({...rect,x:Math.max(margin,Math.min(maxX,x)),y:Math.max(margin,Math.min(maxY,y))})))];
  const score=r=>obstacles.reduce((sum,o)=>sum+Math.max(0,Math.min(r.x+r.width,o.x+o.w)-Math.max(r.x,o.x))*Math.max(0,Math.min(r.y+r.height,o.y+o.h)-Math.max(r.y,o.y))*(o.weight??1),0)+Math.hypot(r.x-rect.x,r.y-rect.y)*.02;
  return candidates.reduce((best,r)=>score(r)<score(best)?r:best,rect);
}
