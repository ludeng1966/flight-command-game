const smooth=(a,b,x)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};

export function airportLabelDetail(label,span){
  if(label.kind==='runway')return smooth(230,340,span);
  if(label.kind==='stand')return smooth(350,500,span);
  return label.level==='main'?smooth(300,440,span):smooth(620,840,span);
}

// 编号来自实际滑行图；同名边合并，锚点投回其中一条边，避免标到草地上。
export function airportLabelDefinitions(airport){
  const result=[],groups=new Map(),height=airport.elevation+1;
  const add=(kind,text,point,extra={})=>{
    const font=kind==='runway'?12:11;
    result.push({id:kind+':'+text,kind,text,point,width:Math.ceil(text.length*font*.68+18),height:kind==='runway'?26:24,order:result.length,...extra});
  };
  for(const r of airport.runways)add('runway',r.designator,[(r.direction===1?r.x0:r.x1)+r.direction*155,r.y,height],{strip:r.stripId,priority:100});
  for(const edge of airport.edges){
    const a=airport.nodes[edge.a],b=airport.nodes[edge.b],length=Math.hypot(b[0]-a[0],b[1]-a[1]);if(length<1)continue;
    if(!groups.has(edge.name))groups.set(edge.name,[]);groups.get(edge.name).push({a,b,length});
  }
  for(const [name,edges] of groups){
    const length=edges.reduce((n,e)=>n+e.length,0),center=[0,1].map(k=>edges.reduce((n,e)=>n+(e.a[k]+e.b[k])*.5*e.length,0)/length);
    let anchor=null,error=Infinity;
    for(const {a,b} of edges){
      const dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((center[0]-a[0])*dx+(center[1]-a[1])*dy)/(dx*dx+dy*dy)));
      const point=[a[0]+dx*t,a[1]+dy*t,height],distance=Math.hypot(point[0]-center[0],point[1]-center[1]);
      if(distance<error){anchor=point;error=distance;}
    }
    const main=/^[A-Z]$/.test(name);add('taxiway',name,anchor,{level:main?'main':'link',priority:main?80:40});
  }
  for(const id of airport.stands)add('stand',id,[...airport.nodes[id].slice(0,2),height],{priority:70});
  return result;
}

const overlaps=(a,b,gap)=>a.x<b.x+b.w+gap&&a.x+a.w+gap>b.x&&a.y<b.y+b.h+gap&&a.y+a.h+gap>b.y;

// 优先沿用上一次偏移；放不下才尝试其他方向，不够空间就隐藏较低优先级编号。
export function layoutAirportLabels(candidates,viewport,{blocked=[],previous=new Map(),gap=5}={}){
  const result=new Map(),occupied=[...blocked],top=102,bottom=viewport.height-90;
  for(const label of [...candidates].sort((a,b)=>b.priority-a.priority||a.order-b.order)){
    const w=label.width,h=label.height,x=label.x,y=label.y;
    const offsets=label.kind==='stand'?
      [[-w/2,28],[-w/2,20],[-w/2,-h-28],[12,-h/2],[-w-12,-h/2],[-w/2,h+38],[-w/2,-2*h-38]]:
      [[-w/2,-h-8],[-w/2,8],[10,-h/2],[-w-10,-h/2],[-w/2,-2*h-18],[-w/2,h+18]];
    const preferred=previous.get(label.id),slots=[...new Set([preferred,...offsets.map((_,i)=>i)])].filter(i=>i!=null&&offsets[i]);
    for(const slot of slots){
      const [dx,dy]=offsets[slot],rect={x:x+dx,y:y+dy,w,h};
      if(rect.x<6||rect.x+w>viewport.width-6||rect.y<top||rect.y+h>bottom||occupied.some(other=>overlaps(rect,other,gap)))continue;
      result.set(label.id,{...rect,slot});occupied.push(rect);break;
    }
  }
  return result;
}
