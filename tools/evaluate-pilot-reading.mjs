import fs from 'node:fs';
import {World} from '../sim/world.js';
import {commandContext} from '../sim/orders.js';
import {validateContext,createQwenClient} from '../server/qwen.mjs';
import {loadEnv,readConfig,ROOT} from '../server/game-server.mjs';
import {installAttackTask,attackObservation,validateAttackDecision} from '../sim/attack-task.js';
import {installRadarTask,validateRadarDecision} from '../sim/radar-task.js';
import {stepRwrDefense} from '../sim/rwr-defense.js';
import {createAttackPilot,normalizeAttackProposal} from '../server/attack-pilot.mjs';
import {createRadarPilot} from '../server/radar-pilot.mjs';
import {createRwrPilot,validateRwrDecision} from '../server/rwr-pilot.mjs';
import {createRadar} from '../sim/radar.js';
import {stepWeapons} from '../sim/weapons.js';

const dir=ROOT+'/.game-server',beforePath=dir+'/reading-ab-before.json';
fs.mkdirSync(dir,{recursive:true});
const profiles=JSON.parse(fs.readFileSync(ROOT+'/data/aircraft.json'));
const definitions=[
  {id:'attack-empty',role:'attack',want:['radar_mode','maneuver']},
  {id:'attack-datalink-only',role:'attack',want:['radar_mode','maneuver']},
  {id:'attack-select',role:'attack',want:['select']},
  {id:'attack-preparing',role:'attack',want:['wait']},
  {id:'radar-start',role:'radar',want:['mode','scan']},
  {id:'radar-v2-coverage',role:'radar',want:['hold','scan','mode']},
  {id:'defense-active',role:'defense',want:['maintain','notch','extend']},
  {id:'defense-not-started',role:'defense',want:['notch','extend']}
];
function fixture(def){
  const world=new World({units:[{id:'a',callsign:'ALPHA',team:'blue',profile:'f16',position:[0,0,6500],heading:0,speed:250}]},profiles);
  world.time=5;const u=world.units[0];
  if(def.id==='radar-v2-coverage')u.radar=createRadar('f16',{sensorModelVersion:2});
  if(['attack-select','attack-preparing','radar-v2-coverage'].includes(def.id)){
    u.radar.mode='pd';u.radar.contacts=[{id:'T1',callsign:'T1',classification:'unknown',source:'radar',observedAt:5,position:[0,20000,6500],velocity:[0,-250,0],state:'confirmed'}];
    if(def.id==='radar-v2-coverage')u.radar.contacts=[];
    if(def.role==='attack'){u.radar.phase='locked';u.radar.targetId='T1';u.radar.canIlluminate=true;}
    if(def.role==='attack'){const t=world.addRadarPracticeTarget(u.id);t.id='T1';t.position=[0,20000,6500];t.velocity=[0,-250,0];}
  }
  if(def.role==='attack'){
    installAttackTask(world,u,{targetId:null,targetRef:null,weaponRef:null,shotLimit:2,altitudeM:null,speedMps:null,headingDeg:null});
    if(def.id==='attack-preparing'){
      u.attackTask.selectedModelId='us_aim_120b';u.attackTask.status='preparing';
      u.weapons.selectedModelId='us_aim_120b';u.weapons.targetId='T1';u.weapons.ready=false;
      u.attackTask.decisionCount=1;u.attackTask.lastDecisionAt=4;u.attackTask.engagedTargetId='T1';u.attackTask.searchLegEstablished=true;
      u.attackTask.lastDecision={operation:'select'};stepWeapons(world,0);
    }
  }else if(def.role==='radar')installRadarTask(world,u,{goal:'search',targetId:null,targetRef:null});
  else{
    u.rwr.contacts=[{id:'RWR-1',epoch:2,level:'launch',bearingDeg:0,signalType:'active_seeker',observedAt:5,firstSeen:5}];stepRwrDefense(world);
    if(def.id==='defense-not-started'){u.rwrDefense.active=null;delete u.rwrDefense.episode.reviewedAt;}
  }
  const context=commandContext(world,u.id);
  if(def.id==='attack-datalink-only')context.units[0].datalink.contacts=[{id:'DL:b:T1',kind:'track',sourceUnitId:'b',sourceTrackId:'T1',classification:'unknown',position:[0,30000,6500],velocity:[0,-200,0],observedAt:4,receivedAt:4.5,positionErrorM:120,velocityErrorMps:5}];
  return {world,u,context};
}
async function capture(){
  const out=[];
  for(const def of definitions){
    const {world,u,context}=fixture(def);let captured;
    const client={async completePilot(messages,schema,options){captured={messages:structuredClone(messages),schema,maxTokens:options.maxTokens};throw Error('CAPTURE_ONLY');}};
    const service={attack:createAttackPilot,radar:createRadarPilot,defense:createRwrPilot}[def.role](client);
    const input={requestId:'eval-'+def.id,unitId:u.id,context,taskId:(u.attackTask??u.radarTask)?.id,
      observation:def.role==='attack'?attackObservation(world,u):undefined,episodeKey:u.rwrDefense?.episode?.key,controlSequence:u.rwrDefense?.controlSequence};
    try{await service(input);}catch(error){if(error.message!=='CAPTURE_ONLY')throw error;}
    if(!captured)throw Error('Scenario did not invoke model: '+def.id);
    out.push({...def,...captured,unit:validateContext(context).units[0],simTime:world.time});
  }
  return out;
}
function grade(item,value){
  try{
    if(!value||Object.keys(value).some(k=>!Object.hasOwn(item.schema.properties,k)))throw Error('extra fields');
    for(const k of item.schema.required)if(!Object.hasOwn(value,k))throw Error('missing '+k);
    const op=value.operation??value.maneuver;
    if(!item.schema.properties[value.operation?'operation':'maneuver'].enum.includes(op))throw Error('operation enum');
    if(item.role==='attack')validateAttackDecision(value,item.unit,item.simTime);
    else if(item.role==='radar')validateRadarDecision(value,item.unit,item.simTime);
    else{validateRwrDecision(value);if(value.maneuver==='maintain'&&!item.unit.rwrDefense.active)throw Error('maintain without active defense');}
    return {legal:true,expected:item.want.includes(op),operation:op};
  }catch(error){return {legal:false,expected:false,operation:value?.operation??value?.maneuver,error:error.message};}
}
const quantile=(a,p)=>a.slice().sort((a,b)=>a-b)[Math.max(0,Math.ceil(a.length*p)-1)]??null;
if(process.argv.includes('--capture-after')){
  fs.writeFileSync(dir+'/reading-ab-after.json',JSON.stringify(await capture(),null,2));
  console.log(JSON.stringify({saved:'reading-ab-after.json',cloudCalls:0}));
}else if(process.argv.includes('--refresh-fixtures')){
  const old=JSON.parse(fs.readFileSync(beforePath)),current=await capture();
  fs.writeFileSync(beforePath,JSON.stringify(current.map((item,i)=>{if(item.id!==old[i].id)throw Error('scenario order changed');return {...item,messages:[old[i].messages[0],...item.messages.slice(1)]};}),null,2));
  console.log(JSON.stringify({refreshed:current.length,baselineSystem:'preserved',sharedInput:'updated for both variants'}));
}else if(process.argv.includes('--capture-before')){
  const cases=await capture();fs.writeFileSync(beforePath,JSON.stringify(cases,null,2));
  console.log(JSON.stringify({captured:cases.length,file:beforePath}));
}else if(process.argv.includes('--run')){
  const before=JSON.parse(fs.readFileSync(beforePath)),after=await capture();
  fs.writeFileSync(dir+'/reading-ab-after.json',JSON.stringify(after,null,2));
  loadEnv(ROOT+'/.env');const config=readConfig();if(!config.apiKey)throw Error('Cloud model credentials are not configured');
  const results=[],rounds=Number(process.env.READING_EVAL_ROUNDS??2);
  for(let round=0;round<rounds;round++)for(let i=0;i<after.length;i++){
    if(JSON.stringify(before[i].messages[1])!==JSON.stringify(after[i].messages[1])||JSON.stringify(before[i].schema)!==JSON.stringify(after[i].schema))throw Error('A/B input or schema mismatch: '+after[i].id);
    for(const variant of (round+i)%2?['after','before']:['before','after']){
      const item=(variant==='before'?before:after)[i];let usage;
      const client=createQwenClient(config,async(...args)=>{const response=await fetch(...args);if(response.ok)usage=(await response.clone().json()).usage;return response;});
      const started=performance.now();let row={round,id:item.id,role:item.role,variant,systemChars:item.messages[0].content.length};
      try{const result=await client.completePilot(item.messages,item.schema,{maxTokens:item.maxTokens}),applied=grade(item,item.role==='attack'?normalizeAttackProposal(result.value).decision:result.value);row={...row,...grade(item,result.value),acceptedLegal:applied.legal,taskAppropriate:applied.expected,value:result.value,ms:performance.now()-started,usage};}
      catch(error){row={...row,legal:false,expected:false,error:error.message,ms:performance.now()-started,usage};}
      results.push(row);fs.writeFileSync(dir+'/reading-ab-results.json',JSON.stringify({model:config.pilotModel,rounds,results},null,2));
      console.log(JSON.stringify({round:round+1,id:row.id,variant,legal:row.legal,expected:row.expected,ms:Math.round(row.ms),error:row.error}));
    }
  }
  const summary=Object.fromEntries(['before','after'].map(v=>{const r=results.filter(x=>x.variant===v);return [v,{calls:r.length,legal:r.filter(x=>x.legal).length,expected:r.filter(x=>x.expected).length,acceptedLegal:r.filter(x=>x.acceptedLegal).length,taskAppropriate:r.filter(x=>x.taskAppropriate).length,medianMs:quantile(r.map(x=>x.ms),.5),p95Ms:quantile(r.map(x=>x.ms),.95),promptTokens:r.reduce((a,x)=>a+(x.usage?.prompt_tokens??0),0),completionTokens:r.reduce((a,x)=>a+(x.usage?.completion_tokens??0),0),averageSystemChars:Math.round(r.reduce((a,x)=>a+x.systemChars,0)/r.length)}];}));
  fs.writeFileSync(dir+'/reading-ab-summary.json',JSON.stringify({model:config.pilotModel,rounds,summary},null,2));console.log(JSON.stringify({model:config.pilotModel,summary}));
}else throw Error('Use --capture-before before editing, then --run after editing');
