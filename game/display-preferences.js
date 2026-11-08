export const DEFAULT_DISPLAY=Object.freeze({airportLabels:'minimal',trails:'selected',waypointLabels:'selected'});
export function displayPreferences(value={}){
  return {airportLabels:['minimal','full','off'].includes(value?.airportLabels)?value.airportLabels:DEFAULT_DISPLAY.airportLabels,
    trails:['selected','all','off'].includes(value?.trails)?value.trails:DEFAULT_DISPLAY.trails,
    waypointLabels:value?.waypointLabels==='all'?'all':'selected'};
}
