import test from 'node:test';
import assert from 'node:assert/strict';
import {PerspectiveCamera,Scene,Vector3,Matrix4,Quaternion} from '../vendor/three/three.module.js';
import {createAirport} from '../sim/airport.js';
import {buildAirport} from '../three3d/airport-scene.js';
import {airportBounds,outsideAirportSegment,airportDetail} from '../three3d/airport-detail.js';
import {airportLabelDefinitions,layoutAirportLabels} from '../three3d/airport-labels.js';

test('按实际屏幕投影放大后显示四个正确的跑道端编号，缩远隐藏',()=>{
  const airport=createAirport(),view=buildAirport(new Scene(),airport),camera=new PerspectiveCamera(52,16/9,20,500000),target=new Vector3(airport.center[0],airport.elevation,-airport.center[1]);
  for(const label of view.labels)label.element={hidden:true,style:{}};
  const at=range=>{camera.position.copy(target).add(new Vector3(0,range,range*.7));camera.lookAt(target);camera.updateMatrixWorld();view.update(camera,{width:1280,height:720},1/60,true);};
  at(30000);assert(view.labels.every(label=>label.element.hidden));
  at(4500);assert.deepEqual(view.labels.filter(label=>label.kind==='runway'&&!label.element.hidden).map(label=>label.text).sort(),['09L','09R','27L','27R']);
  assert.deepEqual(view.labels.filter(label=>label.kind==='stand'&&!label.element.hidden).map(label=>label.text).sort(),airport.stands);
  assert.deepEqual(view.labels.filter(label=>label.kind==='taxiway'&&label.level==='main'&&!label.element.hidden).map(label=>label.text).sort(),['A','B','C']);
  assert(view.labels.filter(label=>label.kind==='taxiway'&&label.level==='link').every(label=>label.element.hidden));
  const initial=new Map(view.labels.filter(label=>!label.element.hidden).map(label=>[label.id,label.element.style.transform.match(/[-\d.]+/g).map(Number)]));
  at(3000);assert(view.labels.some(label=>label.kind==='taxiway'&&label.level==='link'&&!label.element.hidden));
  at(30000);assert(view.labels.every(label=>label.element.hidden));
  at(4500);for(const [id,position]of initial){const label=view.labels.find(label=>label.id===id),after=label.element.style.transform.match(/[-\d.]+/g).map(Number);assert(!label.element.hidden);assert(after.every((v,i)=>Math.abs(v-position[i])<1e-6));}
  assert.equal(airportDetail(230).labels,0);assert.equal(airportDetail(340).labels,1);assert(airportDetail(280).labels>0&&airportDetail(280).labels<1);
});

test('简洁编号保留跑道与选中机位，细节模式可恢复全部，隐藏时不显示',()=>{
  const airport=createAirport(),before=JSON.stringify(airport),view=buildAirport(new Scene(),airport),camera=new PerspectiveCamera(52,16/9,20,500000),target=new Vector3(airport.center[0],airport.elevation,-airport.center[1]);
  for(const label of view.labels)label.element={hidden:true,style:{}};
  camera.position.copy(target).add(new Vector3(0,4500,3150));camera.lookAt(target);camera.updateMatrixWorld();
  const visible=options=>{view.update(camera,{width:1280,height:720},1/60,true,[],options);return view.labels.filter(label=>!label.element.hidden);};
  const full=visible({labelMode:'full'}),minimal=visible({labelMode:'minimal',activeStand:'G1'});
  assert(full.length>minimal.length);assert(minimal.some(label=>label.kind==='stand'&&label.text==='G1'));assert.equal(minimal.filter(label=>label.kind==='runway').length,4);
  assert.equal(visible({labelMode:'off'}).length,0);assert.equal(visible({labelMode:'full'}).length,full.length);assert.equal(JSON.stringify(airport),before);
});

test('建筑和跑道直接使用运行数据的米制位置与尺度',()=>{
  const airport=createAirport({center:[-2000,7000],elevation:250}),before=JSON.stringify(airport),view=buildAirport(new Scene(),airport);
  const matrices=[];view.group.traverse(object=>{if(object.isInstancedMesh)for(let i=0;i<object.count;i++){const m=new Matrix4();object.getMatrixAt(i,m);const p=new Vector3(),s=new Vector3();m.decompose(p,new Quaternion(),s);matrices.push({p,s});}});
  for(const building of airport.buildings)assert(matrices.some(({p,s})=>Math.abs(p.x-building.center[0])<.01&&Math.abs(p.z+building.center[1])<.01&&Math.abs(p.y-(airport.elevation+building.half[2]))<.01&&Math.abs(s.x-building.half[0]*2)<.01&&Math.abs(s.y-building.half[2]*2)<.01&&Math.abs(s.z-building.half[1]*2)<.01));
  assert.equal(JSON.stringify(airport),before);assert.equal(view.labels.filter(label=>label.kind==='runway').length,4);
});

test('滑行道去重，机位编号读取真实节点，滑行道锚点始终在对应道路上',()=>{
  const airport=createAirport(),labels=airportLabelDefinitions(airport),taxi=labels.filter(label=>label.kind==='taxiway');
  assert.deepEqual(taxi.map(label=>label.text).sort(),[...new Set(airport.edges.map(edge=>edge.name))].sort());
  for(const label of taxi)assert(airport.edges.filter(edge=>edge.name===label.text).some(edge=>{
    const a=airport.nodes[edge.a],b=airport.nodes[edge.b],d=Math.hypot(b[0]-a[0],b[1]-a[1]);
    return Math.abs(Math.hypot(label.point[0]-a[0],label.point[1]-a[1])+Math.hypot(label.point[0]-b[0],label.point[1]-b[1])-d)<1e-6;
  }));
  for(const label of labels.filter(label=>label.kind==='stand'))assert.deepEqual(label.point.slice(0,2),airport.nodes[label.text].slice(0,2));
});

test('密集标签避让飞机名称，空间不足时隐藏；位置不变时偏移槽位保持稳定',()=>{
  const blocked=[{x:180,y:200,w:100,h:24}],viewport={width:468,height:500};
  const candidates=[{id:'runway:09L',kind:'runway',priority:100,order:0,width:43,height:26,x:210,y:230},
    ...Array.from({length:12},(_,i)=>({id:'stand:G'+i,kind:'stand',priority:70,order:i+1,width:34,height:24,x:175+i*13,y:230}))];
  const overlap=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
  const first=layoutAirportLabels(candidates,viewport,{blocked}),rects=[...first.values()];
  assert(first.has('runway:09L'));assert(first.size<candidates.length);
  rects.forEach((r,i)=>{assert(r.x>=6&&r.x+r.w<=462&&r.y>=102&&r.y+r.h<=410);assert(blocked.every(b=>!overlap(r,b)));assert(rects.slice(i+1).every(other=>!overlap(r,other)));});
  const previous=new Map([...first].map(([id,r])=>[id,r.slot]));
  assert.deepEqual(layoutAirportLabels(candidates,viewport,{blocked,previous}),first);
});

test('只裁去机场整平范围内的旧等高线，跨界部分准确保留',()=>{
  const bounds=airportBounds({center:[0,0],footprint:[10,5]});
  assert.deepEqual(outsideAirportSegment(-20,0,20,0,bounds),[[-20,0,-10,0],[10,0,20,0]]);
  assert.deepEqual(outsideAirportSegment(0,0,0,20,bounds),[[0,5,0,20]]);
  assert.deepEqual(outsideAirportSegment(-5,-2,5,2,bounds),[]);
  assert.deepEqual(outsideAirportSegment(-20,8,20,8,bounds),[[-20,8,20,8]]);
});
