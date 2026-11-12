// Manual authority has its own generations. Autonomous progress and physical
// motion may update world.revision without cancelling an unrelated proposal.
// These guards are process-local and deliberately do not enter save/AI data.
const states=new WeakMap();
function stateFor(world){let state=states.get(world);if(!state){state={global:0,units:new Map()};states.set(world,state);}return state;}
const unitIds=ids=>[...new Set(ids)].filter(id=>typeof id==='string');

export function notePlayerOrder(world,ids=null){
  if(world.autonomousCommand||world.commandCommitInProgress)return;
  const state=stateFor(world);
  if(ids===null){state.global++;return;}
  for(const id of unitIds(ids))state.units.set(id,(state.units.get(id)??0)+1);
}

export function capturePlayerOrderScope(world){
  const state=stateFor(world);
  return {world,team:world.playerTeam,global:state.global,versions:new Map(state.units),units:new Map(world.units.map(unit=>[unit.id,unit]))};
}

// Serializable marker for long-lived mission records. Do not attach a captured
// scope itself to a mission: it contains world/object references.
export function playerOrderVersion(world,id){
  const state=stateFor(world);return `${state.global}:${state.units.get(id)??0}`;
}

export function isPlayerOrderScopeCurrent(world,scope,ids=null){
  if(!scope||scope.world!==world||scope.team!==world.playerTeam)return false;
  const state=stateFor(world);
  if(scope.global!==state.global)return false;
  const affected=ids===null?[...new Set([...scope.units.keys(),...world.units.map(unit=>unit.id),...state.units.keys()])]:unitIds(ids);
  return affected.every(id=>(scope.versions.get(id)??0)===(state.units.get(id)??0)&&
    scope.units.get(id)===world.units.find(unit=>unit.id===id));
}

export function assertPlayerOrderScope(world,scope,ids=null){
  if(!isPlayerOrderScopeCurrent(world,scope,ids))throw Error('期间已有新操作或战场重置，本次指令已作废，请重新下令');
}

// Stable control choices only: no positions, scan phases, contacts, readiness
// timers, inferred threat bearings, or other ordinary simulation advancement.
function controlKey(world,unit){
  const radar=unit.radar,weapons=unit.weapons,defense=unit.rwrDefense;
  return JSON.stringify([unit.tacticalGuidance?.revision??0,unit.profileId,unit.routeRevision??0,radar?.controlSequence??0,
    weapons?.selectedModelId,weapons?.targetId,weapons?.roe,weapons?.sequence??0,
    unit.rwr?.enabled,defense?.controlSequence??0,defense?.mode,
    unit.controlAuthority?.owner,unit.controlAuthority?.mode,world.executionMode]);
}

export function captureUnitOrderScope(world,unit){
  return {player:capturePlayerOrderScope(world),unit,control:controlKey(world,unit)};
}

export function isUnitOrderScopeCurrent(world,unit,scope){
  return !!scope&&scope.unit===unit&&unit.alive!==false&&
    isPlayerOrderScopeCurrent(world,scope.player,[unit.id])&&scope.control===controlKey(world,unit);
}
