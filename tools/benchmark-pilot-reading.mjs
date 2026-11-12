// Offline prompt footprint only: no cloud calls and no claim about latency.
import {decisionReading} from '../server/pilot-decision-reading.mjs';
const cases=[
  {role:'attack',search:false,link:false},
  {role:'attack',search:true,link:true},
  {role:'radar',search:true,link:true},
  {role:'defense',search:false,link:false}
];
console.log(JSON.stringify(cases.map(({role,search,link})=>{
  const reading=decisionReading(role,{datalink:{available:link}},{search});
  return {role,search,datalink:link,chars:reading.chars,utf8Bytes:Buffer.byteLength(reading.text),version:reading.version,files:[...new Set(reading.files.map(f=>f.file))],sections:reading.files.map(f=>f.section)};
}),null,2));
