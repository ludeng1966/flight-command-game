import {readFileSync} from 'node:fs';
export const MANUAL_FILE='23_对局操作手册.txt';
const text=readFileSync(new URL('../data/pilot-handbook/'+MANUAL_FILE,import.meta.url),'utf8');
const sections=new Map([...text.matchAll(/^\[([a-z]+)\]\r?\n([\s\S]*?)(?=^\[[a-z]+\]\r?$|(?![\s\S]))/gm)].map(m=>[m[1],m[2].trim()]));
export function manualSection(id){if(!sections.has(id))throw Error('没有这个操作手册段落：'+id);return sections.get(id);}
export function manualReading(ids){return [...new Set(ids)].map(manualSection).join('\n\n');}
