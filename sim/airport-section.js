import {installFormation,leaveFormation} from './formation.js';
// A section uses individually read-back clearances and staggered runway use.
// Close side-by-side launches are intentionally not represented by teleporting.
export function updateAirportSections(ops,world){
  const units=world.units.filter(u=>u.alive&&u.surface?.sectionMode);
  for(const u of units){
    const s=u.surface;if(s.sectionLeaderId)continue;
    const peer=units.find(v=>v!==u&&!v.surface.sectionLeaderId&&v.surface.sectionMode===s.sectionMode&&v.surface.sectionIntent===s.sectionIntent&&v.surface.runway===s.runway&&(v.team??'blue')===(u.team??'blue'));
    if(!peer)continue;
    const lead=u.flightRole?.role==='wingman'?peer:peer.flightRole?.role==='lead'?peer:u,wing=lead===u?peer:u;
    for(const member of [lead,wing]){member.surface.sectionLeaderId=lead.id;member.surface.sectionWingId=wing.id;}
    ops.notice(wing,world,'双机分批使用跑道，二号保持间隔，离地后集合；返场按次序分开着陆','SECTION OPERATIONS. NUMBER TWO, MAINTAIN SEPARATION. REJOIN AFTER DEPARTURE; RECOVER INDIVIDUALLY.','approach');
  }
  for(const lead of units.filter(u=>u.surface.sectionLeaderId===u.id)){
    const wing=units.find(v=>v.id===lead.surface.sectionWingId);if(!wing)continue;
    const ls=lead.surface,ws=wing.surface;
    if(ls.sectionIntent==='departure'){
      const q=ops.traffic.state.requests.find(q=>q.id===ws.atcRequestId);
      if(q&&ls.grounded){const leadRequest=ops.traffic.state.requests.find(q=>q.id===ls.atcRequestId);if(leadRequest)leadRequest.priority=Math.max(10,leadRequest.priority);q.priority=Math.max(0,q.priority);ws.sectionWaiting=true;}
      else ws.sectionWaiting=false;
      if(!ls.grounded&&!ws.grounded&&ls.phase==='climb'&&ws.phase==='climb'&&lead.position[2]>ops.airport.elevation+450&&wing.position[2]>ops.airport.elevation+450&&!ws.sectionJoined){
        installFormation(world,wing,{targetId:lead.id,action:'join_formation',formation:'echelon',side:'right',rangeM:1200});ws.sectionJoined=true;
        ops.notice(wing,world,'双机离场完成，向长机右后方集合，保持一千二百米间隔','SECTION AIRBORNE. REJOIN RIGHT ECHELON, SPACING ONE THOUSAND TWO HUNDRED METERS.','departure');
      }
    }else if(ls.sectionIntent==='arrival'&&!ws.sectionReleased){
      if(!ls.grounded){
        if(ws.phase==='approach'){
          leaveFormation(wing);ws.phase='arrival_hold';ws.towerHold=null;wing.waypoints=[];wing.navLegs=[];wing.headingTarget=null;wing.holdAltitude=Math.max(ops.airport.elevation+1800,wing.position[2]);wing.orbit=[wing.position[0]+4000,wing.position[1]];
          ops.traffic.cancelUnit(wing,world,'二号在进近等待区保持，等待长机着陆','NUMBER TWO, HOLD FOR SPACING UNTIL LEAD AIRCRAFT LANDS');
        }
        ws.sectionWaiting=true;
      }else{
        ws.sectionWaiting=false;ws.sectionReleased=true;
        try{ops.apply(wing,{intent:'land',runway:ws.runway,mode:'overhead',airportId:ops.airport.id,taxiways:[],gate:ws.arrivalGate??null,altitudeM:null},world);}
        catch(error){ws.sectionReleased=false;ws.lastATCError=error.message;}
      }
    }
  }
}
