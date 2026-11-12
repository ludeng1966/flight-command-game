import * as THREE from 'three';
import {rwrDisplayContacts} from '../sim/rwr-display.js';

const states=new WeakMap(),point=p=>new THREE.Vector3(p[0],p[2],-p[1]);
const priority={search:0,track:1,launch:2};
// Direction ticks remain close to the receiver; no world-space emitter endpoint
// is available here. All ticks have the same display radius regardless of level.
export function updateRwrScene(scene,camera,canvas,snapshot){
  let items=states.get(scene);if(!items){items=new Map();states.set(scene,items);}
  const own=snapshot.units?.find(unit=>unit.id===snapshot.selectedId);
  const contacts=rwrDisplayContacts(own,snapshot.time).slice(0,3),seen=new Set();
  for(const contact of contacts){
    const id=own.id+':'+contact.id;seen.add(id);let item=items.get(id);
    if(!item){
      const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(new Float32Array(38*3),3));
      const line=new THREE.LineSegments(geometry,new THREE.LineBasicMaterial({color:contact.color,transparent:true,depthTest:false,depthWrite:false}));
      line.frustumCulled=false;scene.add(line);
      const arrowGeometry=new THREE.BufferGeometry();arrowGeometry.setAttribute('position',new THREE.Float32BufferAttribute(new Float32Array(9),3));
      const arrow=new THREE.Mesh(arrowGeometry,new THREE.MeshBasicMaterial({color:contact.color,transparent:true,depthTest:false,depthWrite:false,side:THREE.DoubleSide}));
      arrow.frustumCulled=false;scene.add(arrow);
      item={line,arrow};items.set(id,item);
    }
    // Collinear signals share a marker. Draw the higher warning last so a
    // search/track mark cannot cover an active-seeker or launch warning.
    item.line.renderOrder=9+priority[contact.level]*2;
    item.arrow.renderOrder=item.line.renderOrder+1;
    const pos=point(own.position),pixelsPerMeter=canvas.clientHeight/(2*Math.max(1,camera.position.distanceTo(pos))*Math.tan(camera.fov*Math.PI/360));
    const metersPerPixel=1/Math.max(.0001,pixelsPerMeter),radius=42*metersPerPixel,angle=contact.bearingDeg*Math.PI/180,half=7.5*Math.PI/180,attribute=item.line.geometry.attributes.position;
    const vertex=(index,a,r)=>attribute.setXYZ(index,pos.x+Math.sin(a)*r,pos.y,pos.z-Math.cos(a)*r);
    let count=0;for(let step=0;step<16;step++){vertex(count++,angle-half+half*2*step/16,radius);vertex(count++,angle-half+half*2*(step+1)/16,radius);}
    for(const a of [angle-half,angle,angle+half]){vertex(count++,a,radius*.92);vertex(count++,a,radius*1.08);}
    attribute.needsUpdate=true;item.line.geometry.setDrawRange(0,count);item.line.material.color.set(contact.color);item.line.material.opacity=contact.opacity*.85;
    const arrow=item.arrow.geometry.attributes.position,forward=[Math.sin(angle),-Math.cos(angle)],right=[Math.cos(angle),Math.sin(angle)];
    arrow.setXYZ(0,pos.x+forward[0]*32*metersPerPixel,pos.y,pos.z+forward[1]*32*metersPerPixel);
    for(let side=0;side<2;side++){const sign=side?1:-1;arrow.setXYZ(side+1,pos.x+(forward[0]*20+right[0]*sign*4)*metersPerPixel,pos.y,pos.z+(forward[1]*20+right[1]*sign*4)*metersPerPixel);}
    arrow.needsUpdate=true;item.arrow.material.color.set(contact.color);item.arrow.material.opacity=contact.opacity;
  }
  for(const [id,item]of items)if(!seen.has(id)){for(const object of [item.line,item.arrow]){scene.remove(object);object.geometry.dispose();object.material.dispose();}items.delete(id);}
}
