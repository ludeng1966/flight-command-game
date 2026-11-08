// Adapted equations from OpenAP / Bartel & Young (2008); OpenAP code LGPL-3.0.
// https://github.com/TUDelft-CNS-ATM/openap/blob/master/openap/thrust.py
// Added smooth flight-phase/altitude blending for the point-mass game engine.
import {atmosphere,clamp} from '../sim/flight.js';
const smooth=x=>{x=clamp(x,0,1);return x*x*(3-2*x);},mix=(a,b,t)=>a+(b-a)*t;
function pressure(h){const a=atmosphere(h);return a.density*287.05287*a.temperature;}
function cas(v,h){const a=atmosphere(h),mach=v/a.soundSpeed,qc=pressure(h)*(Math.pow(1+.2*mach*mach,3.5)-1);return atmosphere(0).soundSpeed*Math.sqrt(5*(Math.pow(qc/101325+1,2/7)-1));}
export function airlinerThrust(e,h,v){
  const p=pressure(h),p0=101325,dp=p/p0,b=e.bypassRatio,g=.0606*b+.6337,m0=v/atmosphere(0).soundSpeed;
  const a=-.4327*dp*dp+1.3855*dp+.0472,z=.9106*dp**3-1.7736*dp*dp+1.8697*dp,x=.1377*dp**3-.4374*dp*dp+1.3003*dp;
  const takeoff=e.staticThrustN*Math.max(.02,a-.377*(1+b)/Math.sqrt((1+.82*b)*g)*z*m0+(.23+.19*Math.sqrt(b))*x*m0*m0);
  const mach=Math.max(.04,v/atmosphere(h).soundSpeed),referencePressure=pressure(e.cruiseHeightM),p10=pressure(3048),referenceCAS=cas(e.cruiseMach*atmosphere(e.cruiseHeightM).soundSpeed,e.cruiseHeightM),ratioCAS=Math.max(.1,cas(Math.max(10,v),h)/referenceCAS),roc=2000;
  const coeff=ratioCAS**(-.1),n=2.667e-5*roc+.8633,at10=coeff*(p10/referencePressure)**(-.355*ratioCAS+n),slope=-.12043*ratioCAS-8.8889e-9*roc*roc+2.4444e-5*roc+.47379;
  const low=slope*p/referencePressure+at10-slope*p10/referencePressure,mid=coeff*(p/referencePressure)**(-.355*ratioCAS+n),high=(-.4204*mach/e.cruiseMach+1.0824)*Math.log(p/referencePressure)+(mach/e.cruiseMach)**(-.11);
  const ratio=mix(mix(low,mid,smooth((h-2800)/500)),high,smooth((h-8800)/700)),flight=e.cruiseThrustN*Math.max(.02,ratio);
  return mix(takeoff,Math.min(e.staticThrustN,flight),smooth((h-500)/2500)*smooth((v-75)/75));
}
