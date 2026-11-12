import test from 'node:test';
import assert from 'node:assert/strict';
import {G} from '../sim/flight.js';
import {MISSILE_MODELS,spawnMissile,stepMissiles} from '../sim/missiles.js';
import {assessOwnMissile,captureOwnMissileFlights,incomingRwrAssessment,parseOwnMissileFlights} from '../sim/missile-assessment.js';

const flight=(extra={})=>({id:'missile-1',ownerId:'blue-1',modelId:'us_aim_120b',targetId:'red-1',alive:true,
  phase:'datalink',ageSec:1,speedMps:400,active:false,needsRadarSupport:true,altitudeM:6500,...extra});
const missile=(extra={})=>({...flight(),position:[0,0,6500],...extra});
const rwr=(extra={})=>({id:'RWR-1',signalType:'active_seeker',level:'launch',bearingDeg:15,observedAt:10,...extra});

test('己方发动机阶段来自游戏配置，停止推力不等于耗尽或命中',()=>{
  const boost=assessOwnMissile(flight());assert.equal(boost.propulsionPhase,'powered');assert.equal(boost.speedTrend,'unknown');
  const coast=assessOwnMissile(flight({ageSec:15,speedMps:800,previousSpeedSample:{ageSec:14,speedMps:850,altitudeM:6500}}));
  assert.equal(coast.propulsionPhase,'coasting');assert.equal(coast.speedTrend,'decelerating');assert.equal(coast.mechanicalEnergyTrend,'decreasing');
  assert.equal(coast.reserveAssessment,'unknown');assert.equal(coast.remainingRangeM,null);assert.equal(coast.timeToImpactSec,null);
  assert.equal(coast.supportRequirement,'radar_until_active');assert.match(coast.limitations.join(' '),/停止不等于能量耗尽/);
  const delayed=assessOwnMissile(flight({modelId:'us_aim7p_sparrow_fa_18',phase:'semi_active',ageSec:0}));
  assert.equal(delayed.propulsionPhase,'ignition_pending');assert.match(delayed.summaryZh,/等待动力段点火/);
});

test('能量评估区分速度下降和爬升储能，缺高度不推断总能量',()=>{
  const heightGain=(500**2-480**2)/(2*G);
  const result=assessOwnMissile(flight({ageSec:16,speedMps:480,altitudeM:6500+heightGain,
    previousSpeedSample:{ageSec:15,speedMps:500,altitudeM:6500}}));
  assert.equal(result.speedTrend,'decelerating');assert.equal(result.mechanicalEnergyTrend,'steady');
  assert.equal(result.specificKineticEnergyKJkg,115.2);
  const incomplete=assessOwnMissile(flight({ageSec:16,speedMps:480,altitudeM:null,previousSpeedSample:{ageSec:15,speedMps:500}}));
  assert.equal(incomplete.specificMechanicalEnergyKJkg,null);assert.equal(incomplete.mechanicalEnergyTrend,'unknown');
  assert.match(incomplete.limitations.join(' '),/仅可评估动能/);
});

test('制导支持独立于发动机阶段，主动开机失去航迹不误报永久自主',()=>{
  const active=assessOwnMissile(flight({ageSec:15,active:true,phase:'active'}));
  assert.equal(active.propulsionPhase,'coasting');assert.equal(active.supportRequirement,'autonomous_seeker');
  const lost=assessOwnMissile(flight({ageSec:15,active:true,phase:'inertial'}));
  assert.equal(lost.supportRequirement,'radar_update_if_available');assert.match(lost.limitations.join(' '),/未报告自主跟踪/);
  assert.equal(assessOwnMissile(flight({modelId:'us_aim7p_sparrow_fa_18',phase:'semi_active'})).supportRequirement,'continuous_radar');
  assert.equal(assessOwnMissile(flight({modelId:'us_aim9m_sidewinder',phase:'infrared',needsRadarSupport:false})).supportRequirement,'none');
  const ended=assessOwnMissile(flight({alive:false,phase:'expired',ageSec:MISSILE_MODELS.get('us_aim_120b').lifetimeSec}));
  assert.equal(ended.propulsionPhase,'ended');assert.equal(ended.supportRequirement,'none');assert.equal(ended.speedTrend,'ended');
});

test('遥测采样仅保留指定己方弹，暂停稳定，前后样本和返回对象互相隔离',()=>{
  const own=missile(),enemy=missile({id:'missile-2',ownerId:'red-1',position:[99999,99999,99999]}),world={time:1,missiles:[own,enemy]};
  const unit={id:'blue-1',attackTask:{firedMissileIds:['missile-1','missile-2']}};
  const first=captureOwnMissileFlights(world,unit);assert.equal(first.length,1);assert.equal(first[0].ownerId,'blue-1');
  assert.equal(first[0].previousSpeedSample,null);assert.deepEqual(captureOwnMissileFlights(world,unit),first);
  world.time=2;own.ageSec=2;own.speedMps=450;own.position[2]=6600;
  const next=captureOwnMissileFlights(world,unit)[0];assert.deepEqual(next.previousSpeedSample,{ageSec:1,speedMps:400,altitudeM:6500});
  next.previousSpeedSample.speedMps=9999;assert.equal(captureOwnMissileFlights(world,unit)[0].previousSpeedSample.speedMps,400);
  assert.doesNotMatch(JSON.stringify(next),/position|99999/);assert.equal(assessOwnMissile(captureOwnMissileFlights(world,unit)[0]).speedTrend,'accelerating');
});

test('样本断档或时间倒退清掉趋势，不将重开局当成高速变化',()=>{
  const own=missile(),world={time:1,missiles:[own]},unit={id:'blue-1',attackTask:{firedMissileIds:['missile-1']}};
  captureOwnMissileFlights(world,unit);world.time=20;own.ageSec=20;own.speedMps=700;
  assert.equal(captureOwnMissileFlights(world,unit)[0].previousSpeedSample,null);
  world.time=21;own.ageSec=21;own.speedMps=690;assert.ok(captureOwnMissileFlights(world,unit)[0].previousSpeedSample);
  world.time=0;own.ageSec=0;assert.equal(captureOwnMissileFlights(world,unit)[0].previousSpeedSample,null);
});

test('实际游戏弹体飞行跨越动力段、滑行段和结束段，遥测全程可校验',()=>{
  const own={id:'blue-1',team:'blue',position:[0,0,6500],velocity:[0,250,0],alive:true};
  const target={id:'red-1',team:'red',position:[0,80000,6500],velocity:[0,250,0],alive:true};
  const world={time:0,units:[own,target],missiles:[],missileSequence:0,weaponEvents:[]};
  const m=spawnMissile(world,own,target,MISSILE_MODELS.get('us_aim9m_sidewinder'),{position:target.position,velocity:target.velocity});
  const phases=new Set(),trends=new Set();
  for(let i=0;i<2500;i++){
    world.time+=.05;stepMissiles(world,.05);
    const telemetry=captureOwnMissileFlights(world,own,[m.id]);assert.equal(telemetry.length,1);
    const assessed=assessOwnMissile(parseOwnMissileFlights(telemetry,{ownerId:own.id})[0]);
    phases.add(assessed.propulsionPhase);trends.add(assessed.speedTrend);if(!m.alive)break;
  }
  assert.deepEqual(phases,new Set(['powered','coasting','ended']));assert.ok(trends.has('accelerating'));assert.ok(trends.has('decelerating'));
  assert.equal(m.alive,false);assert.equal(world.weaponEvents.length,0,'远离可截获条件的测试飞行不能报告命中');
});

test('服务白名单拒绝无效/重复/跨所有者遥测，不透传真值或调用方结论',()=>{
  const parsed=parseOwnMissileFlights([flight({position:[999,999,999],fuelKg:99,assessment:{timeToImpactSec:1},hiddenTarget:{alive:false}})],{ownerId:'blue-1'});
  assert.doesNotMatch(JSON.stringify(parsed),/position|fuelKg|timeToImpactSec|hiddenTarget/);
  assert.throws(()=>parseOwnMissileFlights([flight({ownerId:'red-1'})],{ownerId:'blue-1'}),/无效/);
  assert.throws(()=>parseOwnMissileFlights([flight({ownerId:undefined})],{ownerId:'blue-1'}),/无效/);
  assert.equal(parseOwnMissileFlights([flight({ownerId:undefined})])[0].ownerId,null,'旧攻击观测由上层task ids验证');
  for(const changed of [{speedMps:NaN},{speedMps:Infinity},{ageSec:-1},{phase:'magic'},{modelId:'secret'},{active:1},{altitudeM:Infinity},
    {alive:true,phase:'hit'},{alive:false,phase:'active'},{previousSpeedSample:{ageSec:2,speedMps:400}},
    {previousSpeedSample:{ageSec:.9,speedMps:400}},{ageSec:20,previousSpeedSample:{ageSec:1,speedMps:400}},
    {previousSpeedSample:{ageSec:0,speedMps:-1}}])assert.throws(()=>parseOwnMissileFlights([flight(changed)]),/无效/);
  assert.throws(()=>parseOwnMissileFlights([flight(),flight()]),/无效/);
  assert.throws(()=>parseOwnMissileFlights([flight()],{maxCount:0}),/数量无效/);
  assert.equal(parseOwnMissileFlights([flight({active:true,phase:'active',needsRadarSupport:true})])[0].needsRadarSupport,false,'支持需求由程序重新计算');
});

test('RWR来袭能量始终未知：隐含坐标、弹型、剩余推力和提示动画全部不能变成测量',()=>{
  const contact=rwr({emitterKey:'missile:secret',modelId:'us_aim_120b',position:[0,100,6500],velocity:[0,-1000,0],
    fuelKg:1,timeToImpactSec:.1,phase:'spent',visualizationOnly:true});
  const assessed=incomingRwrAssessment([contact],10)[0];
  assert.equal(assessed.energyState,'unknown');assert.equal(assessed.speedMps,null);assert.equal(assessed.rangeM,null);
  assert.equal(assessed.remainingRangeM,null);assert.equal(assessed.timeToImpactSec,null);assert.equal(assessed.source,'rwr_bearing_only');
  assert.doesNotMatch(JSON.stringify(assessed),/missile:secret|us_aim_120b|position|velocity|fuelKg|spent|visualizationOnly/);
  assert.deepEqual(assessed,incomingRwrAssessment([rwr()],10)[0]);
});

test('普通搜索或跟踪不能称作来袭导弹；记忆告警不等于威胁解除',()=>{
  assert.deepEqual(incomingRwrAssessment([rwr({signalType:'radar',level:'search'}),rwr({signalType:'radar',level:'track'})],10),[]);
  const possible=incomingRwrAssessment([rwr({signalType:'radar'})],10)[0];assert.match(possible.summaryZh,/发射相关/);
  const memory=incomingRwrAssessment([rwr()],15)[0];assert.equal(memory.freshness,'memory');assert.equal(memory.energyState,'unknown');
  assert.match(memory.limitations.join(' '),/信号消失不代表导弹失效/);
  assert.deepEqual(incomingRwrAssessment([rwr({observedAt:11}),rwr({bearingDeg:NaN}),rwr({signalType:'secret'})],10),[]);
});
