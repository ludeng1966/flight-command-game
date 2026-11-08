import {AIRCRAFT_MODELS,aircraftModelId} from '../three3d/aircraft-catalog.js';

// 外形、气动和动力配置同时装订；在当前真实位置/速度下重新接入航路。
export function initAircraftAppearance({getWorld,onChange,onError=()=>{},container=document.querySelector('#settings-aircraft')}){
  const fields=new Map(),summaries=new Map();
  for(const unit of getWorld().units){
    const label=document.createElement('label'),field=document.createElement('select');field.id='appearance-'+unit.id;label.htmlFor=field.id;label.append(document.createTextNode(unit.callsign));
    for(const [id,spec]of Object.entries(AIRCRAFT_MODELS)){const option=document.createElement('option');option.value=id;option.textContent=spec.name;field.append(option);}
    field.onchange=()=>{if(!Object.hasOwn(AIRCRAFT_MODELS,field.value))return;try{getWorld().setAircraftType(unit.id,field.value);onChange();}catch(error){update();onError(error.message);}};
    const summary=document.createElement('p');summary.className='setting-hint';summary.dataset.aircraftProfile=unit.id;
    label.append(field);container.append(label,summary);fields.set(unit.id,field);summaries.set(unit.id,summary);
  }
  function update(){for(const unit of getWorld().units){const field=fields.get(unit.id);if(field&&field.value!==aircraftModelId(unit))field.value=aircraftModelId(unit);const p=unit.profile,summary=summaries.get(unit.id),text=`${p.category==='transport'?'OpenAP 参考气动':'战雷数据映射'} · 当前 ${(p.mass/1000).toFixed(1)} t · 机翼 ${p.area.toFixed(1)} m² · ${p.maxG} G`;if(summary&&summary.textContent!==text)summary.textContent=text;}}
  update();return {update};
}
