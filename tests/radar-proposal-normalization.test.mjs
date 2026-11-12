import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeRadarProposal} from '../server/radar-pilot.mjs';
test('radar normalization clears only unused fields and preserves the model original',()=>{
 const raw={operation:'scan',mode:'pd',targetId:'unrelated',headingDeg:60,altitudeM:6000,speedMps:250,scanPolicy:{frame:'body',azCenterDeg:0},message:'已开始扫描'};
 const before=structuredClone(raw),normalized=normalizeRadarProposal(raw);
 assert.deepEqual(raw,before);assert.deepEqual(normalized.decision.scanPolicy,raw.scanPolicy);
 for(const key of ['mode','targetId','headingDeg','altitudeM','speedMps'])assert.equal(normalized.decision[key],null);
 assert.match(normalized.decision.message,/拟/);assert.ok(normalized.normalizations.length>1);
});
test('required lock and maneuver parameters are never invented, clamped or converted',()=>{
 const raw={operation:'maneuver',mode:null,targetId:null,headingDeg:400,altitudeM:null,speedMps:900,scanPolicy:null,message:'转向'};
 const result=normalizeRadarProposal(raw).decision;assert.equal(result.headingDeg,400);assert.equal(result.altitudeM,null);assert.equal(result.speedMps,900);
 const lock=normalizeRadarProposal({operation:'lock',mode:'pd',targetId:'old-track',message:'已经锁定'}).decision;assert.equal(lock.targetId,'old-track');assert.equal(lock.mode,null);assert.doesNotMatch(lock.message,/已经锁定/);
});
