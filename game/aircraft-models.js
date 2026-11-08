import * as THREE from '../vendor/three/three.module.js';
import {OrbitControls} from '../vendor/three/OrbitControls.js';
import {AIRCRAFT_MODELS} from '../three3d/aircraft-catalog.js';
import {loadAircraftModels,buildAircraft} from '../three3d/aircraft.js';
const canvas=document.querySelector('#models'),status=document.querySelector('#status');
try{
  await loadAircraftModels();const scene=new THREE.Scene(),renderer=new THREE.WebGLRenderer({canvas,antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setClearColor(0x08131c);renderer.outputColorSpace=THREE.SRGBColorSpace;
  const camera=new THREE.OrthographicCamera(),controls=new OrbitControls(camera,canvas);controls.enableDamping=true;controls.target.set(0,0,0);
  scene.add(new THREE.HemisphereLight(0xe0efff,0x263c50,2.4));const light=new THREE.DirectionalLight(0xffffff,2.8);light.position.set(-70,100,-80);scene.add(light);
  const grid=new THREE.GridHelper(240,24,0x2e5266,0x183242);grid.position.y=-6;scene.add(grid);
  const colors=['#5bff8a','#6fe3ff','#a2b8d1','#ffca77','#e5edf4'],models=new Map();let x=-88,view='top';
  for(const [i,[id,spec]]of Object.entries(AIRCRAFT_MODELS).entries()){
    const model=buildAircraft(colors[i],id);model.position.x=x+spec.wingspanM/2;scene.add(model);models.set(id,model);x+=spec.wingspanM+12;
    const option=document.createElement('option');option.value=id;option.textContent=spec.name;document.querySelector('#focus').append(option);
    const article=document.createElement('article');article.style.setProperty('--tint',colors[i]);article.innerHTML=`<h2>${spec.name}</h2><p>机长 ${spec.lengthM} m</p><p>翼展 ${spec.wingspanM} m</p><p>${model.userData.triangles.toLocaleString()} 三角面</p><p><a href="${spec.source}" target="_blank" rel="noopener">公开模型 / 授权 ↗</a></p>`;document.querySelector('#specs').append(article);
  }
  const focus=document.querySelector('#focus');
  function frameView(){
    const single=focus.value!=='all',model=models.get(focus.value),size=single?Math.max(model.userData.spec.lengthM,model.userData.spec.wingspanM)*1.35:210,target=new THREE.Vector3(single?model.position.x:0,0,0);
    for(const [id,item]of models)item.visible=!single||id===focus.value;
    const aspect=canvas.clientWidth/canvas.clientHeight,extent=single?Math.max(size/2,size/aspect/2):Math.max(48,110/aspect);camera.left=-extent*aspect;camera.right=extent*aspect;camera.top=extent;camera.bottom=-extent;camera.near=.1;camera.far=1500;
    camera.up.set(0,1,0);const direction=view==='top'?new THREE.Vector3(0,400,.001):view==='side'?new THREE.Vector3(400,0,0):new THREE.Vector3(150,220,260);camera.position.copy(target).add(direction);camera.lookAt(target);camera.updateProjectionMatrix();controls.target.copy(target);controls.update();
  }
  function resize(){renderer.setSize(canvas.clientWidth,canvas.clientHeight,false);frameView();}new ResizeObserver(resize).observe(canvas);resize();
  for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>{view=button.dataset.view;document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b===button));frameView();};focus.onchange=frameView;
  document.querySelector('#gear').onchange=e=>{for(const model of models.values())model.userData.gear.visible=e.target.checked;};
  status.textContent='5 款外观 · 模型已加载';canvas.dataset.loaded='true';
  renderer.setAnimationLoop(()=>{controls.update();renderer.render(scene,camera);});
}catch(error){status.textContent='加载失败：'+error.message;console.error(error);}
