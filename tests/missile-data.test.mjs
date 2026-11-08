import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {missileFamily,missileRecord,importFlightData} from '../tools/import_wt_flight_data.mjs';
import {createFlightDataApi} from '../server/flight-data.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const read=file=>JSON.parse(fs.readFileSync(path.join(root,'data/flight-research',file),'utf8'));
const catalog=read('catalog.json');

test('范围仅包含五类，改型和载机变体不混用',()=>{
  assert.deepEqual(catalog.scope.families.map(f=>f.id),['aim120','aim7','aim9m','pl12','pl5eii']);
  for(const id of ['us_aim9l_sidewinder','cn_pl12a','su_pl5b_default','su_pl5c_default','uk_skyflash_aim_7_dogfight','us_aim_120c_50','us_aim7c_sparrow','us_aim7d_sparrow','us_aim7e_sparrow','us_aim7e2_dogfight_sparrow','us_aim7f_sparrow','us_aim7m_sparrow'])assert.equal(missileFamily(id),null,id);
  for(const family of catalog.scope.families){assert.ok(catalog.missiles.some(r=>r.id===family.preferredId));assert.equal(family.variantCount,catalog.missiles.filter(r=>r.family===family.id).length);}
  assert.equal(catalog.counts.missileVariants,24);
  assert.equal(catalog.counts.uniqueBulletNames,9);
  assert.equal(catalog.missiles.filter(r=>r.family==='aim7').length,2);
  const indexed=catalog.missiles.map(r=>r.id+'.json').sort();
  assert.deepEqual(fs.readdirSync(path.join(root,'data/flight-research/missiles')).filter(f=>f.endsWith('.json')).sort(),indexed);
});

test('全部变体保留气动/飞控原值及燃料质量连续性',()=>{
  for(const summary of catalog.missiles){
    const r=read(summary.file),raw=r.rawRocket;
    assert.equal(r.id,summary.id);assert.equal(r.sourceBulletName,raw.bulletName);
    assert.match(r.provenance.sha256,/^[a-f0-9]{64}$/);
    assert.equal(r.massKg,raw.mass);
    for(const key of ['CxK','dragCx','wingAreaMult','finsAoaHor','finsAoaVer','finsLatAccel'])assert.equal(r.aerodynamics[key],raw[key],r.id+':'+key);
    assert.deepEqual(r.flightControl,raw.guidance.guidanceAutopilot);
    let mass=r.massKg,time=raw.fireDelay??0;
    for(const stage of r.motorStages){assert.equal(stage.initialMassKg,mass);assert.equal(stage.startSec,time);assert.ok(stage.finalMassKg>0&&stage.finalMassKg<=mass);assert.ok(stage.thrustN>0&&stage.durationSec>0);mass=stage.finalMassKg;time+=stage.durationSec;}
    assert.equal(r.finalMassKg,mass);
    assert.equal(r.rangeTables.length,summary.rangeTableCount);
    assert.equal(r.proximityFuse.radiusM,raw.proximityFuse?.radius??null);
  }
});

test('AIM-7P 点火延时及两段推力保留，面板过载不覆盖飞控',()=>{
  const r=read('missiles/us_aim7p_sparrow_fa_18.json');
  assert.deepEqual(r.motorStages.map(s=>[s.startSec,s.durationSec,s.thrustN]),[[.25,4.5,21479.88],[4.75,11,3765.95]]);
  const sample=missileRecord('us_aim9m_sidewinder',{rocket:{bulletType:'aam',mass:80,massEnd:60,timeFire:2,force:10000,loadFactorMax:99,guidance:{guidanceAutopilot:{reqAccelMax:12}}}},'hash');
  assert.equal(sample.statCard.maxG,99);assert.equal(sample.simulationLimits.autopilotMaxG,12);assert.equal(sample.sourceBulletName,null);assert.equal(sample.aerodynamics.CxK,null);
});

test('API 可读取五类实际数据，拒绝范围外配置与路径穿越',()=>{
  const api=createFlightDataApi(root),request=p=>api(new URL(p,'http://localhost'));
  assert.equal(request('/api/flight-data/catalog').data.counts.families,5);
  for(const f of catalog.scope.families){const r=request('/api/flight-data/missile?id='+f.preferredId);assert.equal(r.status,200);assert.equal(r.data.family,f.id);}
  for(const id of ['us_aim9l_sidewinder','us_aim7f_sparrow','us_aim7m_sparrow','cn_pl12a','../../aircraft','__proto__',''])assert.equal(request('/api/flight-data/missile?id='+encodeURIComponent(id)).status,404);
  assert.equal(api(new URL('http://localhost/other')),null);
});

test('缺少必需型号时导入失败，不覆盖已有目录',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'game-missile-import-'));
  try{
    const weapons=path.join(temp,'weapons'),out=path.join(temp,'out');fs.mkdirSync(weapons);fs.mkdirSync(out);
    fs.writeFileSync(path.join(out,'catalog.json'),'{"missiles":[]}');
    assert.throws(()=>importFlightData({weapons,out,aircraftRoot:'unused',archive:'unused'}),/缺少所需导弹/);
    assert.equal(fs.readFileSync(path.join(out,'catalog.json'),'utf8'),'{"missiles":[]}');
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
