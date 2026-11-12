import {trackUsable} from './radar-quality.js';
import {motorState,missileDragArea,lineClear} from './missiles.js';
import {density,atmosphere,G} from './flight.js';
const norm=v=>{const n=Math.hypot(...v);return v.map(x=>x/Math.max(1,n));};
const round=n=>Math.round(n*10)/10;
// Deterministic, inexpensive opportunity estimate, not a probability of kill.
// Uses the same game's motor/drag data, with a straight path and constant target
// velocity. Full guidance, target response and countermeasures are excluded.
export function estimateShotQuality(own,track,model,time,terrain=null,terrainClear=null){
  const assumptions=['目标保持最后观测速度','直线路径、无制导转弯损耗','采用本游戏推力/质量/阻力近似','预测时窗最多180秒','不含目标规避、对抗措施或命中概率'];
  if(!terrain&&terrainClear===null)assumptions.push('未提供地形采样，地形条件需执行器复核');
  const support=model.kind==='semi_active_radar'?'continuous_radar':model.kind==='active_radar'?'radar_until_active':'none';
  const base={method:'game_point_mass_constant_velocity_v1',confidence:'approximation',assumptions,supportRequirement:support};
  if(!track||!track.position?.every(Number.isFinite)||!track.velocity?.every(Number.isFinite))return {...base,rating:'unknown',reason:'没有可用观测，不能评估发射窗口',reasons:['missing_observation'],interceptSec:null,terminalSpeedMps:null,supportSec:null};
  if(track.sensorModelVersion===2&&Math.max(...track.uncertainty.velocitySigmaMps)>30)return {...base,rating:'unknown',reason:'速度估计尚未收敛，继续观测',reasons:['uncertain_kinematics'],interceptSec:null,terminalSpeedMps:null,supportSec:null};
  const age=Math.max(0,time-track.observedAt),start=own.position,position=track.position.map((v,i)=>v+track.velocity[i]*age),delta=position.map((v,i)=>v-start[i]),rangeM=Math.hypot(...delta),direction=norm(delta);
  const reasons=[];if(!trackUsable(track,time))reasons.push('stale_observation');
  if(terrainClear===false||!lineClear(terrain,start,position))reasons.push('terrain_blocked');
  let speed=Math.max(1,(model.launch.useStartSpeed?Math.hypot(...own.velocity):0)+(model.launch.initialSpeedMps??0)),travel=0,interceptSec=null,terminalSpeedMps=null,activationSec=null;
  const horizon=Math.min(180,model.lifetimeSec??180),step=.25,maxTravel=model.simulationLimits.maxTravelM??Infinity;
  for(let t=step;t<=horizon;t+=step){
    const target=position.map((v,i)=>v+track.velocity[i]*t),distance=Math.hypot(...target.map((v,i)=>v-start[i]));
    const altitude=Math.max(0,start[2]+direction[2]*Math.min(travel,distance)),motor=motorState(model,t-step/2),drag=.5*density(altitude)*speed*speed*missileDragArea(model,speed/atmosphere(altitude).soundSpeed);
    speed=Math.max(0,speed+((motor.thrustN-drag)/motor.massKg-G*direction[2])*step);
    if(model.simulationLimits.speedLimitMps)speed=Math.min(speed,model.simulationLimits.speedLimitMps);
    travel+=speed*step;
    if(travel>maxTravel)break;
    if(activationSec===null&&distance-travel<=(model.guidance.lockDistanceM??model.guidance.radar?.receiver?.range??0))activationSec=t;
    if(travel>=distance){interceptSec=round(t);terminalSpeedMps=round(speed);break;}
  }
  if(interceptSec===null)reasons.push('no_intercept_within_model_limits');
  else if(interceptSec<(model.proximityFuse.armingDelaySec??0))reasons.push('before_fuse_armed');
  const reserve=terminalSpeedMps===null?null:round(terminalSpeedMps-Math.hypot(...track.velocity));
  if(reserve!==null&&reserve<80)reasons.push('low_terminal_speed_margin');
  if(Math.acos(Math.max(-1,Math.min(1,direction.reduce((s,v,i)=>s+v*norm(own.velocity)[i],0))))*180/Math.PI>(model.seeker.lockAngleDeg??30))reasons.push('outside_launch_angle');
  const blocked=reasons.some(r=>['terrain_blocked','stale_observation','before_fuse_armed','outside_launch_angle'].includes(r));
  const rating=blocked?'blocked':interceptSec===null?'poor':reserve<80?'marginal':'favorable';
  const labels={stale_observation:'航迹过期',terrain_blocked:'观测连线被地形遮挡',no_intercept_within_model_limits:'近似模型在预测时窗/寿命/航程限制内未能拦截',before_fuse_armed:'预计近遇早于保险解除',low_terminal_speed_margin:'预计末段速度余量偏低',outside_launch_angle:'目标超出发射截获角'};
  return {...base,rating,reason:reasons.length?reasons.map(r=>labels[r]).join('；'):'简化模型可形成拦截窗口，仍不保证命中',reasons,terrainClear:!reasons.includes('terrain_blocked'),observationAgeSec:round(age),rangeM:round(rangeM),interceptSec,terminalSpeedMps,terminalSpeedMarginMps:reserve,
    supportSec:support==='none'?0:support==='continuous_radar'?interceptSec:activationSec===null?interceptSec:round(activationSec)};
}
