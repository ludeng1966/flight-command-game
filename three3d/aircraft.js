import * as THREE from '../vendor/three/three.module.js';
import {AIRCRAFT_MODELS,aircraftModelId} from './aircraft-catalog.js';

const templates=new Map();let loading;
export function loadAircraftModels(fetcher=globalThis.fetch){
  return loading??=Promise.all([...new Set(Object.values(AIRCRAFT_MODELS).map(m=>m.asset))].map(async id=>{
    const response=await fetcher(new URL('../assets/aircraft/'+id+'.json',import.meta.url));
    if(!response.ok)throw Error('飞机模型加载失败：'+id);
    const data=await response.json();
    const groups=data.groups.map(part=>{
      const geometry=new THREE.BufferGeometry();
      geometry.setAttribute('position',new THREE.Float32BufferAttribute(part.positions,3));geometry.setIndex(part.indices);
      geometry.computeVertexNormals();geometry.computeBoundingBox();geometry.computeBoundingSphere();
      return {...part,geometry};
    });
    templates.set(id,{data,groups});
  })).catch(error=>{loading=null;throw error;});
}

// 所有外形使用同一个米制坐标系，局部 -Z 机头、+Y 机背；姿态仍由飞行内核驱动。
export function buildAircraft(color,unit='f16'){
  const id=aircraftModelId(unit),spec=AIRCRAFT_MODELS[id],template=templates.get(spec.asset);
  if(!template)throw Error('请先加载飞机模型：'+id);
  const root=new THREE.Group(),gear=new THREE.Group(),flame=new THREE.Group(),tint=new THREE.Color(color);
  const materialOptions={roughness:.72,metalness:.15,side:THREE.DoubleSide};
  const palette={
    body:new THREE.MeshStandardMaterial({...materialOptions,color:spec.body}),
    dark:new THREE.MeshStandardMaterial({...materialOptions,color:0x273b49,roughness:.58}),
    glass:new THREE.MeshStandardMaterial({...materialOptions,color:0x244453,metalness:.4,roughness:.22}),
    accent:new THREE.MeshStandardMaterial({...materialOptions,color:new THREE.Color(spec.body).lerp(tint,.34)})
  };
  root.add(gear,flame);gear.visible=false;flame.visible=false;
  for(const part of template.groups){
    const mesh=new THREE.Mesh(part.geometry,palette[part.material]);mesh.userData.sharedGeometry=true;
    (part.gear?gear:root).add(mesh);
  }
  // 客机不生成加力效果；双发战斗机使用两个喷口。
  for(const [x,y,z]of spec.engines){
    const jet=new THREE.Mesh(new THREE.ConeGeometry(.48,3.4,10),new THREE.MeshBasicMaterial({color:0xffb34f,transparent:true,opacity:.72,depthWrite:false}));
    jet.rotation.x=Math.PI/2;jet.position.set(x,y,z+1.7);flame.add(jet);
  }
  Object.assign(root.userData,{modelId:id,spec,gear,flame,materials:Object.values(palette),bounds:template.data.bounds,triangles:template.data.triangles});
  root.userData.baseColors=root.userData.materials.map(m=>m.color.clone());
  root.traverse(o=>{o.frustumCulled=false;});return root;
}

export function disposeAircraft(root){
  const geometries=new Set(),materials=new Set();
  root.traverse(o=>{if(o.geometry&&!o.userData.sharedGeometry)geometries.add(o.geometry);for(const m of Array.isArray(o.material)?o.material:o.material?[o.material]:[])materials.add(m);});
  geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());
}
