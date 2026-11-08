export const CONTROL_NAMES={tower:'塔台',commander:'空中指挥'};
export const HANDOFF_STEPS=['通知转接','复诵与告别','向接收方报到','确认接管'];
export function airportExitReady(world,unit){
  if(unit.surface?.grounded||['approach','final','missed'].includes(unit.surface?.phase))return false;
  const airport=world.airportOps?.airport;if(!airport)return true;
  const procedure=unit.surface?.departureProcedure,runway=airport.runways.find(r=>r.designator===unit.surface?.runway);
  if(procedure&&runway){const end=runway.direction===1?runway.x1:runway.x0;return (unit.position[0]-end)*runway.direction>=procedure.transferDistanceM&&unit.position[2]>=airport.elevation+procedure.transferHeightM&&unit.surface.station==='departure';}
  return Math.hypot(unit.position[0]-airport.center[0],unit.position[1]-airport.center[1])>=6000&&unit.position[2]>=airport.elevation+450;
}
export function controlAuthority(world,unit){
  const c=unit.controlAuthority??={owner:unit.surface?.grounded?'tower':'commander',mode:world.executionMode==='relaxed'?'auto':'manual',phase:'owned',target:null,progress:0,sequence:0,transfers:0,history:[],departureArmed:false,airportId:world.airportOps?.airport.id??'BAY'};
  c.station??=unit.surface?.station??(c.owner==='tower'?'ground':'commander');c.frequencyMHz??=c.station==='ground'?121.7:c.station==='approach'?119.4:c.station==='departure'?124.2:c.station==='tower'?118.1:130;
  if(c.phase!=='transferring')c.mode=world.executionMode==='relaxed'?'auto':'manual';return c;
}
export function setHandoffMode(world,unit,mode){
  if(!['auto','manual'].includes(mode))throw Error('请选择自动或手动交接');
  const c=controlAuthority(world,unit);if(c.phase==='transferring')throw Error('交接通话进行中，请等待确认');world.executionMode=mode==='auto'?'relaxed':'strict';c.mode=mode;
}
export function requestHandoff(world,unit,target){
  const c=controlAuthority(world,unit);
  if(!unit.alive)throw Error('飞机损毁，无法交接');
  if(!['tower','commander'].includes(target))throw Error('接收管制方无效');
  if(c.owner===target&&c.phase==='owned')return false;
  if(c.phase==='transferring'){if(c.target===target)return true;throw Error('请先完成当前交接');}
  if(target==='commander'&&!airportExitReady(world,unit))throw Error('仍由机场管制负责；到达公布离场移交点、满足高度并联系离场管制后再移交');
  if(target==='tower'&&unit.surface?.grounded)throw Error('地面飞机应由塔台管制');
  c.phase='ready';c.target=target;c.progress=0;c.departureArmed=false;return true;
}
export function updateControlAuthority(world,unit){
  const c=controlAuthority(world,unit),phase=unit.surface?.phase??'airborne';
  if(!unit.alive)return c;
  if(phase==='takeoff_roll'||phase==='missed'&&c.lastSurfacePhase!=='missed')c.departureArmed=true;
  if(c.owner==='tower'&&c.phase==='owned'&&c.departureArmed&&airportExitReady(world,unit))requestHandoff(world,unit,'commander');
  c.lastSurfacePhase=phase;return c;
}
export function handoffMessages(world,unit){
  const c=controlAuthority(world,unit),call=unit.callsign,airport=c.airportId,toAir=c.target==='commander',from=toAir?'controller':'commander',to=toAir?'commander':'controller';
  const oldZh=toAir?`${airport}离场`:'空中指挥',newZh=toAir?'空中指挥':`${airport}进近`,oldEn=toAir?`${airport} DEPARTURE`:'CONTROL',newEn=toAir?'CONTROL':`${airport} APPROACH`;
  const make=(speaker,zh,en)=>({speaker,unitId:unit.id,label:speaker==='pilot'?`飞行员 · ${call}`:speaker==='controller'?`塔台 · ${airport}`:'空中指挥',handoff:true,text:zh,texts:{zh,en},language:'zh-CN'});
  return [
    make(from,`${call}，${oldZh}。联系${newZh}，继续当前飞行任务。`,`${call}, ${oldEn}. CONTACT ${newEn}. CONTINUE PRESENT FLIGHT TASK.`),
    make('pilot',`${oldZh}，转${newZh}，再见，${call}。`,`${oldEn}, CONTACT ${newEn}. GOOD DAY. ${call}.`),
    make('pilot',`${newZh}，${call}报到，${toAir?'离场爬升中':'请求返场进近'}。`,`${newEn}, ${call}, ${toAir?'DEPARTURE CLIMB':'REQUEST ARRIVAL'}.`),
    make(to,`${call}，${newZh}。已接管，继续当前任务。`,`${call}, ${newEn}. CONTROL ACCEPTED. CONTINUE PRESENT TASK.`)
  ];
}
export function beginHandoff(world,unit){const c=controlAuthority(world,unit);if(c.phase==='owned')return null;if(c.phase==='ready'){c.phase='transferring';c.sequence++;c.progress=0;}return c.sequence;}
export function acknowledgeHandoff(world,unit,sequence,index){
  const c=controlAuthority(world,unit);if(c.sequence!==sequence||c.phase!=='transferring'||c.progress!==index)throw Error('交接通话已失效');
  c.progress++;
  if(c.progress===HANDOFF_STEPS.length){c.history.push({from:c.owner,to:c.target,at:world.time,mode:c.mode,sequence});if(c.history.length>12)c.history.shift();c.owner=c.target;c.station=c.owner==='tower'?'approach':'commander';c.frequencyMHz=c.owner==='tower'?119.4:130;if(unit.surface)unit.surface.station=c.station;c.target=null;c.phase='owned';c.transfers++;c.transferredAt=world.time;}
}
