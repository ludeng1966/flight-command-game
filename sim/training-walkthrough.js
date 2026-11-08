import {FlightTrainingSession} from './training.js';
import {TRAINING_MISSIONS} from './training-missions.js';
import {commandById} from './military-commands.js';
import {trainingLevel} from './training-levels.js';
import {controlAuthority,setHandoffMode,requestHandoff,airportExitReady} from './control-authority.js';
const near=(a,b,tolerance=1)=>a&&b&&a.every((v,i)=>Math.abs(v-b[i])<tolerance);
export class TrainingWalkthrough{
  constructor(world,unitId,{levelId=null}={}){
    if(levelId&&!trainingLevel(levelId))throw Error('没有这个教学关卡');this.levelId=levelId;
    this.handoffVersion=1;
    this.flight=new FlightTrainingSession(world,unitId,{mode:'guided',startingAirborne:this.level?.entry==='airborne'});this.world=world;this.unit=this.flight.unit;
    this.index=0;this.phase='brief';this.completed=[];this.attempts=0;this.feedback='';this.issued=null;
    this.stableSeconds=0;this.lastTime=world.time;
  }
  get level(){return trainingLevel(this.levelId);}
  get missions(){const missions=this.level?.missions??TRAINING_MISSIONS;return this.legacyMissionIds?this.legacyMissionIds.map(id=>missions.find(s=>s.id===id)).filter(Boolean):missions;}
  get step(){return this.missions[this.index];}
  get status(){return this.flight.status==='failed'||this.flight.status==='invalid'?this.flight.status:this.index>=this.missions.length?'passed':'active';}
  get score(){return this.completed.length*10;}
  complete(){if(this.phase==='success'||this.status!=='active')return;this.phase='success';this.feedback=this.step.success;this.completed.push(this.step.id);}
  next(){if(this.phase!=='success')return false;this.index++;this.phase='brief';this.feedback='';this.issued=null;this.stableSeconds=0;this.lastTime=this.world.time;return true;}
  select(id){if(this.step?.kind==='select'&&id===this.unit.id)this.complete();}
  answer(value){
    if(this.status!=='active'||this.phase==='success'||!this.step?.choices)return false;
    const option=this.step.choices.find(c=>c[0]===value);if(!option)return false;
    if(value===this.step.answer){this.complete();return true;}
    this.attempts++;this.feedback=option[2];return false;
  }
  accepted(command,{demo=false}={}){
    if(demo){if(this.step?.kind==='demo')this.complete();return;}
    if(this.status!=='active'||this.phase==='success'||this.step?.kind!=='command')return;
    const u=this.unit;
    this.issued={...command,completed:u.completedWaypoints??0,startTime:this.world.time,startPosition:[...u.position],travel:0,lastPosition:[...u.position]};this.phase='working';this.feedback='命令已接收。接下来观察实际执行。';
    if(command.intent==='orbit'){this.issued.center=[...u.orbit];this.issued.bearing=null;this.issued.angle=0;}
    if(command.intent==='bullseye'){const goal=this.bullseyeGoal(),actual=u.waypoints.at(-1);this.armWaypoint(near(actual,goal,50)?actual:goal);}
    if(command.intent==='report_status')this.complete();
  }
  // Called only after the shared AI command path has committed a real operation.
  // Clarification, connection errors and rejected plans never enter this method.
  observeExecuted(interpretation,{demo=false}={}){
    if(this.status!=='active'||interpretation?.status!=='understood')return;
    const orders=interpretation.orders??[];
    const fail=(order,reason)=>{this.attempts++;this.flight.fail(`已执行“${commandById(order.intent)?.label??order.intent}”。${reason}`);};
    for(const order of orders){
      if(this.status!=='active')break;
      if(['pause','resume','report_event'].includes(order.intent))continue;
      if(order.intent==='report_status'){
        if(this.step.intent==='report_status'||this.step.kind==='demo'){
          const target=this.step.requiredUnitId??this.unit.id;
          if(order.unitIds.includes(target))this.accepted({unitId:target,intent:'report_status'},{demo:demo||this.step.kind==='demo'});
          else this.feedback=`已收到其他飞机的报告；这一步需要${this.world.units.find(u=>u.id===target)?.callsign??'指定飞机'}报告状态。`;
        }
        continue;
      }
      if(!['directive','clearance'].includes(order.speechAct)||order.timing!=='now')continue;
      if(order.unitIds.length!==1||order.unitIds[0]!==this.unit.id){fail(order,'本轮应指挥 Alpha；接令对象错误，本轮任务失败。');continue;}
      if(['gear','flaps'].includes(order.intent)||order.intent==='go_around'&&this.step.id==='land')continue;
      const p=order.parameters??{},intent=order.intent==='return_to_base'?'land':order.intent==='fly_to'&&p.mode==='bullseye'?'bullseye':order.intent;
      if(this.step.kind==='map'&&intent==='fly_to'){
        const point=this.unit.waypoints.at(-1);if(point)this.waypoint(point);continue;
      }
      const expected=this.step.intent,matching=intent===expected||expected==='cruise'&&['set_flight','fly_heading'].includes(intent)||expected==='bullseye'&&intent==='fly_to'||expected==='taxi'&&intent==='hold_short'||expected==='orbit'&&intent==='clear_waypoints';
      if(this.step.kind!=='command'||!matching){fail(order,`本关目标是“${this.step.title}”；执行了其他飞行任务，本轮任务失败。`);continue;}
      if(['taxi','line_up','takeoff','land','approach'].includes(expected)&&this.unit.surface?.runway!=='09L'&&p.runway!=='09L'){
        fail(order,'本关指定09L；已向其他跑道下令，本轮任务失败。');continue;
      }
      if(['cruise','bullseye','orbit','fly_heading'].includes(expected)){
        if(Number.isFinite(p.altitudeM)&&Math.abs(p.altitudeM-6096)>50){fail(order,'本关目标高度是20000英尺；已设置错误高度，本轮任务失败。');continue;}
        if(Number.isFinite(p.speedMps)&&Math.abs(p.speedMps-350*1852/3600)>2){fail(order,'本关目标速度是350节；已设置错误速度，本轮任务失败。');continue;}
      }
      if(expected==='fly_heading'&&Number.isFinite(this.step.headingDeg)&&(!Number.isFinite(p.headingDeg)||Math.abs(p.headingDeg-this.step.headingDeg)>.1)){
        fail(order,`本步目标是${this.step.headingDeg}度；已设置其他航向，本轮任务失败。`);continue;
      }
      if(expected==='bullseye'&&!near(this.unit.waypoints.at(-1),this.bullseyeGoal(),50)){
        fail(order,'本关目的地是靶眼090度、10海里；已飞往其他位置，本轮任务失败。');continue;
      }
      this.stableSeconds=0;this.accepted({unitId:this.unit.id,intent:expected,runway:p.runway,altitudeM:p.altitudeM,speedMps:p.speedMps});
    }
  }
  bullseyeGoal(){return [this.world.bullseye.position[0]+18520,this.world.bullseye.position[1],6096];}
  waypoint(point){
    if(this.status!=='active'||this.step?.kind!=='map'||this.phase==='success')return false;
    if(!this.unit.waypoints.some(w=>near(w,point)))return false;
    this.issued={intent:'map',point:point.slice(0,3),completed:this.unit.completedWaypoints??0};this.armWaypoint(point);this.phase='working';this.feedback='目的地已设置。等飞机真正通过它。';return true;
  }
  observe(){if(this.status!=='active'||this.step.kind!=='observe'||this.phase==='success')return false;this.issued={intent:'observe'};this.phase='working';this.feedback=this.step.text;return true;}
  chooseControlMode(mode){if(this.step.kind!=='handoff-mode'||!['strict','relaxed'].includes(mode))return false;setHandoffMode(this.world,this.unit,mode==='relaxed'?'auto':'manual');this.complete();return true;}
  handoff(){if(this.status!=='active'||this.step.kind!=='handoff'||this.phase==='success')return false;const c=controlAuthority(this.world,this.unit);if(c.owner!==this.step.targetOwner&&c.phase==='owned')requestHandoff(this.world,this.unit,this.step.targetOwner);this.issued={intent:'handoff',targetOwner:this.step.targetOwner};this.phase='working';this.feedback='等待完整交接通话与接管确认。';return true;}
  armWaypoint(point){this.issued.reference=this.unit.waypoints.find(w=>near(w,point));this.issued.present=!!this.issued.reference;this.issued.lastCompleted=this.unit.completedWaypoints??0;}
  tick(world=this.world){
    this.flight.tick(world);if(this.status!=='active'||this.phase==='success')return;
    const now=world.time,dt=Math.max(0,now-this.lastTime);this.lastTime=now;
    if(this.step.kind==='observe'&&this.unit.surface?.phase==='missed'){
      const landing=this.missions.findIndex(s=>s.intent==='land');if(landing>=0){const pending=new Set(this.missions.slice(landing).map(s=>s.id));this.completed=this.completed.filter(id=>!pending.has(id));this.index=landing;this.phase='brief';this.issued=null;this.feedback='飞机已经复飞。先稳定状态，再从指挥电台重新下达降落任务。';}return;
    }
    if(!this.issued)return;
    const u=this.unit,phase=u.surface?.phase??'airborne',intent=this.issued.intent;
    if(intent==='handoff'){const c=controlAuthority(world,u);if(c.owner===this.issued.targetOwner&&c.phase==='owned'&&c.history.some(h=>h.to===c.owner&&h.at>=this.flight.startedAt))this.complete();}
    if(this.issued.lastPosition){this.issued.travel+=Math.hypot(...u.position.map((v,i)=>v-this.issued.lastPosition[i]));this.issued.lastPosition=[...u.position];}
    if(intent==='taxi'&&phase==='holding'&&u.speed<.5)this.complete();
    if(intent==='line_up'&&phase==='lined_up'&&u.speed<.5)this.complete();
    if(intent==='takeoff'&&this.flight.completed.departure&&airportExitReady(world,u))this.complete();
    if(intent==='cruise'){
      const stable=!u.surface?.grounded&&u.flightState==='normal'&&!u.navigationBlocked&&Math.abs(u.position[2]-6096)<150&&Math.abs(u.speed-350*1852/3600)<15&&Math.abs(u.bank)<(this.flight.startingAirborne?Math.PI/4:Math.PI/12);
      this.stableSeconds=stable?this.stableSeconds+dt:0;if(this.stableSeconds>=10)this.complete();
    }
    if(intent==='fly_heading'){
      const heading=Math.atan2(u.velocity[0],u.velocity[1]),error=Math.atan2(Math.sin(heading-this.step.headingDeg*Math.PI/180),Math.cos(heading-this.step.headingDeg*Math.PI/180));
      const stable=!u.surface?.grounded&&u.flightState==='normal'&&!u.navigationBlocked&&Math.abs(error)<Math.PI/36&&Math.abs(u.position[2]-6096)<150&&Math.abs(u.speed-350*1852/3600)<15;
      this.stableSeconds=stable?this.stableSeconds+dt:0;if(this.stableSeconds>=8&&this.issued.travel>=1000)this.complete();
    }
    if(intent==='orbit'){
      const bearing=Math.atan2(u.position[0]-this.issued.center[0],u.position[1]-this.issued.center[1]);
      if(Math.hypot(u.position[0]-this.issued.center[0],u.position[1]-this.issued.center[1])>=Math.max(500,u.speed*3)){
        if(this.issued.bearing!==null)this.issued.angle+=Math.atan2(Math.sin(bearing-this.issued.bearing),Math.cos(bearing-this.issued.bearing));this.issued.bearing=bearing;
      }
      const stable=!u.surface?.grounded&&!u.waypoints.length&&!u.headingRoute&&u.flightState==='normal'&&!u.navigationBlocked&&Math.abs(u.position[2]-6096)<150&&Math.abs(u.speed-350*1852/3600)<15;
      this.stableSeconds=stable?this.stableSeconds+dt:0;
      if(stable&&this.stableSeconds>=10&&Math.abs(this.issued.angle)>=Math.PI*2*(this.step.orbitLaps??1)&&this.issued.travel>=1000)this.complete();
    }
    if(intent==='approach'&&phase==='approach'&&this.issued.travel>=1000&&now-this.issued.startTime>=8)this.complete();
    if(['map','bullseye'].includes(intent)){
      const present=u.waypoints.includes(this.issued.reference),count=u.completedWaypoints??0;
      if(['airborne','climb'].includes(phase)&&count>this.issued.lastCompleted&&!u.headingRoute&&this.issued.present&&!present)this.complete();
      this.issued.present=present;this.issued.lastCompleted=count;
    }
    if(intent==='observe'){
      const reached=phase===this.step.targetPhase||this.step.targetPhase==='rollout'&&this.flight.flags.landed||this.step.targetPhase==='exit'&&this.flight.flags.exited||this.step.targetPhase==='parked'&&this.flight.completed.recovery;
      if(reached&&(!u.surface?.grounded||this.step.targetPhase!=='parked'||u.speed<.5))this.complete();
    }
    if(intent==='land'&&(this.step.completeWhen==='final'?phase==='final'||this.flight.flags.landed:this.flight.completed.recovery))this.complete();
    else if(intent==='land'&&phase==='missed'){this.phase='brief';this.issued=null;this.feedback='这次进近已复飞。检查跑道与飞行状态，再次发送降落命令。';}
  }
  invalidate(reason){this.flight.invalidate(reason);}
  result(){return {...this.flight.result(),status:this.status,steps:[...this.completed],score:this.score,attempts:this.attempts,walkthroughVersion:this.legacyMissionIds?3:4,handoffVersion:this.legacyMissionIds?0:1,controlTransfers:controlAuthority(this.world,this.unit).history.map(h=>({...h})),levelId:this.levelId,levelTitle:this.level?.title??null,totalSteps:this.missions.length};}
}
