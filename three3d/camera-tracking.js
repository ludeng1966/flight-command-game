import {Vector3} from '../vendor/three/three.core.js';

// 远景按F-16的约42像素显示，大型机最多大15%；近景平滑恢复米制1:1。
// 这是地图标记比例，不改变模型资产、气动尺寸或碰撞范围。
export function aircraftVisualScale(camera,position,viewportHeight,{pixels=42,lengthM=15,wingspanM=0}={}){
  const direction=camera.getWorldDirection(new Vector3());
  const depth=Math.max(camera.near,new Vector3().subVectors(position,camera.position).dot(direction));
  const metersPerPixel=2*depth*Math.tan(camera.fov*Math.PI/360)/(Math.max(1,viewportHeight)*camera.zoom);
  const size=Math.max(1,lengthM,wingspanM),referenceSize=15,referenceScale=pixels*metersPerPixel/referenceSize;
  const markerRatio=Math.min(1.15,1+.09*Math.max(0,Math.log(size/referenceSize)));
  const markerScale=Math.max(1,referenceScale)*referenceSize*markerRatio/size;
  // 只有F-16自身已足够大时才逐步显示真实大小，避免缩略地图上的客机突然膨胀。
  let blend=Math.max(0,Math.min(1,(referenceScale-.4)/.6));blend=blend*blend*(3-2*blend);
  return 1+(markerScale-1)*blend;
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
