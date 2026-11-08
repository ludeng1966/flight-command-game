// ENU 米制质点模型；角度为弧度，推力牛顿，真空速米/秒。
export const G = 9.80665;
export const clamp = (x,a,b) => Math.max(a,Math.min(b,x));
export const add = (a,b) => a.map((v,i)=>v+b[i]);
export const mul = (a,s) => a.map(v=>v*s);
export const dot = (a,b) => a.reduce((s,v,i)=>s+v*b[i],0);
export const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export const norm = a => mul(a,1/Math.max(1e-8,Math.hypot(...a)));
export function atmosphere(h){
  h=Math.max(0,h);const temperature=288.15-.0065*Math.min(h,11000);
  const pressure=h<=11000?101325*Math.pow(temperature/288.15,5.25588):22632.06*Math.exp(-(h-11000)*G/(287.05287*216.65));
  return {temperature,density:pressure/(287.05287*temperature),soundSpeed:Math.sqrt(1.4*287.05287*temperature)};
}
export function density(h) { return atmosphere(h).density; }
const smooth=t=>{t=clamp(t,0,1);return t*t*(3-2*t);};
export function machFactor(f,m){
  if(!f)return 1;
  const rise=1+(f.peak-1)*smooth((m-f.critical)/Math.max(.001,f.peakMach-f.critical));
  const tail=f.peak+f.slope*Math.max(0,m-f.peakMach)*smooth((m-f.peakMach)/.12);
  const value=m<=f.peakMach?rise:tail;return f.slope>0?Math.min(f.limit,value):Math.max(f.limit,value);
}
export function hasAfterburner(p){return p.engine?.afterburnerAvailable!==false&&!!p.engine?.afterburnerCoefficients;}
export function aeroAt(p,h,v,configuration){
  const mach=v/atmosphere(h).soundSpeed,m=p.machPolar;
  const cfg=p.configurations?.[configuration?.flaps],wave=p.transonicDrag,compressibility=wave?wave.coefficient*Math.max(0,mach-wave.criticalMach)**4:0;
  return {mach,maxG:cfg?.maxG??p.maxG,cl0:cfg?.cl0??p.cl0,clAlpha:p.clAlpha*machFactor(m?.['2'],mach),clMax:(cfg?.clMax??p.clMax)*machFactor(m?.['3'],mach),
    cd0:p.cd0+(p.storesCd0??0)+compressibility+(p.waveDrag??[]).reduce((sum,w)=>sum+w.cd*(machFactor(w.factor,mach)-1),0),
    k:p.k,criticalAlpha:(p.criticalAlpha??29*Math.PI/180)*machFactor(m?.['5'],mach)};
}
// Airspeed support and aerodynamic stall are different measurements. Unloading
// can keep CL below its limit while the aircraft is still dangerously slow.
export function flightSafety(u){
  const speed=Math.hypot(...u.velocity),grounded=u.surface?.grounded===true;
  const a=aeroAt(u.profile,u.position[2],speed,u),rho=density(u.position[2])*(u.profile.densityScale??1);
  const stallSpeed=Math.sqrt(2*u.profile.mass*G/(rho*u.profile.area*a.clMax));
  return {speed,stallSpeed,severeLowSpeed:!grounded&&speed<stallSpeed*.9,
    lowSpeed:!grounded&&speed<stallSpeed*1.16,stalled:!grounded&&!!u.stalled};
}
export function detectFlightRecovery(u){
  if(u.alive===false||u.surface?.grounded||u.flightState==='stall-recovery')return;
  const safety=flightSafety(u);
  if(safety.stalled||safety.severeLowSpeed){
    u.flightState='stall-recovery';u.recoveryTime=0;u.recoveryCause=safety.stalled?'stall':'low-speed';
    u.lastIncident=safety.stalled?'失速，暂停航路并自动改出':'严重低速，暂停追踪航点并自动增速改出';
  }
}
export const configurationDrag=(u,p=u?.profile)=>(u?.gearDown?(p?.configurationDrag?.gear??.015):0)+(u?.flaps==='landing'?(p?.configurationDrag?.landing??.045):u?.flaps==='takeoff'?(p?.configurationDrag?.takeoff??.015):0)+(u?.speedBrake?(p?.configurationDrag?.speedBrake??.08):0);
export function dragAt(p,h,v,cl,configuration){const a=aeroAt(p,h,v,configuration);return .5*density(h)*(p.densityScale??1)*v*v*p.area*(a.cd0+a.k*cl*cl+configurationDrag(configuration,p));}
function interval(axis,x) { let i=0; while(i<axis.length-2 && x>axis[i+1])i++; return [i,clamp((x-axis[i])/(axis[i+1]-axis[i]),0,1)]; }
export function thrustAt(p,h,v,afterburner=0) {
  const t=p.thrust, [i,a]=interval(t.altitudes,h),[j,b]=interval(t.speeds,v),e=p.engine;
  const sample=wet=>{const at=(k,l)=>t.values[k][l]*(wet?e.wetBoost*e.afterburnerCoefficients[k][l]:e?.dryBoost??1);const row=k=>at(k,j)*(1-b)+at(k,j+1)*b;return row(i)*(1-a)+row(i+1)*a;};
  const dry=sample(false);return (hasAfterburner(p)?dry+(sample(true)-dry)*clamp(afterburner,0,1):dry)*(p.fuelThrustFactor??1);
}
export function dryFraction(p,throttle){
  const modes=p.engine?.dryModes;if(!modes)return clamp(throttle,0,1);
  let i=0;while(i<modes.length-2&&throttle>modes[i+1].throttle)i++;
  const a=modes[i],b=modes[i+1],t=clamp((throttle-a.throttle)/(b.throttle-a.throttle),0,1);
  return a.fraction+(b.fraction-a.fraction)*t;
}
export function throttleForFraction(p,fraction){
  const modes=p.engine?.dryModes;if(!modes)return clamp(fraction,0,1);
  let i=0;while(i<modes.length-2&&fraction>modes[i+1].fraction)i++;
  const a=modes[i],b=modes[i+1];return a.throttle+(b.throttle-a.throttle)*clamp((fraction-a.fraction)/(b.fraction-a.fraction),0,1);
}
export function basis(u) {
  const grounded=u.surface?.grounded,heading=u.surface?.heading??0;
  const f=grounded?[Math.sin(heading),Math.cos(heading),0]:norm(u.velocity), right=norm(cross(f,[0,0,1]));
  const vertical=norm(cross(right,f));
  const lift=add(mul(vertical,Math.cos(u.bank)),mul(right,Math.sin(u.bank)));
  const a=aeroAt(u.profile,u.position[2],Math.hypot(...u.velocity),u);
  const alpha=grounded?0:clamp((u.cl-a.cl0)/a.clAlpha,-.12,Math.min(.65,a.criticalAlpha));
  return {f,lift,forward:add(mul(f,Math.cos(alpha)),mul(lift,Math.sin(alpha))),up:add(mul(lift,Math.cos(alpha)),mul(f,-Math.sin(alpha)))};
}
export function stepFlight(u,dt) {
  const p=u.profile, speed=Math.max(1,Math.hypot(...u.velocity));
  const q=.5*density(u.position[2])*(p.densityScale??1)*speed*speed;
  const aero=aeroAt(p,u.position[2],speed,u);
  // 飞控以10 Hz更新目标，物理帧内连续跟随，避免每次更新都在一帧跳完滚转指令。
  const bankResponse=1-Math.exp(-dt/(p.bankResponseSeconds??.18));
  u.bank+=clamp((u.control.bank-u.bank)*bankResponse,-p.bankRate*dt,p.bankRate*dt);
  // 航路可以请求超出稳定升力区的迎角；越过临界后升力下降、阻力增加。
  const maxCl=Math.min(aero.clMax*1.35,Math.min(u.control.maxG??p.maxG,p.maxG,aero.maxG)*p.mass*G/(q*p.area));
  u.cl+=clamp(clamp(u.control.cl,0,maxCl)-u.cl,-p.clRate*dt,p.clRate*dt);
  u.cl=clamp(u.cl,0,maxCl);
  const excess=Math.max(0,u.cl/aero.clMax-1);
  u.stalled=excess>.025;
  const actualCl=excess>0?aero.clMax*Math.max(.35,1-excess*1.8):u.cl;
  const {f,lift}=basis(u), L=q*p.area*actualCl;
  const D=q*p.area*(aero.cd0+aero.k*u.cl*u.cl+excess*.35+configurationDrag(u,p));
  const response=1-Math.exp(-dt/(p.engine?.responseSeconds??.3));
  u.throttle=(u.throttle??0)+(clamp(u.control.throttle,0,1)-(u.throttle??0))*response;
  u.afterburner=(u.afterburner??0)+((hasAfterburner(p)?clamp(u.control.afterburner??0,0,1):0)-(u.afterburner??0))*response;
  const T=thrustAt(p,u.position[2],speed,u.afterburner)*dryFraction(p,u.throttle);
  const acceleration=add(add(mul(f,(T-D)/p.mass),mul(lift,L/p.mass)),[0,0,-G]);
  u.velocity=add(u.velocity,mul(acceleration,dt));
  u.groundVelocity=add(u.velocity,u.wind??[0,0,0]);u.position=add(u.position,mul(u.groundVelocity,dt));
  u.speed=Math.hypot(...u.velocity);u.loadFactor=L/(p.mass*G);u.mach=u.speed/atmosphere(u.position[2]).soundSpeed;
  u.thrustN=T;u.dragN=D;u.energyHeight=u.position[2]+u.speed*u.speed/(2*G);u.energyRate=(T-D)*speed/(p.mass*G);
  u.recoveryTime=(u.recoveryTime??0)+dt;
  detectFlightRecovery(u);
}
