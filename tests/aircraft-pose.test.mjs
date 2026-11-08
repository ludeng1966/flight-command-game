import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {Vector3,Matrix4} from '../vendor/three/three.core.js';
import {aircraftQuaternion} from '../three3d/aircraft-pose.js';
import {basis,aeroAt,stepFlight,G,density} from '../sim/flight.js';
import {World} from '../sim/world.js';

const profiles=JSON.parse(await fs.readFile(new URL('../data/aircraft.json',import.meta.url)));
const scenario=JSON.parse(await fs.readFile(new URL('../data/scenarios/demo.json',import.meta.url)));
const rad=degrees=>degrees*Math.PI/180;
const near=(actual,expected,message)=>assert(Math.abs(actual-expected)<1e-9,`${message}: ${actual} vs ${expected}`);
const enu=vector=>[vector.x,-vector.z,vector.y];
const axis=(q,x,y,z)=>enu(new Vector3(x,y,z).applyQuaternion(q));
function unit({heading=0,gamma=0,bank=0,alpha=rad(4),profile=profiles.f16}={}){
  const u={profile,position:[0,0,6500],velocity:[230*Math.sin(heading)*Math.cos(gamma),230*Math.cos(heading)*Math.cos(gamma),230*Math.sin(gamma)],bank};
  const aero=aeroAt(profile,6500,230);
  u.cl=aero.cl0+aero.clAlpha*alpha;return u;
}
function pose(u){const b=basis(u);return {b,q:aircraftQuaternion(b.forward,b.up)};}

test('各机型在八个航向和复合俯仰、滚转时保持机头、机背、右翼的右手坐标',()=>{
  for(const profile of Object.values(profiles))for(const heading of [0,45,90,135,180,225,270,315])for(const gamma of [-18,0,18])for(const bank of [-60,0,60]){
    const {b,q}=pose(unit({profile,heading:rad(heading),gamma:rad(gamma),bank:rad(bank)}));
    const nose=axis(q,0,0,-1),up=axis(q,0,1,0),right=axis(q,1,0,0);
    for(let k=0;k<3;k++){near(nose[k],b.forward[k],'nose');near(up[k],b.up[k],'up');}
    near(Math.hypot(...nose),1,'unit nose');near(Math.hypot(...up),1,'unit up');
    near(nose.reduce((sum,value,k)=>sum+value*up[k],0),0,'orthogonal');
    near(new Matrix4().makeRotationFromQuaternion(q).determinant(),1,'handedness');
    // Right wing lowers for positive (right) bank, independently of heading or angle of attack.
    near(right[2],-Math.sin(rad(bank))*Math.cos(rad(gamma)),'wing height');
    assert(Math.abs(q.length()-1)<1e-12);
  }
});

test('平翼爬升和下降的机头俯仰等于航迹倾角加实际迎角，卸载负迎角也不反向',()=>{
  for(const heading of [0,90,180,270])for(const gamma of [-20,0,20])for(const alpha of [-4,0,7]){
    const {q}=pose(unit({heading:rad(heading),gamma:rad(gamma),alpha:rad(alpha)}));
    const nose=axis(q,0,0,-1);
    near(Math.asin(nose[2]),rad(gamma+alpha),'body pitch');
    near(nose[0],Math.sin(rad(heading))*Math.cos(rad(gamma+alpha)),'nose east');
    near(nose[1],Math.cos(rad(heading))*Math.cos(rad(gamma+alpha)),'nose north');
  }
});

test('实际左右转弯的低翼与侧向加速度、航向变化同向',()=>{
  for(const heading of [0,90,180,270])for(const sign of [-1,1]){
    const u=unit({heading:rad(heading),bank:sign*rad(35)}),p=u.profile;
    u.cl=p.mass*G/(.5*density(6500)*(p.densityScale??1)*230**2*p.area*Math.cos(u.bank));
    u.control={bank:u.bank,cl:u.cl,throttle:.7};u.flightState='normal';
    const initial=[...u.velocity],right=[Math.cos(rad(heading)),-Math.sin(rad(heading)),0];
    for(let frame=0;frame<120;frame++){
      const {q}=pose(u),wing=axis(q,1,0,0);assert(sign*wing[2]<0);
      const velocity=[...u.velocity];stepFlight(u,1/60);
      const sideways=u.velocity.reduce((sum,v,k)=>sum+(v-velocity[k])*right[k],0);
      assert(sign*sideways>0,'acceleration into low wing');
    }
    const start=Math.atan2(initial[0],initial[1]),end=Math.atan2(u.velocity[0],u.velocity[1]);
    const turn=Math.atan2(Math.sin(end-start),Math.cos(end-start));assert(sign*turn>.01,'actual heading change');
  }
});

test('换向指令不会让模型提前翻滚，持续跟随当前滚转并平滑通过平翼',()=>{
  const world=new World(scenario,profiles),u=world.units[0];
  u.bank=rad(40);u.control={bank:-rad(40),cl:u.cl,throttle:.7};
  let previous=null,crossed=false;
  for(let frame=0;frame<90;frame++){
    const snapshot=world.snapshot(u.id,{forecast:false}).units.find(v=>v.id===u.id);
    const q=aircraftQuaternion(snapshot.forward,snapshot.up),wing=axis(q,1,0,0);
    near(wing[2],-Math.sin(u.bank)*Math.hypot(u.velocity[0],u.velocity[1])/Math.hypot(...u.velocity),'current bank');
    if(frame===0)assert(wing[2]<0,'still right bank after left command');
    if(u.bank<0){crossed=true;assert(wing[2]>0,'left wing down after actual reversal');}
    if(previous)assert(previous.angleTo(q)<rad(4),'no sign flip or pose jump');
    previous=q;stepFlight(u,1/60);
  }
  assert(crossed);
});

test('地面静止按机头航向显示，侧风飞行使用空速姿态而非地速方向',()=>{
  const grounded=unit();grounded.velocity=[0,0,0];grounded.surface={grounded:true,heading:rad(90)};
  const groundNose=axis(pose(grounded).q,0,0,-1);near(groundNose[0],1,'east');near(groundNose[2],0,'level');
  const airborne=unit({alpha:0});airborne.wind=[35,0,0];airborne.groundVelocity=[35,230,0];
  const nose=axis(pose(airborne).q,0,0,-1);near(nose[0],0,'air heading');near(nose[1],1,'north');
});
