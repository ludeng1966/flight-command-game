import {AIRCRAFT_MODELS,aircraftModelId} from '../three3d/aircraft-catalog.js';

// 只切换外观，不把现有气动配置冒充为新机型的飞行模型。
export function initAircraftAppearance({getWorld,onChange,container=document.querySelector('#settings-aircraft')}){
  const fields=new Map();
  for(const unit of getWorld().units){
    const label=document.createElement('label'),field=document.createElement('select');field.id='appearance-'+unit.id;label.htmlFor=field.id;label.append(document.createTextNode(unit.callsign));
    for(const [id,spec]of Object.entries(AIRCRAFT_MODELS)){const option=document.createElement('option');option.value=id;option.textContent=spec.name;field.append(option);}
    field.onchange=()=>{const target=getWorld().units.find(u=>u.id===unit.id);if(!target||!Object.hasOwn(AIRCRAFT_MODELS,field.value))return;target.visualModel=field.value;onChange();};
    label.append(field);container.append(label);fields.set(unit.id,field);
  }
  function update(){for(const unit of getWorld().units){const field=fields.get(unit.id);if(field&&field.value!==aircraftModelId(unit))field.value=aircraftModelId(unit);}}
  update();return {update};
}
