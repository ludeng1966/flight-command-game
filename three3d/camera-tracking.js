import {Vector3} from '../vendor/three/three.core.js';

// 远处保证约42像素的辨识尺寸；拉近后自然收敛到米制模型的1:1比例。
export function aircraftVisualScale(camera,position,viewportHeight,{pixels=42,lengthM=15}={}){
  const direction=camera.getWorldDirection(new Vector3());
  const depth=Math.max(camera.near,new Vector3().subVectors(position,camera.position).dot(direction));
  const metersPerPixel=2*depth*Math.tan(camera.fov*Math.PI/360)/(Math.max(1,viewportHeight)*camera.zoom);
  return Math.max(1,pixels*metersPerPixel/lengthM);
}

// 跟随只平移相机和轨道中心，不随飞机滚转，保留玩家选择的观察角度与距离。
export class AircraftCameraFollower{
  constructor(camera,controls){this.camera=camera;this.controls=controls;this.unitId=null;this.previous=new Vector3();this.point=new Vector3();this.delta=new Vector3();}
  start(unit){
    if(!unit||unit.alive===false)return false;
    if(this.unitId===null)this.saved={zoomToCursor:this.controls.zoomToCursor,enablePan:this.controls.enablePan};
    this.unitId=unit.id;this.point.set(unit.position[0],unit.position[2],-unit.position[1]);
    this.delta.subVectors(this.point,this.controls.target);this.camera.position.add(this.delta);this.controls.target.copy(this.point);this.previous.copy(this.point);
    this.controls.zoomToCursor=false;this.controls.enablePan=false;this.controls.update();return true;
  }
  update(units){
    if(this.unitId===null)return;
    const unit=units.find(u=>u.id===this.unitId);if(!unit){this.stop();return;}
    this.point.set(unit.position[0],unit.position[2],-unit.position[1]);this.delta.subVectors(this.point,this.previous);
    this.camera.position.add(this.delta);this.controls.target.copy(this.point);this.previous.copy(this.point);this.controls.update();
    if(unit.alive===false)this.stop();
  }
  stop(){
    if(this.unitId===null)return;
    this.unitId=null;Object.assign(this.controls,this.saved);this.saved=null;
  }
}
