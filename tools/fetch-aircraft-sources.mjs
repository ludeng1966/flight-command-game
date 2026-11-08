import fs from 'node:fs/promises';
import crypto from 'node:crypto';
const base=new URL('../assets/aircraft/sources/',import.meta.url),manifest=JSON.parse(await fs.readFile(new URL('manifest.json',base)));
await Promise.all(manifest.map(async model=>{
  const folder=new URL(model.id+'/',base);await fs.mkdir(folder,{recursive:true});
  for(const entry of model.files){
    const file=new URL(entry.file,folder);let bytes;try{bytes=await fs.readFile(file);}catch{}
    const hash=b=>crypto.createHash('sha1').update(Buffer.from(`blob ${b.length}\0`)).update(b).digest('hex');
    if(!bytes||hash(bytes)!==entry.sha){
      const response=await fetch(entry.url);if(!response.ok)throw Error(`${response.status}: ${entry.url}`);bytes=Buffer.from(await response.arrayBuffer());
      if(hash(bytes)!==entry.sha)throw Error('Upstream changed; review and pin new source: '+entry.url);
      await fs.writeFile(file,bytes);
    }
    console.log(model.id,entry.file,bytes.length);
  }
}));
