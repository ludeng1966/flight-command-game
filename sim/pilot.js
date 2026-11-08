import {G,clamp,density,norm,dot,mul,add,basis,aeroAt,detectFlightRecovery,thrustAt,throttleForFraction} from './flight.js';
import {energyEnvelope,controlEnergy} from './energy.js';
import {gateDirection,futureWindow,curvatureAt} from './route-continuity.js';
import {defenseGuidance} from './rwr-defense.js';

function pathAim(u,w,V,envelope){
  const path=u.navLegs?.[0];
  if(!path?.length)return w.map((v,i)=>v-u.position[i]);
  let i=Math.min(u.navCursor??0,path.length-2),t=0;
  while(i<path.length-1){
    const a=path[i],b=path[i+1],leg=b.map((v,k)=>v-a[k]),len2=dot(leg,leg);
    const progress=dot(u.position.map((v,k)=>v-a[k]),leg)/Math.max(1,len2);t=clamp(progress,0,1);
    if(i<path.length-2&&(len2<1||progress>=.995)){i++;continue;}
    break;
  }
  u.navCursor=i;
  // 前视/制动窗口穿过后续航段，航点切换前后使用同一条空间曲线。
  const {nodes,gateDistance}=futureWindow(u,i,t);let along=0,limit=u.targetSpeed;
  u.navigationClimbPreview=0;u.navigationLoadPreview=1;
  let futureEnvelope=envelope,lastHeight=u.position[2];
  for(let j=1;j<nodes.length-1&&along<V*30;j++){
    const a=nodes[j-1],b=nodes[j],c=nodes[j+1],la=Math.hypot(...b.map((v,k)=>v-a[k])),lb=Math.hypot(...c.map((v,k)=>v-b[k]));along+=la;
    if(Math.abs(b[2]-lastHeight)>150){futureEnvelope=energyEnvelope(u.profile,b[2],V);lastHeight=b[2];}
    const normalG=Math.max(1.3,Math.min(2.6,futureEnvelope.sustainableMaxG*.9)),curvature=curvatureAt(a,b,c);
    if(curvature>.00001){const turnSpeed=Math.sqrt(G*Math.sqrt(normalG*normalG-1)/curvature);limit=Math.min(limit,Math.sqrt(turnSpeed*turnSpeed+2*1.2*along));}
    if(along<V*Math.max(2,(u.profile.engine?.responseSeconds??1)+1)){
      u.navigationLoadPreview=Math.max(u.navigationLoadPreview,Math.min(envelope.budgetG,Math.hypot(1,V*V*curvature/G)));
      u.navigationClimbPreview=Math.max(u.navigationClimbPreview,V*(c[2]-b[2])/Math.max(1,lb));
    }
  }
  u.navigationSpeed=Math.max(envelope.safeSpeed(1)*1.08,limit);
  // 允许前视跨过门点，但限制跨越距离，避免切角跳过250米到达范围。
  let point=nodes[0],remaining=Math.min(V*5,gateDistance+Math.min(180,V));
  for(let j=1;j<nodes.length;j++){
    const delta=nodes[j].map((v,k)=>v-point[k]),length=Math.hypot(...delta);
    if(length>=remaining)return point.map((v,k)=>v+delta[k]*remaining/Math.max(1,length)-u.position[k]);
    remaining-=length;point=nodes[j];
  }
  return point.map((v,i)=>v-u.position[i]);
}

export function updatePilot(u,dt=.1) {
  if(u.alive===false)return;
  const p=u.profile,V=Math.max(20,Math.hypot(...u.velocity)),f=norm(u.velocity),a=aeroAt(p,u.position[2],V);
  const rho=density(u.position[2])*(p.densityScale??1),q=.5*rho*V*V,vs=Math.sqrt(2*p.mass*G/(rho*p.area*a.clMax));
  const envelope=energyEnvelope(p,u.position[2],V);
  detectFlightRecovery(u);
  if(u.flightState==='stall-recovery'){
    const plan=u.pilotPowerPlan?.active&&u.pilotPowerPlan.recoveryOnly?u.pilotPowerPlan:null,choice=plan?.recovery,caps=u.pilotExecution?.constraints??{};
    const gamma=Math.asin(clamp(f[2],-1,1)),unload=V<Math.max(vs*1.2,choice?u.targetSpeed*.9:0)||u.recoveryTime<2;
    const targetGamma=unload?(choice?.flightPathDeg??0)*Math.PI/180:0;
    const n=unload?(choice?clamp(Math.cos(gamma)-(gamma-targetGamma)*V/G*.6,.1,choice.unloadG):.6):clamp(Math.cos(gamma)-gamma*V/G*.6,.4,2.2);
    const afterburner=Math.min(plan?.afterburner??1,caps.afterburnerCap??1);
    const thrustCap=thrustAt(p,u.position[2],V,1)*(caps.maximumThrustFraction??1);
    const throttle=Math.min(plan?.throttle??1,caps.throttleCap??1,throttleForFraction(p,thrustCap/thrustAt(p,u.position[2],V,afterburner)));
    u.control={bank:(choice?.bankDeg??0)*Math.PI/180,cl:Math.min(a.clMax*.88,n*p.mass*G/(q*p.area)),maxG:2.2,throttle,afterburner};
    u.recoveryPowerSource=plan?'model':'automatic';
    u.maneuverMode='失速改出';
    if(V>vs*1.3&&Math.abs(gamma)<.1&&u.recoveryTime>5){
      u.flightState='normal';u.stalled=false;u.recoveryCause=null;u.lastIncident='改出完成，重新规划安全航路';u.navigationKey=null;
      u.guidance={bank:u.bank,n:u.loadFactor??1};u.energy=undefined;
      // 已飞完预测中的改出前缀，从恢复点接入航路，不回头追逐旧位置。
      u.navCursor=Math.max(u.navCursor??0,u.navLegs?.[0]?.recoveryEndIndex??0);
      if(plan){plan.active=false;u.targetSpeed=plan.resumeTargetSpeedMps??u.pilotExecution?.targetSpeedMps??u.targetSpeed;}
    }
    return;
  }
  const evasion=defenseGuidance(u)??(u.surface?.towerHold?{...u.surface.towerHold,atc:true}:null);
  while(!evasion&&u.waypoints.length&&!u.navigationBlocked){
    const w=u.waypoints[0];
    const offset=u.position.map((v,k)=>v-w[k]),distance=Math.hypot(...offset);
    if(distance<=250)u.gateEntered=w;
    if(u.gateEntered!==w)break;
    if(distance>35&&dot(offset,gateDirection(u))<0)break;
    u.waypoints.shift();u.navLegs?.shift();u.navCursor=0;u.previousWaypoint=[...w];
    u.gateEntered=null;u.completedWaypoints=(u.completedWaypoints??0)+1;u.holdAltitude=w[2];
    if(!u.waypoints.length){
      const holdG=Math.max(1.15,Math.min(2.5,q*p.area*a.clMax*.82/(p.mass*G))),R=Math.max(2500,V*V/(G*Math.sqrt(holdG*holdG-1)));
      const heading=Math.atan2(u.velocity[0],u.velocity[1]);u.orbit=[u.position[0]+Math.cos(heading)*R,u.position[1]-Math.sin(heading)*R];
    }
    u.navigationKey=JSON.stringify([u.waypoints,u.targetSpeed]);
  }
  let desired,distance;u.navigationSpeed=u.targetSpeed;u.navigationClimbPreview=0;u.navigationLoadPreview=1;
  if(evasion){
    const h=evasion.headingDeg*Math.PI/180,gamma=clamp((evasion.altitudeM-u.position[2])/4000,-.15,.15);
    desired=[Math.sin(h)*Math.cos(gamma),Math.cos(h)*Math.cos(gamma),Math.sin(gamma)];distance=V*6;u.targetAltitude=evasion.altitudeM;
  }else if(u.formationGuidance&&!u.navigationBlocked){
    desired=[...u.formationGuidance.desired];distance=u.formationGuidance.distance;
    u.navigationSpeed=u.formationGuidance.speedMps;u.targetAltitude=u.formationGuidance.altitudeM;
  }else if(u.waypoints.length&&!u.navigationBlocked){
    const w=u.waypoints[0],delta=pathAim(u,w,V,envelope);distance=Math.hypot(...delta);u.targetAltitude=w[2];desired=norm(delta);
  }else if(u.headingTarget!=null&&!u.navigationBlocked){
    const gamma=clamp((u.holdAltitude-u.position[2])/5500,-.2,.2);u.targetAltitude=u.holdAltitude;
    desired=[Math.sin(u.headingTarget)*Math.cos(gamma),Math.cos(u.headingTarget)*Math.cos(gamma),Math.sin(gamma)];distance=V*22;
  }else{
    const available=Math.max(1.15,Math.min(2.5,q*p.area*a.clMax*.82/(p.mass*G)));
    const R=Math.max(2500,V*V/(G*Math.sqrt(available*available-1))),center=u.safetyOrbit??u.orbit;
    const dx=u.position[0]-center[0],dy=u.position[1]-center[1];
    const heading=Math.atan2(dx,dy)+Math.PI/2+Math.atan((Math.hypot(dx,dy)-R)/R*2);
    u.targetAltitude=u.navigationBlocked?Math.max(u.holdAltitude,u.safetyAltitude??0):u.holdAltitude;
    const gamma=clamp((u.targetAltitude-u.position[2])/5500,-.2,.2);
    desired=[Math.sin(heading)*Math.cos(gamma),Math.cos(heading)*Math.cos(gamma),Math.sin(gamma)];distance=V*22;
  }
  if(u.wind&&(!u.headingRoute&&u.waypoints.length||u.headingTarget==null)){
    const heading=Math.atan2(desired[0],desired[1]),cross=u.wind[0]*Math.cos(heading)-u.wind[1]*Math.sin(heading),corrected=heading-Math.asin(clamp(cross/Math.max(20,V*Math.hypot(desired[0],desired[1])),-.6,.6)),horizontal=Math.hypot(desired[0],desired[1]);
    desired=[Math.sin(corrected)*horizontal,Math.cos(corrected)*horizontal,desired[2]];
  }
  const safeG=envelope.budgetG;
  let gamma=Math.asin(clamp(desired[2],-1,1));
  if(u.terrain?.heightAt&&(evasion||!u.waypoints.length||u.navigationBlocked)){
    let floor=-Infinity;
    for(let t=0;t<=24;t+=4)for(const direction of evasion?[f,desired]:[f]){const h=u.terrain.heightAt(u.position[0]+direction[0]*V*t,u.position[1]+direction[1]*V*t);if(h!==null)floor=Math.max(floor,h+450);}
    gamma=Math.max(gamma,Math.atan2(floor-u.position[2],V*10));
  }
  const horizontalAngle=Math.acos(clamp((f[0]*desired[0]+f[1]*desired[1])/Math.max(.001,Math.hypot(f[0],f[1])*Math.hypot(desired[0],desired[1])),-1,1));
  const plannedG=clamp(Math.hypot(1,2*V*V*Math.sin(Math.min(horizontalAngle,Math.PI/2))/(G*Math.max(V*3,Math.min(distance,V*30)))),.5,Math.max(.5,safeG));
  const energy=controlEnergy(u,{gamma,loadFactor:Math.max(plannedG,u.loadFactor??1,u.navigationLoadPreview),previewClimb:u.navigationClimbPreview,targetSpeed:u.navigationSpeed,envelope,urgent:!!u.terrain?.heightAt&&u.position[2]-(u.terrain.heightAt(u.position[0],u.position[1])??0)<180},dt);
  gamma=energy.gamma;const energyLimited=energy.underSpeed;
  let heading=Math.atan2(desired[0],desired[1]);
  const currentHeading=Math.atan2(f[0],f[1]),headingError=Math.atan2(Math.sin(heading-currentHeading),Math.cos(heading-currentHeading));
  // A point behind the aircraft requires a level heading reversal. The shortest
  // 3-D vector can instead ask for an over-the-top pull-up or a steep dive.
  if(Math.abs(headingError)>Math.PI*.6){
    const side=Math.abs(Math.sin(headingError))>1e-4?Math.sign(headingError):u.bank<-.01?-1:1;
    heading=currentHeading+side*Math.PI/2;
  }
  desired=[Math.sin(heading)*Math.cos(gamma),Math.cos(heading)*Math.cos(gamma),Math.sin(gamma)];
  const cosine=clamp(dot(f,desired),-1,1),angle=Math.acos(cosine);
  let tangent=add(desired,mul(f,-cosine));if(Math.hypot(...tangent)<1e-6)tangent=norm([f[1],-f[0],0]);tangent=norm(tangent);
  const lookahead=Math.max(V*3,Math.min(distance,V*30)),turnAcceleration=2*V*V*Math.sin(Math.min(angle,Math.PI/2))/lookahead;
  const gravity=[0,0,-G],normalGravity=add(gravity,mul(f,-dot(gravity,f)));
  const request=add(mul(tangent,turnAcceleration),mul(normalGravity,-1));
  const {lift}=basis(u),right=norm([f[1],-f[0],0]),vertical=norm(add([0,0,1],mul(f,-f[2])));
  const sideways=dot(request,right),upward=dot(request,vertical);
  const bankLimit=Math.min(1.36,Math.acos(1/Math.max(1.02,safeG)));
  const requestedBank=energyLimited?0:upward<0&&Math.abs(sideways)<.05?0:clamp(Math.atan2(sideways,upward),-bankLimit,bankLimit);
  const guidance=u.guidance??={bank:u.bank,n:u.loadFactor??1};
  guidance.bank+=clamp(requestedBank-guidance.bank,-.5*dt,.5*dt);const bank=guidance.bank;
  const requestedN=clamp(dot(request,lift)/G,.1,Math.max(.4,safeG));
  guidance.n+=clamp(requestedN-guidance.n,-1.5*dt,.9*dt);const n=Math.min(guidance.n,safeG);
  const cl=clamp(n*p.mass*G/(q*p.area),0,a.clMax/(envelope.margin*envelope.margin));
  u.demandG=Math.hypot(...request)/G;u.availableG=safeG;u.turnAngle=angle;u.waypointDistance=distance;
  u.maneuverMode=energyLimited?'增速保护':evasion?(evasion.maneuver==='notch'?'告警横切规避':'告警背向脱离'):u.navigationBlocked?'安全待命':u.navDetour?'安全迂回':u.demandG>2.3?'机动转弯':u.demandG>1.5?'转弯调整':'节能飞行';
  u.control={bank,cl,maxG:p.maxG,throttle:energy.throttle,afterburner:energy.afterburner};
}
