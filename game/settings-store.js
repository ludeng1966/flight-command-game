// Preferences survive starting a new game or replacing a simulation save.
export const SETTINGS_KEY='flight-settings-v1';
const oneOf=values=>value=>values.includes(value),boolean=value=>typeof value==='boolean';
const rules={
  'command-style':oneOf(['pla','nato']),'command-auto':boolean,'append-waypoint':boolean,
  'airport-runway':oneOf(['09L','09R','27L','27R']),'airport-gate':oneOf(['G1','G2','G3','G4','G5','G6']),
  'airport-taxiways':value=>typeof value==='string'&&value.length<=80,
  'radio-audio-enabled':boolean
};
const formIds=Object.keys(rules).filter(id=>id!=='radio-audio-enabled');
export function settingsStorage(){try{return globalThis.localStorage??null;}catch{return null;}}
function sanitize(value){return Object.fromEntries(Object.entries(rules).filter(([id,valid])=>valid(value?.[id])).map(([id])=>[id,value[id]]));}
export function readSettings(storage=settingsStorage()){
  try{return sanitize(JSON.parse(storage?.getItem(SETTINGS_KEY)??'{}'));}catch{return {};}
}
export function writeSettings(patch,storage=settingsStorage()){
  try{if(!storage)return false;storage.setItem(SETTINGS_KEY,JSON.stringify({...readSettings(storage),...sanitize(patch)}));return true;}catch{return false;}
}
export function initSettingsMemory({doc=document,win=window,storage=settingsStorage(),legacyForm=null}={}){
  const values={...sanitize(legacyForm),...readSettings(storage)};
  for(const id of formIds){const el=doc.getElementById(id);if(!el||!Object.hasOwn(values,id))continue;if(el.type==='checkbox')el.checked=values[id];else el.value=values[id];}
  const capture=()=>Object.fromEntries(formIds.flatMap(id=>{const el=doc.getElementById(id);return el?[[id,el.type==='checkbox'?el.checked:el.value]]:[];}));
  // Migrate legacy form settings once. Never include command drafts or flight state.
  writeSettings(capture(),storage);
  const change=e=>{const el=e.target;if(formIds.includes(el?.id))writeSettings({[el.id]:el.type==='checkbox'?el.checked:el.value},storage);};
  const flush=()=>writeSettings(capture(),storage);
  doc.addEventListener('change',change);win.addEventListener('pagehide',flush,{capture:true});
  return {handles:id=>formIds.includes(id),flush,destroy(){doc.removeEventListener('change',change);win.removeEventListener('pagehide',flush,{capture:true});}};
}
