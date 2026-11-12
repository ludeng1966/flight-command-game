import {manualSection} from './pilot-manual.mjs';
// The same short reference is readable on disk and injected once per decision.
export const TACTICAL_AWARENESS_RULES=manualSection('evidence');

// History is used to derive trends on the server, not repeated verbatim in the
// model prompt. This keeps the new sensor context from adding avoidable latency.
export function compactRadar(radar){
  if(!radar)return radar;
  return {...radar,contacts:radar.contacts.map(({history,...contact})=>contact)};
}
export function compactTacticalUnit(unit){
  const {missileTelemetry,...rest}=unit;
  return {...rest,radar:compactRadar(unit.radar)};
}
export function compactTacticalContext(context){return {...context,units:context.units.map(compactTacticalUnit)};}
