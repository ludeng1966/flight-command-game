import {G,clamp,density,aeroAt,dragAt,thrustAt,dryFraction,throttleForFraction,atmosphere,hasAfterburner,configurationDrag} from './flight.js';

// 所有预测与实时飞控共用同一能量包线，速度均为 TAS。安全裕度随预计载荷变化。
export function energyEnvelope(p,h,V,configuration){
  V=Math.max(20,V);const rho=density(h)*(p.densityScale??1),a=aeroAt(p,h,V,configuration),q=.5*rho*V*V;
  const vs=Math.sqrt(2*p.mass*G/(rho*p.area*a.clMax)),margin=1.16;
  const military=thrustAt(p,h,V),maximum=thrustAt(p,h,V,1);
  const parasite=q*p.area*(a.cd0+configurationDrag(configuration,p)),induced=a.k*(p.mass*G)**2/(q*p.area),dragFor=n=>parasite+induced*n*n;
  const liftG=Math.min(a.maxG*.9,q*p.area*a.clMax/(p.mass*G*margin*margin));
  const sustainable=thrust=>{
    return clamp(Math.sqrt(Math.max(0,(thrust-parasite)/Math.max(1,induced))),0,liftG);
  };
  // 可短暂交换动能，但8秒后仍须保有对应G值的失速裕度。
  let lo=.4,hi=Math.max(.4,liftG);
  for(let i=0;i<12;i++){const n=(lo+hi)/2,predicted=V+(maximum-dragFor(n))/p.mass*8;if(predicted>=vs*Math.sqrt(n)*margin)lo=n;else hi=n;}
  return {aero:a,vs,margin,liftG,budgetG:Math.min(liftG,lo),military,maximum,
    sustainableMilG:sustainable(military),sustainableMaxG:sustainable(maximum),
    safeSpeed:n=>vs*Math.sqrt(Math.max(.4,n))*margin,dragFor,
    climbRate:(n=1,acceleration=0,wet=false)=>( (wet?maximum:military)-dragFor(n)-p.mass*acceleration)*V/(p.mass*G),
    maxSpeed:Math.min(p.limits?.ias?p.limits.ias*Math.sqrt(1.225/rho)*.97:Infinity,(p.limits?.mach??3)*atmosphere(h).soundSpeed*.97)};
}

export function controlEnergy(u,{gamma,loadFactor,targetSpeed,heightError=0,urgent=false,envelope,previewClimb=0},dt=.1){
  dt=clamp(dt,0,.25);const p=u.profile,V=Math.max(20,Math.hypot(...u.velocity)),base=envelope??energyEnvelope(p,u.position[2],V,u),plan=u.pilotPowerPlan?.active?u.pilotPowerPlan:u.departurePowerPlan;
  const limited=plan?.active&&(plan.executionId||u.position[2]<plan.altitudeM-50)&&V>base.safeSpeed(1)*.95&&u.flightState!=='stall-recovery';
  if(plan?.active&&!limited)plan.active=false;
  const ceiling=limited?thrustAt(p,u.position[2],V,plan.afterburner)*dryFraction(p,plan.throttle):base.maximum;
  const env=limited?{...base,maximum:ceiling,military:Math.min(base.military,ceiling)}:base;
  const e=u.energy??={speedRef:V,gammaRef:Math.asin(clamp(u.velocity[2]/V,-1,1)),integral:0,boost:false,onNeed:0,offNeed:0,modeTime:10};
  const minSpeed=env.safeSpeed(Math.max(1,loadFactor)),commandSpeed=clamp(Math.max(targetSpeed,minSpeed),env.safeSpeed(1),env.maxSpeed);
  // 可达参考轨迹而非远方终点的总能量：速度参考有斜率，俯仰参考有速率限制。
  const oldSpeed=e.speedRef;
  const accelerationLimit=p.controlLimits?.maxAccelerationMps2??3,requestedAcceleration=clamp((commandSpeed-e.speedRef)/3,-accelerationLimit,accelerationLimit);
  e.speedRef+=requestedAcceleration*dt;
  if(Math.abs(commandSpeed-e.speedRef)<.05)e.speedRef=commandSpeed;
  const accelRef=dt?(e.speedRef-oldSpeed)/dt:0;
  const underSpeed=V<minSpeed*.97;
  const plannedDrag=Math.max(env.dragFor(loadFactor),dragAt(p,u.position[2],V,u.cl,u));
  const reserveAcceleration=underSpeed?Math.max(0,(minSpeed*1.08-V)/5):Math.max(0,Math.min(1.8,accelRef));
  const climbMax=(env.maximum-plannedDrag-p.mass*reserveAcceleration)*V/(p.mass*G);
  const climbMin=(env.military*(p.engine?.dryModes?.[0]?.fraction??0)-plannedDrag-p.mass*2)*V/(p.mass*G);
  let climb=clamp(V*Math.sin(gamma),Math.max(-V*.3,climbMin,-(p.controlLimits?.maxDescentMps??Infinity)),Math.min(p.controlLimits?.maxClimbMps??Infinity,Math.max(0,climbMax*.9)));
  if(underSpeed&&!urgent)climb=Math.min(climb,0);
  const gammaCommand=Math.asin(clamp(climb/V,-.3,.4));
  const gammaStep=(gammaCommand-e.gammaRef)*(1-Math.exp(-dt/1.2));
  const gammaRate=p.controlLimits?.gammaRateRadS??.035;e.gammaRef+=clamp(gammaStep,-gammaRate*dt,gammaRate*dt);
  if(underSpeed&&!urgent)e.gammaRef=Math.min(e.gammaRef,.015);
  const climbRef=V*Math.sin(e.gammaRef);
  const error=clamp(heightError,-100,100)+(e.speedRef*e.speedRef-V*V)/(2*G);
  const preparation=Math.max(0,Math.min(previewClimb-climbRef,Math.max(0,climbMax-climbRef)))*.25;
  const energyRate=climbRef+preparation+V*accelRef/G+.12*error+e.integral;
  const required=plannedDrag+p.mass*G/V*energyRate;
  // 饱和时只允许积分向退出饱和的方向变化。
  if((required<env.maximum||error<0)&&(required>0||error>0))e.integral=clamp(e.integral+.008*error*dt,-5,5);
  e.modeTime+=dt;
  const need=required>env.military*1.03;
  e.onNeed=need?e.onNeed+dt:0;
  e.offNeed=required<env.military*.90?e.offNeed+dt:0;
  const emergency=underSpeed||urgent;
  if(hasAfterburner(p)&&!e.boost&&(emergency||(e.onNeed>=.7&&e.modeTime>=1.5))){e.boost=true;e.modeTime=0;}
  if(!hasAfterburner(p))e.boost=false;
  if(e.boost&&((e.offNeed>=2&&e.modeTime>=3)||(V>commandSpeed+15&&gamma<=0))){e.boost=false;e.modeTime=0;e.onNeed=0;}
  let afterburner=e.boost?clamp((required-base.military)/Math.max(1,base.maximum-base.military),emergency?.5:.04,1):0;
  let throttle=afterburner?1:throttleForFraction(p,required/base.military);
  if(limited){throttle=Math.min(throttle,plan.throttle);afterburner=Math.min(afterburner,plan.afterburner);}
  const mode=afterburner>.02?'加力':required>=env.military*.97?(p.category==='transport'?'最大推力':'军推'):accelRef<-.1||required<env.dragFor(1)*.85?'减推':'调推';
  u.energyMode=mode;u.energyReason=underSpeed?'载荷速度保护':required>env.maximum?'推力不足，限制机动':mode==='加力'?'预测能量需求超过军推':mode==='减推'?'提前减速 / 下降':'按总能量需求调节';
  u.effectiveTargetSpeed=commandSpeed;u.safeManeuverSpeed=minSpeed;u.requiredThrustN=required;
  return {gamma:e.gammaRef,throttle,afterburner,availableG:env.budgetG,underSpeed,envelope:env};
}
