import * as THREE from 'three';
import {buildAircraft} from './aircraft.js';
import {aircraftVisualScale} from './camera-tracking.js';
const scenes=new WeakMap(),point=p=>new THREE.Vector3(p[0],p[2],-p[1]);
export function updateRadarScene(scene,camera,canvas,snapshot){
  let state=scenes.get(scene);
  if(!state){
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(new Float32Array(6),3));
    const line=new THREE.Line(geometry,new THREE.LineBasicMaterial({color:'#f3cc85',transparent:true,opacity:.5,depthTest:false}));line.frustumCulled=false;line.renderOrder=8;scene.add(line);
    state={targets:new Map(),line};scenes.set(scene,state);
  }
  const alive=new Set();
  for(const target of snapshot.radarTargets??[]){
    if(target.alive===false)continue;alive.add(target.id);
    let model=state.targets.get(target.id);if(!model){model=buildAircraft('#f5bc7a');model.userData.radarTargetId=target.id;scene.add(model);state.targets.set(target.id,model);}
    const pos=point(target.position),forward=point(target.velocity).normalize(),right=new THREE.Vector3().crossVectors(forward,new THREE.Vector3(0,1,0)).normalize(),up=new THREE.Vector3().crossVectors(right,forward).normalize();
    model.position.copy(pos);model.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right,up,forward.negate()));model.scale.setScalar(aircraftVisualScale(camera,pos,canvas.clientHeight));model.userData.gear.visible=false;
  }
  for(const [id,model]of state.targets)if(!alive.has(id)){scene.remove(model);const disposed=new Set();model.traverse(o=>{for(const item of [o.geometry,...(Array.isArray(o.material)?o.material:[o.material])])if(item&&!disposed.has(item)){disposed.add(item);item.dispose();}});state.targets.delete(id);}
  const own=snapshot.units.find(u=>u.id===snapshot.selectedId),r=own?.radar,track=r?.contacts.find(c=>c.id===r.targetId);
  state.line.visible=!!track;
  if(track){const a=point(own.position),b=point(track.predictedPosition),p=state.line.geometry.attributes.position;p.setXYZ(0,a.x,a.y,a.z);p.setXYZ(1,b.x,b.y,b.z);p.needsUpdate=true;state.line.material.color.set(r.phase==='coasting'?'#8c9b96':r.phase==='locked'?'#ffd08a':'#88bde5');}
}
