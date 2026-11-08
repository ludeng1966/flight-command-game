import {readFileSync} from 'node:fs';
import {World} from '../../sim/world.js';
import {airportRadioProcedure} from '../../sim/airport-radio-procedure.js';
import {createCommanderTransmission} from '../../sim/commander-message.js';
import {createCommandExchange,pilotUnable} from '../../sim/radio-procedure.js';
import {manualRouteReadback} from '../../game/manual-route-radio.js';
import {PilotExecutionRadio} from '../../game/pilot-execution-radio.js';
import {RadarRadio} from '../../game/radar-radio.js';
import {runCommandSession} from '../../game/command-session.js';

const scenario=JSON.parse(readFileSync(new URL('../../data/scenarios/demo.json',import.meta.url)));
const profiles=JSON.parse(readFileSync(new URL('../../data/aircraft.json',import.meta.url)));
const tick=()=>new Promise(resolve=>setImmediate(resolve));

// Real producers and one complete flight cycle, without cloud AI or audio calls.
export async function radioPronunciationCorpus(){
  const world=new World(scenario,profiles,null,{spawnMode:'stands'}),unit=world.units[1],airport=world.airportOps.airport;
  const events=[...airport.events],messages=[];let lastEvent=events.at(-1)?.id??0;
  const collect=()=>{for(const event of airport.events)if(event.id>lastEvent){events.push({...event});lastEvent=event.id;}};
  const advance=(until,seconds)=>{
    collect();for(let i=0;i<seconds*60&&!until()&&unit.alive;i++){world.step(1/60);collect();}
    if(!unit.alive||!until())throw Error('Pronunciation audit flight did not complete: '+unit.surface?.phase);
  };
  world.airportCommand(unit.id,{intent:'taxi',runway:'09L'});advance(()=>unit.surface.phase==='holding',650);
  world.airportCommand(unit.id,{intent:'takeoff',runway:'09L',altitudeM:1300});advance(()=>unit.position[2]>1250,250);
  world.airportCommand(unit.id,{intent:'land',runway:'09L',gate:'G2'});advance(()=>unit.surface.phase==='parked',1200);
  if(unit.surface.node!=='G2')throw Error('Audit aircraft did not return to G2');
  for(const event of events){
    const message=airportRadioProcedure(event,world.units.find(u=>u.id===event.unitId),airport);
    messages.push({source:'airport-phase',message:{...message,unitId:event.unitId,text:message.texts.zh,language:'zh-CN'},event:event.text});
  }
  const airportOrder={intent:'taxi',airportId:'BAY',runway:'09L',taxiways:['A','A1'],gate:'G2'};
  for(const task of [
    {unitId:unit.id,action:'airport',airportOrder},
    {unitId:unit.id,action:'fly_heading',headingDeg:270,altitudeM:1300,speedMps:600/3.6},
    {unitId:unit.id,action:'join_formation',targetId:world.units[0].id,formation:'trail',side:'right',rangeM:1200}
  ]){
    const plan={status:'accepted',tasks:[task]},transmission=createCommanderTransmission({plan},world.units,'nato');
    messages.push({source:'commander',message:transmission});
    const zh=createCommandExchange(plan,world.units,'pla').pilots[0].readbackText;
    const en=createCommandExchange(plan,world.units,'nato').pilots[0].readbackText;
    messages.push({source:'pilot-readback',message:{speaker:'pilot',unitId:unit.id,text:zh,texts:{zh,en}}});
  }
  const unable={zh:pilotUnable(unit,1,'指定滑行道A1关闭','pla'),en:pilotUnable(unit,1,'TAXIWAY A1 CLOSED','nato')};
  messages.push({source:'pilot-unable',message:{speaker:'pilot',unitId:unit.id,text:unable.zh,texts:unable}});
  messages.push({source:'manual-route',message:manualRouteReadback(world,unit.id,{kind:'clear'},'nato')});
  unit.pilotExecution={id:'pronunciation-audit'};
  const execution=new PilotExecutionRadio({getWorld:()=>world,isBusy:()=>false,radio:{transmit:async message=>{messages.push({source:'pilot-execution',message});}}});
  execution.enqueue({world,unitId:unit.id,executionId:'pronunciation-audit',applied:{throttle:.9,afterburner:false,viaCount:2}});execution.pump();await tick();
  execution.enqueue({world,unitId:unit.id,executionId:'pronunciation-audit',error:'跑道09L不可用'});execution.pump();await tick();
  await runCommandSession({world,expectedRevision:world.revision,style:'nato',signal:new AbortController().signal,
    reply:{requestId:'radio-audit',plan:{status:'accepted',summary:'报告本机状态',tasks:[{unitId:unit.id,action:'report_status',altitudeM:null,speedMps:null,headingDeg:null,eastM:null,northM:null,distanceM:null,append:false}]},interpretation:{orders:[]},execution:{status:'ready'}},
    radio:{phase(){},async transmit(message){messages.push({source:message.speaker==='pilot'?'pilot-result':'commander',message});return {...message,id:'radio-audit'};}},
    checkPilotResult:async()=>({checkedBy:'audit-stub',checks:[{unitId:unit.id,verdict:'reported',readbackText:'机位G2，停车就绪',readbackTexts:{zh:'机位G2，停车就绪',en:'AT STAND G2, PARKED AND READY'}}]})
  });
  const radar=new RadarRadio({getWorld:()=>world,isBusy:()=>false,radio:{transmit:async message=>{messages.push({source:'radar',message});}}});
  const sequence=++unit.radar.sequence;
  unit.radar.events.push({sequence,time:world.time,text:'雷达PD模式，发现目标，方位090，距离12000米'});radar.pump();await tick();
  return {world,airport,events,messages};
}
