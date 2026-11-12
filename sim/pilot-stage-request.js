export const PILOT_STAGE_CLEARANCES=Object.freeze({holding:'line_up',lined_up:'takeoff',final:'land'});
export function stageRequestText(phase,runway){return phase==='holding'?`已到${runway}等待点，跑道外等待`:phase==='lined_up'?`${runway}已对正，等待起飞许可`:`${runway}最后进近，请求着陆许可`;}
export function pilotStageMessage(event,unit,airport){
  const runway=event.runway;let zh,en;
  if(event.phase==='holding'){zh=`已到跑道${runway}等待点，保持跑道外等待，请求进入跑道对正等待许可`;en=`HOLDING SHORT OF RUNWAY ${runway}, READY FOR DEPARTURE. REQUEST LINE UP AND WAIT`;}
  else if(event.phase==='lined_up'){zh=`跑道${runway}已对正，准备离场，请求起飞许可`;en=`LINED UP RUNWAY ${runway}, READY FOR DEPARTURE. REQUEST TAKEOFF CLEARANCE`;}
  else if(event.alreadyCleared){zh=`跑道${runway}最后进近，已获着陆许可，继续进近`;en=`FINAL RUNWAY ${runway}, LANDING CLEARANCE RECEIVED, CONTINUING APPROACH`;}
  else{zh=`跑道${runway}最后进近，请求着陆许可`;en=`FINAL RUNWAY ${runway}, REQUEST LANDING CLEARANCE`;}
  return {speaker:'pilot',unitId:unit.id,label:`飞行员 · ${unit.callsign}`,station:'tower',pilotRequestId:event.pilotRequestId,requestedClearance:event.requestedClearance,
    texts:{zh:`${airport.id}塔台，${zh}，${unit.callsign}。`,en:`${airport.id} TOWER, ${en}. ${unit.callsign}.`}};
}
export function currentStageRequest(unit,event){
  const request=unit?.surface?.pilotStageRequests?.[event.requestedClearance];
  return request?.id===event.pilotRequestId&&request.phase===unit.surface.phase&&request.runway===unit.surface.runway?request:null;
}
