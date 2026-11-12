// 空域标准：北约 / FAA 两套简化数据。坐标是世界平面米（x=东，y=北）。
// 这是项目内简化空域，不是真实航图；仅用于指挥与训练。
export const AIRSPACE_STANDARD_IDS = Object.freeze(['faa', 'nato']);
export const AIRSPACE_STANDARD_LABELS = Object.freeze({faa: 'FAA', nato: '北约'});

export const AIRSPACE_STANDARDS = Object.freeze({
  faa: Object.freeze([
    {id:'BAY-B', name:'BAY Class B', type:'Class B', color:'#7fb2ff', floorM:0, ceilingM:3600, center:[-18000,0], radiusM:18000},
    {id:'BAY-C', name:'BAY Class C', type:'Class C', color:'#8fd0ff', floorM:0, ceilingM:2400, center:[-18000,0], radiusM:30000},
    {id:'BAY-D', name:'BAY Class D', type:'Class D', color:'#9de8bb', floorM:0, ceilingM:900, center:[-18000,0], radiusM:8000},
    {id:'BAY-MOA', name:'BAY MOA', type:'MOA', color:'#e4c77e', floorM:1500, ceilingM:9000,
      polygon:[[-30000,12000],[-12000,18000],[4000,12000],[-8000,-2000]]},
    {id:'R-2501', name:'R-2501 禁飞区', type:'Restricted', color:'#ff8e8e', floorM:0, ceilingM:12000,
      polygon:[[22000,-12000],[30000,-5000],[28000,4000],[20000,-2000]]}
  ]),
  nato: Object.freeze([
    {id:'BAY-CTR', name:'BAY CTR', type:'CTR', color:'#7fb2ff', floorM:0, ceilingM:2400, center:[-18000,0], radiusM:9000},
    {id:'BAY-TMA', name:'BAY TMA', type:'TMA', color:'#8fd0ff', floorM:900, ceilingM:7500, center:[-18000,0], radiusM:32000},
    {id:'BAY-TSA', name:'BAY 临时隔离区', type:'TSA', color:'#e4c77e', floorM:0, ceilingM:9000,
      polygon:[[-30000,12000],[-12000,18000],[4000,12000],[-8000,-2000]]},
    {id:'BAY-LF', name:'北部低空航路', type:'LowLevel', color:'#9de8bb', floorM:300, ceilingM:1500,
      polygon:[[-22000,20000],[-14000,30000],[-6000,20000],[-10000,8000]]}
  ])
});

export function isAirspaceStandard(id){return AIRSPACE_STANDARD_IDS.includes(id);}

export function airspaceZones(standard){return AIRSPACE_STANDARDS[standard]??[];}

function insidePolygon(point,polygon){
  let inside=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const [xi,yi]=polygon[i],[xj,yj]=polygon[j];
    if(((yi>point[1])!==(yj>point[1]))&&(point[0]<(xj-xi)*(point[1]-yi)/(yj-yi)+xi))inside=!inside;
  }
  return inside;
}
function insideZone(point,zone){
  if(zone.radiusM!=null)return Math.hypot(point[0]-zone.center[0],point[1]-zone.center[1])<=zone.radiusM;
  return Array.isArray(zone.polygon)&&insidePolygon(point,zone.polygon);
}
// 返回该点/高度所在的空域（可多层）。point=[east,north,alt]。
export function airspaceAt(standard,point){
  if(!point||!Number.isFinite(point[0])||!Number.isFinite(point[1]))return [];
  const altitude=Number.isFinite(point[2])?point[2]:0;
  return airspaceZones(standard).filter(zone=>altitude>=zone.floorM&&altitude<=zone.ceilingM&&insideZone(point,zone));
}

export function airspaceContext(world,unit){
  const standard=world?.airspaceStandard??'faa';
  const zones=airspaceAt(standard,unit?.position??[0,0,0]);
  return {standard,zones:zones.map(({id,name,type})=>({id,name,type}))};
}
