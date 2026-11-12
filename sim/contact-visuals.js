import {RADAR_DEFAULTS} from './radar.js';

// Presentation-only memory. Never feed these extrapolated coordinates back to
// radar acquisition, weapon release checks or a command/model context.
export const CONTACT_VISUAL_DEFAULTS=Object.freeze({scanGraceSec:.25,fadeTailSec:2,visualHoldSec:.25,correctionSec:.35});
const memories=new WeakMap();
const vector=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);
const smoothstep=v=>v*v*(3-2*v);
const positive=(value,fallback)=>Number.isFinite(value)&&value>0?value:fallback;

function opacityAt(entry,time){
  const age=Math.max(0,time-entry.sample.observedAt);
  if(age<=entry.holdSec)return 1;
  const fraction=Math.min(1,(age-entry.holdSec)/(entry.expireSec-entry.holdSec));
  return 1-smoothstep(fraction);
}

function positionAt(entry,time){
  const age=Math.max(0,time-entry.sample.observedAt);
  const correction=Math.exp(-Math.max(0,time-entry.correctedAt)/CONTACT_VISUAL_DEFAULTS.correctionSec);
  return entry.sample.position.map((value,i)=>value+entry.sample.velocity[i]*age+entry.offset[i]*correction);
}

function collectSamples(ownUnits,time){
  const samples=new Map(),ownIds=new Set(ownUnits.map(unit=>unit.id));
  const accept=(contact,source,holdSec,expireSec)=>{
    if(!contact||typeof contact.id!=='string'||!contact.id||ownIds.has(contact.id)||
      !vector(contact.position)||!vector(contact.velocity)||!Number.isFinite(contact.observedAt)||
      contact.observedAt<0||contact.observedAt>time||time-contact.observedAt>=expireSec)return;
    const previous=samples.get(contact.id);
    if(previous&&previous.sample.observedAt>contact.observedAt)return;
    // Explicitly retain only an observation, even if the caller's record has
    // extra fields. Clone vectors because sensors update their records in place.
    const sample={id:contact.id,callsign:contact.callsign??contact.id,classification:contact.classification??'unknown',
      source,observedAt:contact.observedAt,position:[...contact.position],velocity:[...contact.velocity],practice:contact.practice===true};
    samples.set(contact.id,{sample,holdSec,expireSec});
  };
  for(const unit of ownUnits){
    if(unit.alive===false)continue;
    const radar=unit.radar;
    // The sensor owns availability/mode gating and clears its own contacts.
    // Consume the observation record, not a separate presentation-side guess
    // about whether that sensor could currently detect the target.
    if(radar){
      const sweepSec=positive(radar.config?.sweepSec,RADAR_DEFAULTS.sweepSec);
      const memorySec=positive(radar.config?.memorySec,RADAR_DEFAULTS.memorySec);
      for(const contact of radar.contacts??[]){
        const holdSec=contact.sensorModelVersion===2?Math.max(0,contact.expectedRevisitAt-contact.observedAt):((radar.targetId===contact.id?0:sweepSec)+CONTACT_VISUAL_DEFAULTS.scanGraceSec);
        accept(contact,'radar',holdSec,Math.max(memorySec,holdSec)+CONTACT_VISUAL_DEFAULTS.fadeTailSec);
      }
    }
    for(const contact of unit.weapons?.contacts??[]){
      const holdSec=CONTACT_VISUAL_DEFAULTS.visualHoldSec;
      accept(contact,'visual',holdSec,holdSec+CONTACT_VISUAL_DEFAULTS.fadeTailSec);
    }
  }
  return samples;
}

/** Last-observation tracks for the player's map, including fading memory.
 * The only world fields read are time/playerTeam. Hidden target truth, including
 * destruction, never changes a remembered track; only a new observation does.
 */
export function contactVisuals(world,ownUnits){
  const time=world.time;
  if(!Number.isFinite(time)||time<0)return new Map();
  const scope=JSON.stringify([world.playerTeam??'blue',ownUnits.map(unit=>unit.id).sort()]);
  let state=memories.get(world);
  if(!state||time<state.time||scope!==state.scope){
    state={time,scope,tracks:new Map()};memories.set(world,state);
  }
  state.time=time;
  for(const [id,entry]of state.tracks){
    if(time-entry.sample.observedAt>=entry.expireSec)state.tracks.delete(id);
  }
  for(const [id,incoming]of collectSamples(ownUnits,time)){
    const previous=state.tracks.get(id);
    if(previous&&incoming.sample.observedAt<=previous.sample.observedAt)continue;
    const next={...incoming,offset:[0,0,0],correctedAt:time};
    if(previous){
      const before=positionAt(previous,time),after=positionAt(next,time);
      next.offset=before.map((value,i)=>value-after[i]);
    }
    state.tracks.set(id,next);
  }
  const visuals=new Map();
  for(const [id,entry]of state.tracks){
    const age=Math.max(0,time-entry.sample.observedAt),opacity=opacityAt(entry,time);
    if(opacity<=0)continue;
    visuals.set(id,{...entry.sample,position:positionAt(entry,time),samplePosition:[...entry.sample.position],velocity:[...entry.sample.velocity],
      visualOpacity:opacity,visualState:age<=entry.holdSec?'tracked':'memory',visualAgeSec:age,
      visualPredicted:age>0||entry.offset.some(value=>Math.abs(value)>.001),visualizationOnly:true});
  }
  return visuals;
}
