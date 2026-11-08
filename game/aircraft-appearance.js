import {AIRCRAFT_MODELS,aircraftModelId} from '../three3d/aircraft-catalog.js';

// 外形、气动和动力配置同时装订；在当前真实位置/速度下重新接入航路。
export function initAircraftAppearance({getWorld,onChange,onError=()=>{},container=document.querySelector('#settings-aircraft')}){
  const fields=new Map();
  for(const unit of getWorld().units){
    const label=document.createElement('label'),field=document.createElement('select');field.id='appearance-'+unit.id;label.htmlFor=field.id;label.append(document.createTextNode(unit.callsign));
    for(const [id,spec]of Object.entries(AIRCRAFT_MODELS)){const option=document.createElement('option');option.value=id;option.textContent=spec.name;field.append(option);}
    field.onchange=()=>{if(!Object.hasOwn(AIRCRAFT_MODELS,field.value))return;try{getWorld().setAircraftType(unit.id,field.value);onChange();}catch(error){update();onError(error.message);}};
    label.append(field);container.append(label);fields.set(unit.id,field);
  }
  function update(){for(const unit of getWorld().units){const field=fields.get(unit.id);if(field&&field.value!==aircraftModelId(unit))field.value=aircraftModelId(unit);}}
  update();return {update};
}
