import * as THREE from '../vendor/three/three.module.js';
import {aircraftVisualScale} from './camera-tracking.js';
const states=new WeakMap();
// A shared track is a symbol, never an inferred aircraft type or live enemy pose.
export function updateDatalinkScene(scene,camera,canvas,snapshot){
  let state=states.get(scene);
  if(!state){
    const geometry=new THREE.BufferGeometry();
    for(const key of ['position','color'])geometry.setAttribute(key,new THREE.BufferAttribute(new Float32Array(128*8*3),3).setUsage(THREE.DynamicDrawUsage));
    const line=new THREE.LineSegments(geometry,new THREE.LineBasicMaterial({vertexColors:true,transparent:true,opacity:.85,depthTest:false,depthWrite:false}));line.frustumCulled=false;line.renderOrder=9;scene.add(line);
    state={line,geometry,right:new THREE.Vector3(),up:new THREE.Vector3(),point:new THREE.Vector3()};states.set(scene,state);
  }
  const own=snapshot.units.find(u=>u.id===snapshot.selectedId),contacts=own?.datalink?.contacts??[];
  const ownIds=new Set(snapshot.units.filter(u=>!u.visualizationOnly).map(u=>u.id));
  const {geometry,point,right,up}=state,p=geometry.getAttribute('position'),color=geometry.getAttribute('color');
  right.setFromMatrixColumn(camera.matrixWorld,0);up.setFromMatrixColumn(camera.matrixWorld,1);
  let count=0;const height=canvas.clientHeight;
  for(const c of contacts){
    if(c.kind==='participant'&&ownIds.has(c.sourceUnitId))continue;
    const age=Math.max(0,snapshot.time-c.observedAt);if(age>=12||count>=128)continue;
    point.set(c.position[0]+c.velocity[0]*age,c.position[2]+c.velocity[2]*age,-c.position[1]-c.velocity[1]*age);
    const size=aircraftVisualScale(camera,point,height,{pixels:24,lengthM:15})*7.5;
    const fade=Math.max(.2,1-age/12),rgb=c.quality==='coasting'?[.5,.55,.6]:[1,.76,.35];
    const corners=[[0,1],[1,0],[0,-1],[-1,0]];
    for(let i=0;i<4;i++)for(const corner of [corners[i],corners[(i+1)%4]]){
      const index=count*8+i*2+(corner===corners[i]?0:1);
      p.setXYZ(index,point.x+(right.x*corner[0]+up.x*corner[1])*size,point.y+(right.y*corner[0]+up.y*corner[1])*size,point.z+(right.z*corner[0]+up.z*corner[1])*size);
      color.setXYZ(index,rgb[0]*fade,rgb[1]*fade,rgb[2]*fade);
    }
    count++;
  }
  geometry.setDrawRange(0,count*8);p.needsUpdate=color.needsUpdate=true;state.line.visible=count>0;
}
