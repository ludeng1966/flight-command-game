import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {airlinerThrust} from './airliner-thrust.mjs';
import {saveFingerprint} from '../sim/save-state.js';
const root=process.argv[2]??'F:/mygame/wt_flight_research/local_aces/aces.vromfs.bin_u/gamedata/flightmodels/fm';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8')),file='data/aircraft.json',profiles=read(file),runtimeFile='data/aircraft-runtime.json';
const runtime=fs.existsSync(runtimeFile)?read(runtimeFile):{schemaVersion:1,compatibleSaveFingerprints:[]};
const oldFingerprint=saveFingerprint(read('data/scenarios/demo.json'),profiles);if(!runtime.compatibleSaveFingerprints.includes(oldFingerprint))runtime.compatibleSaveFingerprints.push(oldFingerprint);
const sha=buffer=>crypto.createHash('sha256').update(buffer).digest('hex'),radians=d=>d*Math.PI/180;
const numbered=(object,prefix)=>Object.keys(object).filter(k=>k.startsWith(prefix)).sort((a,b)=>Number(a.slice(prefix.length))-Number(b.slice(prefix.length))).map(k=>object[k]);
const machFactor=(p,i)=>({critical:p['MachCrit'+i],peakMach:p['MachMax'+i],peak:p['MultMachMax'+i],slope:p['MultLineCoeff'+i],limit:p['MultLimit'+i]});
const wtEvidence={};
for(const [id,name,sourceFile,referenceFuel]of [['f16','F-16A Block 10','f_16a_block_10',2400],['j11','J-11','j_11',4700],['su27','Su-27','su_27',4700]]){
  const buffer=fs.readFileSync(path.join(root,sourceFile+'.blkx')),d=JSON.parse(buffer),w=d.Aerodynamics.WingPlane,polar=w.FlapsPolar0,engine=d.EngineType0.Main,t=engine.ThrustMax;
  const area=['Left','Right'].reduce((sum,s)=>sum+['In','Mid','Out'].reduce((n,k)=>n+w.Areas[s+k],0),0),parts=d.Mass.Parts??{},capacity=Object.entries(parts).filter(([k])=>k.endsWith('_capacity')&&!parts[k.replace('_capacity','_external')]).reduce((n,[,v])=>n+v,0)||d.Mass.MaxFuelMass0;
  const engines=Object.keys(d).filter(k=>/^Engine\d+$/.test(k)).length,alts=numbered(t,'Altitude_'),speeds=numbered(t,'Velocity_').map(v=>v/3.6),fuse=d.Aerodynamics.FuselagePlane,hor=d.Aerodynamics.HorStabPlane,ver=d.Aerodynamics.VerStabPlane;
  const components=[{area,polar},...[[fuse,['Main']],[hor,['Main','Elevator']],[ver,['Main','Rudder']]].map(([plane,keys])=>({area:keys.reduce((s,k)=>s+(plane.Areas[k]??0),0),polar:plane.Polar}))];
  const mass=d.Mass.EmptyMass+(d.Mass.OilMass??0)+referenceFuel,cd0=components.reduce((sum,c)=>sum+c.area*c.polar.CdMin,0)/area;
  const profile={name,visualModel:id,category:'fighter',mass,emptyMassKg:d.Mass.EmptyMass+(d.Mass.OilMass??0),payloadMassKg:0,referenceFuelKg:referenceFuel,fuelCapacityKg:capacity,engineCount:engines,area,spanM:w.Span,lengthM:d.Length,
    cl0:polar.Cl0,clAlpha:polar.lineClCoeff*180/Math.PI,clMax:polar.ClCritHigh,criticalAlpha:radians(polar.alphaCritHigh),cd0,k:area/(Math.PI*polar.OswaldsEfficiencyNumber*w.Span**2),maxG:9,bankRate:radians(id==='f16'?120:100),clRate:1.2,
    thrust:{altitudes:alts,speeds,values:alts.map((_,i)=>speeds.map((_,j)=>engines*t.ThrustMax0*9.80665*t[`ThrustMaxCoeff_${i}_${j}`]))},
    engine:{afterburnerAvailable:true,dryBoost:engine.ThrottleBoost*engine.Mode4.ThrustMult,wetBoost:engine.AfterburnerBoost*engine.Mode5.ThrustMult,responseSeconds:engine.TurbineTimeConstant,
      dryModes:[0,1,2,3,4].map(i=>({throttle:engine['Mode'+i].Throttle,fraction:engine['Mode'+i].ThrustMult/engine.Mode4.ThrustMult})),afterburnerCoefficients:alts.map((_,i)=>speeds.map((_,j)=>t[`ThrAftMaxCoeff_${i}_${j}`]))},
    fuelFlow:{model:'thrust-specific',tsfcKgPerNs:engine.ConsumptionOmegaMax/(9.80665*3600),afterburnerMultiplier:engine.Mode5.ConsumptionMult/engine.Mode4.ConsumptionMult,idleKgS:engines*t.ThrustMax0*engine.FuelConsumptionOnIdle/3600},
    configurations:{takeoff:{clMax:w.FlapsPolar1.ClCritHigh,cl0:w.FlapsPolar1.Cl0},landing:{clMax:w.FlapsPolar1.ClCritHigh,cl0:w.FlapsPolar1.Cl0}},machPolar:Object.fromEntries([1,2,3,5].map(i=>[String(i),machFactor(polar,i)])),
    waveDrag:components.map(c=>({cd:c.area*c.polar.CdMin/area,factor:machFactor(c.polar,1)})),limits:{mach:w.Strength.MNE,ias:w.Strength.VNE/3.6},
    provenance:{source:`Local War Thunder FM / ${sourceFile}.blkx`,sourceFile:`gamedata/flightmodels/fm/${sourceFile}.blkx`,sha256:sha(buffer),dataVersion:2,scope:'War Thunder configuration mapped to the current point-mass force integrator; not the original solver',
      direct:['Wing areas, span, clean/flapped lift polars, Mach factors, strength speed limits, per-engine thrust grids, number of engines, engine modes and spool time, empty mass and internal tank capacities'],
      approximations:['9 G pilot limit and bank/CL response are gameplay control limits','Clean CD0 is the area-weighted sum of source surface minimum drag coefficients','Induced factor is derived from source wing area/span/Oswald factor; body lift and trim drag are not resolved separately','Mach transitions use smooth blends','Engine thrust base is interpreted as kgf; fuel consumption as kg/(kgf hour) with mode multipliers','Reference load is empty plus oil and stated fuel; carried stores and burned fuel change mass'],referenceFuelKg:referenceFuel}};
  // Preserve independent sensor configuration if the existing profile has it.
  for(const key of ['radar','rwr'])if(profiles[id]?.[key]!==undefined)profile[key]=profiles[id][key];
  profiles[id]=profile;wtEvidence[id]={sourceFile:profile.provenance.sourceFile,sha256:sha(buffer),emptyMassKg:profile.emptyMassKg,internalFuelKg:capacity,referenceFuelKg:referenceFuel,engineCount:engines,wingAreaM2:area,wingSpanM:w.Span,clMax:profile.clMax,clAlphaPerRad:profile.clAlpha,cd0,inducedK:profile.k};
}
function readSimpleYAML(file){const out={},stack=[{indent:-1,value:out}];for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){const m=/^(\s*)([^:#]+):\s*(.*)$/.exec(line);if(!m)continue;const indent=m[1].length;while(stack.at(-1).indent>=indent)stack.pop();const value=m[3].trim();if(!value){const child={};stack.at(-1).value[m[2].trim()]=child;stack.push({indent,value:child});}else stack.at(-1).value[m[2].trim()]=Number.isFinite(Number(value))?Number(value):value;}return out;}
const sourceRoot='data/aircraft-sources/openap',engineLines=fs.readFileSync(sourceRoot+'/engines.csv','utf8').trim().split(/\r?\n/),headers=engineLines.shift().split(','),engines=engineLines.map(l=>Object.fromEntries(l.split(',').map((v,i)=>[headers[i],v!==''&&Number.isFinite(Number(v))?Number(v):v])));
for(const [id,sourceId,engineName,payload,fuel,area,span]of [['a320','a320','CFM56-5B4/P',12000,9000,122.4,34.1],['b7478','b748','GEnx-2B67',45000,85000,554,68.4]]){
  const a=readSimpleYAML(`${sourceRoot}/aircraft/${sourceId}.yml`),d=readSimpleYAML(`${sourceRoot}/dragpolar/${sourceId}.yml`),e=engines.find(e=>e.name===engineName),count=a.engine.number;
  const thrustModel={staticThrustN:e.max_thrust*count,bypassRatio:e.bpr,cruiseThrustN:(id==='a320'?22241:.2*e.max_thrust+890)*count,cruiseMach:id==='a320'?.8:.85,cruiseHeightM:id==='a320'?10668:11000};
  const altitudes=[0,1500,3000,4500,6000,7500,9000,10500,12000,13500,15000],speeds=[0,40,70,100,140,180,220,260,300,340],mass=a.oew+payload+fuel;
  profiles[id]={name:id==='a320'?'Airbus A320-200 / CFM56-5B4':'Boeing 747-8I / GEnx-2B67',visualModel:id,category:'transport',mass,emptyMassKg:a.oew,payloadMassKg:payload,referenceFuelKg:fuel,fuelCapacityKg:a.mfc*.8,engineCount:count,area,spanM:span,lengthM:a.fuselage.length,
    cl0:.2,clAlpha:4.8,clMax:id==='a320'?1.5:1.45,criticalAlpha:radians(16),cd0:d.clean.cd0,k:id==='a320'?1/(Math.PI*d.clean.e*span**2/area):d.clean.k,maxG:2.5,bankRate:radians(id==='a320'?12:8),clRate:.35,bankResponseSeconds:.7,
    controlLimits:{bankRad:radians(30),bankSlewRadS:radians(8),loadRiseGS:.22,loadFallGS:.4,maxClimbMps:id==='a320'?12:10,maxDescentMps:12,maxAccelerationMps2:.8,gammaRateRadS:.008},
    configurations:{takeoff:{clMax:2,cl0:.4},landing:{clMax:2.7,cl0:.6}},configurationDrag:{gear:d.gears,takeoff:.018,landing:.06,speedBrake:.055},
    engine:{afterburnerAvailable:false,dryBoost:1,responseSeconds:4.5,dryModes:[{throttle:0,fraction:.04},{throttle:.5,fraction:.45},{throttle:1,fraction:1}]},
    fuelFlow:{model:'lto-derived',tsfcKgPerNs:e.ff_to/e.max_thrust,idleKgS:e.ff_idl*count,altitudeExponent:.32},
    thrust:{altitudes,speeds,values:altitudes.map(h=>speeds.map(v=>airlinerThrust(thrustModel,h,v)))},
    transonicDrag:{criticalMach:id==='a320'?.76:.85,coefficient:20},limits:{mach:a.mmo,ias:a.vmo*.5144444444,ceilingM:a.ceiling},
    cruise:{altitudeM:a.cruise.height,mach:a.cruise.mach},airportRotationSpeed:id==='a320'?65:75,rotationMargin:1.05,climbSpeedMps:145,dimensions:{lengthM:a.fuselage.length,wingspanM:span,bodyHeightM:a.fuselage.height},
    provenance:{source:'OpenAP aircraft/drag polar/ICAO engine data; Airbus and Boeing airport planning references',sourceLicense:'GPL-3.0 for OpenAP data',dataVersion:2,sourceUrls:[`https://github.com/TUDelft-CNS-ATM/openap/blob/master/openap/data/aircraft/${sourceId}.yml`,`https://github.com/TUDelft-CNS-ATM/openap/blob/master/openap/data/dragpolar/${sourceId}.yml`,'https://doi.org/10.3390/aerospace7080104'],
      direct:['OEW/MTOW/ceiling/speed limits; reference engine static thrust and LTO fuel flow; clean drag polar'],
      approximations:['Representative payload and fuel load, not maximum takeoff mass','CLmax/CLalpha and high-lift increments are game engineering estimates, not an AFM performance deck','Fuel volume converted at 0.8 kg/L','Maximum thrust derived from OpenAP equations with smooth altitude/speed blending','Fuel flow estimated from LTO thrust-specific consumption with altitude correction','Bank/roll/pitch/climb limits represent restrained transport autopilot behavior',id==='a320'?'A320ceo fence-wing area/span 122.4m2/34.1m; OpenAP induced drag adjusted using its Oswald efficiency':'GEnx cruise thrust uses the OpenAP fallback estimate 0.2*Tstatic+890 N per engine'],thrustModel,referenceLoad:{payloadKg:payload,fuelKg:fuel},referenceLimits:{mtowKg:a.mtow,mlwKg:a.mlw}}};
}
fs.mkdirSync('data/aircraft-sources',{recursive:true});fs.writeFileSync('data/aircraft-sources/war-thunder.json',JSON.stringify(wtEvidence,null,2)+'\n');fs.writeFileSync(file,JSON.stringify(profiles,null,2)+'\n');fs.writeFileSync(runtimeFile,JSON.stringify(runtime,null,2)+'\n');
console.log(Object.fromEntries(Object.entries(profiles).map(([id,p])=>[id,{mass:p.mass,area:p.area,engines:p.engineCount,cd0:p.cd0,k:p.k}])));
