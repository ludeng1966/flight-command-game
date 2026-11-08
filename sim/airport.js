import {G,clamp,density,aeroAt,thrustAt,dryFraction,dragAt,atmosphere,hasAfterburner} from './flight.js';
import {controlEnergy,energyEnvelope} from './energy.js';
import {airportModeSupported,airportModeLabel} from './airport-language.js';
import {airportWeather,runwayWeatherLimits,brakingDeceleration,windComponents,atisInformation} from './airport-weather.js';
import {AirportTrafficController,initializeAtc,separationSeconds,AIRPORT_STATIONS} from './airport-atc.js';
import {evaluateDeparturePlan} from './departure-plan.js';
import {takeoffPerformance,landingPerformance,rotationSpeed} from './airport-performance.js';
import {prepareGroundTraffic,groundSpeedLimit,taxiEdgeKey} from './airport-ground.js';
import {updateAirportSections} from './airport-section.js';
import {applyAtcDecision} from './atc-decisions.js';
import {arrivalProcedure,runwayProcedure,updateApproachReceiver,APPROACH_TYPES} from './airport-procedures.js';

export const AIRPORT_INTENTS=['taxi','hold_short','line_up','takeoff','abort_takeoff','approach','land','go_around','gear','flaps'];
const distance=(a,b)=>Math.hypot(...a.map((v,k)=>v-b[k]));
const angle=a=>Math.atan2(Math.sin(a),Math.cos(a));
export function createAirport(config={},terrain){
  const center=config.center??[-18000,0],elevation=config.elevation??100;
  const p=(x,y)=>[center[0]+x,center[1]+y,elevation+1.6];
  const airport={id:config.id??'BAY',name:'海湾国际机场',center,elevation,footprint:[2550,1400],nodes:{},edges:[],runways:[],buildings:[],stands:[],events:[],wind:{heading:90,speedMps:3},closed:[]};
  const node=(id,x,y)=>{airport.nodes[id]=p(x,y);return id;};
  const edge=(a,b,name,width=23)=>airport.edges.push({a,b,name,width});
  node('APRON',0,400);node('EAST',2200,400);node('SOUTH',2200,-600);edge('APRON','EAST','C');edge('EAST','SOUTH','C');
  node('APRON_BYPASS',0,500);node('EAST_BYPASS',2200,500);edge('APRON','APRON_BYPASS','C2');edge('APRON_BYPASS','EAST_BYPASS','C2');edge('EAST_BYPASS','EAST','C2');
  for(let i=0;i<6;i++){const id='G'+(i+1);node(id,-1000+i*350,220);airport.stands.push(id);edge(id,'APRON','P'+(i+1),30);}
  for(const [index,y,name]of [[0,900,'A'],[1,-900,'B']]){
    const xs=[-1700,-800,0,800,1700];
    xs.forEach((x,i)=>{node(name+i,x,y+(index?300:-300));if(i)edge(name+(i-1),name+i,name);});
    if(index){edge('SOUTH','B4','B');}else edge('APRON','A2','A');
    const strip={id:'RW'+index,y:center[1]+y,x0:center[0]-1800,x1:center[0]+1800,width:45,length:3600,owner:null};
    for(const [direction,x,i,suffix]of [[1,-1700,0,index?'R':'L'],[-1,1700,4,index?'L':'R']]){
      const designator=(direction===1?'09':'27')+suffix,hold='H'+designator,entry='R'+designator;
      node(hold,x,y+(index?120:-120));node(entry,x,y);edge(name+i,hold,name+(i===0?'1':'5'));
      airport.runways.push({designator,stripId:strip.id,direction,hold,entry,headingDeg:direction===1?90:270,...strip});
    }
    for(let i=1;i<4;i++){const exit=name+'X'+i;node(exit,xs[i],y);edge(exit,name+i,name+'E'+i);}
  }
  airport.buildings=[{id:'terminal',center:p(0,-100),half:[650,170,22]},{id:'tower',center:p(1200,100),half:[20,20,45]}];
  if(terrain?.heights){
    const m=terrain.meta;
    for(let j=0;j<m.height;j++)for(let i=0;i<m.width;i++){
      const x=m.originEast+i*m.step-center[0],y=m.originNorth+j*m.step-center[1];
      if(Math.abs(x)<airport.footprint[0]&&Math.abs(y)<airport.footprint[1])terrain.heights[j*m.width+i]=elevation;
    }
  }
  airport.weather=airportWeather(config.weather??{});airport.wind={heading:airport.weather.windFromDeg,speedMps:airport.weather.windSpeedMps};
  airport.procedures=airport.runways.map(r=>runwayProcedure(airport,r));initializeAtc(airport);return airport;
}

// Dijkstra over named taxiway edges. Runway entries are deliberately absent.
export function taxiPath(airport,from,to,via=[],{avoidEdges=[],avoidNodes=[]}={}){
  if(!airport.nodes[from]||!airport.nodes[to])throw Error('未知滑行起点或等待点');
  const queue=[{node:from,path:[from],cost:0,via:0}],visited=new Set();
  while(queue.length){queue.sort((a,b)=>a.cost-b.cost);const at=queue.shift(),key=at.node+':'+at.via;if(visited.has(key))continue;visited.add(key);
    if(at.node===to&&at.via===via.length)return at.path;
    for(const e of airport.edges){const next=e.a===at.node?e.b:e.b===at.node?e.a:null;if(!next||airport.closed.includes(e.name)||avoidEdges.includes(taxiEdgeKey(e.a,e.b))||avoidNodes.includes(next))continue;
      const progress=at.via<via.length&&e.name===via[at.via]?at.via+1:at.via;
      queue.push({node:next,path:[...at.path,next],cost:at.cost+distance(airport.nodes[at.node],airport.nodes[next]),via:progress});
    }
  }
  throw Error('滑行道关闭或指定路线不可达');
}
export class AirportOperations{
  constructor(airport){this.airport=airport;this.leases={};this.cooldown={};this.eventSequence=0;Object.defineProperty(this,'world',{value:null,writable:true,enumerable:false});this.traffic=new AirportTrafficController(this);this.groundSlots={};}
  beginFrame(world){
    if(this.traffic.state.playerDirected)this.traffic.state.guidanceMode=world.executionMode==='strict'?'player':'assisted';
    this.world=world;this.airport.clock=world.time;this.airport.weather??=airportWeather({windFromDeg:this.airport.wind?.heading??90,windSpeedMps:this.airport.wind?.speedMps??3});
    for(const u of world.units){const s=u.surface;if(!u.alive||!s)continue;
      if(s.pendingRunwayChange&&s.node&&Math.hypot(u.position[0]-this.airport.nodes[s.node][0],u.position[1]-this.airport.nodes[s.node][1])<4){const d=s.pendingRunwayChange;s.pendingRunwayChange=null;try{applyAtcDecision(world,d);}catch(error){s.atcHoldUntil=Infinity;s.lastATCError=error.message;this.notice(u,world,'改跑道暂无法执行，在路口保持原位','UNABLE RUNWAY CHANGE. HOLD POSITION AT TAXI JUNCTION.','ground');}}
      if(s.grounded&&s.phase==='taxi'&&s.route.length&&!s.clearances)this.traffic.issue(u,'taxi',{runway:s.runway,route:[s.node,...s.route],limit:s.destination??s.route.at(-1)},world);
      if(s.grounded&&s.depart&&!s.atcRequestId)this.traffic.request(u,'departure',world);
      if(s.phase==='final'&&s.landCleared&&!s.clearances){const c=this.traffic.issue(u,'land',{runway:s.runway},world);this.traffic.delivered(c.id,world);this.traffic.acknowledge(c.id,c.parameters,world);}
    }
    updateAirportSections(this,world);this.traffic.tick(world);prepareGroundTraffic(this,world);
  }
  notice(u,world,zh,en,station){return this.traffic.notice(u,world,zh,en,station);}
  performance(u,r,operation){
    this.performanceCache??=new Map();const key=JSON.stringify([u.id,r.designator,operation,Math.round(u.profile.mass/10),this.airport.weatherSequence??0,this.airport.weather,u.departurePowerPlan?.id,u.fuel?.massKg===0]);
    if(!this.performanceCache.has(key)){this.performanceCache.set(key,operation==='departure'?takeoffPerformance(this.airport,r,u):landingPerformance(this.airport,r,u));if(this.performanceCache.size>128)this.performanceCache.delete(this.performanceCache.keys().next().value);}
    return this.performanceCache.get(key);
  }
  installProcedureRoute(u,world,points){world.atcRouteInstall=true;try{return world.replaceRoute(u.id,points);}finally{world.atcRouteInstall=false;}}
  rerouteGround(u,world,avoidEdges=[]){
    const s=u.surface;if(!s?.node||!s.destination||distance(u.position,this.airport.nodes[s.node])>20)return false;
    try{const route=taxiPath(this.airport,s.node,s.destination,[],{avoidEdges});if(route[1]===s.route[0])return false;
      s.route=route.slice(1);this.traffic.issue(u,'taxi',{runway:s.runway,route:[...route],limit:s.destination,qnhHpa:this.airport.weather.qnhHpa,atisCode:atisInformation(this.airport).code},world,{reasonZh:'避让交通，修订滑行路线',reasonEn:'GIVE WAY TO TRAFFIC, REVISED TAXI ROUTE'});return true;
    }catch{return false;}
  }
  weatherChanged(world){
    for(const c of this.traffic.state.clearances)if(['issued','delivered','active'].includes(c.status)&&['line_up','takeoff','land'].includes(c.type)){
      const u=world.units.find(u=>u.id===c.unitId),r=this.runway(c.parameters.runway,true),limits=runwayWeatherLimits(this.airport.weather,r,u?.profile);
      if(!limits.valid||this.airport.closed.includes(r.stripId)||this.airport.closed.includes(r.designator))this.traffic.cancel(c,world,limits.reason??'跑道关闭','RUNWAY OR WEATHER UNAVAILABLE');
    }
    this.traffic.state.revision++;
  }
  resolveRunwayUnavailable(u,world,reason){
    const s=u.surface;if(world.time-(s.runwayReviewAt??-Infinity)<20)return;s.runwayReviewAt=world.time;
    const next=this.airport.runways.filter(r=>r.designator!==s.runway&&!this.airport.closed.includes(r.designator)&&!this.airport.closed.includes(r.stripId)&&runwayWeatherLimits(this.airport.weather,r,u.profile).valid).sort((a,b)=>Math.abs(angle((a.headingDeg-this.airport.weather.windFromDeg)*Math.PI/180))-Math.abs(angle((b.headingDeg-this.airport.weather.windFromDeg)*Math.PI/180)))[0];
    if(this.traffic.state.playerDirected||this.traffic.state.guidanceMode==='player'){s.lastATCError=reason;this.notice(u,world,reason+'，请求玩家重新指定跑道或等待安排','RUNWAY UNAVAILABLE. REQUEST REVISED RUNWAY OR HOLD INSTRUCTIONS.',s.grounded?'ground':'approach');return;}
    if(!next||s.phase==='takeoff_roll'||s.phase==='lined_up'||s.runwayLocked){this.notice(u,world,reason+'，保持等待','STANDBY, RUNWAY OR WEATHER UNAVAILABLE.');return;}
    if(!s.grounded){if(s.phase!=='missed'){this.goAround(u,world,reason);return;}if(u.waypoints.length)return;try{this.apply(u,{intent:'land',runway:next.designator,mode:s.approachType??'ils',airportId:this.airport.id,taxiways:[],gate:s.arrivalGate??null,altitudeM:null},world);}catch(error){s.lastATCError=error.message;}return;}
    this.traffic.cancelUnit(u,world,'改用跑道'+next.designator,'CHANGE TO RUNWAY '+next.designator);this.release(u.id);
    const depart=s.depart,order={intent:depart?'takeoff':'taxi',runway:next.designator,airportId:this.airport.id,taxiways:[],gate:null,altitudeM:s.climbAltitude,mode:s.originalMode??null};
    const power=u.departurePowerPlan?evaluateDeparturePlan(world,u,order,u.departurePowerPlan):null;
    if(u.departurePowerPlan&&!power){this.notice(u,world,'新跑道无法满足原推力要求，保持等待并重新规划','UNABLE ORIGINAL THRUST PLAN ON NEW RUNWAY. HOLD POSITION, REPLANNING.');return;}
    this.apply(u,order,world,power);
    this.notice(u,world,'原跑道不可用，改用跑道'+next.designator+'，按新滑行许可执行','PREVIOUS RUNWAY UNAVAILABLE. CHANGE TO RUNWAY '+next.designator+', FOLLOW REVISED TAXI INSTRUCTIONS.');
  }
  log(u,text,time=0){this.airport.events.push({id:++this.eventSequence,unitId:u.id,time,text,phase:u.surface?.phase??null,grounded:u.surface?.grounded===true,...(text.startsWith('滑行许可：')?{taxiOrigin:u.surface.node}:{})});if(this.airport.events.length>96)this.airport.events.shift();u.surface.message=text;}
  runway(name,allowClosed=false){
    const choices=this.airport.runways.filter(r=>(!name||r.designator===name)&&(name||!this.airport.closed.includes(r.stripId)&&!this.airport.closed.includes(r.designator))).sort((a,b)=>Math.abs(angle((a.headingDeg-this.airport.wind.heading)*Math.PI/180))-Math.abs(angle((b.headingDeg-this.airport.wind.heading)*Math.PI/180)));
    if(!choices.length)throw Error('跑道不存在；请指定09L、09R、27L或27R');
    if(choices.length>1&&name)throw Error('请明确左右跑道');
    if(!allowClosed&&(this.airport.closed.includes(choices[0].stripId)||this.airport.closed.includes(choices[0].designator)))throw Error('该跑道关闭');return choices[0];
  }
  occupied(r,units,owner,{includeApproach=true}={}){return this.airport.closed.includes(r.stripId)||this.airport.closed.includes(r.designator)||!!this.leases[r.stripId]&&this.leases[r.stripId]!==owner||units.some(u=>u.id!==owner&&Math.abs(u.position[1]-r.y)<r.width/2+12&&u.position[0]>r.x0-100&&u.position[0]<r.x1+100&&u.position[2]<this.airport.elevation+80)||(includeApproach&&this.traffic.arrivalBlocks(r,units,owner));}
  reserve(r,units,id){const u=units.find(u=>u.id===id),previous=this.traffic.state.lastUse[r.stripId];if(this.occupied(r,units,id)||previous&&u&&(this.airport.clock??0)-previous.at<separationSeconds(previous,u,u.surface?.grounded?'departure':'arrival'))return false;this.leases[r.stripId]=id;return true;}
  release(id){for(const [k,v]of Object.entries(this.leases))if(v===id){delete this.leases[k];this.traffic.recordRelease(id,k,this.airport.clock??0);this.cooldown[k]=this.airport.clock??0;}}
  taxiRoute(from,to,via,policy='strict'){
    try{return {path:taxiPath(this.airport,from,to,via),rerouted:false};}catch(error){if(policy!=='relaxed'||!via?.length)throw error;return {path:taxiPath(this.airport,from,to,[]),rerouted:true};}
  }
  validate(u,order,policy='strict'){
    if(!u?.alive)throw Error('飞机无法接收机场任务');if(!AIRPORT_INTENTS.includes(order.intent))throw Error('未知机场指令');
    if(order.airportId&&![this.airport.id,this.airport.name].includes(order.airportId))throw Error('机场不存在');
    if(order.gate&&!this.airport.stands.includes(order.gate))throw Error('机位不存在');
    if(policy==='strict'&&!order.runway&&['taxi','hold_short','line_up','takeoff','approach','land'].includes(order.intent))throw Error('严格模式须明确跑道编号');
    const independent=['gear','flaps','abort_takeoff','go_around'].includes(order.intent),r=this.runway(independent?u.surface?.runway:order.runway??u.surface?.runway,independent),ground=u.surface?.grounded===true;
    if(order.intent==='gear'&&!['up','down'].includes(order.mode))throw Error('起落架模式须为up或down');
    if(order.intent==='flaps'&&!['up','takeoff','landing'].includes(order.mode))throw Error('襟翼模式无效');
    if(!airportModeSupported(order))throw Error(`${airportModeLabel(order.mode,order.intent)??'指定模式'}尚未接入实际控制，本次指令未执行`);
    if(['taxi','hold_short','line_up','takeoff','abort_takeoff'].includes(order.intent)&&!ground)throw Error('该机尚在空中，不能执行地面任务');
    if(['land','approach','go_around'].includes(order.intent)&&ground)throw Error('该机已在地面');
    if(order.intent==='abort_takeoff'&&u.surface?.phase!=='takeoff_roll')throw Error('当前没有起飞滑跑');
    if(order.intent==='gear'&&ground&&order.mode==='up')throw Error('地面禁止收起落架');
    if(order.intent==='line_up'&&!['holding','lined_up'].includes(u.surface?.phase))throw Error('须先滑行到跑道外等待点');
    if(order.intent==='line_up'&&u.surface.phase==='holding'&&u.surface.node!==r.hold)throw Error('不在指定跑道等待点，请重新滑行');
    if(order.intent==='takeoff'&&['lined_up','takeoff_roll'].includes(u.surface?.phase)&&u.surface.runway!==r.designator)throw Error('须先脱离当前跑道再变更跑道');
    if(order.intent==='taxi'){
      const from=u.surface.node??this.nearestNode(u.position),to=order.gate??r.hold;
      this.taxiRoute(from,to,order.taxiways??[],policy);
    }
    if(['approach','land'].includes(order.intent)&&u.position[2]>this.airport.elevation+10000)throw Error('高度过高，先下降后请求进近');
    return r;
  }
  nearestNode(position){return Object.keys(this.airport.nodes).sort((a,b)=>distance(position,this.airport.nodes[a])-distance(position,this.airport.nodes[b]))[0];}
  park(u,stand){
    if(!this.airport.stands.includes(stand))throw Error('机位不存在');
    this.release(u.id);u.position=[...this.airport.nodes[stand]];u.velocity=[0,0,0];u.speed=0;u.bank=0;u.cl=0;u.throttle=0;u.afterburner=0;u.gearDown=true;u.flaps='takeoff';u.flightState='normal';u.waypoints=[];u.headingRoute=null;
    u.surface={phase:'parked',grounded:true,node:stand,heading:0,route:[],station:'ground',message:'停机位就绪'};
    u.alive=true;u.mach=0;u.loadFactor=1;u.navLegs=[];u.navCursor=0;u.navigationBlocked=null;u.navigationKey=null;u.speedBrake=false;u.headingTarget=null;u.departurePowerPlan=null;u.pilotPowerPlan=null;u.pilotExecution=null;u.control={bank:0,cl:0,throttle:0,afterburner:0};
  }
  apply(u,order,world,departurePlan=null){
    const r=this.validate(u,order,world.executionMode),s=u.surface??={phase:'airborne',grounded:false,heading:Math.atan2(u.velocity[0],u.velocity[1]),route:[]};
    if(order.intent==='land'&&s.phase==='approach'&&s.runway===r.designator&&(!order.mode||order.mode===s.approachType)){s.landingRequested=true;s.playerAuthorizations??={};s.playerAuthorizations.land=true;s.explicitPhaseClearances??={};s.explicitPhaseClearances.land=true;this.log(u,'着陆许可请求已记录，保持原进近',world.time);return;}
    s.runway=r.designator;s.climbAltitude=order.altitudeM??this.airport.elevation+1200;s.originalMode=order.mode??null;
    if(['takeoff','land','approach'].includes(order.intent)){
      s.sectionMode=['formation','section'].includes(order.mode)?order.mode:null;s.sectionIntent=order.intent==='takeoff'?'departure':'arrival';s.sectionLeaderId=null;s.sectionWingId=null;s.sectionWaiting=false;s.sectionJoined=false;
    }
    if(order.intent==='takeoff')u.departurePowerPlan=departurePlan?{...structuredClone(departurePlan),active:true}:null;
    if(order.intent==='gear'){u.gearDown=order.mode!=='up';return;}
    if(order.intent==='flaps'){u.flaps=order.mode??'landing';return;}
    this.traffic.cancelUnit(u,world);s.clearances??={};s.playerAuthorizations={};s.explicitPhaseClearances={};s.clearanceInhibits={};s.pendingRunwayChange=null;
    if(order.intent==='line_up'){s.playerAuthorizations.line_up=true;s.explicitPhaseClearances.line_up=true;}
    if(order.intent==='takeoff'&&s.phase==='lined_up'){s.playerAuthorizations.takeoff=true;s.explicitPhaseClearances.takeoff=true;}
    if(order.intent==='approach')s.playerAuthorizations.approach=true;
    if(order.intent==='land'){s.playerAuthorizations.approach=true;s.playerAuthorizations.land=true;}
    if(order.intent==='abort_takeoff'){s.phase='rejected';s.depart=false;this.log(u,'中断起飞，保持跑道刹车',world.time);return;}
    if(order.intent==='go_around'){this.goAround(u,world,'指挥复飞');return;}
    if(['approach','land'].includes(order.intent)){
      s.pilotStageRequests={};
      s.phase='approach';s.grounded=false;s.landCleared=false;s.landingRequested=order.intent==='land';s.station='approach';u.gearDown=true;u.flaps='landing';
      s.arrivalGate=order.gate??null;
      s.approachType=s.sectionMode?'overhead':APPROACH_TYPES.includes(order.mode)?order.mode:'ils';s.procedure=arrivalProcedure(this.airport,r,s.approachType,u);
      u.targetSpeed=s.procedure.targetSpeedMps;s.towerHold={headingDeg:(Math.atan2(u.velocity[0],u.velocity[1])*180/Math.PI+360)%360,altitudeM:u.position[2],speedMps:u.speed};
      this.installProcedureRoute(u,world,s.procedure.points);u.waypoints.forEach((p,i)=>p.fixName=s.procedure.points[i]?.fixName);
      this.traffic.request(u,'arrival',world,{approachType:s.approachType});
      this.log(u,`请求${r.designator}进近许可`,world.time);return;
    }
    if(order.intent==='hold_short'){s.depart=false;s.lineUp=false;for(const q of this.traffic.state.requests)if(q.unitId===u.id)q.status='cancelled';if(s.phase==='holding'){this.log(u,'保持跑道外等待',world.time);return;}}
    if(order.intent==='line_up'){s.lineUp=true;s.taxiRequestedAt??=world.time;this.traffic.request(u,'departure',world);return;}
    s.depart=order.intent==='takeoff';s.lineUp=s.depart;
    if(s.phase==='lined_up'&&s.depart){this.traffic.request(u,'departure',world);return;}
    const from=s.node??this.nearestNode(u.position),to=order.gate??r.hold;
    const route=this.taxiRoute(from,to,order.taxiways??[],world.executionMode);if(route.rerouted)this.log(u,'放宽模式：原滑行道无法使用，已改走可达路线',world.time);
    s.route=route.path.slice(1);s.destination=to;s.phase='taxi';s.pilotStageRequests={};u.waypoints=[];u.headingRoute=null;
    s.taxiRequestedAt=world.time;s.station='ground';s.tow=null;s.groupMode=['formation','section'].includes(order.mode)?order.mode:null;
    if(s.depart)this.traffic.request(u,'departure',world);
    if(this.traffic.state.guidanceMode!=='player'||['taxi','hold_short'].includes(order.intent))this.traffic.issue(u,'taxi',{runway:r.designator,route:[...route.path],limit:to,qnhHpa:this.airport.weather.qnhHpa,atisCode:atisInformation(this.airport).code},world);
  }
  goAround(u,world,reason){
    u.surface.pilotStageRequests={};
    const s=u.surface,r=this.runway(s.runway,true);this.release(u.id);s.phase='missed';s.grounded=false;s.landCleared=false;u.gearDown=false;u.flaps='takeoff';
    this.traffic.cancelUnit(u,world,'执行复飞','GOING AROUND');s.station='approach';s.towerHold=null;s.missedProcedure=runwayProcedure(this.airport,r).missed;
    u.waypoints=[];u.headingRoute=null;u.headingTarget=r.headingDeg*Math.PI/180;u.holdAltitude=Math.max(u.position[2]+500,s.missedProcedure.altitudeM);u.targetSpeed=Math.max(150,u.speed);u.navigationBlocked=null;
    u.speedBrake=false;
    const env=energyEnvelope(u.profile,u.position[2],u.speed);u.guidance={bank:u.bank,n:1.25};u.control={bank:0,cl:Math.min(env.aero.clMax*.9,1.25*u.profile.mass*G/(.5*density(u.position[2])*u.speed**2*u.profile.area)),maxG:3,throttle:1,afterburner:1};if(u.energy){u.energy.gammaRef=Math.max(.035,u.energy.gammaRef);u.energy.boost=true;}
    const points=s.missedProcedure.points.map(p=>[...p]);points.forEach(p=>p[2]=Math.max(p[2],(world.terrain?.heightAt(p[0],p[1])??0)+450));
    try{this.installProcedureRoute(u,world,points);}catch{u.headingTarget=null;u.orbit=[u.position[0]+4000,u.position[1]];}
    this.traffic.request(u,'arrival',world,{status:'missed',reason,approachType:s.approachType??'ils'});
    this.log(u,'复飞：'+reason,world.time);
  }
  step(u,world,dt){
    this.airport.clock=world.time;
    const s=u.surface;if(!s)return false;const r=this.runway(s.runway,true),a=this.airport;
    if(!s.grounded&&['approach','final'].includes(s.phase)&&(a.closed.includes(r.stripId)||a.closed.includes(r.designator)||!runwayWeatherLimits(a.weather,r,u.profile).valid)){this.goAround(u,world,'跑道关闭或气象超限');return false;}
    if(!s.grounded){
      if(s.phase==='approach'){
        if(this.traffic.permitted(u,'approach')&&!s.towerHold?.vector)s.towerHold=null;
        updateApproachReceiver(u,a,r);s.landCleared=this.traffic.permitted(u,'land');
      }
      if(['approach','final'].includes(s.phase))u.speedBrake=u.speed>Math.max(95,u.targetSpeed+10);
      if(s.phase==='climb'&&u.position[2]>a.elevation+100){if((u.position[0]-(r.direction===1?r.x1:r.x0))*r.direction>150||Math.abs(u.position[1]-r.y)>800)this.release(u.id);if(u.position[2]>a.elevation+300)u.gearDown=false;}
      if(s.phase==='climb'&&!u.departurePowerPlan&&!s.sidInstalled&&u.position[2]>a.elevation+300&&world.time>=(s.sidRetryAt??0)){
        s.sidRetryAt=world.time+10;s.departureProcedure??=runwayProcedure(a,r).sid;const exit=[...s.departureProcedure.exit];exit[2]=s.climbAltitude;
        try{this.installProcedureRoute(u,world,[exit]);s.sidInstalled=true;}catch(error){s.lastATCError=error.message;}
      }
      if(s.phase==='climb'&&u.departurePowerPlan&&!u.departurePowerPlan.routeInstalled&&u.position[2]>a.elevation+300){
        const power=u.departurePowerPlan;u.waypoints=power.points.map((p,i)=>Object.assign([...p],{number:i+1}));u.nextWaypointNumber=u.waypoints.length+1;u.completedWaypoints=0;u.navLegs=[];u.navCursor=0;u.navigationKey=null;power.routeInstalled=true;
      }
      if(s.phase==='approach'&&!u.waypoints.length){
        if(Math.abs(angle(Math.atan2(u.velocity[0],u.velocity[1])-r.headingDeg*Math.PI/180))>.3||u.speed>115){this.goAround(u,world,'进近方向或速度未稳定');return false;}
        if(this.occupied(r,world.units,u.id,{includeApproach:false})){this.goAround(u,world,'跑道仍被占用');return false;}
        s.phase='final';s.towerHold=null;this.traffic.complete(u,'approach',world);this.traffic.requestNext(u,world);
      }
      if(s.phase==='final'){
        const receiver=updateApproachReceiver(u,a,r),start=r.direction===1?r.x0:r.x1,d=receiver.distanceM,lateral=r.y-u.position[1];
        s.landCleared=this.traffic.permitted(u,'land')||s.landCleared===true&&!s.clearances;
        const minima=s.procedure??arrivalProcedure(a,r,s.approachType??'ils',u),atMinima=u.position[2]<=a.elevation+(minima.decisionHeightM??61);
        if(atMinima&&u.gearFailure){this.goAround(u,world,'起落架无法确认放下锁定，请求故障处置');return false;}
        if(atMinima&&(!s.landCleared||a.weather.visibilityM<(minima.minimumVisibilityM??550)||a.weather.ceilingM<(minima.minimumCeilingM??61))){this.goAround(u,world,!s.landCleared?'未取得有效着陆许可':'天气低于程序最低标准');return false;}
        if(this.occupied(r,world.units,u.id)||d<0&&Math.abs(lateral)>18){this.goAround(u,world,'跑道侵入或未稳定对正');return false;}
        const groundSpeed=Math.max(40,Math.hypot(...(u.groundVelocity??u.velocity).slice(0,2))),height=a.elevation+1.6+Math.max(0,d)*Math.tan(Math.PI/60),desiredVz=d<450?-clamp((u.position[2]-a.elevation-1.6)*.14+.6,.6,3):clamp(-groundSpeed*.052+(height-u.position[2])*.25,-7,3);
        const wind=u.wind??[0,0,0],runwayHeading=r.headingDeg*Math.PI/180,cross=wind[0]*Math.cos(runwayHeading)-wind[1]*Math.sin(runwayHeading);
        const heading=runwayHeading-Math.asin(clamp(cross/Math.max(40,u.speed),-.3,.3))-clamp(r.direction*lateral/1200,-.2,.2),error=angle(heading-Math.atan2(u.velocity[0],u.velocity[1]));
        const env=energyEnvelope(u.profile,u.position[2],u.speed),target=Math.max(78,env.safeSpeed(1)*1.02),energy=controlEnergy(u,{gamma:Math.asin(clamp(desiredVz/u.speed,-.12,.1)),loadFactor:1.15,targetSpeed:target,envelope:env},dt);
        u.targetSpeed=target;u.control={bank:clamp(error*.9,-.35,.35),cl:clamp((1+(desiredVz-u.velocity[2])*.5/G)*u.profile.mass*G/(.5*density(u.position[2])*u.speed**2*u.profile.area),0,env.aero.clMax*.9),maxG:2,throttle:energy.throttle,afterburner:energy.afterburner};
        if(u.position[2]<=a.elevation+2.4&&u.position[0]>=r.x0&&u.position[0]<=r.x1){
          const groundVelocity=u.groundVelocity??u.velocity;
          if(!u.gearDown||Math.abs(u.bank)>.12||Math.abs(angle(Math.atan2(groundVelocity[0],groundVelocity[1])-r.headingDeg*Math.PI/180))>.12||Math.abs(u.velocity[2])>4||Math.abs(lateral)>r.width/2-5||u.speed<60||u.speed>130){u.alive=false;u.flightState='crashed';this.log(u,'着陆碰撞：姿态/速度超限',world.time);return true;}
          s.grounded=true;s.phase='rollout';s.heading=r.headingDeg*Math.PI/180;u.speed=Math.hypot(...groundVelocity.slice(0,2));u.position[2]=a.elevation+1.6;u.bank=0;this.traffic.complete(u,'land',world);this.log(u,'接地，减速脱离跑道',world.time);
        }
        if(d< -r.length+300&& !s.grounded){this.goAround(u,world,'剩余跑道不足');return false;}
      }
      if(!s.grounded)return false;
    }
    u.throttle=0;u.afterburner=0;u.bank=0;u.loadFactor=1;u.maneuverMode=s.message??s.phase;
    if(s.phase==='waiting_gate'&&!world.units.some(v=>v.id!==u.id&&v.alive&&distance(v.position,a.nodes[s.destination])<25)){s.route=taxiPath(a,s.node,s.destination).slice(1);s.phase='taxi';}
    if(s.phase==='holding'&&(s.lineUp||s.depart)&&this.traffic.permitted(u,'line_up')){
      if(!this.occupied(r,world.units,u.id)){this.leases[r.stripId]=u.id;s.route=[r.entry];s.phase='lineup_taxi';}else s.message='跑道占用，保持等待';
    }
    if(s.phase==='lined_up'&&s.depart&&this.traffic.permitted(u,'takeoff')&&!(s.atcHoldUntil>world.time)){s.phase='takeoff_roll';u.gearDown=true;u.flaps='takeoff';}
    if(s.phase==='takeoff_roll'){
      if(this.occupied(r,world.units,u.id,{includeApproach:false})){s.phase='rejected';this.log(u,'跑道侵入，中断起飞',world.time);}
      else{
        const power=u.departurePowerPlan,throttle=power?.throttle??1,afterburner=power?.afterburner??1;
        const speed=u.speed,airSpeed=Math.max(0,speed+windComponents(a.weather,r.headingDeg).headwindMps),thrust=thrustAt(u.profile,a.elevation,Math.max(1,airSpeed),afterburner)*dryFraction(u.profile,throttle),drag=dragAt(u.profile,a.elevation,airSpeed,.2);
        const rolling=(a.weather.runwayCondition==='wet'?.025:.02)*u.profile.mass*G;
        u.speed=Math.max(0,speed+(thrust-drag-rolling)/u.profile.mass*dt);s.heading=r.headingDeg*Math.PI/180;u.throttle=throttle;u.afterburner=afterburner;
        const rotation=rotationSpeed(u,a.elevation,u.speed);
        if(airSpeed>=rotation){s.phase='climb';s.grounded=false;u.flightState='normal';u.speed=airSpeed;u.velocity=[Math.sin(s.heading)*airSpeed,Math.cos(s.heading)*airSpeed,0];u.cl=u.profile.mass*G/(.5*density(a.elevation)*(u.profile.densityScale??1)*airSpeed*airSpeed*u.profile.area);u.guidance={bank:0,n:1};u.energy=undefined;u.headingTarget=s.heading;u.holdAltitude=s.climbAltitude;u.targetSpeed=power?.climbSpeedMps??Math.max(150,rotation+25);u.control={bank:0,cl:u.cl*1.2,maxG:3,throttle,afterburner};if(power)power.routeInstalled=false;this.traffic.complete(u,'takeoff',world);s.departureProcedure=runwayProcedure(a,r).sid;this.log(u,'抬轮离地，爬升',world.time);return false;}
        const remaining=r.direction===1?r.x1-u.position[0]:u.position[0]-r.x0;if(remaining<150){s.phase='rejected';this.log(u,'未达抬轮速度，中断起飞',world.time);}
      }
    }
    if(['rejected','rollout'].includes(s.phase)){
      u.speed=Math.max(0,u.speed-brakingDeceleration(a.weather)*dt);
      if(u.speed<8){
        const name=r.stripId==='RW0'?'A':'B',exits=[1,2,3].map(i=>name+'X'+i).filter(id=>(a.nodes[id][0]-u.position[0])*r.direction>30);
        if(exits.length){s.route=[exits.sort((x,y)=>distance(a.nodes[x],u.position)-distance(a.nodes[y],u.position))[0]];s.phase='exit';s.destination='APRON';}
        else if(u.speed===0){s.message='跑道上停止，等待地面调度';}
      }
    }
    if(s.tow){
      const target=s.tow.target,dx=target[0]-u.position[0],dy=target[1]-u.position[1],span=Math.hypot(dx,dy),desired=Math.atan2(-dx,-dy);
      s.heading+=clamp(angle(desired-s.heading),-.2*dt,.2*dt);u.speed+=clamp(Math.min(1.5,span/3)-u.speed,-2*dt,.5*dt);
      const vx=-Math.sin(s.heading)*u.speed,vy=-Math.cos(s.heading)*u.speed;u.velocity=[vx,vy,0];u.position[0]+=vx*dt;u.position[1]+=vy*dt;
      if(span<2){s.node=s.tow.node;s.tow=null;u.speed=0;u.velocity=[0,0,0];this.rerouteGround(u,world,[taxiEdgeKey(s.node,s.route[0])]);}
      return true;
    }
    if(['taxi','lineup_taxi','exit'].includes(s.phase)){
      const id=s.route[0],target=a.nodes[id];
      if(!target){u.speed=Math.max(0,u.speed-2*dt);if(u.speed<.1){u.speed=0;s.phase=s.phase==='lineup_taxi'?'lined_up':s.node===r.hold?'holding':s.destination?.startsWith('G')&&s.node!==s.destination?'waiting_gate':'parked';if(s.phase==='lined_up'){s.heading=r.headingDeg*Math.PI/180;this.traffic.requestNext(u,world);}if(s.phase==='holding'){s.message=`已到${r.designator}等待点，跑道外等待`;this.traffic.requestNext(u,world);}if(s.phase==='parked')this.log(u,`已到达${s.node}，刹车停车`,world.time);if(s.phase==='waiting_gate')s.message='指定机位占用，在滑行道等待';} }
      else{
        const dx=target[0]-u.position[0],dy=target[1]-u.position[1],span=Math.hypot(dx,dy),desired=Math.atan2(dx,dy),error=angle(desired-s.heading);
        const edge=a.edges.find(e=>e.a===s.node&&e.b===id||e.b===s.node&&e.a===id),closed=edge&&a.closed.includes(edge.name);
        const traffic=groundSpeedLimit(this,u,world,target),authorized=s.phase==='exit'||this.traffic.permitted(u,s.phase==='lineup_taxi'?'line_up':'taxi');
        const wanted=closed||!authorized||s.atcHoldUntil>world.time?0:Math.min(traffic.limit,Math.abs(error)>.3?.5:10,Math.sqrt(2*traffic.brake*Math.max(0,span-1)));
        if(closed){s.message='滑行道关闭，停车等待改线';if(world.time>=(s.rerouteAt??0)){s.rerouteAt=world.time+10;if(!this.rerouteGround(u,world))this.notice(u,world,'滑行道关闭，保持原位，等待可用滑行路线','TAXIWAY CLOSED. HOLD POSITION, AWAIT REVISED TAXI ROUTE.','ground');}}
        u.speed+=clamp(wanted-u.speed,-traffic.brake*dt,1.2*dt);s.heading+=clamp(error,-.35*dt,.35*dt);
        if(span<2){u.position=[...target];s.node=id;s.route.shift();
          if(s.phase==='exit'){
            if(!s.exitTaxiNode){s.exitTaxiNode=id[0]+id.at(-1);s.route=[s.exitTaxiNode];}
            else if(id===s.exitTaxiNode){
              const stand=(s.arrivalGate?[s.arrivalGate]:a.stands).find(g=>!world.units.some(v=>v.id!==u.id&&v.alive&&distance(v.position,a.nodes[g])<25));
              s.phase='taxi';s.depart=false;s.destination=s.arrivalGate??stand??'G1';s.station='ground';s.exitTaxiNode=null;s.route=stand?taxiPath(a,id,stand).slice(1):[];
              this.log(u,'已越过跑道等待线，跑道释放',world.time);this.release(u.id);this.traffic.issue(u,'taxi',{runway:r.designator,route:[id,...s.route],limit:s.destination,qnhHpa:a.weather.qnhHpa,atisCode:atisInformation(a).code},world,{station:'ground'});this.log(u,'正在脱离跑道，保持地面许可',world.time);
            }
          }
        }
      }
      if(!s.route.length&&u.speed===0){if(['holding','parked'].includes(s.phase))this.traffic.complete(u,'taxi',world);if(s.phase==='lined_up')this.traffic.complete(u,'line_up',world);}
    }
    if(s.grounded){
      const vx=Math.sin(s.heading)*u.speed,vy=Math.cos(s.heading)*u.speed;u.velocity=[vx,vy,0];u.mach=u.speed/atmosphere(a.elevation).soundSpeed;u.position[0]+=vx*dt;u.position[1]+=vy*dt;u.position[2]=a.elevation+1.6;
      if(s.phase==='taxi'&&!s.depart&&Math.abs(u.position[1]-r.y)>132){if(this.leases[r.stripId]===u.id)this.log(u,'已越过跑道等待线，跑道释放',world.time);this.release(u.id);}
    }
    return true;
  }
}
export function airportRoutePoints(u,a){
  if(!a||!u.surface)return u.waypoints;
  const s=u.surface,r=a.runways.find(r=>r.designator===s.runway);
  if(s.grounded&&s.route.length)return s.route.map(id=>Object.assign([...a.nodes[id]],{routeLabel:'滑行 '+id}));
  if(u.waypoints.length)return u.waypoints;
  if(!r)return [];
  const start=r.direction===1?r.x0:r.x1,end=r.direction===1?r.x1:r.x0,point=(x,z,label)=>Object.assign([x,r.y,z],{routeLabel:label});
  if(s.phase==='lined_up')return [];
  if(s.phase==='takeoff_roll')return [point(end,a.elevation+1.6,'起飞滑跑'),...(u.departurePowerPlan?u.departurePowerPlan.points.map(p=>Object.assign([...p],{routeLabel:'离场爬升'})):[point(end+r.direction*6000,s.climbAltitude,'离场爬升')])];
  if(s.phase==='climb'&&u.departurePowerPlan)return u.departurePowerPlan.routeInstalled?[]:u.departurePowerPlan.points.map(p=>Object.assign([...p],{routeLabel:'离场爬升'}));
  if(s.phase==='climb'&&!(s.depart&&Math.abs(u.holdAltitude-s.climbAltitude)>=1))return [point(Math.max(r.direction*(u.position[0]+r.direction*2000),r.direction*(end+r.direction*6000))*r.direction,s.climbAltitude,'离场爬升')];
  if(s.phase==='final')return [point(start,a.elevation+1.6,'跑道入口'),point(start+r.direction*400,a.elevation+1.6,'着陆接地区'),point(end,a.elevation+1.6,'着陆滑跑')].filter(p=>(p[0]-u.position[0])*r.direction>0);
  if(s.phase==='rollout')return [point(end,a.elevation+1.6,'减速脱离')];
  return [];
}
