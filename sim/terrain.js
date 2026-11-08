import {formatAltitude} from './units.js';
export class TerrainHeight {
  constructor(meta,heights){this.meta=meta;this.heights=heights;this.clearance=100;}
  static async load(base){
    const r=await fetch(`${base}_height.json`);if(!r.ok)throw Error('地形高度数据加载失败');
    const meta=await r.json(),data=await fetch(`${base}_height.f32`);
    if(!data.ok)throw Error('地形高度栅格加载失败');
    return new TerrainHeight(meta,new Float32Array(await data.arrayBuffer()));
  }
  heightAt(x,y){
    const m=this.meta,fx=(x-m.originEast)/m.step,fy=(y-m.originNorth)/m.step;
    if(fx<0||fy<0||fx>m.width-1||fy>m.height-1)return null;
    const i=Math.min(m.width-2,Math.floor(fx)),j=Math.min(m.height-2,Math.floor(fy)),a=fx-i,b=fy-j;
    const h=(dx,dy)=>this.heights[(j+dy)*m.width+i+dx];
    return Math.max(m.waterLevel,(h(0,0)*(1-a)+h(1,0)*a)*(1-b)+(h(0,1)*(1-a)+h(1,1)*a)*b);
  }
  checkPoint(p,clearance=this.clearance){
    const ground=this.heightAt(p[0],p[1]);
    if(ground===null)return {valid:false,reason:'航点超出地形范围',ground:null};
    const agl=p[2]-ground;
    return {valid:agl>=clearance,reason:agl>=clearance?'':`离地 ${formatAltitude(agl)}，需至少 ${formatAltitude(clearance)}`,ground,agl};
  }
  checkSegment(a,b,clearance=this.clearance){
    const n=Math.max(1,Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/(this.meta.step*.5)));
    for(let i=0;i<=n;i++){
      const t=i/n,p=a.map((v,k)=>v+(b[k]-v)*t),check=this.checkPoint(p,clearance);
      if(!check.valid)return {...check,reason:`航段穿越地形：${check.reason}`,point:p};
    }
    return {valid:true,reason:''};
  }
  checkRoute(origin,points){
    let last=origin;
    for(let i=0;i<points.length;i++){
      const check=this.checkSegment(last,points[i]);
      if(!check.valid)return {...check,index:i};
      last=points[i];
    }
    return {valid:true,reason:''};
  }
  collision(a,b){
    const steps=Math.max(1,Math.ceil(Math.hypot(...b.map((v,i)=>v-a[i]))/(this.meta.step*.25)));
    for(let i=1;i<=steps;i++){
      const t=i/steps,p=a.map((v,k)=>v+(b[k]-v)*t),h=this.heightAt(p[0],p[1]);
      if(h!==null&&p[2]<=h){
        let lo=(i-1)/steps,hi=t;
        for(let k=0;k<15;k++){const mid=(lo+hi)/2,q=a.map((v,j)=>v+(b[j]-v)*mid);if(q[2]>(this.heightAt(q[0],q[1])??-Infinity))lo=mid;else hi=mid;}
        const hit=a.map((v,k)=>v+(b[k]-v)*hi);hit[2]=this.heightAt(hit[0],hit[1]);return hit;
      }
    }
    return null;
  }
}
