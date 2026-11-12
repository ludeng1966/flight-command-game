import fs from 'node:fs';
import {World} from '../sim/world.js';
import {commandContext} from '../sim/orders.js';
import {installRadarTask,radarTaskEvent,applyRadarDecision} from '../sim/radar-task.js';
import {installAttackTask,attackTaskEvent,attackObservation,applyAttackDecision} from '../sim/attack-task.js';
import {searchAssessment} from '../sim/search-assessment.js';
import {stepRwrDefense,applyDefenseRecommendation,defenseReviewSignature} from '../sim/rwr-defense.js';
const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url))),report={cases:[],calls:0};
async function call(kind,body){report.calls++;const response=await fetch('http://127.0.0.1:8000/api/tactical/pilot/'+kind,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:crypto.randomUUID(),pilotModel:'flash',...body}),signal:AbortSignal.timeout(60000)});const result=await response.json();if(!response.ok)throw Error(result.error??response.status);return result;}
function setup(){const w=new World({units:[{id:'blue-1',callsign:'ALPHA',profile:'f16',position:[0,0,6500],heading:0,speed:250}]},profiles);w.attackManeuver('blue-1','搜索巡航',{headingDeg:0,altitudeM:6500,speedMps:250});return w;}
for(const kind of ['radar','attack']){
 const w=setup(),u=w.units[0];if(kind==='radar')installRadarTask(w,u,{goal:'search',targetId:null,targetRef:null});else installAttackTask(w,u,{targetId:null,targetRef:null,weaponRef:null,shotLimit:2,headingDeg:null,altitudeM:null,speedMps:null});
 const task=()=>kind==='radar'?u.radarTask:u.attackTask;
 const request=()=>call(kind,{unitId:u.id,taskId:task().id,context:commandContext(w,u.id),...(kind==='attack'?{observation:attackObservation(w,u)}:{})});
 const apply=r=>{if(!r.decision)throw Error('expected model decision');if(kind==='radar')applyRadarDecision(w,u,r.decision,task().id,r.event);else applyAttackDecision(w,u,r.decision,task().id,task().decisionCount);};
 const decisions=[];let changed=false;
 for(let n=0;n<4;n++){
  const r=await request();decisions.push({time:w.time,event:r.event,decision:r.originalModelDecision??r.decision});apply(r);
  if(r.decision.operation==='maneuver'&&searchAssessment(u,task(),w.time).legSequence>0&&Math.abs(r.decision.headingDeg)>20){changed=true;break;}
  for(let i=0;i<22*60;i++)w.step(1/60);
 }
 report.cases.push({kind,changedSearchHeading:changed,alive:u.alive,decisions});console.log(JSON.stringify({kind,changedSearchHeading:changed,alive:u.alive}));
}
{
 const w=setup(),u=w.units[0];u.rwr.contacts=[{id:'RWR-1',epoch:1,level:'track',signalType:'radar',bearingDeg:0,observedAt:0,firstSeen:0}];stepRwrDefense(w);
 const decisions=[];for(let n=0;n<2;n++){
  const e=u.rwrDefense.episode,r=await call('rwr',{unitId:u.id,episodeKey:e.key,controlSequence:u.rwrDefense.controlSequence,context:commandContext(w,u.id)});decisions.push(r.decision);
  if(r.decision){u.rwrDefense.modelReview={...r.decision,episodeKey:e.key};applyDefenseRecommendation(u,r.decision);e.reviewed=true;e.reviewedAt=w.time;e.reviewSignature=defenseReviewSignature(u,w.time);}
  w.time+=13;u.rwr.contacts[0].observedAt=w.time;stepRwrDefense(w);
 }
 report.cases.push({kind:'rwr',decisions,active:u.rwrDefense.active});console.log(JSON.stringify({kind:'rwr',decisions}));
}
fs.writeFileSync(new URL('../.game-server/search-defense-cloud.json',import.meta.url),JSON.stringify(report,null,2));
if(report.cases.some(c=>c.changedSearchHeading===false))process.exitCode=1;
