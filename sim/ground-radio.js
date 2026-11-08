// Ground reports describe position, readiness and clearance state. They do not
// turn field elevation and zero airspeed into a routine pre-departure call.
export function groundStatusReport(unit,language='zh'){
  const s=unit.surface??{},phase=unit.surfacePhase??s.phase;
  if(unit.alive===false||!(unit.grounded??s.grounded))return null;
  const runway=s.runway??unit.groundRunway,stand=s.node??unit.groundNode;
  const en=language==='en',r=runway?(en?`RUNWAY ${runway}`:`跑道${runway}`):(en?'ASSIGNED RUNWAY':'指定跑道');
  switch(phase){
    case 'parked':return en?`${stand?`STAND ${stand}, `:''}STANDING BY, AWAITING TAXI INSTRUCTIONS`:`${stand?`机位${stand}，`:''}地面待命，等待滑行指令`;
    case 'taxi':return en?`TAXIING, HOLD SHORT OF ${r}`:`正在滑行，${r}外等待`;
    case 'holding':return en?`HOLDING SHORT OF ${r}, READY FOR DEPARTURE`:`${r}外等待，准备离场`;
    case 'lineup_taxi':return en?`LINING UP ${r}`:`正在进入${r}对正`;
    case 'lined_up':return en?`LINED UP ${r}, AWAITING TAKEOFF CLEARANCE`:`${r}已对正，等待起飞许可`;
    case 'takeoff_roll':return en?`TAKEOFF ROLL ${r}`:`${r}起飞滑跑中`;
    case 'rejected':return en?'TAKEOFF REJECTED, BRAKING':'中断起飞，正在刹车';
    case 'rollout':return en?'LANDING ROLL, DECELERATING':'着陆滑跑，正在减速';
    case 'exit':return en?`VACATING ${r}`:`正在脱离${r}`;
    case 'waiting_gate':return en?'RUNWAY VACATED, AWAITING STAND':'跑道已脱离，等待机位';
    default:return en?'ON THE GROUND, STANDING BY':'位于地面，等待指令';
  }
}
