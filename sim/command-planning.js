// Mission information belongs to the player; intermediate flight points belong to the computer.
const tactical=new Set(['intercept','attack','banzai','crank','f_pole','defend','notch','drag','disengage','reengage','bracket','extend','cooperate']);
const specifiedTactics=new Set(['banzai','crank','f_pole','notch','drag','bracket','extend']);
const automatic=new Set(['cruise','fly_heading','orbit','clear_waypoints','follow_unit','join_formation','formation_change','assign_role','cover','escort','taxi','hold_short','line_up','takeoff','abort_takeoff','approach','land','return_to_base','go_around','divert']);
export const planningModeLabel=mode=>({auto_tactics:'自主选择任务内战术',bullseye:'靶眼方位距离',custom_route:'玩家自定义航路'})[mode]??null;
export const COMMAND_PLANNING_RULES=`航路责任：玩家提供任务、目的地/目标和限制；指挥员只解释和转达；飞行员在导航规划接口中提出中间航点；程序生成连续可飞曲线、验证地形与能量并驾驶。编队移动队位、机场程序及未开放AI航点的专用动作由各自执行器规划。不能把自动规划工作退给玩家。
巡航用cruise，未指定航向沿现有航路，无航路时保持当前航向。指挥员对未指定高度速度保留null，接令飞行员依据任务、实况与能力选择常规参数；旧目标只是实况参考，不能当成玩家硬性要求，不追问航点。已有三维航路各点高度、地图点高度与机场许可仍须保留，不为自主选值拉平航路。明确要求沿玩家自定义路线时才用mode=custom_route，路线不存在只请求该自定义路线。
飞往已知坐标/标记点只需要目的地，不需要玩家规划整条航线。靶眼是参考坐标，不是路线；飞往靶眼方位距离用fly_to、mode=bullseye、bearingDeg和rangeM，坐标由程序结合context.bullseye计算，不能自行猜基准，也不能用本机位置或标记点冒充靶眼。距离按玩家明确单位或当前全局单位换算为米。
单独通报靶眼坐标使用report_event和speechAct=report，保留方位、距离、mode=bullseye，不自动飞过去；明确说飞往才是导航，明确说接敌才是intercept。这里的靶眼方位按地图正北为0度、顺时针增加。
接敌、拦截和战术任务不要求人工航点。attack允许先搜索：明确“攻击前方目标”等描述已经足以接令，无回波是搜索中的状态，不要求玩家先给目标编号或锁定；其他任务确实缺必要目标/威胁数据才询问缺项。缺执行器报告缺能力，不要求玩家画路线替代。玩家指定战术就保留该战术；委托自行选取战术时保留原任务并用mode=auto_tactics，在任务范围内选择方法，不自行更换目标或增加开火授权。只有“自行选战术”却没有任务目的时才询问任务目标。`;

export function planningRequirement(order,context){
  const p=order.parameters,custom=p.mode==='custom_route',isTactical=tactical.has(order.intent);
  let kind=custom?'player_route':order.intent==='fly_to'?'destination':isTactical?'tactical':automatic.has(order.intent)?'automatic':['patrol','recon','search'].includes(order.intent)?'mission_area':'none';
  const missing=[];
  if(['search','track_target'].includes(order.intent))kind='sensor';
  if(custom&&!(order.intent==='fly_to'&&Number.isFinite(p.eastM)&&Number.isFinite(p.northM))&&order.unitIds.some(id=>!context.units.find(u=>u.id===id)?.telemetry?.waypoints?.length))missing.push('玩家指定的自定义路线');
  if(order.intent==='fly_to'){
    if(p.mode==='bullseye'){
      if(!context.bullseye)missing.push('靶眼基准位置');
      if(!Number.isFinite(p.bearingDeg)||p.bearingDeg<0||p.bearingDeg>360)missing.push('靶眼方位（0–360度）');
      if(!Number.isFinite(p.rangeM)||p.rangeM<0)missing.push('靶眼距离');
    }else if(!(Number.isFinite(p.eastM)&&Number.isFinite(p.northM))&&!context.mapPoint)missing.push('目的地坐标或一个地图目标点');
  }
  if(order.intent==='fly_heading'&&!Number.isFinite(p.headingDeg))missing.push('目标航向');
  return {orderId:order.id,kind,waypointOwner:custom?'player':'computer',playerWaypointsRequired:custom,
    tacticalChoice:isTactical?(specifiedTactics.has(order.intent)&&p.mode!=='auto_tactics'?'player_selected':'flash_within_task'):'not_applicable',
    requiredMissionData:isTactical?['任务目标或威胁','位置/方位距离及时间','本机能力与任务限制']:kind==='mission_area'?['任务区域或搜索方向']:[],
    missingData:missing,message:missing.length?'请补充'+missing.join('、'):custom?'沿玩家自定义航路飞行':kind==='sensor'?'飞行员自主操作雷达，无需手动指定模式和锁定':kind==='none'?'无需航路规划':kind==='mission_area'?'玩家指定任务区域，程序生成巡逻或搜索航线':isTactical?'目标与任务明确后自动规划战术航路':'程序自行生成航路，无需人工航点'};
}

export function navigationTask(order,unit,context){
  const p=order.parameters;
  if(order.intent==='cruise'){
    const useRoute=!Number.isFinite(p.headingDeg)&&!Number.isFinite(p.distanceM)&&unit.telemetry?.waypoints?.length;
    return {unitId:unit.id,action:useRoute?'set_flight':'fly_heading',altitudeM:useRoute?p.altitudeM:p.altitudeM??unit.targetAltitudeM,speedMps:p.speedMps??unit.targetSpeedMps,
      headingDeg:useRoute?null:p.headingDeg??unit.headingDeg,eastM:null,northM:null,distanceM:useRoute?null:p.distanceM,append:false};
  }
  if(order.intent!=='fly_to')return null;
  let east=p.eastM,north=p.northM,altitude=p.altitudeM;
  if(p.mode==='bullseye'){
    const [e,n]=context.bullseye.position,r=p.bearingDeg*Math.PI/180;
    east=e+Math.sin(r)*p.rangeM;north=n+Math.cos(r)*p.rangeM;
  }else if(!(Number.isFinite(east)&&Number.isFinite(north))){[east,north]=context.mapPoint;altitude??=context.mapPoint[2];}
  else if(context.mapPoint&&Math.hypot(east-context.mapPoint[0],north-context.mapPoint[1])<.01)altitude??=context.mapPoint[2];
  return {unitId:unit.id,action:'fly_to',altitudeM:altitude??unit.targetAltitudeM,speedMps:p.speedMps,headingDeg:null,eastM:east,northM:north,distanceM:null,append:p.append};
}
