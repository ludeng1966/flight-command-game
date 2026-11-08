import * as THREE from '../vendor/three/three.module.js';
import {buildAircraft} from './aircraft.js';
// Render the same mesh as the map once; the rail uses static images, not extra render loops.
export function aircraftPortraits(units){
  const canvas=document.createElement('canvas'),renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:true,preserveDrawingBuffer:true});
  renderer.setPixelRatio(1);renderer.setSize(128,128,false);renderer.setClearColor(0x000000,0);
  const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(-8.8,8.8,8.8,-8.8,.1,100);
  camera.position.set(10,13,-18);camera.lookAt(0,.4,-1.4);
  scene.add(new THREE.HemisphereLight(0xe2f0ff,0x263c50,2.4));
  const light=new THREE.DirectionalLight(0xffffff,2.6);light.position.set(-8,12,-12);scene.add(light);
  const images=new Map(),cache=new Map();
  try{for(const unit of units){
    const key=(unit.profile?.name??'')+':'+unit.color;
    if(!cache.has(key)){
      const model=buildAircraft(unit.color);scene.add(model);renderer.render(scene,camera);cache.set(key,canvas.toDataURL('image/png'));scene.remove(model);
      const geometries=new Set(),materials=new Set();model.traverse(o=>{if(o.geometry)geometries.add(o.geometry);for(const m of Array.isArray(o.material)?o.material:o.material?[o.material]:[])materials.add(m);});
      geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());
    }
    images.set(unit.id,cache.get(key));
  }}finally{renderer.dispose();}
  return images;
}
