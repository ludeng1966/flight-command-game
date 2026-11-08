// node tools/fetch-aircraft-sources.mjs; npm install --prefix .game-server/model-tools meshoptimizer@1.3.0 earcut@3.2.4 three@0.186.0
// node tools/build-aircraft-models.mjs
import fs from 'node:fs/promises';
import {readAC3D,flattenAC3D} from './ac3d-model.mjs';
import {Vector3} from '../vendor/three/three.core.js';
async function buildDependency(name,file){
  const installed=new URL(`../.game-server/model-tools/node_modules/${name}/${file}`,import.meta.url),extracted=new URL(`../.game-server/model-tools/${name}/${file}`,import.meta.url);
  try{await fs.access(installed);return import(installed.href);}catch{return import(extracted.href);}
}
const {MeshoptSimplifier}=await buildDependency('meshoptimizer','meshopt_simplifier.js'),{default:earcut}=await buildDependency('earcut','src/earcut.js');
const {ConvexHull}=await buildDependency('three','examples/jsm/math/ConvexHull.js');
await MeshoptSimplifier.ready;
const base=new URL('../assets/aircraft/',import.meta.url);
const specs=[
  {id:'f16',files:['f16.ac','outlet.ac'],length:15.027,span:9.449,height:5.09,budget:4200,license:'GPL-2.0-or-later'},
  {id:'su27',files:['Su-27.ac','Gear.ac'],length:21.935,span:14.7,height:5.932,budget:4200,license:'GPL-3.0'},
  {id:'b7478',files:['747-8.ac','747-8i_gear.ac'],length:76.3,span:68.4,height:19.4,budget:6000,license:'GPL-2.0'},
  {id:'a320',files:['A320-216.ac','CFM56.ac'],length:37.57,span:34.1,height:11.76,budget:5200,license:'GPL-2.0'}
];
function classification(part,spec){
  const name=part.name,chain=[...part.ancestors,name].join('/');
  if(/placard|\.Inner|FrameInner|BackInside|ForwardInside|Actuator|Wiper|Sensor|Cable|Hinge|Mechanism|Torque|Nurbs|ULD|Static-Elements|Logos|Chute|flame|Afetrburner|HighSpeed|Spinning|Flash|PosLight|Formation|Strobe|Navglass|LightWing|Reverser.*Inner/i.test(chain))return null;
  if(spec.id==='f16'&&/RNLAF|LWStation|RWStation|Link16/.test(name))return null;
  if(spec.id==='a320'&&/Sharklet|RatSpinner|^Rat$/.test(name))return null;
  if(spec.id==='b7478'&&/lav\d|fuselage_in|cabinlighting|cockpitdoor/i.test(chain))return null;
  if(spec.id==='b7478'&&/cockpitshell/i.test(chain)&&!part.faces.some(f=>/glass/i.test(part.materials[f.mat]?.name??'')))return null;
  const gear=part.forceGear||/LandingGear|Strut|Tire|Wheel|MLGFitting|NLGFitting|SlidingTube|LockStay|SlaveLink/i.test(chain)&&!/Door/.test(name);
  const material=/glass|window|Canopy.*Outside|Windshei|Windsh/i.test(name)?'glass':/nozzle|outlet|exhaust|intake|^fan|blades|^pin_|turbine|Tire|Wheel/i.test(name)?'dark':/rudder|vstab|^tail$|TF_|WingTips|WingtipFence/i.test(name)?'accent':'body';
  return {gear,material};
}
function bounds(parts){const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];for(const p of parts)for(const v of p.vertices)for(let k=0;k<3;k++){min[k]=Math.min(min[k],v[k]);max[k]=Math.max(max[k],v[k]);}return {min,max,size:max.map((v,k)=>v-min[k])};}
function closeStaticWings(parts,spec){
  const pattern=spec.id==='a320'?/^(Wings$|Slat[LR]|Aileron[LR]|Flap[LR]|Spoiler[LR])/:/^(wing|slat|doubleflaps|external_flap|aileron|speedbrake|flap_compart)/i;
  const wings=parts.filter(p=>pattern.test(p.name));
  const result=parts.filter(p=>!wings.includes(p));
  for(const side of [-1,1]){
    const points=wings.flatMap(p=>p.vertices).filter(v=>v[2]*side>=-.001).map(v=>new Vector3(...v)),hull=new ConvexHull().setFromPoints(points),vertices=[],faces=[],index=new Map();
    for(const face of hull.faces){const refs=[];let edge=face.edge;do{const point=edge.head().point;if(!index.has(point)){index.set(point,vertices.length);vertices.push([point.x,point.y,point.z]);}refs.push(index.get(point));edge=edge.next;}while(edge!==face.edge);faces.push({mat:0,refs});}
    result.push({name:'StaticWing'+side,vertices,faces,gear:false,material:'body',materials:[{name:'body'}]});
  }
  return result;
}
function triangulate(vertices,refs){
  if(refs.length===3)return refs;
  const a=vertices[refs[0]];let normal=[0,0,0];
  for(let j=1;j<refs.length-1;j++){const b=vertices[refs[j]].map((v,k)=>v-a[k]),c=vertices[refs[j+1]].map((v,k)=>v-a[k]);normal=[b[1]*c[2]-b[2]*c[1],b[2]*c[0]-b[0]*c[2],b[0]*c[1]-b[1]*c[0]];if(Math.hypot(...normal)>1e-9)break;}
  const drop=normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs))),axes=[0,1,2].filter(k=>k!==drop),flat=refs.flatMap(i=>axes.map(k=>vertices[i][k]));
  const tris=earcut(flat),out=[];
  // Earcut may reverse winding; align each result with the original polygon normal.
  for(let j=0;j<tris.length;j+=3){const tri=tris.slice(j,j+3).map(i=>refs[i]),p=vertices[tri[0]],b=vertices[tri[1]].map((v,k)=>v-p[k]),c=vertices[tri[2]].map((v,k)=>v-p[k]);const n=[b[1]*c[2]-b[2]*c[1],b[2]*c[0]-b[0]*c[2],b[0]*c[1]-b[1]*c[0]];if(n.reduce((s,v,k)=>s+v*normal[k],0)<0)[tri[1],tri[2]]=[tri[2],tri[1]];out.push(...tri);}
  return out;
}
const report=[];
for(const spec of specs){
  let parts=[];
  for(const file of spec.files){const source=readAC3D(await fs.readFile(new URL(`sources/${spec.id}/${file}`,base),'utf8'));for(const part of flattenAC3D(source.root)){part.forceGear=/gear/i.test(file);part.materials=source.materials;const group=classification(part,spec);if(group)parts.push({...part,...group});}}
  const sourceTriangles=parts.reduce((s,p)=>s+p.faces.reduce((n,f)=>n+f.refs.length-2,0),0);
  // 原缝翼、襟翼留有动画接缝，静态策略模型用原顶点的闭合凸包合并每侧翼面。
  if(spec.id==='a320'||spec.id==='b7478')parts=closeStaticWings(parts,spec);
  const raw=bounds(parts),scales=[spec.length/raw.size[0],spec.height/raw.size[1],spec.span/raw.size[2]],center=[(raw.min[0]+raw.max[0])/2,0,(raw.min[2]+raw.max[2])/2];
  // FlightGear source: +X nose, +Y up. Game: -Z nose, +Y up, +X right.
  for(const part of parts)part.vertices=part.vertices.map(v=>[(v[2]-center[2])*scales[2],v[1]*scales[1],-(v[0]-center[0])*scales[0]]);
  const groups=new Map();let input=0;
  for(const part of parts){
    const byMaterial=new Map();for(const face of part.faces){const material=/glass/i.test(part.materials[face.mat]?.name??'')?'glass':part.material;if(!byMaterial.has(material))byMaterial.set(material,[]);byMaterial.get(material).push(face);}
    for(const [material,faces]of byMaterial){const key=`${part.gear?'gear':'body'}:${material}`;if(!groups.has(key))groups.set(key,{gear:part.gear,material,vertices:[],indices:[]});const group=groups.get(key),offset=group.vertices.length;group.vertices.push(...part.vertices);for(const face of faces){const tri=triangulate(part.vertices,face.refs);group.indices.push(...tri.map(i=>i+offset));input+=tri.length/3;}}
  }
  const output=[];
  for(const group of groups.values()){
    const positions=new Float32Array(group.vertices.flat()),indices=new Uint32Array(group.indices),target=Math.max(30,Math.floor(spec.budget*indices.length/(input*3))*3);
    const [reduced,error]=MeshoptSimplifier.simplify(indices,positions,3,Math.min(indices.length,target),.008,['LockBorder']);
    const used=new Map(),vertices=[],index=[];for(const old of reduced){if(!used.has(old)){used.set(old,used.size);vertices.push(...group.vertices[old].map(v=>+v.toFixed(4)));}index.push(used.get(old));}
    output.push({gear:group.gear,material:group.material,positions:vertices,indices:index,error});
  }
  const measured=bounds(output.map(g=>({vertices:Array.from({length:g.positions.length/3},(_,i)=>g.positions.slice(i*3,i*3+3))}))),result={id:spec.id,units:'meters',forward:'-Z',up:'+Y',license:spec.license,dimensions:{lengthM:spec.length,wingspanM:spec.span,heightM:spec.height},bounds:measured,sourceTriangles,triangles:output.reduce((s,g)=>s+g.indices.length/3,0),groups:output};
  await fs.writeFile(new URL(spec.id+'.json',base),JSON.stringify(result));report.push({id:spec.id,sourceTriangles,triangles:result.triangles,bytes:JSON.stringify(result).length,sourceSize:raw.size,dimensions:result.dimensions,actualSize:measured.size});
}
await fs.writeFile(new URL('build-report.json',base),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
