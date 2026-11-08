import {radioDigits} from '../sim/radio.js';
import {altitudeValue,unitLabels,getUnitSystem} from '../sim/units.js';

// 已提交的鼠标指令直接复诵，不再交给语言模型重新解释。
export function manualRouteReadback(world,id,change={},style='pla',system=getUnitSystem()){
  const unit=world.units.find(u=>u.id===id);if(!unit||unit.alive===false)return null;
  const route=unit.waypoints,call=style==='nato'?unit.callsign:radioDigits(unit.radioNumber||String(101+world.units.indexOf(unit)));
  const point=change.point&&route.find(w=>w.every((v,i)=>i>2||Math.abs(v-change.point[i])<.1));
  const next=point??route[0],labels=unitLabels(system),alt=next?Math.round(altitudeValue(next[2],system)):null;
  const actions={append:['追加航点','Waypoint added'],command:['新航路已接收','New route received'],move:['航点已调整','Waypoint updated'],replace:['重绘航路已接收','Redrawn route received'],delete:['航点已删除','Waypoint deleted'],undo:['已撤销航路修改','Route edit undone'],redo:['已重做航路修改','Route edit redone'],clear:['航路已清除','Route cleared']};
  const action=actions[change.kind]??actions.replace;
  const zh=next?`${action[0]}，${point?'航点':'下一航点'}${next.number??route.indexOf(next)+1}，目标高度${alt}${labels.altitudeSpoken}，剩余${route.length}个航点，按更新航路执行。`:`${action[0]}，盘旋待命。`;
  const en=next?`${action[1]}. ${point?'Waypoint':'Next waypoint'} ${next.number??route.indexOf(next)+1}, target altitude ${alt} ${labels.altitudeEnglish}. ${route.length} waypoints remaining. Executing updated route.`:`${action[1]}. Holding orbit.`;
  const texts={zh:`${call}，收到。${zh}${unit.routeLoop?'环形航路，持续循环飞行。':''}`,en:`${unit.callsign}, ROGER. ${en}${unit.routeLoop?' Closed circuit. Continuing cyclic route.':''}`};
  return {speaker:'pilot',unitId:id,text:texts.zh,texts,language:'zh-CN',source:'manual-route',routeRevision:unit.routeRevision??0,simTime:world.time};
}

export class ManualRouteRadio{
  constructor({getState,radio,isBusy=()=>false,now=()=>performance.now(),settleMs=350}){
    Object.assign(this,{getState,radio,isBusy,now,settleMs});this.pending=new Map();this.active=null;
  }
  enqueue(id,change){
    const state=this.getState(),message=manualRouteReadback(state.world,id,change,state.radioStyle,state.world.unitSystem??getUnitSystem());if(!message)return;
    // 同一飞机在短时间内重复编辑只保留最后一次；两架飞机分别确认。
    this.pending.set(id,{world:state.world,message,readyAt:this.now()+this.settleMs});
  }
  pump(){
    if(this.active||this.isBusy())return;
    const world=this.getState().world;
    for(const [id,item]of this.pending){
      const unit=world.units.find(u=>u.id===id);
      if(item.world!==world||!unit||unit.alive===false||(unit.routeRevision??0)!==item.message.routeRevision){this.pending.delete(id);continue;}
      if(this.now()<item.readyAt)continue;
      this.pending.delete(id);const controller=new AbortController();this.active=controller;
      this.radio.phase('executing','手动航路已生效 · 飞行员确认');
      Promise.resolve().then(()=>this.radio.transmit(item.message,{signal:controller.signal})).catch(()=>{}).finally(()=>{if(this.active===controller)this.active=null;});
      break;
    }
  }
  interrupt(){this.active?.abort();this.active=null;}
  clear(){this.pending.clear();this.interrupt();}
}
