import {G,stepFlight,flightSafety} from './flight.js';
import {updatePilot} from './pilot.js';
import {energyEnvelope} from './energy.js';
import {throughWaypoints,rejoinWaypoints} from './route-continuity.js';

const distance=(a,b)=>Math.hypot(...b.map((v,i)=>v-a[i]));
const TAU=Math.PI*2,mod=x=>(x%TAU+TAU)%TAU;

function turnLeg(origin,heading,goal,radius,side){
  const center=[origin[0]+Math.cos(heading)*radius*side,origin[1]-Math.sin(heading)*radius*side];
  const dx=goal[0]-center[0],dy=goal[1]-center[1],d=Math.hypot(dx,dy);
  const theta0=Math.atan2(origin[1]-center[1],origin[0]-center[0]),theta=Math.atan2(dy,dx);
  if(d<radius-1)return null;
  let best=null;
  for(const sign of [-1,1]){
    const end=theta+sign*Math.acos(Math.min(1,radius/d)),point=[center[0]+radius*Math.cos(end),center[1]+radius*Math.sin(end)];
    const tangent=[side*Math.sin(end),-side*Math.cos(end)];
    if(d>radius+1&&tangent[0]*(goal[0]-point[0])+tangent[1]*(goal[1]-point[1])<=0)continue;
    let arc=mod(side*(theta0-end));if(arc>TAU-.01)arc=0;
    const length=arc*radius+Math.hypot(goal[0]-point[0],goal[1]-point[1]);
    best={arc,length};break;
  }
  if(!best)return null;
  const arc=best.arc,points=[[...origin]],steps=Math.max(1,Math.ceil(arc*radius/220));
  for(let i=1;i<=steps;i++){const angle=theta0-side*arc*i/steps;points.push([center[0]+radius*Math.cos(angle),center[1]+radius*Math.sin(angle),origin[2]]);}
  const start=points.at(-1),count=Math.max(1,Math.ceil(Math.hypot(goal[0]-start[0],goal[1]-start[1])/400));
  for(let i=1;i<=count;i++)points.push([start[0]+(goal[0]-start[0])*i/count,start[1]+(goal[1]-start[1])*i/count,goal[2]]);
  return points;
}

const pathLength=path=>path.slice(1).reduce((sum,p,i)=>sum+distance(path[i],p),0);
function directLeg(origin,goal){const count=Math.max(1,Math.ceil(distance(origin,goal)/400));return Array.from({length:count+1},(_,i)=>origin.map((v,k)=>v+(goal[k]-v)*i/count));}
function extendLeg(origin,heading,goal,radius,side,angle){
  const center=[origin[0]+Math.cos(heading)*radius*side,origin[1]-Math.sin(heading)*radius*side];
  const theta=Math.atan2(origin[1]-center[1],origin[0]-center[0]),count=Math.max(1,Math.ceil(angle*radius/220));
  const prefix=Array.from({length:count+1},(_,i)=>{const t=theta-side*angle*i/count;return [center[0]+radius*Math.cos(t),center[1]+radius*Math.sin(t),origin[2]];});
  if(Math.hypot(goal[0]-origin[0],goal[1]-origin[1])<10&&Math.abs(angle/TAU-Math.round(angle/TAU))<.001){prefix[prefix.length-1]=[...goal];return prefix;}
  const end=prefix.at(-1),bearing=heading+side*angle;
  const tails=[1,-1].map(s=>turnLeg(end,bearing,goal,radius,s)).filter(Boolean).sort((a,b)=>pathLength(a)-pathLength(b));
  return tails.length?[...prefix,...tails[0].slice(1)]:null;
}

function fitAltitude(points,origin,goal,terrain,limits){
  const lengths=[0];for(let i=1;i<points.length;i++)lengths.push(lengths.at(-1)+Math.hypot(points[i][0]-points[i-1][0],points[i][1]-points[i-1][1]));
  const length=lengths.at(-1);
  if(length<1&&Math.abs(goal[2]-origin[2])>250)return false;
  for(let i=0;i<points.length;i++){
    const t=lengths[i]/Math.max(1,length),ground=terrain?.heightAt?.(points[i][0],points[i][1]);
    if(ground===null)return false;
    const margin=100+180*Math.min(1,lengths[i]/2000,(length-lengths[i])/2000);
    const blend=t*t*(3-2*t);
    points[i][2]=Math.max(origin[2]+(goal[2]-origin[2])*blend,ground===undefined?-Infinity:ground+margin);
  }
  for(let i=points.length-2;i>=0;i--)points[i][2]=Math.max(points[i][2],points[i+1][2]-(lengths[i+1]-lengths[i])*limits.climb);
  for(let i=1;i<points.length;i++)points[i][2]=Math.max(points[i][2],points[i-1][2]-(lengths[i]-lengths[i-1])*limits.descent);
  if(points[0][2]>origin[2]+1||points.at(-1)[2]>goal[2]+1)return false;
  points[0]=[...origin];points[points.length-1]=[...goal];
  if(terrain?.checkSegment)for(let i=1;i<points.length;i++)if(!terrain.checkSegment(points[i-1],points[i],100).valid)return false;
  return true;
}

function cloneUnit(original,goals,legs){
  // Forecast the candidate route after takeover, not an unbounded old defensive overlay.
  // The real aircraft keeps evading until the new route is validated and committed.
  const u={...original,formation:null,formationGuidance:null,rwrDefense:null,position:[...original.position],velocity:[...original.velocity],orbit:[...original.orbit],
    surface:original.surface?{...original.surface,towerHold:null}:undefined,
    departurePowerPlan:original.departurePowerPlan?structuredClone(original.departurePowerPlan):null,
    pilotPowerPlan:original.pilotPowerPlan?structuredClone(original.pilotPowerPlan):null,
    waypoints:goals.map(w=>[...w]),navLegs:legs.map(leg=>Object.assign(leg.map(p=>[...p]),Number.isInteger(leg.recoveryEndIndex)?{recoveryEndIndex:leg.recoveryEndIndex}:{})),navCursor:0,headingTarget:null,
    navigationBlocked:null,control:{...original.control},energy:original.energy?{...original.energy}:undefined,guidance:original.guidance?{...original.guidance}:undefined,trail:[],completedWaypoints:0};
  const captured=original.gateEntered&&original.gateEntered===original.waypoints?.[0]?original.waypoints[0]:original.gateCaptured?original.gatePosition:null;
  u.gateEntered=captured&&goals[0]?.every((v,k)=>Math.abs(v-captured[k])<.001)?u.waypoints[0]:null;
  return u;
}
const needsRecovery=u=>{const safety=flightSafety(u);return u.flightState==='stall-recovery'||safety.stalled||safety.severeLowSpeed;};
function advancePrediction(u,dt){updatePilot(u,dt);const steps=Math.max(1,Math.ceil(dt/(1/60)));for(let i=0;i<steps;i++)stepFlight(u,dt/steps);}

// 当前状态已需要改出时，先用同一飞控和气动内核模拟恢复，不把它算作新航路引起的失速。
function recoveryEntry(original,terrain){
  const u=cloneUnit({...original,terrain},[],[]),points=[u.position.slice()];let seconds=0;
  while(seconds<90){
    const before=u.position.slice();advancePrediction(u,.1);seconds+=.1;
    const ground=terrain?.heightAt?.(u.position[0],u.position[1]),hit=terrain?.collision?.(before,u.position);
    if(ground===null||hit||ground!==undefined&&u.position[2]-ground<100)return {valid:false,reason:'当前失速改出的地形净空不足，无法安全接入航路'};
    if(!u.position.every(Number.isFinite))return {valid:false,reason:'当前飞行状态无法完成改出预测'};
    if(Math.round(seconds*10)%5===0)points.push(u.position.slice());
    if(!needsRecovery(u)){if(Math.hypot(...points.at(-1).map((v,i)=>v-u.position[i]))>.01)points.push(u.position.slice());return {valid:true,unit:u,points,seconds};}
  }
  return {valid:false,reason:'当前飞机未能完成失速改出，暂缓航路'};
}

export function traceFlight(original,goals,legs,{duration=900,dt=.1,cursor=0,settle=15}={}){
  const u=cloneUnit(original,goals,legs);u.navCursor=cursor;
  const initialRecovery=needsRecovery(u);let recovering=initialRecovery,recoverySeconds=0;
  const points=[[...u.position]],warnings=new Set();let peakG=0,minAgl=Infinity,time=0,finishedAt=null,missionDistance=0,afterburnerSeconds=0,smoothness=0,lastG=u.loadFactor??1,minSpeed=Infinity,speedDeficitDistance=0;
  for(let i=0;i<Math.ceil(duration/dt);i++){
    if(!u.waypoints.length){finishedAt??=time;if(time-finishedAt>=settle)break;}
    const before=[...u.position];advancePrediction(u,dt);
    time+=dt;peakG=Math.max(peakG,u.loadFactor);
    // A proposed capped-power route cannot rely on protection silently lifting
    // that cap. Emergency control remains available in live flight, but such a
    // forecast is not evidence that the proposed plan is feasible.
    const power=original.pilotPowerPlan;
    if(finishedAt===null&&power?.active&&(u.control.throttle>power.throttle+1e-5||(u.control.afterburner??0)>power.afterburner+1e-5)){
      warnings.add('所规划推力无法完成航路，需要提高可用推力或延长平缓航段');break;
    }
    if(finishedAt===null){missionDistance+=distance(before,u.position);afterburnerSeconds+=(u.afterburner??0)*dt;smoothness+=Math.abs(u.loadFactor-lastG);lastG=u.loadFactor;minSpeed=Math.min(minSpeed,u.speed);speedDeficitDistance+=Math.max(0,u.targetSpeed*.9-u.speed)*dt;}
    if(i%5===0)points.push([...u.position]);
    if(u.stalled||u.flightState==='stall-recovery'){
      if(!recovering){warnings.add('失速风险');break;}
      recoverySeconds=time;if(time>=90){warnings.add('当前失速改出未完成');break;}
    }else if(recovering){recovering=false;recoverySeconds=time;}
    if(u.terrain?.heightAt){
      const ground=u.terrain.heightAt(u.position[0],u.position[1]);
      const hit=u.terrain.collision?.(before,u.position);minAgl=Math.min(minAgl,u.position[2]-(ground??-Infinity));
      if(ground===null||hit||minAgl<100){warnings.add(ground===null?'预计飞出地图范围':'预计轨迹与地形冲突');if(hit)points.push(hit);break;}
    }
    if(!u.position.every(Number.isFinite)){warnings.add('飞行状态不可用');break;}
  }
  return {valid:!warnings.size,completed:u.waypoints.length===0,points,warnings:[...warnings],peakG,minAgl,time,missionDistance,afterburnerSeconds,smoothness,minSpeed,speedDeficitDistance,initialRecovery,recoverySeconds,recovering};
}

export function planSafeRoute(original,goals,terrain){
  if(!goals.length)return {valid:true,legs:[],points:[],warnings:[],detour:false};
  if(terrain?.checkPoint){for(const p of goals){const check=terrain.checkPoint(p);if(!check.valid)return {valid:false,reason:check.reason,points:[],warnings:[check.reason]};}}
  else if(terrain?.checkRoute){const check=terrain.checkRoute(original.position,goals);if(!check.valid)return {...check,points:[],warnings:[check.reason]};}
  if(needsRecovery(original)){
    const entry=recoveryEntry(original,terrain);
    if(!entry.valid)return {valid:false,reason:entry.reason,points:[],warnings:[entry.reason],legs:[]};
    const tail=planSafeRoute(entry.unit,goals,terrain);if(!tail.valid)return tail;
    const legs=[...tail.legs];legs[0]=Object.assign([...entry.points,...legs[0].slice(1)],{recoveryEndIndex:entry.points.length-1});
    const length=legs.reduce((sum,leg)=>sum+pathLength(leg),0),trace=traceFlight({...original,terrain},goals,legs,{duration:Math.min(1800,Math.max(180,length/Math.max(100,original.targetSpeed)*2+100+entry.seconds))});
    if(!trace.valid||!trace.completed){const reason=trace.warnings.join('、')||'改出后仍无法安全到达航点';return {valid:false,reason,points:trace.points,warnings:[reason],legs:[]};}
    return {...tail,legs,points:trace.points,routeLength:trace.missionDistance,peakG:trace.peakG,minAgl:trace.minAgl,afterburnerSeconds:trace.afterburnerSeconds,initialRecovery:true,recoverySeconds:entry.seconds,reason:'先自动改出恢复速度，再衔接安全航路'};
  }
  const V=Math.max(90,Math.hypot(...original.velocity)),startEnvelope=energyEnvelope(original.profile,original.position[2],V);
  let failure='没有找到可安全到达的路径',best=null;
  const candidates=[],seen=new Set();
  const direct=goals.reduce((sum,p,i)=>sum+distance(i?goals[i-1]:original.position,p),0);
  const continuations=[rejoinWaypoints(original,goals,terrain),goals.length>1?throughWaypoints(original,goals,terrain):null].filter(Boolean);
  for(const legs of continuations){
    if(legs){
      const length=legs.reduce((sum,leg)=>sum+pathLength(leg),0);
      const trace=traceFlight({...original,terrain},goals,legs,{duration:Math.min(1800,Math.max(180,length/Math.max(100,original.targetSpeed)*2+100))});
      // 已接近必须经过各门点的直线下界，且没有明显掉速时，避免再枚举数十条绕行方案。
      if(trace.valid&&trace.completed&&trace.missionDistance<=direct*1.06&&trace.minSpeed>=Math.max(90,original.targetSpeed*.85))return {valid:true,legs,points:trace.points,warnings:[],peakG:trace.peakG,minAgl:trace.minAgl,routeLength:trace.missionDistance,afterburnerSeconds:trace.afterburnerSeconds,continuous:true,detour:false,reason:'连续通过航点，提前协调转弯 / 爬升'};
      candidates.push({legs,length,setting:{through:true,angle:0},trace});
    }
  }
  const settings=[{direct:true},...[1.6,2.2,3].flatMap(g=>[1,-1].map(side=>({g,side,angle:0}))),
    ...[Math.PI/6,Math.PI/3,Math.PI/2,Math.PI*2/3,Math.PI].flatMap(angle=>[1,-1].map(side=>({g:3,side,angle}))),
    ...[-1,1].flatMap(via=>[1,-1].map(side=>({g:2.2,side,via,angle:0}))),
    ...[Math.PI/3,Math.PI*2/3,Math.PI,TAU,TAU*2,TAU*3].flatMap(angle=>[1,-1].map(side=>({g:2.2,side,angle})))];
  for(const setting of settings){
    let origin=[...original.position],heading=Math.atan2(original.velocity[0],original.velocity[1]),legs=[],okay=true;
    for(const [index,goal] of goals.entries()){
      const envelope=energyEnvelope(original.profile,Math.max(origin[2],goal[2]),V);
      const n=Math.max(1.25,Math.min(setting.g??2.2,startEnvelope.budgetG*.94,envelope.budgetG*.94));
      const radius=Math.max(400,V*V/(G*Math.sqrt(n*n-1)))*1.06;
      const limits={climb:Math.max(.025,Math.min(.32,envelope.climbRate(Math.min(n,1.5),0,true)/V*.8)),descent:.25};
      const dx=goal[0]-origin[0],dy=goal[1]-origin[1],span=Math.hypot(dx,dy);
      const offset=Math.max(radius*1.7,span*.25),via=[(origin[0]+goal[0])/2+dy/Math.max(1,span)*offset*(setting.via??0),(origin[1]+goal[1])/2-dx/Math.max(1,span)*offset*(setting.via??0),Math.max(origin[2],goal[2])];
      let at=origin,bearing=heading,leg=[];
      for(const target of setting.via?[via,goal]:[goal]){
        let options;
        if(setting.direct)options=[directLeg(at,target)];
        else if(index===0&&!leg.length&&setting.angle)options=[extendLeg(at,bearing,target,radius,setting.side,setting.angle)];
        else options=(index===0&&!leg.length?[setting.side]:[1,-1]).map(side=>turnLeg(at,bearing,target,radius,side));
        options=options.filter(path=>path&&fitAltitude(path,at,target,terrain,limits)).sort((a,b)=>pathLength(a)-pathLength(b));
        const part=options[0];if(!part){okay=false;break;}
        const previous=part.at(-2);bearing=Math.atan2(target[0]-previous[0],target[1]-previous[1]);at=target;leg.push(...(leg.length?part.slice(1):part));
      }
      if(!okay)break;
      legs.push(leg);const previous=leg.at(-2);heading=Math.atan2(goal[0]-previous[0],goal[1]-previous[1]);origin=[...goal];
    }
    if(!okay)continue;
    const length=legs.reduce((sum,leg)=>sum+pathLength(leg),0),key=legs.map(leg=>leg.map(p=>p.map(v=>Math.round(v/30)).join(',')).join(';')).join('|');
    if(!seen.has(key)){
      seen.add(key);const candidate={legs,length,setting};
      if(setting.direct){
        const trace=traceFlight({...original,terrain},goals,legs,{duration:Math.min(1800,Math.max(180,length/Math.max(100,original.targetSpeed)*2+100))});candidate.trace=trace;
        if(goals.length===1&&trace.valid&&trace.completed&&trace.missionDistance<=direct+goals.length*120)return {valid:true,legs,points:trace.points,warnings:[],peakG:trace.peakG,minAgl:trace.minAgl,routeLength:trace.missionDistance,afterburnerSeconds:trace.afterburnerSeconds,detour:false,reason:'采用直接安全路径'};
      }
      candidates.push(candidate);
    }
  }
  candidates.sort((a,b)=>a.length-b.length);
  for(const candidate of candidates){
    const {legs,length,setting}=candidate;
    if(best&&length>best.trace.missionDistance*1.03+Math.max(1500,goals.length*500))continue;
    const trace=candidate.trace??traceFlight({...original,terrain},goals,legs,{duration:Math.min(1800,Math.max(180,length/Math.max(100,original.targetSpeed)*2+100))});
    if(trace.valid&&trace.completed){
      const quality=trace.missionDistance+2*trace.speedDeficitDistance+25*trace.smoothness+5*trace.afterburnerSeconds;
      if(!best||trace.missionDistance<best.trace.missionDistance*.97||(trace.missionDistance<best.trace.missionDistance*1.03&&quality<best.quality))best={...candidate,trace,quality};
      if(goals.length===1&&trace.missionDistance<=direct+goals.length*120)break;
    }else failure=trace.warnings.join('、')||'当前速度 / 高度下无法完成航路，暂缓执行';
  }
  if(best){
    const {trace,legs,setting}=best,detour=trace.missionDistance>direct*1.15+250;
    return {valid:true,legs,points:trace.points,warnings:[],peakG:trace.peakG,minAgl:trace.minAgl,routeLength:trace.missionDistance,afterburnerSeconds:trace.afterburnerSeconds,detour,
      continuous:!!setting.through,reason:setting.through?'连续通过航点，提前协调转弯 / 爬升':detour?(setting.angle>=TAU?'能量 / 高度需要，采用盘旋延长':'采用较短的安全迂回路径'):'采用最短候选安全路径'};
  }
  return {valid:false,reason:`安全规划未通过：${failure}`,points:[],warnings:[failure],legs:[]};
}
