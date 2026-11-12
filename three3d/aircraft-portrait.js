import * as THREE from '../vendor/three/three.module.js';
import {buildAircraft,disposeAircraft} from './aircraft.js';
import {aircraftModelId,AIRCRAFT_MODELS} from './aircraft-catalog.js';
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
    const id=aircraftModelId(unit),key=id+':'+unit.color;
    if(!cache.has(key)){
      const size=Math.max(AIRCRAFT_MODELS[id].lengthM,AIRCRAFT_MODELS[id].wingspanM),extent=size*.59;
      camera.left=camera.bottom=-extent;camera.right=camera.top=extent;camera.far=size*8;camera.position.set(size*.7,size*.9,-size*1.2);camera.lookAt(0,0,0);camera.updateProjectionMatrix();
      const model=buildAircraft(unit.color,unit);scene.add(model);renderer.render(scene,camera);cache.set(key,canvas.toDataURL('image/png'));scene.remove(model);disposeAircraft(model);
    }
    images.set(unit.id,cache.get(key));
  }}finally{renderer.dispose();renderer.forceContextLoss();}
  return images;
}
