// Read-only public-source download. Run explicitly; the game never downloads a lexicon on startup.
import {mkdir,writeFile,readFile,access} from 'node:fs/promises';
const root=new URL('../.game-server/aviation-import/',import.meta.url);await mkdir(root,{recursive:true});
const refresh=process.argv.includes('--refresh'),base='https://www.faa.gov/air_traffic/publications/atpubs/pcg_html/';
async function download(url,name,binary=false){
 const file=new URL(name,root);if(!refresh)try{await access(file);return await readFile(file,binary?undefined:'utf8');}catch{}
 for(let attempt=0;attempt<3;attempt++)try{
  const response=await fetch(url,{signal:AbortSignal.timeout(45000)});if(!response.ok)throw Error('HTTP '+response.status);
  const data=binary?Buffer.from(await response.arrayBuffer()):await response.text();await writeFile(file,data);return data;
 }catch(error){if(attempt===2)throw Error(name+': '+error.message);}
}
const index=await download(base+'index.html','faa-index.html');
const letters=[...new Set([...index.matchAll(/glossary-([a-z])\.html/g)].map(m=>m[1]))];if(letters.length<20)throw Error('Incomplete FAA glossary index');
for(let i=0;i<letters.length;i+=3){const results=await Promise.allSettled(letters.slice(i,i+3).map(letter=>download(base+'glossary-'+letter+'.html','faa-'+letter+'.html')));for(const result of results)if(result.status==='rejected')throw result.reason;console.log('FAA '+letters.slice(0,i+3).join('').toUpperCase());}
await download('https://www.alssa.mil/Portals/9/Documents/mttps/brevity_2025.pdf','brevity_2025.pdf',true);console.log('Public FAA and ALSSA sources cached');
