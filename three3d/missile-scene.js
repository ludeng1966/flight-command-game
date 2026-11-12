import * as THREE from 'three';
const states=new WeakMap(),point=p=>new THREE.Vector3(p[0],p[2],-p[1]);
const forwardAxis=new THREE.Vector3(0,1,0);
export function updateMissileScene(scene,camera,canvas,snapshot){
  let state=states.get(scene);if(!state){state=new Map();states.set(scene,state);}
  const ids=new Set();
  for(const m of snapshot.missiles??[]){ids.add(m.id);let item=state.get(m.id);
    if(!item){
      // Screen-sized pointed markers remain legible at tactical map scale.
      const marker=new THREE.Mesh(new THREE.ConeGeometry(.55,2.8,6),new THREE.MeshBasicMaterial({color:'#ffc97d',depthTest:false,depthWrite:false,transparent:true}));marker.renderOrder=10;
      const ring=new THREE.Mesh(new THREE.RingGeometry(1.35,1.6,24),new THREE.MeshBasicMaterial({color:'#ff5a66',depthTest:false,depthWrite:false,transparent:true,side:THREE.DoubleSide}));ring.renderOrder=9;
      const positions=new Float32Array(240*3),geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
      const trail=new THREE.Line(geometry,new THREE.LineBasicMaterial({color:'#ffc97d',transparent:true,opacity:.65,depthTest:false,depthWrite:false}));trail.frustumCulled=false;trail.renderOrder=8;
      const label=document.createElement('div');label.className='ac-label missile-label';label.textContent='导弹 · RWR';label.style.color='#ff5a66';label.style.pointerEvents='none';label.hidden=true;(canvas.parentNode.querySelector('.ac-labels')??canvas.parentNode).appendChild(label);
      scene.add(marker,ring,trail);item={marker,ring,trail,label};state.set(m.id,item);
    }
    const warning=m.source==='rwr',opacity=m.opacity??(m.alive?1:Math.max(0,1-(snapshot.time-m.endedAt)/15));
    const color=warning?'#ff5a66':m.phase==='hit'?'#f4efcf':m.phase==='lost'?'#8a9b96':'#ffc97d';
    const pos=point(m.position);item.marker.position.copy(pos);item.ring.position.copy(pos);
    const pixelsPerMeter=canvas.clientHeight/(2*Math.max(1,camera.position.distanceTo(pos))*Math.tan(camera.fov*Math.PI/360));
    const scale=Math.max(1,(warning?4.5:3.5)/Math.max(.0001,pixelsPerMeter));
    item.marker.scale.setScalar(scale);item.marker.visible=(m.alive||m.phase==='hit')&&opacity>0;
    const direction=point(m.velocity??m.forward??[0,1,0]).normalize();
    if(direction.lengthSq()>0)item.marker.quaternion.setFromUnitVectors(forwardAxis,direction);
    item.marker.material.color.set(color);item.marker.material.opacity=opacity;
    item.ring.scale.setScalar(scale);item.ring.quaternion.copy(camera.quaternion);item.ring.visible=warning&&opacity>0;
    item.ring.material.opacity=opacity*(.45+.15*Math.sin(snapshot.time*7));
    const projected=pos.clone().project(camera),label=item.label;
    label.hidden=!warning||opacity<=0||projected.z< -1||projected.z>1||Math.abs(projected.x)>1||Math.abs(projected.y)>1;
    label.style.opacity=String(opacity);label.textContent=m.phase==='coasting'?'导弹 · 信号记忆':'导弹 · RWR';
    label.style.transform=`translate(${(projected.x*.5+.5)*canvas.clientWidth+12}px,${(-projected.y*.5+.5)*canvas.clientHeight-9}px)`;
    const points=(m.trail??[]).slice(-240),attr=item.trail.geometry.attributes.position;
    points.forEach((p,i)=>attr.setXYZ(i,p[0],p[2],-p[1]));attr.needsUpdate=true;item.trail.geometry.setDrawRange(0,points.length);
    item.trail.material.color.set(color);item.trail.material.opacity=.65*opacity;item.trail.visible=opacity>0&&points.length>1;
  }
  for(const [id,item]of state)if(!ids.has(id)){for(const o of [item.marker,item.ring,item.trail]){scene.remove(o);o.geometry.dispose();o.material.dispose();}item.label.remove();state.delete(id);}
}
