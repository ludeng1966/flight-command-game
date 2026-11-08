// 轮换固定缓冲，对完整路径交叉淡化，不把两个安全路径插值成未经验证的中间航迹。
export class PathFade{
  constructor(create,write){this.write=write;this.slots=Array.from({length:3},()=>({object:create(),points:null,weight:0,target:0}));this.points=null;}
  set(points){
    if(points===this.points)return;this.points=points;
    this.slots.forEach(slot=>slot.target=0);
    if(!points?.length)return;
    let slot=this.slots.find(slot=>slot.points===points);
    if(!slot){
      slot=this.slots.reduce((a,b)=>a.weight<b.weight?a:b);
      // 极密集回包时回收最淡的一层，把微小亮度余量交给仍可见的旧层。
      const carry=slot.weight,others=this.slots.filter(s=>s!==slot),sum=others.reduce((n,s)=>n+s.weight,0);
      if(carry&&sum)others.forEach(s=>s.weight+=carry*s.weight/sum);
      slot.weight=0;slot.points=points;this.write(slot.object,points);
    }
    slot.target=1;
  }
  clear(immediate=false){this.set(null);if(immediate)this.slots.forEach(slot=>{slot.weight=0;slot.object.visible=false;});}
  frame(dt,opacity=1,reduced=false){
    const alpha=reduced?1:1-Math.exp(-Math.max(0,dt)/.06);
    for(const slot of this.slots){
      slot.weight+=(slot.target-slot.weight)*alpha;if(Math.abs(slot.weight-slot.target)<.0001)slot.weight=slot.target;
      slot.object.material.opacity=opacity*slot.weight;slot.object.visible=slot.object.material.opacity>.001;
    }
  }
}
