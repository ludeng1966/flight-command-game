// Player-facing gameplay hints, deliberately separate from AI/sensor context.
// RWR measures a bearing, not a missile position. Once that signal is received,
// the map may illustrate its missile; this must never become targeting evidence.
export const MISSILE_VISUAL_FRESH_SEC=.15;
export const MISSILE_VISUAL_MEMORY_SEC=3;
const TRAIL_SEC=2.5,MAX_TRAIL_POINTS=80,states=new WeakMap();
const vector=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);
const smoothFade=t=>1-t*t*(3-2*t);

export function visibleMissiles(world,ownUnits){
  const time=world.time,ownIds=new Set(ownUnits.map(u=>u.id));
  const scope=[...ownIds].sort().join('\0');
  let state=states.get(world);
  if(!state||time<state.time||scope!==state.scope){
    state={time,scope,tracks:new Map()};states.set(world,state);
  }
  state.time=time;
  const missiles=world.missiles??[],byId=new Map(missiles.map(m=>[m.id,m]));
  const signals=new Map();
  for(const unit of ownUnits){
    if(unit.alive===false||!unit.rwr?.available||!unit.rwr.enabled)continue;
    for(const contact of unit.rwr.contacts??[]){
      if(contact.signalType!=='active_seeker'||!contact.emitterKey?.startsWith('missile:'))continue;
      const age=time-contact.observedAt;
      if(!Number.isFinite(age)||age<0||age>MISSILE_VISUAL_FRESH_SEC)continue;
      const id=contact.emitterKey.slice('missile:'.length);
      if(!signals.has(id)||signals.get(id).observedAt<contact.observedAt)signals.set(id,contact);
    }
  }
  for(const [id,signal]of signals){
    const missile=byId.get(id),track=state.tracks.get(id);
    if(!missile||ownIds.has(missile.ownerId)||!vector(missile.position)||!vector(missile.velocity))continue;
    // A held warning is not a new position measurement. Never follow a hidden
    // turn, impact or deletion while its last warning is merely still displayed.
    if(track&&signal.observedAt<=track.observedAt)continue;
    const position=missile.position.slice(),velocity=missile.velocity.slice();
    const samples=track?.samples??[];
    if(!samples.length||time-samples.at(-1).time>=.08)samples.push({time,position:position.slice()});
    const recent=samples.filter(p=>time-p.time<=TRAIL_SEC).slice(-MAX_TRAIL_POINTS);
    state.tracks.set(id,{position,velocity,sampledAt:time,observedAt:signal.observedAt,
      firstSeen:track?.firstSeen??signal.observedAt,samples:recent});
  }
  const visible=missiles.filter(m=>ownIds.has(m.ownerId)).map(m=>{if(m.sensorModelVersion!==2)return m;const {truthTargetId,seekerTrack,...view}=m;return view;});
  for(const [id,track]of state.tracks){
    const age=Math.max(0,time-track.observedAt);
    if(age>=MISSILE_VISUAL_MEMORY_SEC){state.tracks.delete(id);continue;}
    const position=track.position.map((v,i)=>v+track.velocity[i]*Math.max(0,time-track.sampledAt));
    const opacity=age<=MISSILE_VISUAL_FRESH_SEC?1:smoothFade((age-MISSILE_VISUAL_FRESH_SEC)/(MISSILE_VISUAL_MEMORY_SEC-MISSILE_VISUAL_FRESH_SEC));
    const trail=track.samples.filter(p=>time-p.time<=TRAIL_SEC).map(p=>p.position.slice());
    trail.push(position.slice());
    visible.push({id,position,velocity:track.velocity.slice(),trail,alive:true,
      phase:age<=MISSILE_VISUAL_FRESH_SEC?'active':'coasting',opacity,
      source:'rwr',visualizationOnly:true,positionKind:'gameplay_hint_not_rwr_solution',
      observedAt:track.observedAt,firstSeen:track.firstSeen});
  }
  return visible;
}
