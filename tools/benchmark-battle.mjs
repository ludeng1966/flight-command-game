// Offline deterministic smoke benchmark: no network, credentials or LLM calls.
import fs from 'node:fs';
import {World} from '../sim/world.js';
import {makeOpponentScenario} from '../sim/opponent.js';
import {MISSILE_MODELS} from '../sim/missiles.js';
const profiles=JSON.parse(fs.readFileSync(new URL('../data/aircraft.json',import.meta.url)));
const base={units:[{id:'blue-1',callsign:'ALPHA',profile:'f16',position:[0,0,6500],heading:0,speed:250}]};
const cases=[
  {id:'observed_intercept',seconds:90,description:'恒定初始迎头条件，蓝方默认本地RWR自卫'},
  {id:'crossing_after_contact',seconds:90,description:'第8秒蓝方开始向东转弯，观察实际航迹丢失与重新截获',tick(w){if(w.time>=8&&!w.benchmarkTurn){const u=w.units[0];u.headingTarget=Math.PI/2;u.holdAltitude=6500;w.benchmarkTurn=true;}}},
  {id:'unobserved_target',seconds:45,description:'蓝方从红方后方远距起始，红方不可凭真值转向',setup(w){w.units[0].position=[0,110000,6500];}},
  {id:'empty_stores',seconds:45,description:'红方无弹起始，验证脱离和不产生虚假发射',setup(w){for(const id in w.units[1].weapons.inventory)w.units[1].weapons.inventory[id]=0;}}
];
const rounded=value=>value===null?null:Math.round(value*100)/100;
function run(spec){
  const world=new World(makeOpponentScenario(base),profiles),blue=world.units[0],red=world.units[1];spec.setup?.(world);
  const rounds=()=>Object.values(red.weapons.inventory).reduce((sum,n)=>sum+n,0),initialRounds=rounds(),events=new Map();
  let firstDetectedSec=null,firstLockedSec=null,firstWarningSec=null,firstDefenseSec=null,supportDemandSec=0,supportProvidedSec=0,observedSec=0,previousObserved=false,observationLosses=0;
  for(let i=0;i<spec.seconds*60;i++){
    spec.tick?.(world);world.step(1/60);
    const observed=red.radar.contacts.some(c=>c.id===blue.id&&world.time-c.observedAt<=2.25);
    if(observed){firstDetectedSec??=world.time;observedSec+=1/60;}if(previousObserved&&!observed)observationLosses++;previousObserved=observed;
    if(red.radar.phase==='locked')firstLockedSec??=world.time;
    if(blue.rwr.contacts.some(c=>['track','launch'].includes(c.level)))firstWarningSec??=world.time;
    if(blue.rwrDefense.active)firstDefenseSec??=world.time;
    for(const m of world.missiles)if(m.ownerId===red.id&&m.alive){const kind=MISSILE_MODELS.get(m.modelId).kind,needs=kind==='semi_active_radar'||kind==='active_radar'&&!m.active;if(needs){supportDemandSec+=1/60;if(red.radar.canIlluminate&&red.radar.targetId===m.targetId)supportProvidedSec+=1/60;}}
    for(const event of world.weaponEvents)events.set(event.id+':'+event.type,event);
  }
  const launches=[...events.values()].filter(e=>e.type==='launch'&&e.ownerId===red.id),hits=[...events.values()].filter(e=>e.type==='hit'&&e.ownerId===red.id);
  return {case:spec.id,description:spec.description,simulationSec:rounded(world.time),firstDetectedSec:rounded(firstDetectedSec),firstLockedSec:rounded(firstLockedSec),observedSec:rounded(observedSec),observationLosses,
    firstWarningSec:rounded(firstWarningSec),firstDefenseSec:rounded(firstDefenseSec),firstLaunchSec:rounded(launches[0]?.time??null),firstHitSec:rounded(hits[0]?.time??null),launchEvents:launches.length,roundsSpent:initialRounds-rounds(),hitEvents:hits.length,
    supportDemandSec:rounded(supportDemandSec),supportProvidedSec:rounded(supportProvidedSec),supportCoverage:supportDemandSec?rounded(supportProvidedSec/supportDemandSec):null,
    blueAlive:blue.alive,redAlive:red.alive,redPhase:red.opponentState.phase,lastOpponentError:red.opponentState.lastError};
}
const results=cases.map(run),report={benchmark:'battle_offline_v1',determinism:'固定初始条件；当前仿真不使用随机数',scope:'真实World.step、传感器、武器积分和本地对手。没有真实LLM调用，不是LLM胜率测试。',
  limitations:['无地形测试场景','单一F-16/当前简化传感器与武器模型','短时确定性检查，不代表真实武器能力或统计战斗胜率','仅基准裁判读取双方存活和弹体支持状态'],results};
const serialized=JSON.stringify(report,null,2);console.log(serialized);
const outputIndex=process.argv.indexOf('--output');if(outputIndex>=0){const output=process.argv[outputIndex+1];if(!output)throw Error('--output需要文件路径');fs.writeFileSync(output,serialized+'\n');}
if(results.find(r=>r.case==='unobserved_target').firstDetectedSec!==null||results.find(r=>r.case==='unobserved_target').roundsSpent!==0||results.find(r=>r.case==='empty_stores').roundsSpent!==0||results.find(r=>r.case==='observed_intercept').launchEvents<1)process.exitCode=1;
