import {monitorAttackTasks,cancelAttackTask} from './attack-task.js';
import {density,G,stepFlight,basis,atmosphere} from './flight.js';
import {updatePilot} from './pilot.js';
import {extendHeadingRoute} from './navigation.js';
import {planSafeRoute,traceFlight} from './safe-navigation.js';
import {TACTICAL_INTENTS,ROUTINE_INTENTS} from './pilot-watch.js';
import {createAirport,AirportOperations} from './airport.js';
import {applyPlan} from './orders.js';
import {executionMode} from './execution-policy.js';
import {resolveEntityCollisions,terrainBodyCollision} from './entity-collision.js';
import {updateFormation,leaveFormation,FORMATION_ACTIONS} from './formation.js';
import {createRadar,stepRadars,radarView,applyRadarOrder} from './radar.js';
import {beginPilotExecution} from './pilot-execution.js';
import {configureRouteLoop,extendRouteLoop,captureLoopRoute,restoreLoopRoute} from './route-loop.js';
import {createWeapons,stepWeapons,F16_LOADOUT,F16_LOADOUT_ID} from './weapons.js';
import {stepMissiles,missileModel} from './missiles.js';
import {createRwr,stepRwr} from './rwr.js';
import {createRwrDefense,stepRwrDefense,notePlayerDefenseOrder} from './rwr-defense.js';
import {controlAuthority,updateControlAuthority} from './control-authority.js';
import {initializeMass,updateAircraftMass} from './aircraft-mass.js';
import {applyAtmosphere,updateWeather} from './airport-weather.js';
import {ATC_INTENTS} from './atc-command.js';
import {setAircraftType} from './aircraft-type.js';
export class World {
  constructor(scenario,profiles,terrain=null,{spawnMode='airborne',mode='strict'}={}) {
    Object.defineProperty(this,'profiles',{value:profiles,enumerable:false});
    this.spawnMode=spawnMode;this.radarTargets=[];this.radarTargetSequence=0;
    this.missiles=[];this.missileSequence=0;this.weaponEvents=[];
    this.rwrPracticeEmitters=[];this.rwrPracticeSequence=0;
    this.executionMode=executionMode(mode);
    this.bullseye=scenario.bullseye?structuredClone(scenario.bullseye):null;
    this.time=0;this.ai=0;this.history=0;this.revision=0;this.terrain=terrain;this.commandLog=[];
    if(scenario.airport)this.airportOps=new AirportOperations(createAirport(scenario.airport,terrain));
    this.units=scenario.units.map(s=>{
      const profile=profiles[s.profile],v=s.speed,a=s.heading*Math.PI/180;
      return {...s,profile,aircraftTypeVersion:1,radar:createRadar(s.profile,profile.radar),weapons:createWeapons(s.profile,s.loadout),rwr:createRwr(s.profile,profile.rwr),rwrDefense:createRwrDefense(),position:[...s.position],velocity:[Math.sin(a)*v,Math.cos(a)*v,0],
        bank:0,cl:profile.mass*G/(.5*density(s.position[2])*v*v*profile.area),
        speed:v,mach:v/atmosphere(s.position[2]).soundSpeed,loadFactor:1,throttle:0,afterburner:0,targetAltitude:s.position[2],holdAltitude:s.position[2],targetSpeed:v,
        orbit:[s.position[0]+4000,s.position[1]],waypoints:[],completedWaypoints:0,nextWaypointNumber:1,alive:true,flightState:'normal',recoveryTime:0,terrain,trail:[],trailRevision:0,control:{bank:0,cl:0,throttle:0}};
    });
    this.units.forEach((u,i)=>{initializeMass(u,profiles[scenario.units[i].profile],scenario.units[i].profile,scenario.units[i]);applyAtmosphere(u,this.airportOps?.airport.weather,0);updatePilot(u,0);});
    if(spawnMode==='stands'){
      if(!this.airportOps||this.units.length>this.airportOps.airport.stands.length)throw Error('机位不足，无法安排地面出生');
      this.units.forEach((u,i)=>{const stand=this.airportOps.airport.stands[i];this.airportOps.park(u,stand);this.airportOps.log(u,`${stand}机位就绪，等待指令`);});
    }
    this.units.forEach(u=>controlAuthority(this,u));
  }
  step(dt) {
    this.lastDt=dt;const previous=new Map([...this.units,...this.radarTargets].map(u=>[u.id,[...u.position]]));
    for(const u of this.units){updateAircraftMass(u,dt);applyAtmosphere(u,this.airportOps?.airport.weather,this.time);}
    this.airportOps?.beginFrame?.(this,dt);
    this.ai+=dt;this.history+=dt;
    if(this.ai>=.1){
      for(const u of this.units){const h=Math.atan2(u.velocity[0],u.velocity[1]);u.formationTurnRate=u.lastFormationHeading==null?0:Math.atan2(Math.sin(h-u.lastFormationHeading),Math.cos(h-u.lastFormationHeading))/.1;u.lastFormationHeading=h;}
      this.units.forEach(u=>{updateFormation(this,u,.1);if(u.surface?.grounded||u.surface?.phase==='final')return;extendHeadingRoute(this,u);extendRouteLoop(this,u);this.ensureNavigation(u);updatePilot(u,.1);});this.ai-=.1;
    }
    for(const u of this.units){
      if(!u.alive)continue;
      const before=[...u.position];if(this.airportOps?.step(u,this,dt))continue;stepFlight(u,dt);
      const hit=terrainBodyCollision(u,before,this.terrain)??this.terrain?.collision(before,u.position);
      if(hit){u.position=hit;u.lastPose=basis(u);u.velocity=[0,0,0];u.speed=0;u.alive=false;u.flightState='crashed';u.throttle=0;u.control.throttle=0;u.maneuverMode='触地坠毁';u.trail.push([...hit]);}
    }
    resolveEntityCollisions(this,previous);
    this.time+=dt;
    this.units.forEach(u=>updateControlAuthority(this,u));
    for(const target of this.radarTargets)if(target.alive!==false)target.position=target.position.map((v,i)=>v+target.velocity[i]*dt);
    stepRadars(this,dt);
    stepWeapons(this,dt);stepMissiles(this,dt,previous);monitorAttackTasks(this);
    stepRwr(this,dt);stepRwrDefense(this);
    if(this.history>=.2){for(const u of this.units){u.trail.push([...u.position]);if(u.trail.length>256)u.trail.shift();u.trailRevision++;}this.history-=.2;}
  }
  checkRoute(id,points){
    const u=this.units.find(u=>u.id===id);if(!u.alive)return {valid:false,reason:'飞机已坠毁，无法执行航路'};
    if(points.some(p=>p[2]>(u.profile.limits?.ceilingM??Infinity)))return {valid:false,reason:'航点超出本机型实用升限'};
    if(this.terrain?.checkPoint){for(const point of points){const check=this.terrain.checkPoint(point);if(!check.valid)return check;}return {valid:true,reason:''};}
    return this.terrain?.checkRoute(u.position,points)??{valid:true,reason:''};
  }
  setAircraftType(id,profileId){return setAircraftType(this,id,profileId);}
  setAirportWeather(patch){if(!this.airportOps)throw Error('本场景未配置机场');const result=updateWeather(this.airportOps.airport,patch,this.time);this.airportOps.weatherChanged?.(this);this.revision++;return result;}
  setAltimeter(id,qnhHpa){if(!Number.isFinite(qnhHpa)||qnhHpa<870||qnhHpa>1085)throw Error('气压设置无效');const u=this.units.find(u=>u.id===id);if(!u)throw Error('飞机不存在');u.qnhHpa=qnhHpa;this.revision++;}
  declareAirportEmergency(id,type='fuel'){
    if(!['fuel','engine','gear','medical','radio'].includes(type))throw Error('应急类型无效');const u=this.units.find(u=>u.id===id);if(!u?.alive)throw Error('飞机不存在');
    u.surface??={phase:'airborne',grounded:false,route:[]};u.surface.emergency=true;u.surface.emergencyType=type;u.transponderCode=type==='radio'?'7600':'7700';
    if(type==='radio'&&!this.airportOps.traffic.state.communicationFailures.includes(id))this.airportOps.traffic.state.communicationFailures.push(id);
    if(type==='engine')u.engineFailed=true;
    if(type==='gear')u.gearFailure=true;
    if(type==='radio'&&u.surface.grounded){this.airportOps.traffic.cancelUnit(u,this,'通信失效，保持原位','RADIO FAILURE, HOLD POSITION');u.surface.atcHoldUntil=Infinity;}
    this.airportOps.notice(u,this,'已确认应急，优先安排返场，其他航空器保持间隔','EMERGENCY ACKNOWLEDGED, PRIORITY ARRIVAL. OTHER TRAFFIC MAINTAIN SEPARATION.','approach');this.revision++;
  }
  restoreAirportRadio(id){const u=this.units.find(u=>u.id===id);if(!u)throw Error('飞机不存在');const atc=this.airportOps.traffic,s=atc.state;s.communicationFailures=s.communicationFailures.filter(v=>v!==id);if(u.surface){u.surface.atcHoldUntil=0;if(u.surface.emergencyType==='radio'){u.surface.emergency=false;u.surface.emergencyType=null;u.transponderCode='2000';}if(u.surface.grounded&&u.surface.phase==='taxi'&&u.surface.route.length)atc.issue(u,'taxi',{runway:u.surface.runway,route:[u.surface.node,...u.surface.route],limit:u.surface.destination},this);}atc.resume(this);this.airportOps.notice(u,this,'无线电检查正常，按新许可执行','RADIO CHECK READABILITY FIVE. FOLLOW REVISED CLEARANCE.',u.surface?.station??'approach');this.revision++;}
  cancelAirportNavigation(u){if(this.atcRouteInstall||!u.surface||u.surface.grounded)return;
    if(u.surface.phase==='climb'){u.surface.sidInstalled=true;return;}
    if(!['approach','final','missed'].includes(u.surface.phase))return;
    this.airportOps?.traffic.cancelUnit(u,this,'新飞行任务已接管','NEW FLIGHT TASK HAS CONTROL');for(const q of this.airportOps?.traffic.state.requests??[])if(q.unitId===u.id)q.status='cancelled';u.surface.phase='airborne';u.surface.towerHold=null;
  }
  radarCommand(id,radarOrder){return applyPlan(this,{status:'accepted',summary:'雷达操作',tasks:[{unitId:id,action:'radar',radarOrder}]},this.revision);}
  attackManeuver(id,summary,d){
    const unit=this.units.find(u=>u.id===id);if(unit?.rwrDefense?.active||this.playerCommandPending)throw Error('告警规避或玩家下令中，暂缓自主攻击航向调整');
    this.autonomousCommand=true;try{return applyPlan(this,{status:'accepted',summary,tasks:[{unitId:id,action:'fly_heading',altitudeM:d.altitudeM,speedMps:d.speedMps,headingDeg:d.headingDeg,eastM:null,northM:null,distanceM:null,append:false}]},this.revision);}finally{this.autonomousCommand=false;}
  }
  weaponCommand(id,weaponOrder){return applyPlan(this,{status:'accepted',summary:'武器操作',tasks:[{unitId:id,action:'weapon',weaponOrder}]},this.revision);}
  defenseCommand(id,defenseOrder){return applyPlan(this,{status:'accepted',summary:'告警与自卫',tasks:[{unitId:id,action:'defense',defenseOrder}]},this.revision);}
  addRwrPracticeEmitter(id,mode){
    const u=this.units.find(u=>u.id===id);if(!u?.alive||u.surface?.grounded||!u.rwr?.available)throw Error('请在空中选择具有RWR的飞机');
    this.rwrPracticeEmitters=this.rwrPracticeEmitters.filter(e=>this.time-e.createdAt<=120);
    if(!['search','track','illumination','active'].includes(mode)||this.rwrPracticeEmitters.length>=4)throw Error('告警演练源数量或类型无效');
    const bearing=Math.atan2(u.velocity[0],u.velocity[1])+Math.PI/4;
    const source={id:'rwr-practice-'+(++this.rwrPracticeSequence),ownerId:id,mode,createdAt:this.time,frequencyGHz:8.5,
      position:[u.position[0]+Math.sin(bearing)*10000,u.position[1]+Math.cos(bearing)*10000,u.position[2]+500]};
    this.rwrPracticeEmitters.push(source);this.revision++;return source;
  }
  reloadPracticeMissile(id,modelId){
    const own=this.units.find(u=>u.id===id);missileModel(modelId);
    if(!own?.alive||!own.radar?.available)throw Error('本机未配置导弹演练挂载');
    if(this.missiles.some(m=>m.alive&&m.ownerId===id))throw Error('等待本机在空导弹结束后再调整演练挂载');
    const fixed=own.weapons.loadoutId===F16_LOADOUT_ID;
    if(fixed&&!Object.hasOwn(F16_LOADOUT,modelId))throw Error('F-16固定挂载4枚AIM-120B和2枚AIM-9M，不能装入其他弹型');
    own.weapons.inventory[modelId]=fixed?F16_LOADOUT[modelId]:2;this.revision++;
  }
  addRadarPracticeTarget(id){
    const own=this.units.find(u=>u.id===id);if(!own?.alive||own.surface?.grounded||own.position[2]<500)throw Error('雷达演练请先起飞，或在场景设置中选择空中出生');
    if(!own.radar?.available)throw Error('该机没有可用的搜索雷达，无法安排雷达演练');
    if(this.radarTargets.filter(t=>t.alive!==false).length>=4)throw Error('最多同时安排四架练习靶机');
    const f=own.velocity.slice();f[2]=0;const n=Math.max(1,Math.hypot(...f)),position=own.position.map((v,i)=>v+f[i]/n*15000);position[2]=Math.max(300,own.position[2]-500);
    const ground=this.terrain?.heightAt?.(position[0],position[1]);if(ground!==null&&ground!==undefined)position[2]=Math.max(position[2],ground+300);
    this.radarTargets=this.radarTargets.filter(t=>t.alive!==false);
    const number=++this.radarTargetSequence,target={id:'tgt-'+number,callsign:'TGT '+String(number).padStart(2,'0'),team:'practice',radarPractice:true,
      position,velocity:f.map(v=>-v/n*250),alive:true};
    this.radarTargets.push(target);this.revision++;return target;
  }
  setRadarPracticeAspect(ownId,targetId,aspect){
    const own=this.units.find(u=>u.id===ownId),target=this.radarTargets.find(t=>t.id===targetId);if(!own||!target||!['headon','crossing'].includes(aspect))throw Error('练习靶机或航向无效');
    const d=target.position.map((v,i)=>v-own.position[i]),n=Math.max(1,Math.hypot(d[0],d[1]));
    target.velocity=aspect==='headon'?[-d[0]/n*250,-d[1]/n*250,0]:[d[1]/n*250,-d[0]/n*250,0];this.revision++;
  }
  airportCommand(id,order){if(!this.airportOps)throw Error('本场景未配置机场');const airportOrder={intent:order.intent,airportId:order.airportId??null,runway:order.runway??null,taxiways:order.taxiways??[],gate:order.gate??null,altitudeM:order.altitudeM??null,mode:order.mode??null};return applyPlan(this,{status:'accepted',summary:'机场任务',tasks:[{unitId:id,action:'airport',airportOrder}]},this.revision);}
  spawnAtStand(id,stand){const u=this.units.find(u=>u.id===id);if(!u||!this.airportOps)throw Error('飞机或机场不存在');const point=this.airportOps.airport.nodes[stand];if(!point||this.units.some(v=>v.id!==id&&v.alive&&Math.hypot(...v.position.map((x,i)=>x-point[i]))<20))throw Error('机位占用或不存在');this.airportOps.park(u,stand);delete u.controlAuthority;controlAuthority(this,u);u.sceneResetCount=(u.sceneResetCount??0)+1;this.revision++;}
  recordMilitaryOrder(requestId,interpretation,execution){
    if(!interpretation)return;
    this.commandLog.push({requestId,time:this.time,interpretation,execution});
    if(this.commandLog.length>32)this.commandLog.shift();
    for(const order of interpretation.orders??[]){
      if(order.speechAct!=='directive'||ATC_INTENTS.includes(order.intent))continue;
      for(const id of order.unitIds){
        const unit=this.units.find(u=>u.id===id);if(!unit)continue;
        if(FORMATION_ACTIONS.includes(order.intent)||order.intent==='assign_role')unit.pilotMission=null;
        else if(TACTICAL_INTENTS.includes(order.intent))unit.pilotMission={id:requestId+':'+order.id,intent:order.intent,timing:order.timing,
          condition:order.condition,parameters:structuredClone(order.parameters),revision:this.revision,reviewed:unit.lastPilotResult?.requestId===requestId};
        else if(ROUTINE_INTENTS.includes(order.intent)&&order.intent!=='report_status')unit.pilotMission=null;
      }
    }
  }
  routeKey(u){return JSON.stringify([u.waypoints,u.targetSpeed]);}
  setRouteLoop(id,enabled=true){configureRouteLoop(this,id,enabled);}
  rememberRoute(u){(u.routeUndo??=[]).push(captureLoopRoute(u));if(u.routeUndo.length>30)u.routeUndo.shift();u.routeRedo=[];}
  resolvePlan(u,points,prepared,{resetPower=false}={}){
    const candidate=resetPower?{...u,pilotPowerPlan:null,departurePowerPlan:null}:u;
    if(!prepared)return planSafeRoute(candidate,points,this.terrain);
    const seed=prepared.seed;
    if(!seed||seed.key!==JSON.stringify(points.map(p=>p.slice(0,3)))||seed.targetSpeed!==u.targetSpeed)throw Error('飞行状态已变化，正在重新规划');
    const travel=Math.hypot(...u.position.map((v,i)=>v-seed.position[i]));let cursor=0;
    if(travel>Math.max(150,u.speed*.8)||Math.abs(u.bank-seed.bank)>.3){
      // 允许接入计算期间已经沿原航路前进的部分，只接受位置和速度方向仍贴合新路径的结果。
      let best=Infinity,along=0;const leg=prepared.legs?.[0];
      if(!seed.velocity||travel>u.speed*8||Math.abs(u.speed-seed.speed)>Math.max(12,seed.speed*.08)||Math.abs(u.bank-seed.bank)>.5)throw Error('飞行状态已变化，正在重新规划');
      for(let i=0;leg&&i<leg.length-1&&along<u.speed*10;i++){
        const a=leg[i],delta=leg[i+1].map((v,k)=>v-a[k]),length=Math.hypot(...delta);
        const t=Math.max(0,Math.min(1,delta.reduce((s,v,k)=>s+(u.position[k]-a[k])*v,0)/Math.max(1,length*length)));
        const error=Math.hypot(...a.map((v,k)=>v+delta[k]*t-u.position[k]));
        const alignment=delta.reduce((s,v,k)=>s+v*u.velocity[k],0)/Math.max(1,length*u.speed);
        if(error<best&&alignment>.96){best=error;cursor=i;}along+=length;
      }
      if(best>Math.max(90,u.speed*.65))throw Error('飞行状态已变化，正在重新规划');
    }
    if(prepared.valid){const near=traceFlight(candidate,points,prepared.legs,{duration:14,cursor});if(!near.valid)throw Error('近程轨迹已变化，正在重新规划');}
    return {...prepared,cursor};
  }
  replaceRoute(id,points,{record=true,prepared}={}){
    const u=this.units.find(u=>u.id===id),check=this.checkRoute(id,points);if(!check.valid)throw Error(check.reason);
    const plan=this.resolvePlan(u,points,prepared,{resetPower:true});if(!plan.valid)throw Error(plan.reason);
    if(record)this.rememberRoute(u);this.cancelAirportNavigation(u);
    notePlayerDefenseOrder(this,u);cancelAttackTask(this,u);
    leaveFormation(u,'手动航路已接管，退出编队');
    u.departurePowerPlan=null;
    u.routeLoop=null;u.waypoints=points.map((p,i)=>{const w=p.slice(0,3);w.number=(u.completedWaypoints??0)+i+1;return w;});
    u.nextWaypointNumber=(u.completedWaypoints??0)+points.length+1;u.headingTarget=null;u.headingRoute=null;
    this.revision++;u.routeRevision=(u.routeRevision??0)+1;this.installNavigation(u,plan);beginPilotExecution(this,u);return plan;
  }
  undoRoute(id,redo=false){
    const u=this.units.find(u=>u.id===id),source=redo?u.routeRedo:u.routeUndo;if(!source?.length)return false;
    const points=source.at(-1),current=captureLoopRoute(u);this.replaceRoute(id,points,{record:false});restoreLoopRoute(u,points);
    source.pop();(redo?(u.routeUndo??=[]):(u.routeRedo??=[])).push(current);return true;
  }
  planRoute(id,points,targetSpeed,{resetPower=false}={}){const u=this.units.find(u=>u.id===id);return planSafeRoute({...u,targetSpeed:targetSpeed??u.targetSpeed,...(resetPower?{pilotPowerPlan:null,departurePowerPlan:null}:{})},points,this.terrain);}
  installNavigation(u,plan){
    u.navLegs=plan.legs;u.navCursor=plan.cursor??0;u.navDetour=plan.detour;u.navContinuous=!!plan.continuous;if(u.gateEntered!==u.waypoints[0])u.gateEntered=null;u.navigationBlocked=null;u.safetyOrbit=null;
    u.navigationKey=this.routeKey(u);u.navigationCheckAt=this.time+2;u.navigationRetryAt=this.time+10;u.navigationMessage=plan.reason??'';
  }
  ensureNavigation(u){
    if(u.rwrDefense?.active)return;
    if(!u.alive||!u.waypoints.length||u.flightState!=='normal'||u.navigationPending)return;
    let needs=this.routeKey(u)!==u.navigationKey;
    if(u.navigationBlocked&&this.time>=u.navigationRetryAt)needs=true;
    if(!needs&&!u.navigationBlocked&&this.time>=(u.navigationCheckAt??0)){
      u.navigationCheckAt=this.time+2;
      const trace=traceFlight(u,u.waypoints,u.navLegs??[],{duration:14,cursor:u.navCursor??0});needs=!trace.valid;
    }
    if(!needs)return;
    if(this.deferNavigation){u.navigationKey=this.routeKey(u);u.navigationCheckAt=this.time+2;u.navigationRetryAt=this.time+10;this.deferNavigation(u);return;}
    const plan=this.planRoute(u.id,u.waypoints);
    if(plan.valid)this.installNavigation(u,plan);
    else{
      u.navigationBlocked=plan.reason;u.navigationMessage=`暂缓执行：${plan.reason}`;u.navigationKey=this.routeKey(u);u.navigationRetryAt=this.time+10;
      u.safetyOrbit??=[u.position[0]+4000,u.position[1]];u.safetyAltitude=Math.max(u.position[2],(this.terrain?.heightAt?.(u.position[0],u.position[1])??0)+800);
    }
  }
  command(id,point,append=false,prepared) {
    const u=this.units.find(u=>u.id===id);if(!u)return;
    if(!u.alive)throw Error('飞机已坠毁，无法执行航路');
    const route=append?[...u.waypoints,point]:[point],check=this.checkRoute(id,route);
    if(!check.valid)throw Error(check.reason);
    const plan=this.resolvePlan(u,route,prepared,{resetPower:true});if(!plan.valid)throw Error(plan.reason);
    this.rememberRoute(u);this.cancelAirportNavigation(u);
    notePlayerDefenseOrder(this,u);cancelAttackTask(this,u);
    leaveFormation(u,'新航点已接管，退出编队');
    u.departurePowerPlan=null;
    this.revision++;u.routeRevision=(u.routeRevision??0)+1;u.headingTarget=null;u.headingRoute=null;
    u.routeLoop=null;if(!append){u.waypoints=[];u.completedWaypoints=0;u.nextWaypointNumber=1;u.previousWaypoint=[...u.position];u.captureWaypoint=null;}
    const w=point.slice(0,3);w.number=u.nextWaypointNumber++;u.waypoints.push(w);
    this.installNavigation(u,plan);beginPilotExecution(this,u);return plan;
  }
  moveWaypoint(id,index,point,prepared){
    const u=this.units.find(u=>u.id===id),loopIndex=u.waypoints[index]?.loopIndex,route=u.waypoints.map((w,i)=>i===index||u.routeLoop&&w.loopIndex===loopIndex?point:w);
    const check=this.checkRoute(id,route);if(!check.valid)throw Error(check.reason);
    const plan=this.resolvePlan(u,route,prepared,{resetPower:true});if(!plan.valid)throw Error(plan.reason);
    this.rememberRoute(u);this.cancelAirportNavigation(u);
    notePlayerDefenseOrder(this,u);cancelAttackTask(this,u);
    leaveFormation(u,'航点编辑已接管，退出编队');
    u.departurePowerPlan=null;
    const w=u.waypoints[index];for(const p of u.waypoints)if(p===w||u.routeLoop&&p.loopIndex===loopIndex)p.splice(0,3,...point.slice(0,3));if(u.routeLoop)u.routeLoop.points[loopIndex]=point.slice(0,3);if(u.gateEntered===w)u.gateEntered=null;u.headingRoute=null;u.approachWaypoint=null;this.revision++;u.routeRevision=(u.routeRevision??0)+1;this.installNavigation(u,plan);beginPilotExecution(this,u);return plan;
  }
  forecast(id,route){
    return this.planRoute(id,route);
  }
  snapshot(selectedId,{forecast=true}={}){
    const u=this.units.find(u=>u.id===selectedId),key=JSON.stringify([selectedId,this.revision,Math.floor(this.time),u.waypoints]);
    if(forecast&&this.forecastKey!==key){this.forecastKey=key;this.prediction=u.alive&&u.waypoints.length&&!u.navigationBlocked?traceFlight(u,u.waypoints,u.navLegs??[],{duration:180,cursor:u.navCursor??0}):{points:[],warnings:[]};}
    return {time:this.time,selectedId,prediction:this.prediction,pilotPreview:this.pilotPreview??null,missiles:this.missiles,weaponEvents:this.weaponEvents,radarTargets:this.radarTargets.map(t=>({...t,position:[...t.position],velocity:[...t.velocity]})),units:this.units.map(u=>({...u,radar:radarView(u,this.time),...(u.alive?basis(u):u.lastPose??basis(u))}))};
  }
}
