import * as THREE from 'three';
const states=new WeakMap(),point=p=>new THREE.Vector3(p[0],p[2],-p[1]);
export function updateMissileScene(scene,camera,canvas,snapshot){
  let state=states.get(scene);if(!state){state=new Map();states.set(scene,state);}
  const ids=new Set();
  for(const m of snapshot.missiles??[]){ids.add(m.id);let item=state.get(m.id);
    if(!item){
      const marker=new THREE.Mesh(new THREE.SphereGeometry(1,8,6),new THREE.MeshBasicMaterial({color:'#ffc97d',depthTest:false}));marker.renderOrder=9;
      const positions=new Float32Array(240*3),geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
      const trail=new THREE.Line(geometry,new THREE.LineBasicMaterial({color:'#ffc97d',transparent:true,opacity:.65}));trail.frustumCulled=false;
      scene.add(marker,trail);item={marker,trail};state.set(m.id,item);
    }
    const pos=point(m.position);item.marker.position.copy(pos);
    const pixelsPerMeter=canvas.clientHeight/(2*Math.max(1,camera.position.distanceTo(pos))*Math.tan(camera.fov*Math.PI/360));
    item.marker.scale.setScalar(Math.max(1,3/Math.max(.0001,pixelsPerMeter)));item.marker.visible=m.alive||m.phase==='hit';
    item.marker.material.color.set(m.phase==='hit'?'#f4efcf':m.phase==='lost'?'#8a9b96':'#ffc97d');
    const points=m.trail.slice(-240),attr=item.trail.geometry.attributes.position;
    points.forEach((p,i)=>attr.setXYZ(i,p[0],p[2],-p[1]));attr.needsUpdate=true;item.trail.geometry.setDrawRange(0,points.length);
    item.trail.material.opacity=m.alive ? .65 : Math.max(0,.65*(1-(snapshot.time-m.endedAt)/15));
  }
  for(const [id,item]of state)if(!ids.has(id)){for(const o of [item.marker,item.trail]){scene.remove(o);o.geometry.dispose();o.material.dispose();}state.delete(id);}
}
