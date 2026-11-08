import {radioAltitude,radioSpeed,radioDistance} from './units.js';
import {unitLabels,altitudeValue,speedValue,distanceValue} from './units.js';
import {airportCommandLabel,airportModeLabel} from './airport-language.js';
import {needsDeparturePlan,departurePlanReadback} from './departure-plan.js';
import {groundStatusReport} from './ground-radio.js';
import {atcOrderPhrase} from './atc-command.js';
const n=value=>String(Math.round(value*100)/100);
const label=value=>String(value??'').replaceAll('_',' ').toUpperCase();
const airportNames={taxi:'TAXI',hold_short:'HOLD SHORT',line_up:'LINE UP AND WAIT',takeoff:'TAKE OFF',abort_takeoff:'ABORT TAKEOFF',approach:'APPROACH',land:'LAND',go_around:'GO AROUND',gear:'LANDING GEAR',flaps:'FLAPS'};
export const ENGLISH_VERDICTS=Object.freeze({executing:'Executing; target not yet reached.',reached:'Target reached.',blocked:'Unable to execute.',mismatch:'Installed settings do not match the instruction.',reported:'Status verified.'});
export function englishResultReadback(fact,plan,context,interpretation){
  const system=context.unitSystem??'metric',labels=unitLabels(system),unit=context.units.find(u=>u.id===fact.unitId),tasks=plan.tasks.filter(t=>t.unitId===fact.unitId),parts=[];
  if(tasks.length&&tasks.every(t=>t.action==='report_status')&&unit){
    parts.push(groundStatusReport(unit,'en')??`Heading ${n(Math.round(unit.headingDeg))} degrees, altitude ${n(radioAltitude(unit.position[2],system))} ${labels.altitudeEnglish}, true airspeed ${n(radioSpeed(unit.speedMps,system))} ${labels.speedEnglish}`);
  }else for(const t of tasks){
    const p=[],target=context.units.find(u=>u.id===t.targetId)?.callsign??t.targetId;
    if(t.action==='atc')p.push(atcOrderPhrase(t.atcOrder,context.units,true));
    if(t.action==='defense')p.push(defensePhrase(t.defenseOrder,true));
    if(t.action==='weapon')p.push(weaponPhrase(t.weaponOrder,true)+(t.weaponOrder.operation==='launch'&&fact.expectedVerdict==='reported'?'. Launched; hit not confirmed':''));
    if(t.action==='assign_role')p.push(`Assigned as ${t.role==='lead'?'flight lead':'wingman'}, partner ${target}`);
    if(['join_formation','follow_unit','formation_change','cover','escort'].includes(t.action))p.push(`${({cover:'Cover',escort:'Escort',join_formation:'Join formation with',formation_change:'Change formation with',follow_unit:'Follow'})[t.action]} ${target}, ${label(t.formation)}${t.formation==='trail'?'':', '+label(t.side)}, spacing ${n(distanceValue(t.rangeM,system))} ${labels.distanceEnglish}`);
    if(t.action==='airport'){
      const o=t.airportOrder;p.push(airportCommandLabel(o.intent,'en')??airportNames[o.intent]??label(o.intent));if(o.runway)p.push('runway '+o.runway);if(o.gate)p.push('stand '+o.gate);if(o.taxiways?.length)p.push('via '+o.taxiways.join(', '));const mode=airportModeLabel(o.mode,o.intent,'en');if(mode)p.push(mode);if(Number.isFinite(o.altitudeM))p.push(`altitude ${n(radioAltitude(o.altitudeM,system))} ${labels.altitudeEnglish}`);
    }
    if(t.action==='fly_heading')p.push(`Heading ${n(t.headingDeg%360)} degrees`);
    if(t.action==='report_status')p.push('Report own status');
    if(t.action==='fly_to')p.push(t.append?'Append designated waypoint':'Proceed to designated waypoint');
    if(['orbit','clear_waypoints'].includes(t.action))p.push(t.action==='orbit'?'Orbit and hold':'Clear route and hold');
    if(t.action==='pause'||t.action==='resume')p.push(t.action==='pause'?'Pause simulation':'Resume simulation');
    if(Number.isFinite(t.altitudeM))p.push(`altitude ${n(radioAltitude(t.altitudeM,system))} ${labels.altitudeEnglish}`);
    if(Number.isFinite(t.speedMps))p.push(`true airspeed ${n(radioSpeed(t.speedMps,system))} ${labels.speedEnglish}`);
    if(Number.isFinite(t.distanceM))p.push(`proceed ${n(distanceValue(t.distanceM,system))} ${labels.distanceEnglish}`);
    if(p.length)parts.push(p.join(', '));
  }
  if(!parts.length)for(const order of interpretation?.orders??[])if(order.unitIds.includes(fact.unitId))parts.push(label(order.intent));
  if(fact.departurePlan&&tasks.some(t=>t.action==='airport'&&needsDeparturePlan(t.airportOrder)))parts.push(departurePlanReadback(fact.departurePlan,system,'en'));
  const outcome=fact.expectedVerdict==='executing'&&fact.modelFacts?.clockRunning===false?'Orders set. Simulation paused; awaiting resume.':ENGLISH_VERDICTS[fact.expectedVerdict];
  return [...parts,outcome].filter(Boolean).join('. ');
}
import {weaponPhrase} from './weapons.js';
import {defensePhrase} from './rwr-defense.js';
