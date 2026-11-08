const commands={taxi:['滑行','TAXI'],hold_short:['跑道外等待','HOLD SHORT'],line_up:['进入跑道对正等待','LINE UP AND WAIT'],takeoff:['起飞','TAKE OFF'],abort_takeoff:['中断起飞','ABORT TAKEOFF'],approach:['进近','APPROACH'],land:['着陆','LAND'],return_to_base:['返航着陆','RETURN TO BASE'],go_around:['复飞','GO AROUND'],gear:['起落架控制','LANDING GEAR'],flaps:['襟翼控制','FLAPS']};
const modes={reduced_thrust:['减推力起飞','REDUCED-THRUST TAKEOFF'],derated:['减推力起飞','DERATED TAKEOFF'],flex:['灵活推力起飞','FLEX TAKEOFF'],full_thrust:['全推力起飞','FULL-THRUST TAKEOFF'],military_power:['军用推力','MILITARY POWER'],afterburner:['加力','AFTERBURNER'],dry:['不开加力','DRY POWER']};
export const airportCommandLabel=(intent,language='zh')=>commands[intent]?.[language==='en'?1:0]??null;
const taxiwayMode=mode=>typeof mode==='string'&&/^[A-Z]\d*(?:\s*[,，]\s*[A-Z]\d*)*$/.test(mode);
export function airportModeSupported({intent,mode}){
  if(!mode)return true;
  if(intent==='gear')return ['up','down'].includes(mode);
  if(intent==='flaps')return ['up','takeoff','landing'].includes(mode);
  if(intent==='takeoff'&&Object.hasOwn(modes,mode))return true;
  if(['land','approach'].includes(intent)&&['visual','ils','rnav','overhead','formation','section'].includes(mode))return true;
  if(intent==='takeoff'&&['formation','section'].includes(mode))return true;
  if(['normal','standard','default','auto'].includes(mode))return true;
  return ['taxi','takeoff'].includes(intent)&&taxiwayMode(mode);
}
export function airportModeLabel(mode,intent,language='zh'){
  if(!mode||!commands[intent]||taxiwayMode(mode)||['normal','standard','default','auto'].includes(mode))return null;
  const en=language==='en';
  const procedures={visual:['目视进近','VISUAL APPROACH'],ils:['仪表着陆系统进近','ILS APPROACH'],rnav:['区域导航进近','RNAV APPROACH'],overhead:['起落航线通场转弯进近','OVERHEAD APPROACH'],formation:['双机编队起降','FORMATION OPERATION'],section:['双机编队起降','SECTION OPERATION']};
  if(procedures[mode])return procedures[mode][en?1:0];
  if(intent==='gear')return ({up:['收起起落架','GEAR UP'],down:['放下起落架','GEAR DOWN']})[mode]?.[en?1:0]??(en?'UNRECOGNIZED GEAR MODE':'未识别的起落架模式');
  if(intent==='flaps')return ({up:['收起襟翼','FLAPS UP'],takeoff:['起飞襟翼','TAKEOFF FLAPS'],landing:['着陆襟翼','LANDING FLAPS']})[mode]?.[en?1:0]??(en?'UNRECOGNIZED FLAP MODE':'未识别的襟翼模式');
  return modes[mode]?.[en?1:0]??(en?'UNSUPPORTED MODE':'未支持的附加模式');
}
export const airportModeCapability=order=>airportModeSupported(order)?null:Object.hasOwn(modes,order.mode)?'power':'advanced_control';
