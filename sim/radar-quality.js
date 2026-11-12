// Shared observed-track policy. No world/target access is permitted here.
export function trackUsable(c,time,purpose='acquisition'){
  if(!c||!Number.isFinite(c.observedAt)||c.observedAt>time+.001)return false;
  if(c.sensorModelVersion!==2)return time-c.observedAt<=2.25;
  if(c.state==='lost'||c.awaitingValidation)return false;
  const age=Math.max(0,time-c.observedAt),sigma=Math.max(...c.uncertainty.positionSigmaM);
  if(purpose==='acquisition')return age<=45&&sigma<=5000;
  return c.state==='confirmed'&&c.associationQuality==='unique'&&sigma<=300&&
    Math.max(...c.uncertainty.velocitySigmaMps)<=30&&age<=(purpose==='midcourse'?2:.25);
}
export function groundVelocity(u){return u.velocityFrame==='world'?[...u.velocity]:u.groundVelocity??u.velocity.map((v,i)=>v+(u.wind?.[i]??0));}
export function radarTarget(world,own,id){
  const key=own.radar?.sensorModelVersion===2?own.radar.bindings?.[id]??id:id;
  return [...world.units,...(world.radarTargets??[])].find(t=>t.id===key);
}
export function radarSupport(own,id,kind,time){
  const r=own?.radar,c=r?.contacts.find(c=>c.id===id);
  if(r?.sensorModelVersion!==2){const ok=!!r?.canIlluminate&&r.targetId===id&&!!c&&time-c.observedAt<=.2;return {launchEligible:ok,illuminationAvailable:ok,midcourseAvailable:ok};}
  const on=own.alive!==false&&r.mode!=='off'&&!own.surface?.grounded;
  const illuminationAvailable=on&&r.targetId===id&&r.phase==='locked'&&trackUsable(c,time,'fireControl');
  const midcourseAvailable=on&&(r.targetId===id||r.config.supportsTws&&r.scheduledTrackIds?.slice(0,r.config.maxDatalinkChannels).includes(id))&&trackUsable(c,time,'midcourse');
  return {launchEligible:kind==='semi_active_radar'?illuminationAvailable:midcourseAvailable&&trackUsable(c,time,'fireControl'),
    illuminationAvailable,midcourseAvailable,lastUpdateMeasuredAt:c?.observedAt??null,scheduledNextUpdateAt:c?.expectedRevisitAt??null};
}
