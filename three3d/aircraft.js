import * as THREE from 'three';

// 米制简模，局部 -Z 为机头、+Y 为机背。只随飞行内核姿态转动，无独立舵面模拟。
export function buildAircraft(color){
  const root=new THREE.Group(),tint=new THREE.Color(color);
  const upper=new THREE.MeshStandardMaterial({color:0xb7c9d8,roughness:.7,metalness:.25,flatShading:true});
  const lower=new THREE.MeshStandardMaterial({color:0x304759,roughness:.8,flatShading:true});
  const accent=new THREE.MeshStandardMaterial({color:tint,emissive:tint,emissiveIntensity:.3,roughness:.6});
  const dark=new THREE.MeshStandardMaterial({color:0x102635,roughness:.28,metalness:.6});
  const mesh=(geo,material,pos=[0,0,0])=>{const m=new THREE.Mesh(geo,material);m.position.set(...pos);root.add(m);return m;};
  const body=mesh(new THREE.CylinderGeometry(.5,.8,10.7,10),upper,[0,0,-.3]);body.rotation.x=Math.PI/2;
  const nose=mesh(new THREE.ConeGeometry(.5,3.2,10),upper,[0,0,-7.2]);nose.rotation.x=-Math.PI/2;
  const engine=mesh(new THREE.CylinderGeometry(.62,.72,1.2,12),lower,[0,0,5.5]);engine.rotation.x=Math.PI/2;
  mesh(new THREE.SphereGeometry(1,12,8),dark,[0,.64,-3.2]).scale.set(.5,.48,1.5);
  function surface(outline,thickness,material){
    const shape=new THREE.Shape();outline.forEach(([x,z],i)=>i?shape.lineTo(x,-z):shape.moveTo(x,-z));shape.closePath();
    const geo=new THREE.ExtrudeGeometry(shape,{depth:thickness,bevelEnabled:false});geo.rotateX(-Math.PI/2);geo.translate(0,-thickness/2,0);return mesh(geo,material);
  }
  for(const side of [-1,1]){
    surface([[side*.55,-2],[side*4.72,1.1],[side*4.72,2.2],[side*.55,2.6]],.18,upper);
    surface([[side*.48,3],[side*2.8,4.7],[side*2.8,5.5],[side*.48,5.3]],.16,lower);
    mesh(new THREE.BoxGeometry(.18,.22,1.4),accent,[side*4.72,0,1.5]);
  }
  const fin=new THREE.BufferGeometry();fin.setAttribute('position',new THREE.Float32BufferAttribute([0,.3,2,0,2.7,4.7,0,.3,5.6],3));fin.computeVertexNormals();
  const finMat=accent.clone();finMat.side=THREE.DoubleSide;mesh(fin,finMat);
  const intake=mesh(new THREE.SphereGeometry(1,10,6),lower,[0,-.65,-1.4]);intake.scale.set(.68,.5,1.8);
  const flame=mesh(new THREE.ConeGeometry(.55,4,12),new THREE.MeshBasicMaterial({color:0xffb34f,transparent:true,opacity:.75,depthWrite:false}),[0,0,8]);flame.rotation.x=Math.PI/2;flame.visible=false;
  root.userData.flame=flame;root.userData.materials=[upper,lower,accent,dark,finMat];
  const gear=new THREE.Group();root.add(gear);root.userData.gear=gear;gear.visible=false;
  for(const [x,z]of [[0,-4],[-1.5,1],[1.5,1]]){const strut=new THREE.Mesh(new THREE.CylinderGeometry(.07,.07,.65,6),upper);strut.position.set(x,-1,z);gear.add(strut);const wheel=new THREE.Mesh(new THREE.CylinderGeometry(.3,.3,.18,10),dark);wheel.rotation.z=Math.PI/2;wheel.position.set(x,-1.3,z);gear.add(wheel);}
  root.userData.baseColors=root.userData.materials.map(m=>m.color.clone());
  root.traverse(o=>{o.frustumCulled=false;});return root;
}
