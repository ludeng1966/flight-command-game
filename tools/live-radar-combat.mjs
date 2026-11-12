import {CommandPlanner} from '../game/command-planner.js';
import {PlannerClient} from '../game/planner-client.js';
import {createFlightWorker} from './node-flight-planner.mjs';
// Explicitly authorized live-model evaluation. Never used by automated tests.
import fs from 'node:fs';
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {World} from '../sim/world.js';
import {installRadarTask} from '../sim/radar-task.js';
import {installAttackTask} from '../sim/attack-task.js';
import {RadarPilot} from '../game/radar-pilot.js';
import {AttackPilot} from '../game/attack-pilot.js';
import {RwrPilot} from '../game/rwr-pilot.js';
import {datalinkContext} from '../sim/datalink.js';
if(!process.argv.includes('--live'))throw Error('Requires --live: this tool calls the configured paid model.');
const arg=(name,fallback)=>process.argv.find(a=>a.startsWith(name+'='))?.slice(name.length+1)??fallback;
const baseUrl=arg('--url','http://127.0.0.1:8003'),selected=arg('--case','all'),output=arg('--output','.game-server/live-radar-combat.json');
const requestLimit=Number(arg('--max-requests','80')),profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const specs=[{id:'search_contact',seconds:120,range:46000,x:8000,altitude:9500,attackAt:16,channelTest:true},
 {id:'crossing_defense',seconds:100,range:28000,x:7000,altitude:6500,attackAt:0,channelTest:false},
 {id:'fire_control',seconds:100,range:30000,x:0,altitude:6500,attackAt:20,channelTest:false,control:true}]
 .filter(s=>selected==='all'?s.id!=='fire_control':s.id===selected).map(s=>({...s,seconds:Number(arg('--seconds',s.seconds))}));
if(!specs.length||!Number.isInteger(requestLimit)||requestLimit<1||requestLimit>150)throw Error('Invalid case/request budget');
const report={createdAt:new Date().toISOString(),localTime:new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}),
 evaluation:'live_radar_combat_v2',model:'configured Flash via actual HTTP endpoints',clockRate:1,node:process.version,cpu:os.cpus()[0].model,
 scope:'Cloud blue pilots vs observed-only local red opponent. Actual World.step, radar v2, missiles, RWR and datalink. Structured scenario tasking; no ASR/TTS or LLM commander.',
 requestLimit,requestCount:0,cases:[],limitations:['small sample; not a win-rate estimate','flat/no terrain scene','judge reads truth only for evaluation, never for model decisions','HTTP modelInvoked is not a billing/token count']};
const copy=v=>structuredClone(v),round=v=>Number.isFinite(v)?Math.round(v*1000)/1000:null;
const stats=values=>{if(!values.length)return {samples:0};const a=[...values].sort((x,y)=>x-y);return {samples:a.length,p50Ms:round(a[Math.floor(a.length*.5)]),p95Ms:round(a[Math.floor(a.length*.95)]),maxMs:round(a.at(-1)),totalMs:round(a.reduce((s,v)=>s+v,0))};};
const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2));
const sanitize=s=>String(s).replace(/sk-[A-Za-z0-9_-]{12,}/g,'[redacted]').slice(0,600);
function setup(spec){
 const world=new World({sensorModelVersion:2,sensorSeed:41,playerTeam:'blue',battleMode:'free_flight',units:[
  {id:'blue-1',callsign:'ALPHA 01',profile:'f16',team:'blue',position:[0,0,6500],heading:0,speed:250},
  {id:'blue-2',callsign:'BRAVO 02',profile:'f16',team:'blue',position:[-5000,-2500,7000],heading:0,speed:250},
  {id:'red-live',callsign:'RED',profile:'f16',team:'red',controllable:false,position:[spec.x,spec.range,spec.altitude],heading:195,speed:250,
   opponent:spec.control?undefined:{enabled:true,policy:'observed_intercept_v1'}}]},profiles);
 for(const u of world.units){u.headingTarget=Math.atan2(u.velocity[0],u.velocity[1]);u.holdAltitude=u.position[2];u.weapons.roe='free';}
 if(spec.control){const red=world.units[2];red.weapons.roe='hold';red.rwrDefense.mode='report_only';for(const key in red.weapons.inventory)red.weapons.inventory[key]=0;}
 for(const u of world.units.filter(u=>u.team==='blue'))installRadarTask(world,u,{goal:'search',targetId:null,targetRef:null});
 return world;
}
async function run(spec){
 const world=setup(spec),wallStarted=performance.now(),initialInventory=Object.fromEntries(world.units.map(u=>[u.id,copy(u.weapons.inventory)]));let playing=true,attacked=false,sampledAt=-1,loggedAt=-10;
 const entry={id:spec.id,spec,startedAt:new Date().toISOString(),requests:[],events:[],frames:[],controls:[],initialInventory,metrics:{},status:'running'};report.cases.push(entry);save();
 const cpu={world:[],radar:[],rwr:[],weapons:[],datalink:[],sensorTick:[],pilotScheduler:[],loopLag:[],maneuverApply:[],maneuverPlanning:[]},lastProbe={},seen=new Set(),first={},defenseEpisodes=new Set(),modelReviews=new Set();
 const commandPlanner=new CommandPlanner(null,{workerFactory:createFlightWorker}),navigationPlanner=new PlannerClient(null,{workerFactory:createFlightWorker});
 const preparePlan=async(...args)=>{const start=performance.now();try{return await commandPlanner.prepare(...args);}finally{cpu.maneuverPlanning.push(performance.now()-start);}};
 world.deferNavigation=(u,{checkOnly=false}={})=>{const key=world.routeKey(u),profile=u.profile;u.navigationPending=true;
  navigationPlanner.request('nav:'+u.id,u,u.waypoints,checkOnly?'check':'plan').then(prepared=>{
   if(u.profile!==profile)return;u.navigationPending=false;if(!playing||world.routeKey(u)!==key||!u.waypoints.length)return;
   if(u.rwrDefense?.active){u.navigationKey=null;return;}
   if(checkOnly){if(prepared?.valid)u.navigationCheckAt=world.time+2;else world.deferNavigation(u);return;}
   try{if(!prepared){u.navigationKey=null;return;}const plan=world.resolvePlan(u,u.waypoints,prepared);if(plan.valid)world.installNavigation(u,plan);else{u.navigationBlocked=plan.reason;u.navigationRetryAt=world.time+10;}}catch{u.navigationKey=null;}
  });
 };
 const originalManeuver=world.attackManeuver;world.attackManeuver=function(...args){const start=performance.now();try{return originalManeuver.apply(this,args);}finally{const ms=performance.now()-start;cpu.maneuverApply.push(ms);if(ms>20)entry.events.push({kind:'blocking_maneuver_apply',time:world.time,elapsedMs:ms,unitId:args[0]});}};
 const probe={now:()=>performance.now(),sample:(key,value)=>{lastProbe[key]=value;cpu[key].push(value);}};
 const pending=new Set(),audit=[];
 const transport=async(path,options)=>{
  if(report.requestCount>=requestLimit)throw Error('Live evaluation HTTP request budget reached');
  report.requestCount++;const input=JSON.parse(options.body),start=performance.now();
  const request={id:input.requestId,path,unitId:input.unitId,taskId:input.taskId??null,issuedAt:world.time,issuedWallMs:start-wallStarted,input};entry.requests.push(request);
  const promise=(async()=>{
   try{const response=await fetch(baseUrl+path,options);const payload=await response.clone().json();request.status=response.status;request.response=payload;request.returnedAt=world.time;
    request.elapsedMs=performance.now()-start;audit.push({request,due:world.time+.15,taskCount:input.context.units.find(u=>u.id===input.unitId)?.attackTask?.decisionCount??input.context.units.find(u=>u.id===input.unitId)?.radarTask?.decisionCount??null});
    return response;
   }catch(error){request.error=sanitize(error.message);request.returnedAt=world.time;request.elapsedMs=performance.now()-start;throw error;}
  })();pending.add(promise);try{return await promise;}finally{pending.delete(promise);}
 };
 const options={getWorld:()=>world,isPlaying:()=>playing,enabled:()=>true,getPilotModel:()=>'flash',fetchImpl:transport,preparePlan};
 const radar=new RadarPilot(options),attack=new AttackPilot(options),rwr=new RwrPilot(options);
 function events(){
  for(const u of world.units){
   for(const [kind,list]of [['radar',u.radar.events],['rwr',u.rwr.events],['attack',u.attackTask?.events??[]]])for(const e of list){
    const key=[u.id,kind,kind==='attack'?u.attackTask?.id??'':'',e.sequence,e.time,e.type].join('|');if(seen.has(key))continue;seen.add(key);entry.events.push({unitId:u.id,kind,...copy(e)});
   }
   const unknown=u.radar.contacts.find(c=>c.classification!=='friendly');if(unknown&&first[u.id]?.detectedAt==null){first[u.id]??={};first[u.id].detectedAt=world.time;first[u.id].contactId=unknown.id;}
   if(u.radar.phase==='locked'){first[u.id]??={};first[u.id].lockedAt??=world.time;}
   const warning=u.rwr.contacts.find(c=>['track','launch'].includes(c.level));if(warning){first[u.id]??={};first[u.id].warningAt??=world.time;}
   if(u.rwrDefense.active){const key=u.id+'|'+u.rwrDefense.active.episodeKey;if(!defenseEpisodes.has(key)){defenseEpisodes.add(key);entry.events.push({unitId:u.id,kind:'defense_started',time:world.time,control:copy(u.rwrDefense.active),source:'program_local_rule'});first[u.id]??={};first[u.id].defenseAt??=world.time;}}
   if(u.rwrDefense.modelReview){const key=u.id+'|'+u.rwrDefense.modelReview.episodeKey+'|'+u.rwrDefense.modelReview.time;if(!modelReviews.has(key)){modelReviews.add(key);entry.events.push({unitId:u.id,kind:'model_defense_review',time:world.time,review:copy(u.rwrDefense.modelReview)});}}
  }
  for(const e of world.weaponEvents){const key=e.id+'|'+e.type+'|'+e.time;if(!seen.has(key)){seen.add(key);entry.events.push({kind:'weapon',...copy(e)});}}
  for(let i=audit.length-1;i>=0;i--)if(world.time>=audit[i].due){const {request,taskCount}=audit.splice(i,1)[0],u=world.units.find(u=>u.id===request.unitId),task=u?.attackTask?.id===request.taskId?u.attackTask:u?.radarTask?.id===request.taskId?u.radarTask:null;
   request.executionAudit={taskStillCurrent:!!task,decisionCountBefore:taskCount,decisionCountAfter:task?.decisionCount??null,lastError:task?.lastError??u?.rwrDefense?.modelError??null,lastAppliedDecision:copy(task?.lastDecision??null)};
  }
 }
 function observe(){
  events();if(world.time-sampledAt<.5)return;sampledAt=world.time;
  entry.frames.push({time:world.time,kind:'judge_truth_and_observation_separated',units:world.units.map(u=>({id:u.id,team:u.team,alive:u.alive,
   judgeTruth:{position:[...u.position],velocity:[...u.velocity]},radar:{mode:u.radar.mode,phase:u.radar.phase,targetId:u.radar.targetId,policy:copy(u.radar.scanPolicy),contacts:u.radar.contacts.map(c=>({id:c.id,classification:c.classification,state:c.state,observedAt:c.observedAt,expectedRevisitAt:c.expectedRevisitAt,position:[...c.position],velocity:[...c.velocity],uncertainty:copy(c.uncertainty),estimationModel:c.estimationModel}))},
   datalink:datalinkContext(u,world.time),defense:copy(u.rwrDefense.active),rwr:u.rwr.contacts.map(c=>({id:c.id,level:c.level,bearingDeg:c.bearingDeg,observedAt:c.observedAt,judgeEmitterKey:c.emitterKey})),
   engagement:copy(u.attackTask?.engagement??null),navigationBlocked:u.navigationBlocked??false,headingTarget:u.headingTarget??null,attackStatus:u.attackTask?.status??null,lastAttackError:u.attackTask?.lastError??null,inventory:copy(u.weapons.inventory),opponentError:u.opponentState?.lastError??null})),missiles:world.missiles.map(m=>({id:m.id,ownerId:m.ownerId,alive:m.alive,phase:m.phase,active:m.active,ageSec:m.ageSec,observedAgeSec:m.observation.ageSec}))});
 }
 try{
  while(playing&&world.time<spec.seconds){
   const wallElapsed=(performance.now()-wallStarted)/1000;if(wallElapsed>spec.seconds+15)throw Error('Real-time loop exceeded wall deadline');
   let steps=0;while(world.time+1/60<=wallElapsed&&steps++<20){
    if(!attacked&&world.time>=spec.attackAt){attacked=true;for(const u of world.units.filter(u=>u.team==='blue'&&u.alive))installAttackTask(world,u,{targetId:null,targetRef:null,weaponRef:null,shotLimit:2,altitudeM:null,speedMps:null,headingDeg:null});entry.controls.push({time:world.time,type:'commander_attack_authorization',target:'observed_nonfriendly_only'});}
    if(spec.channelTest&&world.time>=6&&!entry.channelOff){entry.channelOff=true;world.setDatalink('blue-2',{networkId:'blue-isolated'});entry.controls.push({time:world.time,type:'channel_changed',unitId:'blue-2',network:'blue-isolated'});}
    if(spec.channelTest&&world.time>=12&&!entry.channelOn){entry.channelOn=true;world.setDatalink('blue-2',{networkId:'blue'});entry.controls.push({time:world.time,type:'channel_restored',unitId:'blue-2',network:'blue'});}
    const due=world.units.some(u=>u.radar?.accumulator+1/60>=.05-1e-9),start=performance.now();world.step(1/60,probe);cpu.world.push(performance.now()-start);if(due)cpu.sensorTick.push(lastProbe.radar+lastProbe.rwr);
    observe();if(!world.units.some(u=>u.team==='blue'&&u.alive)||!world.units.some(u=>u.team==='red'&&u.alive)){playing=false;break;}
   }
   const lag=Math.max(0,(wallElapsed-world.time)*1000);cpu.loopLag.push(lag);if(lag>200&&world.time-(entry.lastLagEvent??-1)>1){entry.lastLagEvent=world.time;entry.events.push({kind:'loop_lag',time:world.time,lagMs:lag});}
   const pilotStart=performance.now();radar.tick();attack.tick();rwr.tick();cpu.pilotScheduler.push(performance.now()-pilotStart);
   if(world.time-loggedAt>=10){loggedAt=world.time;save();console.log(JSON.stringify({case:spec.id,simSec:round(world.time),wallSec:round(wallElapsed),requests:entry.requests.length,alive:world.units.filter(u=>u.alive).map(u=>u.id),radars:world.units.map(u=>[u.id,u.radar.phase,u.radar.contacts.length]),missiles:world.missiles.filter(m=>m.alive).length}));}
   await new Promise(resolve=>setTimeout(resolve,5));
  }
  entry.status='completed';
 }catch(error){entry.status='failed';entry.error=sanitize(error.message);}
 finally{
  playing=false;radar.stop();attack.stop();rwr.stop();commandPlanner.cancel();navigationPlanner.dispose();await Promise.allSettled([...pending]);events();
  const launches=entry.events.filter(e=>e.kind==='weapon'&&e.type==='launch'),hits=entry.events.filter(e=>e.kind==='weapon'&&e.type==='hit');
  entry.metrics={wallSec:round((performance.now()-wallStarted)/1000),simulationSec:round(world.time),clockRate:1,first,
   httpRequests:entry.requests.length,modelInvokedResponses:entry.requests.filter(r=>r.response?.modelInvoked===true).length,httpErrors:entry.requests.filter(r=>r.status>=400).length,cancelledOrFailedRequests:entry.requests.filter(r=>r.error).length,
   modelLatency:stats(entry.requests.filter(r=>r.response?.modelInvoked===true).map(r=>r.elapsedMs)),cpu:Object.fromEntries(Object.entries(cpu).map(([k,v])=>[k,stats(v)])),
   launches:launches.map(e=>({time:e.time,ownerId:e.ownerId,quantity:e.quantity??null,text:e.text})),hits:hits.map(e=>({time:e.time,ownerId:e.ownerId,targetId:e.targetId})),
   survivors:world.units.filter(u=>u.alive).map(u=>u.id),finalInventory:Object.fromEntries(world.units.map(u=>[u.id,copy(u.weapons.inventory)])),localDefenseEpisodes:defenseEpisodes.size,modelDefenseReviews:modelReviews.size};
  save();console.log(JSON.stringify({case:spec.id,status:entry.status,metrics:entry.metrics}));
 }
}
const health=await fetch(baseUrl+'/api/health').then(r=>r.json());if(!health.pilotReady)throw Error('Configured cloud pilot is not ready; no live calls made.');
report.model=health.pilotModel??health.commandModel??report.model;save();for(const spec of specs)await run(spec);report.finishedAt=new Date().toISOString();save();
console.log(JSON.stringify({output,requestCount:report.requestCount,cases:report.cases.map(c=>({id:c.id,status:c.status,wallSec:c.metrics.wallSec,simulationSec:c.metrics.simulationSec}))}));
if(report.cases.some(c=>c.status==='failed'))process.exitCode=1;
