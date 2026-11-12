import {AIRSPACE_STANDARD_IDS,AIRSPACE_STANDARD_LABELS} from '../sim/airspace.js';

const STORAGE='flight-airspace-standard';
export function initAirspaceControl({getWorld,onChange=()=>{}}){
  let standard='faa';
  try{const saved=localStorage.getItem(STORAGE);if(AIRSPACE_STANDARD_IDS.includes(saved))standard=saved;}catch{}
  const button=document.createElement('button');
  button.id='airspace-toggle';button.type='button';button.title='切换空域标准（FAA / 北约）';
  button.addEventListener('click',()=>{
    standard=AIRSPACE_STANDARD_IDS[(AIRSPACE_STANDARD_IDS.indexOf(standard)+1)%AIRSPACE_STANDARD_IDS.length];
    try{localStorage.setItem(STORAGE,standard);}catch{}
    try{getWorld()?.setAirspaceStandard?.(standard);}catch{}
    onChange();update();
  });
  document.querySelector('#panel-controls')?.append(button);
  function update(){
    button.textContent=`空域 ${AIRSPACE_STANDARD_LABELS[standard]??standard}`;
    const world=getWorld();
    if(world&&typeof world.setAirspaceStandard==='function'&&world.airspaceStandard!==standard){
      try{world.setAirspaceStandard(standard);}catch{}
    }
  }
  update();return {update,get standard(){return standard;}};
}
