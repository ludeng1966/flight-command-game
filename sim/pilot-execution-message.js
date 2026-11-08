import {getUnitSystem,unitLabels,radioSpeed,radioAltitude,rounded} from './units.js';

function reasonTexts(cause){
  if(cause?.urgent||cause?.feedback?.flightState==='stall-recovery')return {zh:'低速，能量不足，正在实施改出',en:'LOW AIRSPEED, INSUFFICIENT ENERGY. RECOVERING'};
  return ({
    energy_shortfall:{zh:'能量不足，原方案无法维持爬升或空速',en:'INSUFFICIENT ENERGY. UNABLE TO MAINTAIN CLIMB OR AIRSPEED WITH PREVIOUS PLAN'},
    route_blocked:{zh:'原航路受阻，无法继续按原航路飞行',en:'UNABLE PREVIOUS ROUTE, ROUTE OBSTRUCTED'},
    progress_stalled:{zh:'未能有效接近指定航点，需要修订航路',en:'UNABLE TO MAKE PROGRESS TO ASSIGNED FIX, REVISING ROUTE'}
  })[cause?.issue]??{zh:'根据当前飞行状态修订执行方案',en:'REVISING PLAN FOR CURRENT FLIGHT CONDITIONS'};
}

// Describe the observed trigger and installed controls, not an unchecked model
// narrative. Both languages are complete before entering the shared TTS path.
export function pilotExecutionMessage(report,unit,system=getUnitSystem()){
  const a=report.applied,name=unit.callsign,reason=reasonTexts(report.cause),labels=unitLabels(system);
  let zh,en;
  if(a){
    const throttle=rounded(a.throttle*100,2),burner=rounded(a.afterburner*100,2),speed=radioSpeed(a.speedMps,system),r=a.recovery,plan=report.plan;
    const goal=Number.isFinite(plan?.targetAltitudeM)?radioAltitude(plan.targetAltitudeM,system):null;
    zh=`指挥台，${reason.zh}。推力上限调整至${throttle}%，${burner?`加力上限${burner}%`:'不使用加力'}，暂用真空速${speed}${labels.speedSpoken}。`;
    en=`CONTROL, ${reason.en}. THRUST LIMIT REVISED TO ${throttle} PERCENT. ${burner?`AFTERBURNER LIMIT ${burner} PERCENT`:'NO AFTERBURNER'}. TEMPORARY TRUE AIRSPEED ${speed} ${labels.speedEnglish}. `;
    if(r){
      zh+=`改出方案已装订，目标航迹${r.flightPathDeg}度，坡度${r.bankDeg}度，卸载上限${r.unloadG}G。恢复后继续原任务`;
      en+=`RECOVERY PLAN SET: FLIGHT PATH ${r.flightPathDeg} DEGREES, BANK ${r.bankDeg} DEGREES, UNLOAD LIMIT ${r.unloadG} G. RESUMING ORIGINAL TASK AFTER RECOVERY`;
    }else{
      const replanned=plan?.routeReplanned||a.viaCount>0;
      zh+=replanned?`航路已重新规划${a.viaCount?`，增设${a.viaCount}个中间航点`:''}，保留原定航点。`:'保持原航路。';
      en+=replanned?`ROUTE REPLANNED${a.viaCount?` WITH ${a.viaCount} INTERMEDIATE WAYPOINTS`:''}, ASSIGNED FIXES RETAINED. `:'MAINTAINING ASSIGNED ROUTE. ';
      if(replanned&&Number.isFinite(plan?.nextFix?.bearingDeg)&&Number.isFinite(plan.nextFix.altitudeM)){
        const bearing=String(Math.round(plan.nextFix.bearingDeg)%360).padStart(3,'0'),altitude=radioAltitude(plan.nextFix.altitudeM,system);
        zh+=`下一航点方位${bearing}度，高度${altitude}${labels.altitudeSpoken}。`;
        en+=`NEXT FIX BEARING ${bearing} DEGREES, ALTITUDE ${altitude} ${labels.altitudeEnglish}. `;
      }
      zh+='继续原任务';en+='CONTINUING ORIGINAL TASK';
    }
    zh+=`${goal!==null?`，目标高度${goal}${labels.altitudeSpoken}`:''}，${name}。`;
    en+=`${goal!==null?`, ASSIGNED ALTITUDE ${goal} ${labels.altitudeEnglish}`:''}. ${name}.`;
  }else{
    const error=String(report.error??'未能确认修订方案').replace(/[。.!]+$/,'');
    const detail=/超过|超出|限制/.test(error)?'REVISED PLAN EXCEEDS ASSIGNED LIMITS':/推力不足/.test(error)?'INSUFFICIENT THRUST FOR REVISED PLAN':
      /航路|航点|轨迹|地形/.test(error)?'UNABLE REVISED ROUTE WITH CURRENT FLIGHT CONDITIONS':'UNABLE TO CONFIRM REVISED PLAN';
    zh=`指挥台，${reason.zh}。修订方案无法执行，${error}。保持原任务，继续重新规划，${name}。`;
    en=`CONTROL, ${reason.en}. UNABLE REVISED PLAN. ${detail}. MAINTAINING CURRENT TASK, REPLANNING. ${name}.`;
  }
  return {speaker:'pilot',unitId:unit.id,text:zh,texts:{zh,en},simTime:report.simTime};
}
