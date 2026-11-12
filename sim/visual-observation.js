// Explicitly coarse optical measurements. No exact velocity/identity backfill.
export function visualObservationsV2(world,own,candidates,lineClear){
  const time=world.time,previous=own.weapons.contacts??[];
  if(time<(own.nextVisualSampleAt??0))return previous.filter(c=>time-c.observedAt<=2);
  own.nextVisualSampleAt=time+.5;
  const maxRange=Math.min(11000,own.visibilityM??20000),forward=own.sensorPose?.forward??own.velocity;
  const forwardLength=Math.max(1,Math.hypot(...forward)),result=[];
  for(const t of candidates){
    if(t.id===own.id||t.alive===false)continue;
    const delta=t.position.map((v,i)=>v-own.position[i]),range=Math.hypot(...delta);
    if(range>maxRange||range<1||delta.reduce((s,v,i)=>s+v*forward[i],0)/(range*forwardLength)<=.5||!lineClear(world.terrain,own.position,t.position))continue;
    const position=t.position.map(v=>Math.round(v/100)*100);
    const near=c=>Math.hypot(...c.position.map((v,i)=>v+(c.velocity?.[i]??0)*(time-c.observedAt)-position[i]));
    const radar=(own.radar?.contacts??[]).filter(c=>near(c)<500).sort((a,b)=>near(a)-near(b))[0];
    let old=previous.filter(c=>near(c)<500).sort((a,b)=>near(a)-near(b))[0];
    if(old&&result.some(c=>c.id===old.id))old=null;
    const id=radar?.id??old?.id??`${own.id}-V${own.visualSequence=(own.visualSequence??0)+1}`;
    if(own.radar?.bindings)own.radar.bindings[id]=t.id;
    const velocity=old?position.map((v,i)=>.7*old.velocity[i]+.3*(v-old.position[i])/Math.max(.1,time-old.observedAt)):[0,0,0];
    const classification=(t.team??t.faction??'blue')===(own.team??own.faction??'blue')?'friendly':'unknown';
    result.push({sensorModelVersion:2,id,callsign:classification==='friendly'?t.callsign??id:id,classification,source:'visual',observedAt:time,
      position,velocity,velocityEstimateMps:old?velocity:null,expectedRevisitAt:time+.5,state:old?'confirmed':'tentative',associationQuality:'unique',
      uncertainty:{positionSigmaM:[100,100,100],velocitySigmaMps:old?[80,80,80]:[300,300,300],radialSigmaMps:100},history:[]});
    if(result.length>=32)break;
  }
  return result;
}
