export const EXECUTION_MODES=['strict','relaxed'];
export function executionMode(value){return EXECUTION_MODES.includes(value)?value:'strict';}
// 只放宽意图补全与已有流程组合，不放宽碰撞、实体与跑道占用。
export function adaptExecution(value,context){
  const adjustments=[];if(context.executionMode!=='relaxed')return {value,adjustments};
  const copy=structuredClone(value),airportIntents=['taxi','hold_short','line_up','takeoff','approach','land','return_to_base'];
  for(const o of copy.orders){
    if(!airportIntents.includes(o.intent))continue;const p=o.parameters,airports=context.airports??[];
    if(p.constraints&&/^(允许|可以|可)?(自行|自动)(安排|选择|调整|规划)(路线|滑行路线|滑行道|跑道|离场流程)[，。；\s]*$/.test(p.constraints)){p.constraints=null;adjustments.push('按玩家授权自动安排机场流程');}
    const a=airports.find(a=>p.airportRef&&[a.id,a.name].includes(p.airportRef))??(!p.airportRef||/^(本场|本机场|本基地|基地)$/.test(p.airportRef)?airports[0]:null);if(!a)continue;
    if(p.airportRef!==a.id){adjustments.push(`自动选用${a.name}`);p.airportRef=a.id;}
    const runways=a.runways.map(r=>typeof r==='string'?r:r.designator);let requested=p.runway;
    if(!requested){const peer=copy.orders.find(x=>x!==o&&JSON.stringify(x.unitIds)===JSON.stringify(o.unitIds)&&x.parameters.runway);requested=peer?.parameters.runway??null;}
    const code=requested?.toUpperCase().replace(/跑道|\s/g,'').replace(/左/g,'L').replace(/右/g,'R').replace(/中/g,'C').replace(/^(\d)([LRC]?)$/,'0$1$2');
    const selected=runways.includes(code)?code:runways.find(r=>!code||r.startsWith(code));
    if(selected&&selected!==p.runway){adjustments.push(`补全跑道${selected}`);p.runway=selected;}
  }
  const departure=['taxi','hold_short','line_up','takeoff'],used=new Set(),orders=[];
  for(const o of copy.orders){if(used.has(o))continue;
    const group=copy.orders.filter(x=>!used.has(x)&&departure.includes(x.intent)&&x.timing!=='on_condition'&&!x.condition&&!x.parameters.constraints&&!x.parameters.holdPoint?.startsWith('G')&&JSON.stringify(x.unitIds)===JSON.stringify(o.unitIds)&&x.parameters.runway===o.parameters.runway&&x.parameters.airportRef===o.parameters.airportRef);
    if(departure.includes(o.intent)&&group.length>1&&group.some(x=>x.timing==='now')&&group.some(x=>x.intent==='takeoff'||x.intent==='line_up')){
      const final=group.find(x=>x.intent==='takeoff')??group.find(x=>x.intent==='line_up'),parameters={...final.parameters};
      for(const x of group)for(const k of ['mode','altitudeM','holdPoint'])if(parameters[k]===null)parameters[k]=x.parameters[k];
      orders.push({...final,parameters,timing:'now',condition:null});group.forEach(x=>used.add(x));adjustments.push('将滑行、等待和离场阶段合并为程序连续流程');
    }else{orders.push(o);used.add(o);}
  }
  copy.orders=orders.map((o,i)=>({...o,id:`order-${i+1}`}));return {value:copy,adjustments:[...new Set(adjustments)]};
}
