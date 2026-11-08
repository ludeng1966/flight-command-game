import {Vector3,Matrix4,Quaternion} from '../vendor/three/three.core.js';

const nose=new Vector3(),up=new Vector3(),right=new Vector3(),rotation=new Matrix4();

// Simulation: east/north/up. Mesh: +X right wing, +Y upper surface, -Z nose.
// Use the current body axes (including angle of attack), not target bank or Euler angles.
export function aircraftQuaternion(forward,bodyUp,target=new Quaternion()){
  nose.set(forward[0],forward[2],-forward[1]).normalize();
  up.set(bodyUp[0],bodyUp[2],-bodyUp[1]).normalize();
  right.crossVectors(nose,up).normalize();
  up.crossVectors(right,nose).normalize();
  return target.setFromRotationMatrix(rotation.makeBasis(right,up,nose.negate()));
}
