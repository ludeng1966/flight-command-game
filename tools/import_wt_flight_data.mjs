import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';
const hash=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
const number=v=>Number.isFinite(v)?v:null;
const defaultScope=JSON.parse(fs.readFileSync(new URL('../data/missile-scope.json',import.meta.url),'utf8'));
export function missileFamily(id,scope=defaultScope){return scope.families.find(f=>new RegExp(f.sourceIdPattern).test(id))??null;}
export function missileRecord(id,source,sourceHash){
  const r=source.rocket;if(!r||r.bulletType!=='aam')throw Error('不是空空导弹');
  const g=r.guidance??{},radar=g.radarSeeker,optical=g.opticalSeeker,stages=[];let start=r.fireDelay??0,mass=r.mass;
  for(let i=0;i<8;i++){const suffix=i?String(i):'',duration=r['timeFire'+suffix],force=r['force'+suffix],end=r['massEnd'+suffix];if(duration===undefined&&force===undefined)continue;
    stages.push({sourceSuffix:suffix,startSec:start,durationSec:number(duration),thrustN:number(force),initialMassKg:number(mass),finalMassKg:number(end)});start+=duration??0;mass=end??mass;}
  const seeker=radar??optical??{};
  const family=missileFamily(id);
  return {id,family:family?.id??null,familyName:family?.name??null,sourceBulletName:r.bulletName??null,bulletName:r.bulletName??id,kind:radar?(radar.active===true?'active_radar':'semi_active_radar'):optical?'infrared':r.guidanceType??'unknown',
    massKg:number(r.mass),finalMassKg:number(mass),lengthM:number(r.length),diameterM:number(r.caliber),lifetimeSec:number(r.timeLife),motorStages:stages,
    aerodynamics:{dragCx:number(r.dragCx),CxK:number(r.CxK),wingAreaMult:number(r.wingAreaMult),finsAoaHor:number(r.finsAoaHor),finsAoaVer:number(r.finsAoaVer),finsLatAccel:number(r.finsLatAccel),distFromCmToStabM:number(r.distFromCmToStab),
      frontalAreaM2:Number.isFinite(r.caliber)?Math.PI*(r.caliber/2)**2:null,
      interpretation:'Source coefficients retained without inventing a Cd(Mach, alpha) polar. Frontal area is derived geometry, not a verified solver reference area. Fin source values are not angles in radians.'},
    flightControl:{...(g.guidanceAutopilot??{})},
    launch:{initialSpeedMps:number(r.startSpeed),useStartSpeed:r.useStartSpeed??null,fireDelaySec:number(r.fireDelay)},
    proximityFuse:{enabled:r.hasProximityFuse===true,radiusM:number(r.proximityFuse?.radius),armingDelaySec:number(r.proximityFuse?.timeOut)},
    simulationLimits:{maxTravelM:number(r.maxDistance),speedLimitMps:number(r.endSpeed),autopilotMaxG:number(g.guidanceAutopilot?.reqAccelMax),guidanceDelaySec:number(g.guidanceAutopilot?.timeOut)},
    statCard:{rangeM:number(r.rangeMax),maxG:number(r.loadFactorMax),mach:number(r.machMax),usage:'Display values, not launch guarantees or flight-control limits'},
    seeker:{fovDeg:number(seeker.fov),lockAngleDeg:number(seeker.lockAngleMax),gimbalAngleDeg:number(seeker.angleMax),trackingRateDegSec:number(seeker.rateMax),warmupSec:number(g.warmUpTime),workSec:number(g.workTime)},
    rangeTables:Object.entries(g).filter(([k,v])=>/^table\d+$/.test(k)&&v&&typeof v==='object').map(([sourceKey,data])=>({sourceKey,...data})),
    provenance:{file:'gamedata/weapons/rocketguns/'+id+'.blkx',sha256:sourceHash,scope:'Local game configuration; source variants remain separate',tableLayout:'Source arrays preserved; no inferred axis order, NEZ or hit probability',motorInterpretation:'Numbered stages treated as sequential durations for inspection; raw source authoritative'},
    rawRocket:r};
}
export function importFlightData({weapons,aircraftRoot,archive,out}){
  const previousFile=path.join(out,'catalog.json'),previous=fs.existsSync(previousFile)?JSON.parse(fs.readFileSync(previousFile,'utf8')):null;
  fs.mkdirSync(path.join(out,'missiles'),{recursive:true});const records=[];
  for(const name of fs.readdirSync(weapons).filter(n=>n.endsWith('.blkx')).sort()){
    if(!missileFamily(name.slice(0,-5)))continue;
    const buffer=fs.readFileSync(path.join(weapons,name)),source=JSON.parse(buffer);if(source.rocket?.bulletType!=='aam')continue;
    records.push(missileRecord(name.slice(0,-5),source,hash(buffer)));
  }
  for(const family of defaultScope.families)if(!records.some(r=>r.id===family.preferredId))throw Error('缺少所需导弹基础型号：'+family.name);
  const aircraft={};
  for(const [id,file]of [['f16','f_16a_block_10'],['f86','f-86a-5']]){
    const fmPath=path.join(aircraftRoot,'fm',file+'.blkx'),fmBuffer=fs.readFileSync(fmPath),fm=JSON.parse(fmBuffer),unitPath=path.join(aircraftRoot,file+'.blkx'),unit=fs.existsSync(unitPath)?JSON.parse(fs.readFileSync(unitPath)):{};
    const refs=new Set();const walk=o=>{if(!o||typeof o!=='object')return;for(const [key,v]of Object.entries(o)){if(key==='blk'&&typeof v==='string'&&/rocketguns/i.test(v))refs.add(path.posix.basename(v.replaceAll('\\','/')).replace(/\.blk$/i,''));else walk(v);}};walk(unit);
    aircraft[id]={id,sourceFile:`gamedata/flightmodels/fm/${file}.blkx`,sha256:hash(fmBuffer),massSource:fm.Mass,wingSource:fm.Aerodynamics?.WingPlane,engineSource:fm.EngineType0,
      compatibleMissileIds:records.filter(r=>refs.has(r.id)).map(r=>r.id),compatibilityScope:'References in local unit WeaponSlot/WeaponPreset tree, not a fitted loadout; quantities not inferred'};
  }
  fs.writeFileSync(path.join(out,'aircraft-source.json'),JSON.stringify(aircraft,null,2)+'\n');
  const manifest={schemaVersion:2,importedAt:new Date().toISOString(),scope:{families:defaultScope.families.map(({sourceIdPattern,...family})=>({...family,variantCount:records.filter(r=>r.family===family.id).length})),policy:'Only these five requested families; aircraft-specific and default variants remain distinct; Only AIM-7P within AIM-7; PL-12A, other AIM-9 and PL-5 versions excluded'},source:{kind:'local-war-thunder',archiveName:path.basename(archive),archiveSha256:hash(fs.readFileSync(archive)),archiveBytes:fs.statSync(archive).size},counts:{families:defaultScope.families.length,missileVariants:records.length,uniqueBulletNames:new Set(records.map(r=>r.sourceBulletName).filter(Boolean)).size,variantsWithoutBulletName:records.filter(r=>!r.sourceBulletName).length},missiles:records.map(({rawRocket,rangeTables,...summary})=>({...summary,rangeTableCount:rangeTables.length,file:`missiles/${summary.id}.json`})),aircraftIds:Object.keys(aircraft),limitations:['Game configuration, not verified real-world aerodynamic data','No original War Thunder solver copied; full Mach/angle-of-attack polars and inertia are not supplied','No weapons enabled by importing data','Range tables are source scenario data, not guaranteed range or NEZ']};
  for(const record of records)fs.writeFileSync(path.join(out,'missiles',record.id+'.json'),JSON.stringify(record,null,2)+'\n');
  fs.writeFileSync(path.join(out,'catalog.json'),JSON.stringify(manifest,null,2)+'\n');
  const columns=['id','family','sourceBulletName','kind','massKg','finalMassKg','diameterM','lengthM','lifetimeSec','CxK','dragCx','wingAreaMult','autopilotMaxG','motorStages'];
  const cell=v=>{const s=v==null?'':typeof v==='object'?JSON.stringify(v):String(v);return /[",\r\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;};
  fs.writeFileSync(path.join(out,'missiles.csv'),[columns.join(','),...records.map(r=>[r.id,r.family,r.sourceBulletName,r.kind,r.massKg,r.finalMassKg,r.diameterM,r.lengthM,r.lifetimeSec,r.aerodynamics.CxK,r.aerodynamics.dragCx,r.aerodynamics.wingAreaMult,r.simulationLimits.autopilotMaxG,r.motorStages].map(cell).join(','))].join('\n')+'\n');
  // Remove only previously indexed generated records; never traverse/delete a directory.
  for(const old of previous?.missiles??[]){if(!/^[-a-z0-9_]+$/.test(old.id)||records.some(r=>r.id===old.id))continue;const file=path.join(out,'missiles',old.id+'.json');if(fs.existsSync(file)){const generated=JSON.parse(fs.readFileSync(file,'utf8'));if(generated.id===old.id&&generated.provenance?.file===`gamedata/weapons/rocketguns/${old.id}.blkx`)fs.unlinkSync(file);}}
  return manifest.counts;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args={};for(let i=2;i<process.argv.length;i+=2)args[process.argv[i].replace(/^--/,'')]=process.argv[i+1];
  if(!args.weapons||!args['aircraft-root']||!args.archive)throw Error('需要 --weapons、--aircraft-root、--archive，可选 --out');
  console.log(importFlightData({weapons:args.weapons,aircraftRoot:args['aircraft-root'],archive:args.archive,out:args.out??'data/flight-research'}));
}
