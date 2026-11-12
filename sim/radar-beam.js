import {cross,norm} from './flight.js';
const radians=degrees=>degrees*Math.PI/180;
// Conservative broad phase: dot products and tangent bounds, no target truth
// beyond position, no angle/range/Doppler/terrain calculation for rejected points.
// Exact sensor visibility is still evaluated after this gate for detections.
export function beamGate(position,pose,beam,half,config){
  const azLow=Math.max(-config.azimuthHalfDeg,Math.min(beam.from.az,beam.to.az)-half);
  const azHigh=Math.min(config.azimuthHalfDeg,Math.max(beam.from.az,beam.to.az)+half);
  const elLow=Math.max(-config.elevationHalfDeg,Math.min(beam.from.el,beam.to.el)-half);
  const elHigh=Math.min(config.elevationHalfDeg,Math.max(beam.from.el,beam.to.el)+half);
  return {origin:position,forward:pose.forward,right:norm(cross(pose.forward,pose.up)),up:pose.up,
    azLow:Math.tan(radians(azLow)),azHigh:Math.tan(radians(azHigh)),elLow:Math.tan(radians(elLow)),elHigh:Math.tan(radians(elHigh)),empty:azLow>azHigh||elLow>elHigh};
}
export function inBeam(gate,x,y,z){
  if(gate.empty)return false;
  x-=gate.origin[0];y-=gate.origin[1];z-=gate.origin[2];
  const f=gate.forward,r=gate.right,u=gate.up,forward=x*f[0]+y*f[1]+z*f[2];if(forward<=0)return false;
  const right=x*r[0]+y*r[1]+z*r[2],epsilon=1e-9*(1+forward);
  if(right<forward*gate.azLow-epsilon||right>forward*gate.azHigh+epsilon)return false;
  const up=x*u[0]+y*u[1]+z*u[2],horizontal=Math.sqrt(forward*forward+right*right);
  return up>=horizontal*gate.elLow-epsilon&&up<=horizontal*gate.elHigh+epsilon;
}
