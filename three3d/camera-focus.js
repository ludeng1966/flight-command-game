import {Vector3,MathUtils} from '../vendor/three/three.core.js';

export const CAMERA_DISTANCE={min:100,max:180000};
export function cameraMotionScale(distance){
  return {rotate:MathUtils.clamp(Math.sqrt(distance/24000)*.6,.16,.6),move:MathUtils.clamp(distance*.35,5,14000)};
}

// 只调整观察深度，不把相机突然转向鼠标旁的命中点。
export function focusAtVisibleDepth(camera,controls,point,{onlyNearer=false}={}){
  if(!point)return false;
  const forward=camera.getWorldDirection(new Vector3()),distance=camera.position.distanceTo(controls.target);
  const depth=new Vector3().subVectors(point,camera.position).dot(forward);
  if(!Number.isFinite(depth)||depth<=0||onlyNearer&&depth>=distance)return false;
  // 空白背景或远处地面不能把近景观察中心一下拉回远处。
  const next=Math.max(CAMERA_DISTANCE.min,Math.min(depth,distance*1.5,CAMERA_DISTANCE.max));
  controls.target.copy(camera.position).addScaledVector(forward,next);
  controls.update();return true;
}

export function terrainFocusPoint(ray,terrain,maxDistance=CAMERA_DISTANCE.max){
  if(!terrain)return null;
  const step=Math.max(30,(terrain.meta?.step??240)*.5),point=new Vector3();
  let previous=null;
  for(let distance=0;distance<=maxDistance;distance+=step){
    ray.at(distance,point);const ground=terrain.heightAt(point.x,-point.z);
    if(ground===null){previous=null;continue;}
    const above=point.y-ground;
    if(above<=0&&previous!==null){
      let lo=previous,hi=distance;
      for(let i=0;i<14;i++){const mid=(lo+hi)/2;ray.at(mid,point);const h=terrain.heightAt(point.x,-point.z);if(h!==null&&point.y<=h)hi=mid;else lo=mid;}
      return ray.at((lo+hi)/2,new Vector3());
    }
    previous=above>0?distance:null;
  }
  return null;
}

// 在 OrbitControls 之前注册普通阶段事件，航路编辑的捕获阶段仍可优先接管。
export function installCameraFocus({canvas,camera,getControls,anchorAt,isLocked=()=>false}){
  const prepare=(event,onlyNearer)=>{
    const controls=getControls();if(!controls?.enabled||event.defaultPrevented)return;
    const rect=canvas.getBoundingClientRect();
    const x=onlyNearer?rect.left+rect.width/2:event.clientX,y=onlyNearer?rect.top+rect.height/2:event.clientY;
    if(!isLocked())focusAtVisibleDepth(camera,controls,anchorAt(x,y),{onlyNearer});
    controls.rotateSpeed=cameraMotionScale(camera.position.distanceTo(controls.target)).rotate;
  };
  const wheel=e=>{const controls=getControls();if(!e.deltaY||!controls?.enableZoom||controls.state!==-1)return;prepare(e,false);};
  const pointer=e=>{if(e.button===0||e.button===1)prepare(e,true);};
  canvas.addEventListener('wheel',wheel,{passive:true});canvas.addEventListener('pointerdown',pointer);
  return ()=>{canvas.removeEventListener('wheel',wheel);canvas.removeEventListener('pointerdown',pointer);};
}
