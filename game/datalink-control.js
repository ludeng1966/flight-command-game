import {datalinkContext} from '../sim/datalink.js';
import {formatAltitude,formatDistance,formatSpeed} from '../sim/units.js';
export function initDatalinkControl({getWorld,getSelected,onChange}){
  const settings=document.createElement('details');settings.id='datalink-settings';
  settings.innerHTML='<summary>战术数据链 · 训练终端</summary><p data-terminal></p><label>工作模式<select data-mode><option value="transmit_receive">收发</option><option value="receive">仅接收 · 发射静默</option><option value="off">关闭</option></select></label><label>战术频道（通联与数据链共用）<input data-network maxlength="32"></label><label>训练密钥组<input data-key maxlength="32"></label><button type="button" data-apply>应用到选中机</button><p data-error role="status"></p><small>F-16与J-11/Su-27使用不同训练链族；客机未安装战术终端。密钥组是游戏分组标识，不是真实密码。</small>';
  document.querySelector('#settings-radio').append(settings);
  const reports=document.createElement('details');reports.id='datalink-reports';
  reports.innerHTML='<summary>数据链态势</summary><p data-status></p><pre data-reports style="white-space:pre-wrap;max-height:240px;overflow:auto"></pre><small>◇ 共享观测仅供态势与搜索提示；不能直接锁定或制导。不同来源可能报告同一目标。</small>';
  document.querySelector('#radar-control').append(reports);
  const field=s=>settings.querySelector(s);let lastUnit=null,lastConfig='',lastText='';
  field('[data-apply]').onclick=()=>{try{
    getWorld().setDatalink(getSelected(),{mode:field('[data-mode]').value,networkId:field('[data-network]').value.trim(),keyId:field('[data-key]').value.trim()});
    field('[data-error]').textContent='';lastConfig='';onChange();update();
  }catch(error){field('[data-error]').textContent=error.message;}};
  function update(){
    const world=getWorld(),unit=world.units.find(u=>u.id===getSelected()),d=unit?.datalink;if(!d)return;
    const c=d.config,key=JSON.stringify(c);
    if(unit!==lastUnit||key!==lastConfig){lastUnit=unit;lastConfig=key;
      field('[data-terminal]').textContent=c.available?`${unit.callsign} · ${c.family} · 游戏训练改装终端`:`${unit.callsign} · 无战术数据链终端`;
      field('[data-mode]').value=c.mode;field('[data-network]').value=c.networkId;field('[data-key]').value=c.keyId;
      for(const el of settings.querySelectorAll('input,select,button'))el.disabled=!c.available;
    }
    if(!reports.open)return;
    const view=datalinkContext(unit,world.time),status={unavailable:'无终端',off:'关闭',connected:'正在接收',isolated:'等待链路 / 无近期接收'};
    reports.querySelector('[data-status]').textContent=`${status[view.status]} · ${view.peers.length} 个近期发信站 · 收 ${view.received} / 发 ${view.sent} / 丢 ${view.dropped}`;
    const text=view.contacts.map(c=>{
      const range=Math.hypot(...c.position.map((v,i)=>v-unit.position[i]));
      const bearing=(Math.atan2(c.position[0]-unit.position[0],c.position[1]-unit.position[1])*180/Math.PI+360)%360;
      return `${c.kind==='participant'?'友机自报':'共享航迹'} ${c.callsign} · ${c.quality==='coasting'?'老化':'新近'}\n来源 ${c.sourceCallsign} · 频道 ${c.channelId??view.networkId} · 方位 ${bearing.toFixed(0)}° / ${formatDistance(range)} / ${formatAltitude(c.position[2])}${c.kind==='participant'?`\n航向 ${Math.round(c.headingDeg??0)}° · 真空速 ${formatSpeed(c.speedMps??Math.hypot(...c.velocity),{digits:0})}`:''}\n${c.ageSec.toFixed(1)} 秒前观测 · 误差参考 ${Math.round(c.positionErrorM)} m`;
    }).join('\n\n')||'尚无收到的观测。检查终端模式、链族、网络/密钥组、距离与地形遮挡。';
    if(text!==lastText){reports.querySelector('[data-reports]').textContent=text;lastText=text;}
  }
  update();return {update};
}
