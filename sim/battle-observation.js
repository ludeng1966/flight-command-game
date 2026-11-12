// Observation metadata describes the current simplified sensors honestly. It
// does not pretend that ideal samples are a calibrated error/noise model.
export const teamOf=unit=>unit?.team??unit?.faction??'blue';
export function commandUnits(world){return world.units.filter(u=>teamOf(u)===(world.playerTeam??'blue')&&u.controllable!==false);}
export function observationEvidence(contact,time,source=contact.source??'radar'){
  const ageSec=Math.max(0,time-contact.observedAt);
  if(contact.sensorModelVersion===2)return {source,ageSec,quality:contact.state,
    measurementModel:source==='visual'?'coarse_optical_measurement_v2':contact.estimationModel==='axis_search'?'noisy_beam_axis_kalman_v2':'noisy_beam_measurement_ekf_v2',positionErrorM:Math.max(...contact.uncertainty.positionSigmaM),
    identification:contact.classification==='friendly'?'simulated_friendly_identification':'unidentified',
    limitations:['位置和速度为含误差的估计','后续机动未知','误差和确认状态不代表命中概率']};
  return {source,ageSec,quality:ageSec<=.25?'fresh':ageSec<=2.25?'aging':'coasting',
    measurementModel:'idealized_sample_no_noise_model',positionErrorM:null,
    identification:contact.classification==='friendly'?'simulated_friendly_identification':contact.classification==='hostile'?'explicit_hostile_identification':'unidentified',
    limitations:['观测时间之后的机动未知','坐标为简化传感器采样，未建模量测误差']};
}
export function observedContact(contact,time,source){
  const result={...contact,...observationEvidence(contact,time,source)};
  if(contact.sensorModelVersion===2){
    result.uncertainty={positionSigmaM:[...contact.uncertainty.positionSigmaM],velocitySigmaMps:[...contact.uncertainty.velocitySigmaMps],radialSigmaMps:contact.uncertainty.radialSigmaMps};
    if(contact.predictedPosition)result.predictedPosition=[...contact.predictedPosition];
    if(contact.usable)result.usable={...contact.usable};
  }
  return result;
}
export function scopedAirportTraffic(world,units){
  const value=world.airportOps?.traffic.snapshot(world);if(!value)return null;
  const ids=new Set(units.map(u=>u.id));
  for(const key of ['traffic','queue','clearances','pendingPilotRequests'])if(Array.isArray(value[key]))value[key]=value[key].filter(v=>ids.has(v.unitId));
  for(const runway of value.runways??[]){if(runway.ownerId&&!ids.has(runway.ownerId))runway.ownerId=null;if(runway.lastUse?.unitId&&!ids.has(runway.lastUse.unitId))runway.lastUse=null;}
  return value;
}
