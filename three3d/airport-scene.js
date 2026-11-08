import * as THREE from '../vendor/three/three.module.js';
import {airportBounds,airportDetail} from './airport-detail.js';
import {airportLabelDefinitions,airportLabelDetail,layoutAirportLabels} from './airport-labels.js';

// 机场与等高线沙盘共用暗色底、蓝灰轮廓；尺寸和位置仍直接读取机场运行数据。
export function buildAirport(scene,a){
  if(!a)return null;
  const group=new THREE.Group();group.name='international-airport';scene.add(group);
  const surface=(color,layer)=>new THREE.MeshBasicMaterial({color,polygonOffset:true,polygonOffsetFactor:-layer,polygonOffsetUnits:-layer});
  const pad=surface(0x0a1822,0),runway=surface(0x0c1922,2),taxi=surface(0x182c39,1),roof=surface(0x294856,3);
  const white=surface(0xc4d8e2,4),yellow=surface(0xb8a06d,4),light=new THREE.MeshBasicMaterial({color:0xa2c6d6});
  const building=new THREE.MeshStandardMaterial({color:0x243a48,roughness:.95,metalness:0,flatShading:true,polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1});
  const details=[white,yellow,light];details.forEach(m=>{m.transparent=true;m.opacity=0;m.depthWrite=false;});
  const instances=new Map(),edgePoints=[],paint=[],labels=airportLabelDefinitions(a).map(label=>({...label,point:new THREE.Vector3(label.point[0],label.point[2],-label.point[1]),element:null,leader:null,alpha:0})),strips=a.runways.filter(r=>r.direction===1),bounds=airportBounds(a);
  function line(x0,y0,z0,x1,y1,z1){edgePoints.push(x0,z0,-y0,x1,z1,-y1);}
  function rectangle(x,y,z,l,w){
    const x0=x-l/2,x1=x+l/2,y0=y-w/2,y1=y+w/2;
    line(x0,y0,z,x1,y0,z);line(x1,y0,z,x1,y1,z);line(x1,y1,z,x0,y1,z);line(x0,y1,z,x0,y0,z);
  }
  function box(x,y,z,l,w,h,m,angle=0){
    const matrix=new THREE.Matrix4().compose(new THREE.Vector3(x,z,-y),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),angle),new THREE.Vector3(l,h,w));
    if(!instances.has(m))instances.set(m,[]);instances.get(m).push(matrix);
  }
  function strip(p,q,w,m,raise=.2){
    const dx=q[0]-p[0],dy=q[1]-p[1];box((p[0]+q[0])/2,(p[1]+q[1])/2,a.elevation+raise,Math.hypot(dx,dy),w,.12,m,Math.atan2(dy,dx));
  }
  box(a.center[0],a.center[1],a.elevation-.25,bounds.maxX-bounds.minX,bounds.maxY-bounds.minY,.5,pad);
  rectangle(a.center[0],a.center[1],a.elevation+.45,bounds.maxX-bounds.minX,bounds.maxY-bounds.minY);
  box(a.center[0],a.center[1]+300,a.elevation+.15,2500,300,.12,taxi);
  for(const e of a.edges){strip(a.nodes[e.a],a.nodes[e.b],e.width,taxi);strip(a.nodes[e.a],a.nodes[e.b],.35,yellow,.35);}
  for(const r of strips){
    strip([r.x0,r.y],[r.x1,r.y],r.width,runway,.25);
    rectangle((r.x0+r.x1)/2,r.y,a.elevation+.5,r.x1-r.x0,r.width);
    for(let x=r.x0+100;x<r.x1-100;x+=100)strip([x,r.y],[x+35,r.y],.9,white,.4);
    for(const x of [r.x0+30,r.x1-30])for(let i=-4;i<=4;i++)if(i)box(x,r.y+i*4,a.elevation+.4,30,1.7,.1,white);
    for(let x=r.x0;x<=r.x1;x+=60)for(const side of [-1,1])box(x,r.y+side*(r.width/2+1.5),a.elevation+.6,1.5,1.5,1,light);
  }
  for(const r of a.runways){
    const h=a.nodes[r.hold];strip(h,a.nodes[r.entry],23,taxi);strip(h,a.nodes[r.entry],.35,yellow,.35);box(h[0],h[1],a.elevation+.4,26,1,.1,yellow);
    const x=(r.direction===1?r.x0:r.x1)+r.direction*155;
    // 近处保留方向正确的地面号码；屏幕标签承担中景可读性。
    if(typeof document!=='undefined'){
      const c=document.createElement('canvas');c.width=128;c.height=192;const ctx=c.getContext('2d');
      ctx.fillStyle='#c4d8e2';ctx.textAlign='center';ctx.font='bold 76px monospace';ctx.fillText(r.designator.slice(0,2),64,83);ctx.font='bold 68px monospace';ctx.fillText(r.designator.slice(2),64,163);
      const material=new THREE.MeshBasicMaterial({map:new THREE.CanvasTexture(c),transparent:true,opacity:0,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-5,polygonOffsetUnits:-5});
      const mesh=new THREE.Mesh(new THREE.PlaneGeometry(28,42),material);mesh.rotation.set(-Math.PI/2,0,-r.direction*Math.PI/2);mesh.position.set(x,a.elevation+.45,-r.y);mesh.visible=false;group.add(mesh);paint.push({mesh,strip:r.stripId});
    }
  }
  for(const b of a.buildings){
    const [x,y]=b.center,[l,w,h]=b.half.map(v=>v*2),z=a.elevation+h;
    box(x,y,a.elevation+h/2,l,w,h,building);rectangle(x,y,z+.15,l,w);rectangle(x,y,a.elevation+.5,l,w);
    for(const dx of [-l/2,l/2])for(const dy of [-w/2,w/2])line(x+dx,y+dy,a.elevation,x+dx,y+dy,z+.15);
    box(x,y,z-.12,l*.94,w*.9,.16,roof);
    if(l>300)for(let dx=-l/2+160;dx<l/2;dx+=160)line(x+dx,y-w/2,z+.2,x+dx,y+w/2,z+.2);
  }
  for(const [material,matrices]of instances){
    const mesh=new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),material,matrices.length);matrices.forEach((m,i)=>mesh.setMatrixAt(i,m));mesh.instanceMatrix.needsUpdate=true;mesh.frustumCulled=false;group.add(mesh);
  }
  const edges=new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(edgePoints,3)),new THREE.LineBasicMaterial({color:0x4a778c,transparent:true,opacity:.65,depthTest:false,depthWrite:false}));edges.frustumCulled=false;group.add(edges);
  const projected=new THREE.Vector3(),left=new THREE.Vector3(),right=new THREE.Vector3(),forward=new THREE.Vector3(),pixelLengths=new Map(),previousSlots=new Map();
  return {group,labels,attachLabels(root){
    for(const label of labels){
      const el=document.createElement('div');el.className='ac-airport-label'+(label.kind==='runway'?' ac-runway-label':'');el.textContent=label.text;el.hidden=true;el.dataset.kind=label.kind;el.dataset.level=label.level??'';
      el.style.width=label.width+'px';el.style.height=label.height+'px';el.setAttribute('aria-label',({runway:'跑道',taxiway:'滑行道',stand:'停机位'}[label.kind])+' '+label.text);root.appendChild(el);label.element=el;
      const leader=document.createElement('span');leader.className='ac-airport-label-leader';leader.hidden=true;root.appendChild(leader);label.leader=leader;
    }
  },update(camera,viewport,dt=1/60,reduced=false,obstacles=[],options={}){
    let markings=0;
    for(const r of strips){
      left.set(r.x0,a.elevation,-r.y).project(camera);right.set(r.x1,a.elevation,-r.y).project(camera);
      const length=left.z<1&&right.z<1?Math.hypot((right.x-left.x)*viewport.width/2,(right.y-left.y)*viewport.height/2):0;
      pixelLengths.set(r.stripId,length);markings=Math.max(markings,airportDetail(length).markings);
    }
    details.forEach(m=>m.opacity=markings*.9);
    for(const item of paint){const alpha=airportDetail(pixelLengths.get(item.strip)??0).markings;item.mesh.material.opacity=alpha;item.mesh.visible=alpha>.01;}
    const blend=reduced?1:1-Math.exp(-Math.max(0,dt)/.08),candidates=[];
    camera.getWorldDirection(forward);const focal=viewport.height*camera.zoom/(2*Math.tan(camera.fov*Math.PI/360));
    for(const label of labels){
      const el=label.element;if(!el)continue;projected.copy(label.point).project(camera);
      const x=(projected.x*.5+.5)*viewport.width,y=(-projected.y*.5+.5)*viewport.height;
      const visible=projected.z>-1&&projected.z<1&&x>5&&x<viewport.width-5&&y>100&&y<viewport.height-85;
      const depth=(label.point.x-camera.position.x)*forward.x+(label.point.y-camera.position.y)*forward.y+(label.point.z-camera.position.z)*forward.z;
      const span=label.kind==='runway'?(pixelLengths.get(label.strip)??0):3600*focal/Math.max(camera.near,depth);
      const secondary=label.kind!=='runway'&&!(label.kind==='stand'&&label.text===options.activeStand);
      const detailSpan=options.labelMode==='minimal'&&secondary?span/1.6:span;
      label.target=visible&&options.labelMode!=='off'?airportLabelDetail(label,detailSpan):0;
      if(visible&&(label.target>.001||label.alpha>.02))candidates.push({...label,x,y});
    }
    const placed=layoutAirportLabels(candidates,viewport,{blocked:obstacles,previous:previousSlots});
    for(const label of labels){
      const el=label.element;if(!el)continue;const rect=placed.get(label.id);
      if(!rect){label.alpha=0;el.hidden=true;if(label.leader)label.leader.hidden=true;if(label.target<.001)previousSlots.delete(label.id);continue;}
      if(previousSlots.has(label.id)&&previousSlots.get(label.id)!==rect.slot)label.alpha=0;
      previousSlots.set(label.id,rect.slot);label.alpha+=(label.target-label.alpha)*blend;el.hidden=label.alpha<.02;
      if(el.hidden&&label.target<.001)previousSlots.delete(label.id);
      if(!el.hidden){el.style.opacity=String(label.alpha);el.style.transform='translate('+rect.x+'px,'+rect.y+'px)';}
      if(label.leader){
        projected.copy(label.point).project(camera);const x=(projected.x*.5+.5)*viewport.width,y=(-projected.y*.5+.5)*viewport.height;
        const dx=Math.max(rect.x,Math.min(rect.x+rect.w,x))-x,dy=Math.max(rect.y,Math.min(rect.y+rect.h,y))-y,length=Math.hypot(dx,dy);
        label.leader.hidden=el.hidden||length<14;
        if(!label.leader.hidden){label.leader.style.width=length+'px';label.leader.style.opacity=String(label.alpha*.45);label.leader.style.transform='translate('+x+'px,'+y+'px) rotate('+Math.atan2(dy,dx)+'rad)';}
      }
    }
  }};
}
