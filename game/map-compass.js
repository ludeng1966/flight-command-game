const bearingLabel=angle=>({0:'N 北',45:'NE',90:'E 东',135:'SE',180:'S 南',225:'SW',270:'W 西',315:'NW'})[(angle%360+360)%360]??String((angle%360+360)%360).padStart(3,'0');
export function initMapCompass(stage){
  const panel=document.createElement('section');panel.id='map-compass';panel.setAttribute('aria-label','地图罗盘');
  panel.title='跟随地图视角旋转。N为地图正北；视图朝向不同于飞机航向。';
  panel.innerHTML='<div class="compass-north" aria-hidden="true"><span>N</span><svg viewBox="0 0 32 32"><path d="M16 3 23 25 16 21 9 25Z"/></svg></div><div class="compass-window" aria-hidden="true"><div class="compass-tape"></div><span class="compass-index">▾</span></div><output aria-live="off"><small>视图朝向</small><b>000°</b></output>';
  const tape=panel.querySelector('.compass-tape'),clip=panel.querySelector('.compass-window'),north=panel.querySelector('svg'),value=panel.querySelector('output b');
  for(let angle=-360;angle<=720;angle+=15){const tick=document.createElement('span');tick.className='compass-tick'+(angle%90===0?' cardinal':angle%30===0?' major':'');tick.style.left=((angle+360)*3)+'px';if(angle%30===0||angle%45===0)tick.textContent=bearingLabel(angle);tape.append(tick);}
  stage.append(panel);let lastDegree=-1,lastWidth=0,lastHeading=-1;
  return {update(heading){
    const width=clip.clientWidth;if(heading===lastHeading&&width===lastWidth)return;lastHeading=heading;lastWidth=width;
    tape.style.transform=`translateX(${width/2-(heading+360)*3}px)`;north.style.transform=`rotate(${-heading}deg)`;
    const rounded=Math.round(heading)%360;if(rounded!==lastDegree){lastDegree=rounded;const text=String(rounded).padStart(3,'0')+'°';value.textContent=text;panel.setAttribute('aria-label','地图罗盘，视图朝向'+text);panel.dataset.heading=String(rounded);}
  }};
}
